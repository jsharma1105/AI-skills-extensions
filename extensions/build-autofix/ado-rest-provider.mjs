// Azure DevOps REST API provider — replaces az CLI for all read/write ADO operations
// Uses native fetch() (Node 18+) with PAT or bearer token auth.
//
// Auth resolution order:
//   1. AZURE_DEVOPS_PAT — Personal Access Token (most common)
//   2. AZURE_DEVOPS_EXT_PAT — Used by az devops extension
//   3. SYSTEM_ACCESSTOKEN — Available in ADO pipelines
//   4. ADO_BEARER_TOKEN — Explicit bearer token for ADO (audience: 499b84ac-1321-427f-aa17-267ca6975798)
//
// Required PAT scopes: vso.build (read), vso.build_execute (trigger), vso.code_write (PRs)

import { redactSecrets, truncate, sleep } from "./shell.mjs";

const API_VERSION = "7.1";
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Auth ───────────────────────────────────────────────────────────

/**
 * Resolve ADO auth from environment variables.
 * @returns {{ type: "basic"|"bearer", header: string } | null}
 */
export function resolveAuth() {
    // PAT sources — Basic auth with ":{pat}" base64-encoded
    const pat = process.env.AZURE_DEVOPS_PAT
        || process.env.AZURE_DEVOPS_EXT_PAT
        || process.env.SYSTEM_ACCESSTOKEN;

    if (pat) {
        const encoded = Buffer.from(`:${pat}`).toString("base64");
        return { type: "basic", header: `Basic ${encoded}` };
    }

    // Explicit bearer token
    const bearer = process.env.ADO_BEARER_TOKEN;
    if (bearer) {
        return { type: "bearer", header: `Bearer ${bearer}` };
    }

    return null;
}

/**
 * Check if REST API auth is available and which capabilities are accessible.
 */
export async function preflight() {
    const auth = resolveAuth();
    if (!auth) {
        return {
            ok: false,
            error: "No ADO REST auth found. Set AZURE_DEVOPS_PAT, AZURE_DEVOPS_EXT_PAT, SYSTEM_ACCESSTOKEN, or ADO_BEARER_TOKEN.",
            capabilities: { read: false, write: false },
        };
    }

    // Validate token by calling a lightweight endpoint
    // We can't know scopes from the token alone, so just verify connectivity
    return {
        ok: true,
        authType: auth.type,
        source: process.env.AZURE_DEVOPS_PAT ? "AZURE_DEVOPS_PAT"
            : process.env.AZURE_DEVOPS_EXT_PAT ? "AZURE_DEVOPS_EXT_PAT"
            : process.env.SYSTEM_ACCESSTOKEN ? "SYSTEM_ACCESSTOKEN"
            : "ADO_BEARER_TOKEN",
        capabilities: {
            read: true,
            write: true,
            note: "Actual capabilities depend on PAT scopes. Required: vso.build (read builds), vso.build_execute (trigger), vso.code_write (create PRs).",
        },
    };
}

// ─── HTTP Helpers ───────────────────────────────────────────────────

/**
 * Make an authenticated ADO REST API call.
 * @param {string} url - Full API URL
 * @param {object} [opts] - { method, body, accept, timeout }
 * @returns {Promise<any>} Parsed JSON response
 */
async function adoFetch(url, opts = {}) {
    const auth = resolveAuth();
    if (!auth) throw new Error("No ADO REST auth configured.");

    const method = opts.method || "GET";
    const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
    const accept = opts.accept || "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const fetchOpts = {
            method,
            signal: controller.signal,
            headers: {
                "Authorization": auth.header,
                "Accept": accept,
                "Content-Type": "application/json",
            },
        };

        if (opts.body) {
            fetchOpts.body = JSON.stringify(opts.body);
        }

        const response = await fetch(url, fetchOpts);

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            const msg = `ADO REST API error: ${response.status} ${response.statusText} — ${redactSecrets(errorBody.slice(0, 500))}`;
            throw new Error(msg);
        }

        // Some endpoints return plain text (logs)
        if (accept === "text/plain") {
            return await response.text();
        }

        const text = await response.text();
        if (!text) return {};
        return JSON.parse(text);
    } catch (e) {
        if (e.name === "AbortError") {
            throw new Error(`ADO REST API timed out after ${timeout}ms: ${method} ${redactSecrets(url)}`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Build ADO API URL with version query param.
 */
function apiUrl(orgUrl, path, queryParams = {}) {
    const base = `${orgUrl}/${path}`;
    const params = new URLSearchParams({ "api-version": API_VERSION, ...queryParams });
    return `${base}?${params.toString()}`;
}

/**
 * Resolve the full ADO org URL from a short name or full URL.
 *
 * Resolution order:
 *   1. AZURE_DEVOPS_ORG_URL env var (highest priority — explicit override)
 *   2. Full URL passed directly (starts with "http")
 *   3. Legacy format detection ("orgname.visualstudio.com" in the string)
 *   4. az CLI default org (from `az devops configure --list`) — lazy, cached
 *   5. Default: https://dev.azure.com/{org}
 *
 * Examples:
 *   orgUrl("myorg")                                  → https://dev.azure.com/myorg
 *   orgUrl("https://dev.azure.com/myorg")            → https://dev.azure.com/myorg
 *   orgUrl("https://myorg.visualstudio.com")         → https://myorg.visualstudio.com
 *   orgUrl("myorg.visualstudio.com")                 → https://myorg.visualstudio.com
 *   orgUrl("itsals") + az CLI configured              → https://itsals.visualstudio.com
 */
export function orgUrl(org) {
    // 1. Env var override — takes priority over everything
    const envUrl = process.env.AZURE_DEVOPS_ORG_URL;
    if (envUrl) return envUrl.replace(/\/$/, "");

    // 2. Already a full URL — use as-is
    if (org.startsWith("http")) return org.replace(/\/$/, "");

    // 3. Legacy visualstudio.com format (without https://)
    if (org.includes(".visualstudio.com")) return `https://${org.replace(/\/$/, "")}`;

    // 4. Check az CLI default org (lazy, cached, synchronous)
    const cliOrg = _resolveOrgFromCliSync();
    if (cliOrg && cliOrg.shortName === org) {
        return cliOrg.url;
    }

    // 5. Default to modern dev.azure.com format
    return `https://dev.azure.com/${org}`;
}

// Lazy cache for az CLI org default — avoids repeated shell calls
let _cachedCliOrg = undefined; // undefined = not yet probed, null = probed but empty

/**
 * Synchronously probe az CLI for the configured default organization URL.
 * Called lazily on first orgUrl() invocation — result is cached.
 * Enables short org names to resolve to legacy visualstudio.com URLs.
 */
function _resolveOrgFromCliSync() {
    if (_cachedCliOrg !== undefined) return _cachedCliOrg;

    try {
        const { execSync } = await_import_child_process();
        const output = execSync('az devops configure --list', {
            timeout: 10_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const match = output.match(/organization\s*=\s*(https?:\/\/\S+)/i);
        if (match) {
            const url = match[1].replace(/\/$/, "");
            let shortName;
            const vsMatch = url.match(/https?:\/\/(\w+)\.visualstudio\.com/i);
            const devMatch = url.match(/https?:\/\/dev\.azure\.com\/(\w+)/i);
            if (vsMatch) shortName = vsMatch[1];
            else if (devMatch) shortName = devMatch[1];

            if (shortName) {
                _cachedCliOrg = { shortName, url };
                return _cachedCliOrg;
            }
        }
    } catch {
        // az CLI not available or not configured
    }

    _cachedCliOrg = null;
    return null;
}

// Sync wrapper — we can't use top-level await in the function,
// but we can use the global import since child_process is a built-in
import { execSync as _execSync } from "node:child_process";
function await_import_child_process() {
    return { execSync: _execSync };
}

function normalizeBranch(branch) {
    if (!branch) return branch;
    return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

// ─── Build Operations ───────────────────────────────────────────────

/**
 * Watch a pipeline run until completion or timeout.
 */
export async function watchBuild({ org, project, runId, branch, pipelineId, pollInterval = 30, maxWait = 300 }) {
    const startTime = Date.now();
    const maxMs = maxWait * 1000;
    const pollMs = pollInterval * 1000;
    const base = orgUrl(org);

    // If no runId, find the latest run
    if (!runId) {
        const queryParams = { "$top": "5" };
        if (pipelineId) queryParams.definitions = String(pipelineId);
        if (branch) queryParams.branchName = normalizeBranch(branch);

        const url = apiUrl(base, `${project}/_apis/build/builds`, queryParams);
        const data = await adoFetch(url);
        const runs = data.value || [];

        if (runs.length === 0) {
            return { status: "not_found", message: "No pipeline runs found." };
        }
        runId = runs[0].id;
    }

    // Poll until complete or timeout
    while (Date.now() - startTime < maxMs) {
        const url = apiUrl(base, `${project}/_apis/build/builds/${runId}`);
        const run = await adoFetch(url, { timeout: Math.min(pollMs * 0.8, 60_000) });

        if (run.status === "completed") {
            // Get timeline for failed jobs
            let failedJobs = [];
            let timelineFetchError = null;
            try {
                const tlUrl = apiUrl(base, `${project}/_apis/build/builds/${runId}/timeline`);
                const timeline = await adoFetch(tlUrl);
                failedJobs = (timeline.records || [])
                    .filter((r) => r.type === "Job" && r.result === "failed")
                    .map((r) => ({ id: r.id, name: r.name, result: r.result }));
            } catch (e) {
                failedJobs = [];
                timelineFetchError = `Timeline unavailable: ${e.message}`;
            }

            return {
                status: "completed",
                conclusion: run.result, // succeeded, failed, canceled
                runId: run.id,
                runUrl: run._links?.web?.href || `${base}/${project}/_build/results?buildId=${run.id}`,
                name: run.definition?.name,
                branch: run.sourceBranch?.replace("refs/heads/", ""),
                failedJobs,
                ...(timelineFetchError ? { timelineFetchError } : {}),
            };
        }

        await sleep(pollMs);
        if (Date.now() - startTime >= maxMs) break;
    }

    // Timeout
    const url = apiUrl(base, `${project}/_apis/build/builds/${runId}`);
    const current = await adoFetch(url);

    return {
        status: "timeout",
        currentStatus: current.status,
        runId: current.id,
        runUrl: current._links?.web?.href || `${base}/${project}/_build/results?buildId=${current.id}`,
        message: `Build still ${current.status} after ${maxWait}s. Use build_check_status to resume polling.`,
    };
}

/**
 * Get failure logs from failed tasks in a pipeline run.
 */
export async function getFailureLogs({ org, project, runId }) {
    const base = orgUrl(org);

    // Get timeline
    let timeline;
    try {
        const tlUrl = apiUrl(base, `${project}/_apis/build/builds/${runId}/timeline`);
        timeline = await adoFetch(tlUrl);
    } catch (e) {
        return { runId, jobs: [], error: `Failed to fetch timeline: ${e.message}` };
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
        if (task.log?.id) {
            try {
                const logUrl = apiUrl(base, `${project}/_apis/build/builds/${runId}/logs/${task.log.id}`);
                const logData = await adoFetch(logUrl);
                // Log endpoint returns { value: [...lines] } or can be plain text
                if (Array.isArray(logData.value)) {
                    logContent = logData.value.join("\n");
                } else if (typeof logData === "string") {
                    logContent = logData;
                } else {
                    logContent = JSON.stringify(logData);
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

    const runUrl = `${base}/${project}/_build/results?buildId=${runId}`;
    return { runId, runUrl, jobs: jobDetails };
}

/**
 * Trigger a pipeline run on a branch.
 */
export async function triggerBuild({ org, project, pipelineId, branch }) {
    const base = orgUrl(org);
    const branchRef = normalizeBranch(branch);

    try {
        const url = apiUrl(base, `${project}/_apis/build/builds`);
        const result = await adoFetch(url, {
            method: "POST",
            body: {
                definition: { id: parseInt(pipelineId, 10) },
                sourceBranch: branchRef,
            },
        });
        return { runId: result.id, status: result.status, triggered: true };
    } catch (e) {
        return { triggered: false, error: `Failed to trigger pipeline: ${e.message}` };
    }
}

/**
 * Open a pull request on Azure DevOps via REST API.
 */
export async function openPullRequest({ org, project, repo, branchName, baseBranch, title, body }) {
    const base = orgUrl(org);
    const sourceBranch = normalizeBranch(branchName);
    const targetBranch = normalizeBranch(baseBranch);

    const url = apiUrl(base, `${project}/_apis/git/repositories/${repo}/pullrequests`);
    const result = await adoFetch(url, {
        method: "POST",
        body: {
            sourceRefName: sourceBranch,
            targetRefName: targetBranch,
            title,
            description: body,
        },
    });

    return {
        prId: result.pullRequestId,
        prUrl: result.url || `${base}/${project}/_git/${repo}/pullrequest/${result.pullRequestId}`,
    };
}

/**
 * Check PR status on ADO via REST API.
 * Uses the project-level PR endpoint (by ID, no repo needed).
 */
export async function checkPRStatus({ org, project, repo, prId }) {
    const base = orgUrl(org);

    // Use repo-scoped endpoint since we have repo available
    const url = apiUrl(base, `${project}/_apis/git/repositories/${repo}/pullrequests/${prId}`);
    const pr = await adoFetch(url);

    const merged = pr.status === "completed" && pr.mergeStatus === "succeeded";
    return {
        prId: pr.pullRequestId,
        prUrl: pr.url || `${base}/${project}/_git/${repo || "unknown"}/pullrequest/${pr.pullRequestId}`,
        state: pr.status, // active, completed, abandoned
        merged,
        mergeSha: pr.lastMergeCommit?.commitId || null,
    };
}

/**
 * Wait for PR merge — bounded wait.
 */
export async function waitForPRMerge({ org, project, repo, prId, pollInterval = 60, maxWait = 300 }) {
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
