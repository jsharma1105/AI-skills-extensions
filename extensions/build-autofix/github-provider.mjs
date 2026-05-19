// GitHub Actions provider — uses gh CLI for all operations

import { runText, runJson, checkCli, redactSecrets, truncate, sleep } from "./shell.mjs";

/**
 * Preflight check: gh CLI available and authenticated.
 */
export async function preflight() {
    const cli = await checkCli("gh", ["--version"]);
    if (!cli.available) {
        return { ok: false, error: "gh CLI not installed. Install from https://cli.github.com" };
    }
    try {
        await runText("gh", ["auth", "status"], { timeout: 15_000 });
        return { ok: true, version: cli.version };
    } catch (e) {
        return { ok: false, error: `gh CLI not authenticated: ${e.message}. Run 'gh auth login'.` };
    }
}

/**
 * Watch a workflow run until completion or timeout.
 * Returns immediately with current status — does NOT block for hours.
 */
export async function watchBuild({ owner, repo, runId, branch, workflowId, pollInterval = 30, maxWait = 300 }) {
    const startTime = Date.now();
    const maxMs = maxWait * 1000;
    const pollMs = pollInterval * 1000;

    // If no runId, find the latest run for the branch/workflow
    if (!runId) {
        const args = ["run", "list", "--repo", `${owner}/${repo}`, "--json", "databaseId,status,conclusion,headBranch,name", "--limit", "5"];
        if (branch) args.push("--branch", branch);
        if (workflowId) args.push("--workflow", workflowId);

        const runs = await runJson("gh", args);
        if (!runs || runs.length === 0) {
            return { status: "not_found", message: "No workflow runs found for the specified branch/workflow." };
        }
        runId = runs[0].databaseId;
    }

    // Poll until complete or bounded timeout
    while (Date.now() - startTime < maxMs) {
        const run = await runJson("gh", [
            "run", "view", String(runId),
            "--repo", `${owner}/${repo}`,
            "--json", "databaseId,status,conclusion,name,headBranch,url,jobs",
        ], { timeout: Math.min(pollMs * 0.8, 60_000) });

        if (run.status === "completed") {
            const failedJobs = (run.jobs || [])
                .filter((j) => j.conclusion === "failure")
                .map((j) => ({ id: j.databaseId, name: j.name, conclusion: j.conclusion }));

            return {
                status: "completed",
                conclusion: run.conclusion,
                runId: run.databaseId,
                runUrl: run.url,
                name: run.name,
                branch: run.headBranch,
                failedJobs,
            };
        }

        await sleep(pollMs);
        // Re-check timeout after sleep to avoid overshooting
        if (Date.now() - startTime >= maxMs) break;
    }

    // Timeout — return current state for resumption
    const current = await runJson("gh", [
        "run", "view", String(runId),
        "--repo", `${owner}/${repo}`,
        "--json", "databaseId,status,conclusion,name,headBranch,url",
    ]);

    return {
        status: "timeout",
        currentStatus: current.status,
        runId: current.databaseId,
        runUrl: current.url,
        message: `Build still ${current.status} after ${maxWait}s. Use build_check_status to resume polling.`,
    };
}

/**
 * Get failure logs from failed jobs in a workflow run.
 */
export async function getFailureLogs({ owner, repo, runId }) {
    // Get run details with jobs
    const run = await runJson("gh", [
        "run", "view", String(runId),
        "--repo", `${owner}/${repo}`,
        "--json", "databaseId,status,conclusion,name,jobs,url",
    ]);

    const failedJobs = (run.jobs || []).filter((j) => j.conclusion === "failure");

    if (failedJobs.length === 0) {
        return {
            runId: run.databaseId,
            conclusion: run.conclusion,
            runUrl: run.url,
            jobs: [],
            message: "No failed jobs found.",
        };
    }

    const jobDetails = [];
    for (const job of failedJobs) {
        try {
            // Get job logs
            const logs = await runText("gh", [
                "api", `repos/${owner}/${repo}/actions/jobs/${job.databaseId}/logs`,
            ], { timeout: 30_000 });

            // Extract error lines (lines with "error", "Error", "FAILED", "fatal")
            const logLines = logs.split("\n");
            const errorLines = logLines.filter((l) =>
                /\b(error|Error|ERROR|FAILED|fatal|Fatal|FATAL|exception|Exception)\b/.test(l)
            );

            // Get the last N lines for context
            const tailLines = logLines.slice(-100);

            jobDetails.push({
                jobId: job.databaseId,
                jobName: job.name,
                conclusion: job.conclusion,
                errorSummary: redactSecrets(truncate(errorLines.join("\n"), 3000)),
                logTail: redactSecrets(truncate(tailLines.join("\n"), 3000)),
            });
        } catch (e) {
            jobDetails.push({
                jobId: job.databaseId,
                jobName: job.name,
                conclusion: job.conclusion,
                errorSummary: `Failed to fetch logs: ${e.message}`,
                logTail: "",
            });
        }
    }

    return {
        runId: run.databaseId,
        runUrl: run.url,
        conclusion: run.conclusion,
        jobs: jobDetails,
    };
}

/**
 * Trigger a workflow run on a branch.
 */
export async function triggerBuild({ owner, repo, workflowId, branch }) {
    // Try workflow_dispatch first
    try {
        await runText("gh", [
            "workflow", "run", workflowId,
            "--repo", `${owner}/${repo}`,
            "--ref", branch,
        ]);

        // Wait briefly for the run to appear
        await sleep(5000);

        // Find the new run
        const runs = await runJson("gh", [
            "run", "list",
            "--repo", `${owner}/${repo}`,
            "--branch", branch,
            "--workflow", workflowId,
            "--json", "databaseId,status,createdAt",
            "--limit", "1",
        ]);

        if (runs && runs.length > 0) {
            return { runId: runs[0].databaseId, status: runs[0].status, triggered: true };
        }
        return { triggered: true, message: "Workflow dispatched but run ID not yet available. Poll shortly." };
    } catch (e) {
        return { triggered: false, error: `Failed to trigger workflow: ${e.message}` };
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

    // Check if there are changes to commit
    try {
        await runText("git", ["diff", "--cached", "--quiet"], { cwd });
        return { committed: false, message: "No changes to commit." };
    } catch {
        // diff --quiet exits with 1 when there ARE changes — that's expected
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
 * Open a pull request on GitHub.
 */
export async function openPullRequest({ owner, repo, branchName, baseBranch, title, body }) {
    const result = await runJson("gh", [
        "pr", "create",
        "--repo", `${owner}/${repo}`,
        "--head", branchName,
        "--base", baseBranch,
        "--title", title,
        "--body", body,
        "--json", "number,url",
    ]);
    return { prId: result.number, prUrl: result.url };
}

/**
 * Check PR merge status. Bounded check — returns immediately.
 */
export async function checkPRStatus({ owner, repo, prId }) {
    const pr = await runJson("gh", [
        "pr", "view", String(prId),
        "--repo", `${owner}/${repo}`,
        "--json", "number,state,mergedAt,mergeCommit,url,title",
    ]);

    const merged = pr.state === "MERGED" || !!pr.mergedAt;
    return {
        prId: pr.number,
        prUrl: pr.url,
        state: pr.state,
        merged,
        mergeSha: pr.mergeCommit?.oid || null,
    };
}

/**
 * Wait for PR to be merged — bounded wait, returns timeout for resumption.
 */
export async function waitForPRMerge({ owner, repo, prId, pollInterval = 60, maxWait = 300 }) {
    const startTime = Date.now();
    const maxMs = maxWait * 1000;
    const pollMs = pollInterval * 1000;

    while (Date.now() - startTime < maxMs) {
        const status = await checkPRStatus({ owner, repo, prId });
        if (status.merged) return { ...status, timedOut: false };
        if (status.state === "CLOSED") return { ...status, timedOut: false, message: "PR was closed without merging." };
        await sleep(pollMs);
    }

    const current = await checkPRStatus({ owner, repo, prId });
    return { ...current, timedOut: true, message: `PR still ${current.state} after ${maxWait}s. Use build_check_pr_status to resume.` };
}
