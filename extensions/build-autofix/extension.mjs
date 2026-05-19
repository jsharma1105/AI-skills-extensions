// Extension: build-autofix
// Watch builds, investigate failures, auto-fix code, raise PRs, retry until success.
// Supports GitHub Actions and Azure DevOps pipelines.

import { joinSession } from "@github/copilot-sdk/extension";
import { allTools } from "./tools.mjs";
import { detectPlatform, getCurrentBranch } from "./detect.mjs";

const session = await joinSession({
    tools: allTools,
    hooks: {
        onSessionStart: async (input) => {
            // Detect platform and inject context
            let platformInfo = "";
            let detected = { platform: "unknown" };
            try {
                detected = await detectPlatform(input.cwd);
                const branch = await getCurrentBranch(input.cwd);
                if (detected.platform === "github") {
                    platformInfo = `Detected GitHub repo: ${detected.owner}/${detected.repo} (branch: ${branch}).`;
                } else if (detected.platform === "ado") {
                    platformInfo = `Detected Azure DevOps repo: ${detected.org}/${detected.project}/${detected.repo} (branch: ${branch}).`;
                } else {
                    platformInfo = "Could not auto-detect platform. Specify platform='github' or platform='ado' when using build tools.";
                }
            } catch {
                platformInfo = "Platform detection skipped (not in a git repo).";
            }

            await session.log("Build auto-fix skill loaded");

            return {
                additionalContext: `## Build Auto-Fix Skill Available

${platformInfo}

### Provider Strategy
${detected.platform === "github" ? `**GitHub detected — MCP-first approach:**
- **Read operations** (watch build, get logs, check PR): Use built-in MCP tools directly:
  - \`github-mcp-server-actions_get\` (method: get_workflow_run) — check build status
  - \`github-mcp-server-actions_list\` (method: list_workflow_runs / list_workflow_jobs) — find runs, list jobs
  - \`github-mcp-server-get_job_logs\` — fetch failure logs (use return_content=true, failed_only=true)
  - \`github-mcp-server-pull_request_read\` (method: get) — check PR merge status
- **Write operations** (create PR, trigger build): Use extension tools (requires gh CLI):
  - \`build_fix_and_pr\` — create branch, commit, push, open PR
  - \`build_trigger_workflow\` — trigger workflow_dispatch
- **No gh CLI?** You can still watch builds and investigate failures via MCP. Only PR creation and workflow triggers need the gh CLI.`
: detected.platform === "ado" ? `**Azure DevOps detected — REST API first, az CLI fallback:**
- **Priority 1: REST API** — Set \`AZURE_DEVOPS_PAT\` env var for zero-CLI operation:
  - All read AND write operations work via REST API (build status, logs, PRs, triggers)
  - No \`az\` CLI installation needed
  - Also supports \`AZURE_DEVOPS_EXT_PAT\`, \`SYSTEM_ACCESSTOKEN\`, or \`ADO_BEARER_TOKEN\`
- **Priority 2: az CLI** — Fallback when no PAT/token is set:
  - Requires \`az\` CLI installed and authenticated: \`az login\`
  - Requires azure-devops extension: \`az extension add --name azure-devops\`
- Extension tools automatically try REST first, fall back to az CLI.`
: "Specify platform explicitly when using build tools."}

### Available Build Tools
You have access to these tools for watching, investigating, and fixing build failures:

1. **build_preflight** — Check CLI tools, auth, MCP availability, platform detection. Run first.
2. **build_watch_start** — Watch a pipeline run until it completes or times out (bounded). GitHub: prefer MCP.
3. **build_investigate_failure** — Fetch and analyze failure logs (secrets redacted). GitHub: prefer MCP.
4. **build_fix_and_pr** — After fixing code, create branch + commit + PR with failure summary. Requires CLI.
5. **build_check_pr_status** — Check if a PR has been merged. GitHub: prefer MCP.
6. **build_wait_for_pr_merge** — Poll PR merge status (bounded timeout). GitHub: prefer MCP.
7. **build_trigger_workflow** — Trigger a new build on a branch. Requires CLI.
8. **build_check_status** — Check current status of a build run. GitHub: prefer MCP.
9. **build_autofix_orchestrate** — Generate a step-by-step plan with MCP-preferred tools for GitHub.

### Recommended Workflow (Build Fix Loop)
Call **build_autofix_orchestrate** first — it generates a plan that prefers MCP tools for GitHub read operations and falls back to extension tools when MCP is unavailable.

### Configuration Defaults
- poll_interval: 60s (1min) | max_wait (build): 1800s (30min) | max_wait (PR): 1800s (30min)
- All tools support dry_run=true for simulation
- All mutating tools log their actions

### Safety Rules
- NEVER auto-merge PRs — always require human approval
- PR descriptions include sanitized failure analysis (secrets redacted)
- All operations are bounded (no infinite polling)
- Use dry_run=true to preview actions before executing
`,
            };
        },

        onErrorOccurred: async (input) => {
            // Retry transient failures (rate limits, network issues) for read-only operations
            if (input.recoverable && input.errorContext === "tool_execution") {
                const errorMsg = input.error || "";
                const isTransient = /rate limit|429|502|503|timeout|ETIMEDOUT|ECONNRESET/i.test(errorMsg);
                if (isTransient) {
                    return {
                        errorHandling: "retry",
                        retryCount: 2,
                        userNotification: "Transient API error detected. Retrying...",
                    };
                }
            }
            return undefined; // Default handling
        },
    },
});

