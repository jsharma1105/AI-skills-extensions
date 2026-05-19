#!/usr/bin/env node

// ──────────────────────────────────────────────────────────────────────────────
// autofix-runner.mjs — Headless build-autofix runner for CI/CD pipelines
// ──────────────────────────────────────────────────────────────────────────────
// Invoked from a pipeline step on build failure. Investigates the failure,
// collects error context, creates a fix branch, and opens a PR.
//
// NOTE: This runner does NOT auto-fix code. It investigates the failure,
// extracts structured error context, and creates a PR with the failure
// analysis so a developer (or Copilot CLI agent) can apply the fix.
// For fully automated fixes, use Copilot CLI interactively.
//
// Usage:
//   node autofix-runner.mjs --org <url> --project <name> --run-id <id> \
//     --branch <branch> [--max-retries 3] [--platform ado|github]
// ──────────────────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic imports from extension modules
const { runText } = await import(join(__dirname, "shell.mjs"));
const { redactSecrets, truncate } = await import(join(__dirname, "shell.mjs"));
const ghProvider = await import(join(__dirname, "github-provider.mjs"));
const adoProvider = await import(join(__dirname, "ado-provider.mjs"));
const { buildPRDescription, buildPRTitle } = await import(join(__dirname, "pr-template.mjs"));

// ─── CLI Arguments ──────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        platform:      { type: "string", default: "auto" },
        owner:         { type: "string", default: "" },
        repo:          { type: "string", default: "" },
        org:           { type: "string", default: "" },
        project:       { type: "string", default: "" },
        "run-id":      { type: "string", default: "" },
        "pipeline-id": { type: "string", default: "" },
        "workflow-id": { type: "string", default: "" },
        branch:        { type: "string", default: "" },
        "max-retries": { type: "string", default: "3" },
        "dry-run":     { type: "boolean", default: false },
        help:          { type: "boolean", default: false },
    },
});

if (args.help) {
    console.log(`
autofix-runner.mjs — Headless build failure investigator

Flags:
  --platform       github | ado | auto (default: auto)
  --owner          GitHub repo owner
  --repo           Repository name
  --org            ADO organization URL (e.g., https://dev.azure.com/myorg)
  --project        ADO project name
  --run-id         Failed build/workflow run ID
  --pipeline-id    ADO pipeline ID
  --workflow-id    GitHub workflow filename or ID
  --branch         Source branch name
  --max-retries    Max fix attempts (default: 3)
  --dry-run        Print what would happen without making changes
  --help           Show this help
    `);
    process.exit(0);
}

// ─── Platform Detection ─────────────────────────────────────────────────────

function detectPlatform() {
    if (args.platform !== "auto") return args.platform;
    if (args.owner) return "github";
    if (args.org) return "ado";
    // Check environment variables
    if (process.env.GITHUB_ACTIONS) return "github";
    if (process.env.BUILD_BUILDID) return "ado";
    console.error("Cannot auto-detect platform. Use --platform github|ado");
    process.exit(1);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const platform = detectPlatform();
    const runId = args["run-id"];
    const maxRetries = parseInt(args["max-retries"], 10) || 3;
    const dryRun = args["dry-run"];

    console.log("═══════════════════════════════════════════════");
    console.log("  Build Auto-Fix Runner");
    console.log("═══════════════════════════════════════════════");
    console.log(`  Platform:    ${platform}`);
    console.log(`  Run ID:      ${runId}`);
    console.log(`  Branch:      ${args.branch}`);
    console.log(`  Max Retries: ${maxRetries}`);
    console.log(`  Dry Run:     ${dryRun}`);
    console.log("═══════════════════════════════════════════════\n");

    if (!runId) {
        console.error("--run-id is required.");
        process.exit(1);
    }

    // Step 1: Preflight check
    console.log("▶ Step 1: Preflight check...");
    const provider = platform === "github" ? ghProvider : adoProvider;
    const preflight = await provider.preflight();
    if (!preflight.ok) {
        console.error(`Preflight failed: ${preflight.error}`);
        process.exit(1);
    }
    console.log(`  ✓ CLI authenticated (${preflight.version?.split("\n")[0]})\n`);

    // Step 2: Investigate failure
    console.log("▶ Step 2: Investigating build failure...");
    let failureData;
    if (platform === "github") {
        failureData = await ghProvider.getFailureLogs({
            owner: args.owner,
            repo: args.repo,
            runId,
        });
    } else {
        // Extract org name from URL for ADO
        const orgName = args.org.replace(/\/$/, "").split("/").pop();
        failureData = await adoProvider.getFailureLogs({
            org: orgName,
            project: args.project,
            runId,
        });
    }

    if (!failureData.jobs || failureData.jobs.length === 0) {
        console.log("  ℹ No failed jobs found. Build may have succeeded or logs unavailable.");
        console.log(`  Run URL: ${failureData.runUrl || "N/A"}`);
        process.exit(0);
    }

    console.log(`  Found ${failureData.jobs.length} failed job(s):\n`);
    for (const job of failureData.jobs) {
        const jobName = job.jobName || job.taskName || "unknown";
        console.log(`  ─── ${jobName} ───`);
        if (job.errorSummary) {
            console.log("  Error summary:");
            console.log(`    ${job.errorSummary.split("\n").slice(0, 10).join("\n    ")}`);
        }
        console.log();
    }

    // Step 3: Output structured context
    const context = {
        platform,
        runId,
        runUrl: failureData.runUrl,
        branch: args.branch,
        failedJobs: failureData.jobs.map((j) => ({
            name: j.jobName || j.taskName,
            errorSummary: j.errorSummary,
            logTail: j.logTail,
        })),
        timestamp: new Date().toISOString(),
        suggestion: "Use Copilot CLI with build_autofix_orchestrate to auto-fix, or review errors above and fix manually.",
    };

    // Write context file for downstream consumption
    const contextPath = "autofix-context.json";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(contextPath, JSON.stringify(context, null, 2));
    console.log(`▶ Step 3: Failure context saved to ${contextPath}`);

    if (dryRun) {
        console.log("\n[DRY RUN] Would create a PR with failure analysis. Exiting.");
        console.log(JSON.stringify(context, null, 2));
        process.exit(0);
    }

    // Step 4: Create a PR with failure analysis (for human/Copilot to fix)
    console.log("\n▶ Step 4: Creating failure analysis PR...");

    const errorSummary = failureData.jobs
        .map((j) => `### ${j.jobName || j.taskName}\n\`\`\`\n${j.errorSummary || "No error summary"}\n\`\`\``)
        .join("\n\n");

    const prBody = `## 🔧 Build Failure Analysis

**Run ID:** ${runId}
**Branch:** ${args.branch}
**Run URL:** ${failureData.runUrl || "N/A"}
**Generated:** ${new Date().toISOString()}

## Failed Jobs

${errorSummary}

## Log Tails

${failureData.jobs.map((j) => `<details><summary>${j.jobName || j.taskName}</summary>\n\n\`\`\`\n${j.logTail || "No logs"}\n\`\`\`\n</details>`).join("\n\n")}

## Next Steps

1. Review the errors above
2. Fix the code on this branch
3. Push changes — the pipeline will re-run automatically

Or use **Copilot CLI** for automated fixing:
\`\`\`
> Investigate build failure ${runId} and fix it
\`\`\`

---
*Generated by build-autofix runner*`;

    const prTitle = `🔧 [autofix] Build failure analysis for ${args.branch} (run ${runId})`;

    try {
        // Create analysis branch
        const branchName = `autofix/analysis-${args.branch}-${Date.now()}`;
        await runText("git", ["checkout", "-b", branchName]);
        await runText("git", ["add", contextPath]);
        await runText("git", ["commit", "-m", `chore(autofix): failure analysis for run ${runId}`]);
        await runText("git", ["push", "--set-upstream", "origin", branchName]);

        // Open PR
        let prResult;
        if (platform === "github") {
            prResult = await ghProvider.openPullRequest({
                owner: args.owner,
                repo: args.repo,
                branchName,
                baseBranch: args.branch,
                title: prTitle,
                body: prBody,
            });
        } else {
            const orgName = args.org.replace(/\/$/, "").split("/").pop();
            prResult = await adoProvider.openPullRequest({
                org: orgName,
                project: args.project,
                repo: args.repo,
                branchName,
                baseBranch: args.branch,
                title: prTitle,
                body: prBody,
            });
        }

        console.log(`\n  ✓ PR created: ${prResult.prUrl}`);
        console.log(`  PR ID: ${prResult.prId}`);

        // Set ADO pipeline variable for downstream steps
        if (process.env.BUILD_BUILDID) {
            console.log(`##vso[task.setvariable variable=autofixPrId;isOutput=true]${prResult.prId}`);
            console.log(`##vso[task.setvariable variable=autofixPrUrl;isOutput=true]${prResult.prUrl}`);
        }

        // Set GitHub Actions output
        if (process.env.GITHUB_OUTPUT) {
            const { appendFile } = await import("node:fs/promises");
            await appendFile(process.env.GITHUB_OUTPUT, `pr_id=${prResult.prId}\npr_url=${prResult.prUrl}\n`);
        }

    } catch (e) {
        console.error(`\n  ✗ Failed to create PR: ${e.message}`);
        console.log("\n  Failure context is available in autofix-context.json");
        console.log("  Use Copilot CLI manually to investigate and fix.");
        process.exit(1);
    }

    console.log("\n═══════════════════════════════════════════════");
    console.log("  Auto-Fix Runner Complete");
    console.log("═══════════════════════════════════════════════");
}

main().catch((e) => {
    console.error(`Fatal error: ${e.message}`);
    process.exit(1);
});
