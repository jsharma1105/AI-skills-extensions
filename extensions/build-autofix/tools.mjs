// Tool definitions for build-autofix extension
// Each tool is short-lived, returns structured data, and lets the agent drive orchestration.

import * as gh from "./github-provider.mjs";
import * as ado from "./ado-provider.mjs";
import { detectPlatform, getCurrentBranch } from "./detect.mjs";
import { buildPRDescription, buildPRTitle } from "./pr-template.mjs";

// ─── Helpers ──────────────────────────────────────────────────────────

async function resolveProvider(args) {
    let platform = args.platform || "auto";
    let detected = {};

    if (platform === "auto") {
        detected = await detectPlatform(process.cwd());
        platform = detected.platform;
    }

    if (platform === "unknown") {
        throw new Error("Could not auto-detect platform. Specify platform='github' or platform='ado' explicitly.");
    }

    return { platform, detected };
}

function formatResult(data) {
    return JSON.stringify(data, null, 2);
}

// ─── Tool: build_preflight ───────────────────────────────────────────

export const preflightTool = {
    name: "build_preflight",
    description: "Check if the required CLI tools (gh/az) are installed, authenticated, and the platform is detected. Run this before any build operations.",
    parameters: {
        type: "object",
        properties: {
            platform: {
                type: "string",
                enum: ["auto", "github", "ado"],
                description: "Platform to check. 'auto' detects from git remote.",
            },
        },
    },
    skipPermission: true,
    handler: async (args) => {
        const { platform, detected } = await resolveProvider(args);

        const result = { platform, detected };

        if (platform === "github") {
            result.preflight = await gh.preflight();
            result.providerStrategy = {
                note: "GitHub: MCP-first for read ops, gh CLI for write ops.",
                priority: ["MCP (built-in)", "Extension tools (gh CLI)"],
                readOps: "Use MCP tools directly — no gh CLI required",
                writeOps: result.preflight.ok ? "gh CLI available" : "gh CLI NOT available — cannot create PRs or trigger workflows",
                mcpTools: [
                    "github-mcp-server-actions_get (watch build)",
                    "github-mcp-server-actions_list (list runs/jobs)",
                    "github-mcp-server-get_job_logs (failure logs)",
                    "github-mcp-server-pull_request_read (PR status)",
                ],
            };
        } else if (platform === "ado") {
            result.preflight = await ado.preflight();
            const providers = result.preflight.providers || {};
            result.providerStrategy = {
                note: "ADO: REST API first (PAT/bearer), az CLI fallback.",
                priority: ["REST API (AZURE_DEVOPS_PAT)", "Extension tools (az CLI)"],
                restApi: providers.rest?.ok
                    ? { available: true, authType: providers.rest.authType, source: providers.rest.source }
                    : { available: false, error: providers.rest?.error },
                azCli: providers.cli?.ok
                    ? { available: true, version: providers.cli.version }
                    : { available: false, error: providers.cli?.error },
                preferred: result.preflight.preferred || "none",
                readOps: providers.rest?.ok ? "REST API — no az CLI required" : providers.cli?.ok ? "az CLI" : "NONE — set AZURE_DEVOPS_PAT or install az CLI",
                writeOps: providers.rest?.ok ? "REST API — no az CLI required" : providers.cli?.ok ? "az CLI" : "NONE — set AZURE_DEVOPS_PAT or install az CLI",
            };
        }

        result.currentBranch = await getCurrentBranch(process.cwd());
        return formatResult(result);
    },
};

// ─── Tool: build_watch_start ─────────────────────────────────────────

export const watchTool = {
    name: "build_watch_start",
    description: "Watch a pipeline/workflow run and poll until it completes or times out. Returns the run status, conclusion, and list of failed jobs. Supports both GitHub Actions and Azure DevOps pipelines.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner. Required for GitHub." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization. Required for ADO." },
            project: { type: "string", description: "Azure DevOps project. Required for ADO." },
            run_id: { type: "string", description: "Specific run/build ID to watch. If omitted, watches the latest run on the branch." },
            branch: { type: "string", description: "Branch to filter runs. If omitted, uses current branch." },
            workflow_id: { type: "string", description: "GitHub workflow filename or ID, or ADO pipeline ID." },
            poll_interval_seconds: { type: "number", description: "Seconds between polls. Default: 60 (1min)." },
            max_wait_seconds: { type: "number", description: "Max seconds to wait before returning timeout. Default: 1800 (30min)." },
            dry_run: { type: "boolean", description: "If true, show what would be polled without actually polling." },
        },
    },
    handler: async (args, invocation) => {
        if (args.dry_run) {
            return formatResult({ dry_run: true, message: "Would poll build run.", args });
        }

        const { platform, detected } = await resolveProvider(args);
        const branch = args.branch || await getCurrentBranch(process.cwd());

        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub. Specify explicitly or ensure git remote is set.");
            return formatResult(await gh.watchBuild({
                owner, repo,
                runId: args.run_id,
                branch,
                workflowId: args.workflow_id,
                pollInterval: args.poll_interval_seconds || 60,
                maxWait: args.max_wait_seconds || 1800,
            }));
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            if (!org || !project) throw new Error("org and project required for ADO. Specify explicitly or ensure git remote is set.");
            return formatResult(await ado.watchBuild({
                org, project,
                runId: args.run_id,
                branch,
                pipelineId: args.workflow_id,
                pollInterval: args.poll_interval_seconds || 60,
                maxWait: args.max_wait_seconds || 1800,
            }));
        }
    },
};

// ─── Tool: build_investigate_failure ─────────────────────────────────

export const investigateTool = {
    name: "build_investigate_failure",
    description: "Fetch and analyze failure logs from a failed pipeline/workflow run. Returns structured error summaries with redacted secrets. Use the output to understand what broke and plan a fix.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            run_id: { type: "string", description: "The failed run/build ID to investigate." },
        },
        required: ["run_id"],
    },
    handler: async (args) => {
        const { platform, detected } = await resolveProvider(args);

        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub.");
            return formatResult(await gh.getFailureLogs({ owner, repo, runId: args.run_id }));
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            if (!org || !project) throw new Error("org and project required for ADO.");
            return formatResult(await ado.getFailureLogs({ org, project, runId: args.run_id }));
        }
    },
};

// ─── Tool: build_fix_and_pr ──────────────────────────────────────────

export const fixAndPrTool = {
    name: "build_fix_and_pr",
    description: "After fixing the code, call this tool to: create a fix branch, commit all changes, push, and open a PR targeting the base branch. The PR includes a failure analysis summary. IMPORTANT: Fix the code BEFORE calling this tool.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            base_branch: { type: "string", description: "Branch the pipeline runs on (PR target)." },
            fix_description: { type: "string", description: "Human-readable description of what was fixed." },
            failure_summary: { type: "string", description: "Brief summary of the build failure (for PR description)." },
            failed_step: { type: "string", description: "Name of the failed step/job." },
            run_id: { type: "string", description: "The failed run ID (for linking in PR)." },
            run_url: { type: "string", description: "URL to the failed run." },
            pipeline_name: { type: "string", description: "Name of the pipeline/workflow." },
            attempt: { type: "number", description: "Current attempt number. Default: 1." },
            max_attempts: { type: "number", description: "Max configured attempts. Default: 5." },
            files_changed: {
                type: "array", items: { type: "string" },
                description: "List of files that were changed in the fix.",
            },
            dry_run: { type: "boolean", description: "If true, show what would happen without creating branch/PR." },
        },
        required: ["base_branch", "fix_description"],
    },
    handler: async (args) => {
        const { platform, detected } = await resolveProvider(args);
        const cwd = process.cwd();
        const baseBranch = args.base_branch;
        const attempt = args.attempt || 1;
        const maxAttempts = args.max_attempts || 5;

        // Build PR description
        const prBody = buildPRDescription({
            branch: baseBranch,
            attempt,
            maxAttempts,
            pipelineName: args.pipeline_name || "unknown",
            runId: args.run_id || "unknown",
            runUrl: args.run_url || "",
            failedStep: args.failed_step || "unknown",
            errorSummary: args.failure_summary || "See linked build run for details.",
            fixDescription: args.fix_description,
            filesChanged: args.files_changed || [],
            platform,
        });
        const prTitle = buildPRTitle(baseBranch, attempt);

        if (args.dry_run) {
            return formatResult({
                dry_run: true,
                message: "Would create fix branch, commit, push, and open PR.",
                prTitle,
                prBody: prBody.slice(0, 500) + "...",
                baseBranch,
            });
        }

        // Create fix branch
        let branchResult;
        if (platform === "github") {
            branchResult = await gh.createFixBranch({ baseBranch, cwd });
        } else {
            branchResult = await ado.createFixBranch({ baseBranch, cwd });
        }

        // Commit and push
        const commitMsg = `fix(autofix): ${args.fix_description.slice(0, 72)}`;
        let commitResult;
        if (platform === "github") {
            commitResult = await gh.commitAndPush({ branchName: branchResult.branchName, message: commitMsg, cwd });
        } else {
            commitResult = await ado.commitAndPush({ branchName: branchResult.branchName, message: commitMsg, cwd });
        }

        if (!commitResult.committed) {
            // Clean up orphaned fix branch and switch back to base
            const { runText: rt } = await import("./shell.mjs");
            try { await rt("git", ["checkout", baseBranch], { cwd }); } catch {}
            try { await rt("git", ["branch", "-D", branchResult.branchName], { cwd }); } catch {}
            return formatResult({ success: false, message: "No changes to commit. Did you fix the code before calling this tool?" });
        }

        // Open PR
        let prResult;
        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub.");
            prResult = await gh.openPullRequest({
                owner, repo,
                branchName: branchResult.branchName,
                baseBranch, title: prTitle, body: prBody,
            });
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            const repo = args.repo || detected.repo;
            if (!org || !project || !repo) throw new Error("org, project, and repo required for ADO.");
            prResult = await ado.openPullRequest({
                org, project, repo,
                branchName: branchResult.branchName,
                baseBranch, title: prTitle, body: prBody,
            });
        }

        // Switch back to base branch for the next iteration
        try {
            const { runText } = await import("./shell.mjs");
            await runText("git", ["checkout", baseBranch], { cwd });
        } catch {}

        return formatResult({
            success: true,
            branchName: branchResult.branchName,
            commitSha: commitResult.commitSha,
            prId: prResult.prId,
            prUrl: prResult.prUrl,
            prTitle,
        });
    },
};

// ─── Tool: build_check_pr_status ─────────────────────────────────────

export const checkPrTool = {
    name: "build_check_pr_status",
    description: "Check the current status of a pull request (open, merged, closed/abandoned). Use this to poll whether a developer has approved and merged the auto-fix PR.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            pr_id: { type: "string", description: "Pull request number/ID." },
        },
        required: ["pr_id"],
    },
    skipPermission: true,
    handler: async (args) => {
        const { platform, detected } = await resolveProvider(args);

        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub.");
            return formatResult(await gh.checkPRStatus({ owner, repo, prId: args.pr_id }));
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            if (!org || !project) throw new Error("org and project required for ADO.");
            return formatResult(await ado.checkPRStatus({ org, project, repo: args.repo || detected.repo, prId: args.pr_id }));
        }
    },
};

// ─── Tool: build_wait_for_pr_merge ───────────────────────────────────

export const waitMergeTool = {
    name: "build_wait_for_pr_merge",
    description: "Poll a PR until it is merged or a bounded timeout is reached. If timeout, returns status for resumption — call build_check_pr_status to continue checking later.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            pr_id: { type: "string", description: "Pull request number/ID." },
            poll_interval_seconds: { type: "number", description: "Seconds between polls. Default: 60." },
            max_wait_seconds: { type: "number", description: "Max seconds to wait. Default: 1800 (30min). PR approval may take longer — use build_check_pr_status for longer waits." },
            dry_run: { type: "boolean", description: "If true, show what would be polled." },
        },
        required: ["pr_id"],
    },
    handler: async (args) => {
        if (args.dry_run) {
            return formatResult({ dry_run: true, message: "Would poll PR status.", args });
        }

        const { platform, detected } = await resolveProvider(args);

        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub.");
            return formatResult(await gh.waitForPRMerge({
                owner, repo, prId: args.pr_id,
                pollInterval: args.poll_interval_seconds || 60,
                maxWait: args.max_wait_seconds || 1800,
            }));
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            if (!org || !project) throw new Error("org and project required for ADO.");
            return formatResult(await ado.waitForPRMerge({
                org, project, repo: args.repo || detected.repo, prId: args.pr_id,
                pollInterval: args.poll_interval_seconds || 60,
                maxWait: args.max_wait_seconds || 1800,
            }));
        }
    },
};

// ─── Tool: build_trigger_workflow ────────────────────────────────────

export const triggerTool = {
    name: "build_trigger_workflow",
    description: "Trigger a new pipeline/workflow run on a branch. Use after a fix PR is merged to verify the fix. Returns the new run ID for subsequent watching.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            workflow_id: { type: "string", description: "GitHub workflow filename/ID or ADO pipeline ID." },
            branch: { type: "string", description: "Branch to trigger on. Default: current branch." },
            dry_run: { type: "boolean", description: "If true, show what would be triggered." },
        },
        required: ["workflow_id"],
    },
    handler: async (args) => {
        if (args.dry_run) {
            return formatResult({ dry_run: true, message: "Would trigger build.", args });
        }

        const { platform, detected } = await resolveProvider(args);
        const branch = args.branch || await getCurrentBranch(process.cwd());

        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub.");
            return formatResult(await gh.triggerBuild({ owner, repo, workflowId: args.workflow_id, branch }));
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            if (!org || !project) throw new Error("org and project required for ADO.");
            return formatResult(await ado.triggerBuild({ org, project, pipelineId: args.workflow_id, branch }));
        }
    },
};

// ─── Tool: build_check_status ────────────────────────────────────────

export const checkStatusTool = {
    name: "build_check_status",
    description: "Check the current status of a specific pipeline/workflow run. Use this to resume monitoring a build after a timeout from build_watch_start.",
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            run_id: { type: "string", description: "Run/build ID to check." },
        },
        required: ["run_id"],
    },
    skipPermission: true,
    handler: async (args) => {
        const { platform, detected } = await resolveProvider(args);

        // Re-use watchBuild with very short maxWait to get immediate status
        if (platform === "github") {
            const owner = args.owner || detected.owner;
            const repo = args.repo || detected.repo;
            if (!owner || !repo) throw new Error("owner and repo required for GitHub.");
            return formatResult(await gh.watchBuild({
                owner, repo, runId: args.run_id, pollInterval: 1, maxWait: 5,
            }));
        } else {
            const org = args.org || detected.org;
            const project = args.project || detected.project;
            if (!org || !project) throw new Error("org and project required for ADO.");
            return formatResult(await ado.watchBuild({
                org, project, runId: args.run_id, pollInterval: 1, maxWait: 5,
            }));
        }
    },
};

// ─── Tool: build_autofix_orchestrate ─────────────────────────────────
// This is a PLANNING tool, not a long-running loop.
// It validates config, detects the environment, and returns a step-by-step
// execution plan for the agent to follow using the other tools.

export const orchestrateTool = {
    name: "build_autofix_orchestrate",
    description: `Plan and configure a build-fix-retry loop. This tool does NOT execute the loop itself — it validates the environment, resolves configuration, and returns a step-by-step execution plan that you (the agent) should follow using the individual build tools. 

Call this first to get the plan, then execute each step sequentially. The plan includes all tool names, arguments, and decision points. Respect max_retries and stop when the build succeeds or retries are exhausted.`,
    parameters: {
        type: "object",
        properties: {
            platform: { type: "string", enum: ["auto", "github", "ado"], description: "Platform. Default: auto-detect." },
            owner: { type: "string", description: "GitHub repo owner." },
            repo: { type: "string", description: "Repository name." },
            org: { type: "string", description: "Azure DevOps organization." },
            project: { type: "string", description: "Azure DevOps project." },
            branch: { type: "string", description: "Branch to watch/fix. Default: current branch." },
            workflow_id: { type: "string", description: "GitHub workflow filename/ID or ADO pipeline ID." },
            run_id: { type: "string", description: "Specific run to start watching. If omitted, watches latest." },
            min_retries: { type: "number", description: "Minimum retry attempts. Default: 3." },
            max_retries: { type: "number", description: "Maximum retry attempts. Default: 5." },
            build_timeout_seconds: { type: "number", description: "Max seconds to wait for each build. Default: 1800 (30min)." },
            pr_wait_timeout_seconds: { type: "number", description: "Max seconds to wait for PR merge. Default: 1800 (30min)." },
            poll_interval_seconds: { type: "number", description: "Seconds between polls. Default: 30." },
            dry_run: { type: "boolean", description: "If true, all subsequent tool calls should use dry_run=true." },
        },
    },
    skipPermission: true,
    handler: async (args) => {
        // Resolve platform and environment
        const { platform, detected } = await resolveProvider(args);
        const branch = args.branch || await getCurrentBranch(process.cwd());
        const config = {
            platform,
            branch,
            workflowId: args.workflow_id || null,
            runId: args.run_id || null,
            minRetries: args.min_retries || 3,
            maxRetries: args.max_retries || 5,
            buildTimeoutSeconds: args.build_timeout_seconds || 1800,
            prWaitTimeoutSeconds: args.pr_wait_timeout_seconds || 1800,
            pollIntervalSeconds: args.poll_interval_seconds || 60,
            dryRun: args.dry_run || false,
        };

        // Resolve platform-specific identifiers
        const platformArgs = {};
        if (platform === "github") {
            platformArgs.owner = args.owner || detected.owner;
            platformArgs.repo = args.repo || detected.repo;
            if (!platformArgs.owner || !platformArgs.repo) {
                throw new Error("Could not resolve owner/repo for GitHub. Specify explicitly.");
            }
        } else if (platform === "ado") {
            platformArgs.org = args.org || detected.org;
            platformArgs.project = args.project || detected.project;
            platformArgs.repo = args.repo || detected.repo;
            if (!platformArgs.org || !platformArgs.project) {
                throw new Error("Could not resolve org/project for ADO. Specify explicitly.");
            }
        }

        // Build the common args string for tool calls
        const commonArgs = { platform, ...platformArgs };

        // Platform-specific strategy
        const isGitHub = platform === "github";
        const isADO = platform === "ado";

        // Check ADO REST availability for plan generation
        let adoRestAvailable = false;
        if (isADO) {
            try {
                const { resolveAuth } = await import("./ado-rest-provider.mjs");
                adoRestAvailable = !!resolveAuth();
            } catch {}
        }

        return formatResult({
            status: "plan_ready",
            config,
            platformArgs: commonArgs,
            providerStrategy: isGitHub
                ? {
                    priority: ["1. MCP (built-in)", "2. Extension tools (gh CLI)"],
                    readOps: "MCP (github-mcp-server-*) — no gh CLI needed",
                    writeOps: "Extension tools (build_fix_and_pr, build_trigger_workflow) — requires gh CLI",
                    note: "For GitHub, prefer MCP tools for all read operations. They are built-in agent tools that call the GitHub API directly without needing the gh CLI installed.",
                }
                : {
                    priority: adoRestAvailable
                        ? ["1. REST API (AZURE_DEVOPS_PAT)", "2. Extension tools (az CLI)"]
                        : ["1. Extension tools (az CLI)"],
                    readOps: adoRestAvailable ? "REST API — no az CLI needed" : "Extension tools (az CLI)",
                    writeOps: adoRestAvailable ? "REST API — no az CLI needed" : "Extension tools (az CLI)",
                    note: adoRestAvailable
                        ? "ADO REST API available via PAT. Extension tools use REST first, az CLI as fallback. All operations work without az CLI."
                        : "No ADO REST auth found (set AZURE_DEVOPS_PAT for zero-CLI operation). All operations use az CLI.",
                },
            executionPlan: [
                {
                    step: 1,
                    action: "PREFLIGHT",
                    tool: "build_preflight",
                    args: { platform },
                    description: "Verify CLI tools are installed and authenticated.",
                    onFailure: "STOP — fix CLI setup before proceeding.",
                },
                {
                    step: 2,
                    action: "WATCH_BUILD",
                    ...(isGitHub ? {
                        preferred: {
                            description: "Use MCP tools directly (no gh CLI needed).",
                            steps: [
                                config.runId
                                    ? `Call github-mcp-server-actions_get with method='get_workflow_run', owner='${platformArgs.owner}', repo='${platformArgs.repo}', resource_id='${config.runId}'`
                                    : `Call github-mcp-server-actions_list with method='list_workflow_runs', owner='${platformArgs.owner}', repo='${platformArgs.repo}'${config.workflowId ? `, resource_id='${config.workflowId}'` : ""}${config.branch ? `, workflow_runs_filter={branch:'${config.branch}'}` : ""}`,
                                "Check the run status. If 'completed', check conclusion. If 'in_progress'/'queued', wait poll_interval seconds and repeat.",
                                `Poll up to ${config.buildTimeoutSeconds}s total. If still running, return timeout status.`,
                            ],
                        },
                        fallback: {
                            tool: "build_watch_start",
                            args: { ...commonArgs, branch: config.branch, workflow_id: config.workflowId, run_id: config.runId, poll_interval_seconds: config.pollIntervalSeconds, max_wait_seconds: config.buildTimeoutSeconds, dry_run: config.dryRun },
                            description: "Fallback: use extension tool (requires gh CLI).",
                        },
                    } : {
                        tool: "build_watch_start",
                        args: { ...commonArgs, branch: config.branch, workflow_id: config.workflowId, run_id: config.runId, poll_interval_seconds: config.pollIntervalSeconds, max_wait_seconds: config.buildTimeoutSeconds, dry_run: config.dryRun },
                    }),
                    description: "Watch the current/latest build run.",
                    onSuccess: "Build passed! STOP — no fix needed.",
                    onFailure: "Proceed to step 3.",
                    onTimeout: "Use build_check_status (or github-mcp-server-actions_get for GitHub) to resume. Repeat step 2.",
                },
                {
                    step: 3,
                    action: "INVESTIGATE",
                    ...(isGitHub ? {
                        preferred: {
                            description: "Use MCP tools directly (no gh CLI needed).",
                            steps: [
                                `Call github-mcp-server-actions_list with method='list_workflow_jobs', owner='${platformArgs.owner}', repo='${platformArgs.repo}', resource_id='RUN_ID_FROM_STEP_2' to get all jobs.`,
                                "Filter for jobs with conclusion='failure'.",
                                `For each failed job, call github-mcp-server-get_job_logs with owner='${platformArgs.owner}', repo='${platformArgs.repo}', job_id=JOB_ID, return_content=true, failed_only=true.`,
                                "Extract error lines (containing 'error', 'Error', 'FAILED', 'fatal', 'exception').",
                            ],
                        },
                        fallback: {
                            tool: "build_investigate_failure",
                            args: { ...commonArgs, run_id: "FROM_STEP_2" },
                            description: "Fallback: use extension tool (requires gh CLI).",
                        },
                    } : {
                        tool: "build_investigate_failure",
                        args: { ...commonArgs, run_id: "FROM_STEP_2" },
                    }),
                    description: "Fetch and analyze failure logs.",
                },
                {
                    step: 4,
                    action: "FIX_CODE",
                    tool: "Use standard edit/create tools",
                    description: "Analyze the error summary from step 3. Identify the root cause. Fix the code using edit/view/grep tools. This is YOUR job as the agent — apply the fix directly to the codebase.",
                },
                {
                    step: 5,
                    action: "CREATE_PR",
                    tool: "build_fix_and_pr",
                    args: {
                        ...commonArgs,
                        base_branch: config.branch,
                        fix_description: "FROM_YOUR_ANALYSIS",
                        failure_summary: "FROM_STEP_3",
                        dry_run: config.dryRun,
                    },
                    description: "Create a fix branch, commit changes, open PR with failure analysis. NOTE: This step always requires CLI tools (gh for GitHub, az for ADO).",
                },
                {
                    step: 6,
                    action: "WAIT_FOR_MERGE",
                    ...(isGitHub ? {
                        preferred: {
                            description: "Use MCP to check PR status (no gh CLI needed for checking).",
                            steps: [
                                `Call github-mcp-server-pull_request_read with method='get', owner='${platformArgs.owner}', repo='${platformArgs.repo}', pullNumber=PR_NUMBER_FROM_STEP_5.`,
                                "Check state field: 'MERGED' → proceed to step 7, 'CLOSED' → PR rejected, 'OPEN' → wait and retry.",
                                `Poll every ${config.pollIntervalSeconds}s, up to ${config.prWaitTimeoutSeconds}s total.`,
                            ],
                        },
                        fallback: {
                            tool: "build_wait_for_pr_merge",
                            args: { ...commonArgs, pr_id: "FROM_STEP_5", poll_interval_seconds: config.pollIntervalSeconds, max_wait_seconds: config.prWaitTimeoutSeconds, dry_run: config.dryRun },
                            description: "Fallback: use extension tool (requires gh CLI).",
                        },
                    } : {
                        tool: "build_wait_for_pr_merge",
                        args: { ...commonArgs, pr_id: "FROM_STEP_5", poll_interval_seconds: config.pollIntervalSeconds, max_wait_seconds: config.prWaitTimeoutSeconds, dry_run: config.dryRun },
                    }),
                    description: "Wait for developer to review and merge the PR.",
                    onTimeout: "Inform the user the PR is still open. Use build_check_pr_status or MCP to check later.",
                    onMerged: "Proceed to step 7.",
                    onClosed: "PR was rejected. Ask the user for guidance.",
                },
                {
                    step: 7,
                    action: "TRIGGER_REBUILD",
                    tool: "build_trigger_workflow",
                    args: {
                        ...commonArgs,
                        workflow_id: config.workflowId,
                        branch: config.branch,
                        dry_run: config.dryRun,
                    },
                    description: "Trigger a new build on the branch to verify the fix. NOTE: This step always requires CLI tools (gh for GitHub, az for ADO).",
                    then: "Go back to step 2 with the new run_id. Increment attempt counter.",
                },
            ],
            retryPolicy: {
                maxRetries: config.maxRetries,
                minRetries: config.minRetries,
                rule: `Execute the loop (steps 2-7) up to ${config.maxRetries} times. After ${config.maxRetries} failed attempts, STOP and report all failures to the user.`,
            },
            safetyRules: [
                "NEVER auto-merge PRs — always wait for human approval.",
                "Track attempt count — stop at max_retries.",
                "All PR descriptions include failure analysis (secrets already redacted).",
                "If dry_run is true, pass dry_run=true to ALL tool calls.",
                `Switch back to branch '${config.branch}' after creating each fix PR.`,
            ],
        });
    },
};

// ─── Export all tools ────────────────────────────────────────────────

export const allTools = [
    preflightTool,
    watchTool,
    investigateTool,
    fixAndPrTool,
    checkPrTool,
    waitMergeTool,
    triggerTool,
    checkStatusTool,
    orchestrateTool,
];
