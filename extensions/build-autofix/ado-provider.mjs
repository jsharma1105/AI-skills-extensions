// Azure DevOps provider — tiered strategy: REST API first, az CLI fallback
//
// Priority order:
//   1. REST API (ado-rest-provider.mjs) — uses PAT/bearer token, no CLI needed
//   2. az CLI (inline functions below) — traditional approach
//
// Each operation tries REST first. If REST auth is unavailable, falls back to CLI.

import { runText, runJson, checkCli, redactSecrets, truncate, sleep } from "./shell.mjs";
import * as rest from "./ado-rest-provider.mjs";
import { orgUrl } from "./ado-rest-provider.mjs";

// ─── Provider Selection ─────────────────────────────────────────────

/**
 * Determine which provider(s) are available.
 * @returns {{ rest: { ok: boolean, ... }, cli: { ok: boolean, ... }, preferred: "rest"|"cli"|"none" }}
 */
async function resolveProviders() {
    const restResult = await rest.preflight();
    const cliResult = await cliPreflight();

    let preferred = "none";
    if (restResult.ok) preferred = "rest";
    else if (cliResult.ok) preferred = "cli";

    return { rest: restResult, cli: cliResult, preferred };
}

/**
 * Preflight for az CLI only.
 */
async function cliPreflight() {
    const cli = await checkCli("az", ["--version"]);
    if (!cli.available) {
        return { ok: false, error: "az CLI not installed. Install from https://aka.ms/install-azure-cli" };
    }

    try {
        const exts = await runText("az", ["extension", "list", "--query", "[?name=='azure-devops'].name", "-o", "tsv"], { timeout: 15_000 });
        if (!exts.includes("azure-devops")) {
            return { ok: false, error: "Azure DevOps extension not installed. Run: az extension add --name azure-devops" };
        }
    } catch (e) {
        return { ok: false, error: `Failed to check az extensions: ${e.message}` };
    }

    try {
        await runText("az", ["account", "show", "-o", "none"], { timeout: 15_000 });
    } catch (e) {
        return { ok: false, error: `az CLI not authenticated: ${e.message}. Run 'az login'.` };
    }

    // orgUrl() will lazily resolve the CLI default org on first call
    const resolvedOrg = orgUrl("_probe_");
    const hasCliDefault = resolvedOrg !== "https://dev.azure.com/_probe_";

    return { ok: true, version: cli.version, ...(hasCliDefault ? { defaultOrg: resolvedOrg } : {}) };
}

/**
 * Combined preflight — reports both REST and CLI availability.
 */
export async function preflight() {
    const providers = await resolveProviders();

    if (providers.preferred === "none") {
        return {
            ok: false,
            error: "No ADO provider available. Set AZURE_DEVOPS_PAT for REST API, or install az CLI.",
            providers,
        };
    }

    return {
        ok: true,
        preferred: providers.preferred,
        providers,
        ...(providers.preferred === "rest"
            ? { authType: providers.rest.authType, source: providers.rest.source }
            : { version: providers.cli.version }),
    };
}

// ─── Facade Functions ────────────────────────────────────────────────
// Each function tries REST first, falls back to CLI.

/**
 * Watch a pipeline run until completion or timeout.
 * Bounded wait — returns timeout status for resumption.
 */
export async function watchBuild(opts) {
    const restAuth = rest.resolveAuth();
    if (restAuth) {
        try {
            return await rest.watchBuild(opts);
        } catch {
            // REST failed — fall through to CLI
        }
    }
    return cliWatchBuild(opts);
}

async function cliWatchBuild({ org, project, runId, branch, pipelineId, pollInterval = 30, maxWait = 300 }) {
    const startTime = Date.now();
    const maxMs = maxWait * 1000;
    const pollMs = pollInterval * 1000;
    const resolvedOrg = orgUrl(org);

    // If no runId, find the latest run
    if (!runId) {
        const args = ["pipelines", "runs", "list", "--org", resolvedOrg, "--project", project, "--top", "5", "-o", "json"];
        if (pipelineId) args.push("--pipeline-ids", String(pipelineId));

        const runs = await runJson("az", args);
        if (!runs || runs.length === 0) {
            return { status: "not_found", message: "No pipeline runs found." };
        }

        // Filter by branch if specified
        let targetRun = runs[0];
        if (branch) {
            const branchRef = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
            const branchRuns = runs.filter((r) => r.sourceBranch === branchRef);
            if (branchRuns.length > 0) targetRun = branchRuns[0];
        }
        runId = targetRun.id;
    }

    // Poll until complete or timeout
    while (Date.now() - startTime < maxMs) {
        const run = await runJson("az", [
            "pipelines", "runs", "show",
            "--id", String(runId),
            "--org", resolvedOrg,
            "--project", project,
            "-o", "json",
        ], { timeout: Math.min(pollMs * 0.8, 60_000) });

        if (run.status === "completed") {
            let failedJobs = [];
            let timelineFetchError = null;
            try {
                const timeline = await runJson("az", [
                    "devops", "invoke",
                    "--area", "build",
                    "--resource", "timeline",
                    "--route-parameters", `buildId=${runId}`, `project=${project}`,
                    "--org", resolvedOrg,
                    "-o", "json",
                ]);
                failedJobs = (timeline.records || [])
                    .filter((r) => r.type === "Job" && r.result === "failed")
                    .map((r) => ({ id: r.id, name: r.name, result: r.result }));
            } catch (e) {
                failedJobs = [];
                timelineFetchError = `Timeline unavailable: ${e.message}`;
            }

            return {
                status: "completed",
                conclusion: run.result,
                runId: run.id,
                runUrl: run._links?.web?.href || `${resolvedOrg}/${project}/_build/results?buildId=${run.id}`,
                name: run.definition?.name,
                branch: run.sourceBranch?.replace("refs/heads/", ""),
                failedJobs,
                ...(timelineFetchError ? { timelineFetchError } : {}),
            };
        }

        await sleep(pollMs);
        if (Date.now() - startTime >= maxMs) break;
    }

    const current = await runJson("az", [
        "pipelines", "runs", "show", "--id", String(runId),
        "--org", resolvedOrg, "--project", project, "-o", "json",
    ]);

    return {
        status: "timeout",
        currentStatus: current.status,
        runId: current.id,
        runUrl: current._links?.web?.href || `${resolvedOrg}/${project}/_build/results?buildId=${current.id}`,
        message: `Build still ${current.status} after ${maxWait}s. Use build_check_status to resume polling.`,
    };
}

/**
 * Get failure logs from failed tasks in a pipeline run.
 */
export async function getFailureLogs(opts) {
    const restAuth = rest.resolveAuth();
    if (restAuth) {
        try {
            return await rest.getFailureLogs(opts);
        } catch {
            // REST failed — fall through to CLI
        }
    }
    return cliGetFailureLogs(opts);
}

async function cliGetFailureLogs({ org, project, runId }) {
    const resolvedOrg = orgUrl(org);

    // Get timeline (contains all tasks/jobs with their status)
    let timeline;
    try {
        timeline = await runJson("az", [
            "devops", "invoke",
            "--area", "build",
            "--resource", "timeline",
            "--route-parameters", `buildId=${runId}`, `project=${project}`,
            "--org", resolvedOrg,
            "-o", "json",
        ]);
    } catch (e) {
        const stderr = e.stderr ? ` stderr: ${e.stderr}` : "";
        return { runId, jobs: [], error: `Failed to fetch timeline: ${e.message}${stderr}` };
    }

    const failedTasks = (timeline.records || []).filter(
        (r) => (r.type === "Task" || r.type === "Job") && r.result === "failed"
    );

    if (failedTasks.length === 0) {
        return { runId, jobs: [], message: "No failed tasks found in timeline." };
    }

    const jobDetails = [];
    for (const task of failedTasks.filter((t) => t.type === "Task")) {
        let logContent = "";
        if (task.log?.url) {
            try {
                logContent = await runText("az", [
                    "devops", "invoke",
                    "--area", "build",
                    "--resource", "logs",
                    "--route-parameters", `buildId=${runId}`, `project=${project}`, `logId=${task.log.id}`,
                    "--org", resolvedOrg,
                    "-o", "json",
                ]).catch(() => "");

                if (logContent) {
                    try {
                        const parsed = JSON.parse(logContent);
                        if (Array.isArray(parsed.value)) logContent = parsed.value.join("\n");
                    } catch {
                        // Already plain text
                    }
                }
            } catch {
                logContent = "Failed to fetch log content.";
            }
        }

        const logLines = logContent.split("\n");
        const errorLines = logLines.filter((l) =>
            /\b(error|Error|ERROR|FAILED|fatal|Fatal|FATAL|exception|Exception|##\[error\])\b/.test(l)
        );

        jobDetails.push({
            taskId: task.id,
            taskName: task.name,
            result: task.result,
            parentId: task.parentId,
            errorSummary: redactSecrets(truncate(errorLines.join("\n"), 3000)),
            logTail: redactSecrets(truncate(logLines.slice(-100).join("\n"), 3000)),
        });
    }

    const runUrl = `${resolvedOrg}/${project}/_build/results?buildId=${runId}`;
    return { runId, runUrl, jobs: jobDetails };
}

/**
 * Trigger a pipeline run on a branch.
 */
export async function triggerBuild(opts) {
    const restAuth = rest.resolveAuth();
    if (restAuth) {
        try {
            return await rest.triggerBuild(opts);
        } catch {
            // REST failed — fall through to CLI
        }
    }
    return cliTriggerBuild(opts);
}

async function cliTriggerBuild({ org, project, pipelineId, branch }) {
    const resolvedOrg = orgUrl(org);
    const branchRef = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;

    try {
        const result = await runJson("az", [
            "pipelines", "run",
            "--id", String(pipelineId),
            "--branch", branchRef,
            "--org", resolvedOrg,
            "--project", project,
            "-o", "json",
        ]);
        return { runId: result.id, status: result.status, triggered: true };
    } catch (e) {
        return { triggered: false, error: `Failed to trigger pipeline: ${e.message}` };
    }
}

/**
 * Create a fix branch from the base branch (fetches latest first).
 */
export async function createFixBranch({ baseBranch, cwd }) {
    const timestamp = Date.now();
    const branchName = `autofix/${baseBranch}-${timestamp}`;
    // Ensure we're on the correct base before branching
    await runText("git", ["fetch", "origin", baseBranch], { cwd });
    await runText("git", ["checkout", baseBranch], { cwd });
    await runText("git", ["reset", "--hard", `origin/${baseBranch}`], { cwd });
    await runText("git", ["checkout", "-b", branchName], { cwd });
    return { branchName };
}

/**
 * Commit current changes and push.
 */
export async function commitAndPush({ branchName, message, cwd }) {
    await runText("git", ["add", "-A"], { cwd });

    try {
        await runText("git", ["diff", "--cached", "--quiet"], { cwd });
        return { committed: false, message: "No changes to commit." };
    } catch {
        // Changes exist
    }

    await runText("git", ["commit", "-m", message], { cwd });
    const commitSha = await runText("git", ["rev-parse", "HEAD"], { cwd });
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
        throw new Error(`Unexpected git rev-parse output: ${commitSha}`);
    }
    await runText("git", ["push", "--set-upstream", "origin", branchName], { cwd });
    return { committed: true, commitSha };
}

/**
 * Open a pull request on Azure DevOps.
 */
export async function openPullRequest(opts) {
    const restAuth = rest.resolveAuth();
    if (restAuth) {
        try {
            return await rest.openPullRequest(opts);
        } catch {
            // REST failed — fall through to CLI
        }
    }
    return cliOpenPullRequest(opts);
}

async function cliOpenPullRequest({ org, project, repo, branchName, baseBranch, title, body }) {
    const resolvedOrg = orgUrl(org);
    const sourceBranch = branchName.startsWith("refs/") ? branchName : `refs/heads/${branchName}`;
    const targetBranch = baseBranch.startsWith("refs/") ? baseBranch : `refs/heads/${baseBranch}`;

    const result = await runJson("az", [
        "repos", "pr", "create",
        "--org", resolvedOrg,
        "--project", project,
        "--repository", repo,
        "--source-branch", sourceBranch,
        "--target-branch", targetBranch,
        "--title", title,
        "--description", body,
        "-o", "json",
    ]);

    return {
        prId: result.pullRequestId,
        prUrl: result.url || `${resolvedOrg}/${project}/_git/${repo}/pullrequest/${result.pullRequestId}`,
    };
}

/**
 * Check PR status on ADO.
 */
export async function checkPRStatus(opts) {
    const restAuth = rest.resolveAuth();
    if (restAuth) {
        try {
            return await rest.checkPRStatus(opts);
        } catch {
            // REST failed — fall through to CLI
        }
    }
    return cliCheckPRStatus(opts);
}

async function cliCheckPRStatus({ org, project, repo, prId }) {
    const resolvedOrg = orgUrl(org);

    const pr = await runJson("az", [
        "repos", "pr", "show",
        "--id", String(prId),
        "--org", resolvedOrg,
        "-o", "json",
    ]);

    const merged = pr.status === "completed" && pr.mergeStatus === "succeeded";
    const repoName = pr.repository?.name || repo || "unknown";
    return {
        prId: pr.pullRequestId,
        prUrl: pr.url || `${resolvedOrg}/${project}/_git/${repoName}/pullrequest/${pr.pullRequestId}`,
        state: pr.status, // active, completed, abandoned
        merged,
        mergeSha: pr.lastMergeCommit?.commitId || null,
    };
}

/**
 * Wait for PR merge — bounded wait.
 */
export async function waitForPRMerge(opts) {
    const restAuth = rest.resolveAuth();
    if (restAuth) {
        try {
            return await rest.waitForPRMerge(opts);
        } catch {
            // REST failed — fall through to CLI
        }
    }
    return cliWaitForPRMerge(opts);
}

async function cliWaitForPRMerge({ org, project, repo, prId, pollInterval = 60, maxWait = 300 }) {
    const startTime = Date.now();
    const maxMs = maxWait * 1000;
    const pollMs = pollInterval * 1000;

    while (Date.now() - startTime < maxMs) {
        const status = await checkPRStatus({ org, project, repo, prId });
        if (status.merged) return { ...status, timedOut: false };
        if (status.state === "abandoned") return { ...status, timedOut: false, message: "PR was abandoned." };
        await sleep(pollMs);
    }

    const current = await checkPRStatus({ org, project, repo, prId });
    return { ...current, timedOut: true, message: `PR still ${current.state} after ${maxWait}s. Use build_check_pr_status to resume.` };
}
