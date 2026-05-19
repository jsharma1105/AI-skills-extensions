# Build Auto-Fix Skill

A Copilot CLI extension that watches CI/CD builds, investigates failures, helps fix code, and raises PRs — with a configurable retry loop until the build succeeds.

**Supports both GitHub Actions and Azure DevOps pipelines.**

## Installation

This extension is installed as a **user-scoped** Copilot CLI extension. It loads automatically for all repos.

**Location:** `~/.copilot/extensions/build-autofix/`

To install manually, copy the `build-autofix/` directory to your Copilot CLI extensions folder and reload:
```
/clear
```

## Prerequisites

### For GitHub Actions
- **Priority 1 — MCP tools** (built-in, zero install):
  - `github-mcp-server-actions_get` / `actions_list` — watch builds, list runs
  - `github-mcp-server-get_job_logs` — fetch failure logs
  - `github-mcp-server-pull_request_read` — check PR status
- **Priority 2 — `gh` CLI** — fallback for read ops + required for write ops (create PR, trigger workflow)
  - Install from https://cli.github.com
  - Authenticate: `gh auth login`
  - **Not installed?** Read operations still work via MCP

### For Azure DevOps
- **Priority 1 — REST API** (zero CLI install):
  - Set `AZURE_DEVOPS_PAT` environment variable (Personal Access Token)
  - Also supports `AZURE_DEVOPS_EXT_PAT`, `SYSTEM_ACCESSTOKEN`, or `ADO_BEARER_TOKEN`
  - Required PAT scopes: `vso.build` (read), `vso.build_execute` (trigger), `vso.code_write` (PRs)
  - **All operations** (read AND write) work without az CLI
- **Priority 2 — `az` CLI** — fallback when no PAT/token is set
  - Install from https://aka.ms/install-azure-cli
  - Authenticate: `az login`
  - Install DevOps extension: `az extension add --name azure-devops`

## Provider Strategy — Tiered Fallback

Both platforms use a **tiered provider strategy** — the extension automatically selects the best available provider:

| Operation | GitHub Tier 1 | GitHub Tier 2 | ADO Tier 1 | ADO Tier 2 |
|---|---|---|---|---|
| Watch build | MCP (`actions_get`) | `build_watch_start` (gh) | REST API (PAT) | `build_watch_start` (az) |
| List runs | MCP (`actions_list`) | `build_watch_start` (gh) | REST API (PAT) | `build_watch_start` (az) |
| Get failure logs | MCP (`get_job_logs`) | `build_investigate_failure` (gh) | REST API (PAT) | `build_investigate_failure` (az) |
| Check PR status | MCP (`pull_request_read`) | `build_check_pr_status` (gh) | REST API (PAT) | `build_check_pr_status` (az) |
| Create PR | ❌ No MCP | `build_fix_and_pr` (gh) | REST API (PAT) | `build_fix_and_pr` (az) |
| Trigger workflow | ❌ No MCP | `build_trigger_workflow` (gh) | REST API (PAT) | `build_trigger_workflow` (az) |

**Result:** Both platforms can operate without any CLI installation — GitHub via MCP (read-only), ADO via REST API (full read+write).

The `build_autofix_orchestrate` tool generates a plan that includes `preferred` (MCP/REST) and `fallback` (CLI) paths for each step. The agent picks the right one based on available providers.

## Available Tools

| Tool | Description | Read-Only |
|------|-------------|-----------|
| `build_preflight` | Check providers, auth, platform detection | ✅ |
| `build_watch_start` | Watch a build run until completion/timeout | ✅ |
| `build_investigate_failure` | Fetch + analyze failure logs (secrets redacted) | ✅ |
| `build_fix_and_pr` | Create fix branch, commit, open PR with failure summary | ❌ |
| `build_check_pr_status` | Check if a PR has been merged | ✅ |
| `build_wait_for_pr_merge` | Poll PR merge status (bounded timeout) | ✅ |
| `build_trigger_workflow` | Trigger a new build on a branch | ❌ |
| `build_check_status` | Check current status of a build run | ✅ |
| `build_autofix_orchestrate` | Generate a step-by-step execution plan for the retry loop | ✅ |

## Quick Start

### Watch and fix a build (full loop)

```
Watch the build on branch 'feature/my-feature' and fix it if it fails. 
Use max 3 retries.
```

The agent will:
1. Run `build_autofix_orchestrate` to generate the execution plan
2. Run `build_preflight` to verify the environment
3. Watch the build with `build_watch_start`
4. If it fails → investigate with `build_investigate_failure`
5. Fix the code using standard edit tools
6. Create a PR with `build_fix_and_pr` (includes failure analysis in description)
7. Wait for you to review and merge the PR
8. Trigger a new build and repeat

### Watch a specific run

```
Watch build run #12345 on GitHub (owner: my-org, repo: my-app)
```

### Investigate a failure

```
Investigate the failure in ADO pipeline run 67890 
(org: mycompany, project: MyProject)
```

### Dry-run mode

```
Do a dry-run of the build auto-fix loop on branch 'main' 
with workflow 'ci.yml'
```

## Configuration

All tools accept these configuration parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `platform` | `auto` | `github`, `ado`, or `auto` (detect from git remote) |
| `poll_interval_seconds` | 60 | Seconds between status polls |
| `max_wait_seconds` | 1800 | Max seconds to wait for build/PR (30min) |
| `dry_run` | false | Simulate without side effects |

### Orchestrator-specific

| Parameter | Default | Description |
|-----------|---------|-------------|
| `min_retries` | 3 | Minimum retry attempts |
| `max_retries` | 5 | Maximum retry attempts |
| `build_timeout_seconds` | 1800 | Per-build timeout (30min) |
| `pr_wait_timeout_seconds` | 1800 | Per-PR-merge timeout (30min) |

### ADO REST API Environment Variables

| Variable | Description |
|----------|-------------|
| `AZURE_DEVOPS_PAT` | Personal Access Token (primary) |
| `AZURE_DEVOPS_EXT_PAT` | PAT used by az devops extension |
| `SYSTEM_ACCESSTOKEN` | Automatically available in ADO pipelines |
| `ADO_BEARER_TOKEN` | Explicit bearer token (audience: `499b84ac-...`) |

## Safety

- **Never auto-merges PRs** — always requires human review
- **Secrets redacted** from all log output and PR descriptions
- **Bounded polling** — no infinite loops; returns timeout status for resumption
- **Dry-run mode** — preview all actions without side effects
- **Attempt tracking** — hard stops at max_retries
- **Audit trail** — all actions logged to the session timeline

## PR Description

Auto-generated PRs include:
- Failure analysis (pipeline name, failed step, error summary)
- Fix description (what was changed and why)
- Attempt count (e.g., "Attempt 2/3")
- Files changed list
- Warning banner requiring human review

## Architecture

```
extension.mjs          ← Entry point, hooks, tool registration
├── tools.mjs          ← Tool definitions (platform-agnostic, tiered provider plans)
├── github-provider.mjs ← GitHub provider (gh CLI — fallback when MCP unavailable)
├── ado-provider.mjs   ← ADO provider facade (REST first → az CLI fallback)
├── ado-rest-provider.mjs ← ADO REST API provider (PAT/bearer, no CLI needed)
├── detect.mjs         ← Platform auto-detection
├── pr-template.mjs    ← PR description template
├── shell.mjs          ← Shell execution helpers
├── autofix-runner.mjs ← Headless runner for CI/CD pipeline integration
└── pipeline-templates/
    ├── ado-autofix-step.yml    ← ADO pipeline template
    └── github-autofix.yml      ← GitHub Actions reusable workflow

GitHub — Tiered Providers:
├── Tier 1: MCP (built-in)     ← Zero-install reads
│   ├── github-mcp-server-actions_get     ← Check build status
│   ├── github-mcp-server-actions_list    ← List runs/jobs
│   ├── github-mcp-server-get_job_logs    ← Fetch failure logs
│   └── github-mcp-server-pull_request_read ← Check PR status
└── Tier 2: gh CLI             ← Write ops + read fallback

ADO — Tiered Providers:
├── Tier 1: REST API (PAT)     ← Zero-install, full read+write
└── Tier 2: az CLI             ← Fallback when no PAT set
```

## Platform Detection

The extension auto-detects the platform from `git remote -v`:
- `github.com` → GitHub Actions
- `dev.azure.com` / `*.visualstudio.com` → Azure DevOps
- SSH variants are also supported

Override with `platform='github'` or `platform='ado'` in any tool call.

## CI/CD Pipeline Integration

Integrate build-autofix directly into your pipelines so it triggers automatically on failure.

### Azure DevOps — Pipeline Template

Add a failure stage that either notifies a developer or runs the headless runner:

```yaml
# azure-pipelines.yml
trigger:
  - main

stages:
  - stage: Build
    jobs:
      - job: BuildAndTest
        steps:
          - script: dotnet build && dotnet test

  # ← Add this stage — fires only when Build fails
  - stage: AutoFix
    dependsOn: Build
    condition: failed()
    jobs:
      - template: pipeline-templates/ado-autofix-step.yml
        parameters:
          mode: 'notify'        # 'notify' or 'headless'
          maxRetries: 3
          # serviceConnection: 'my-azure-sc'  # for headless mode
```

**Modes:**

| Mode | What Happens | Requirements |
|------|-------------|--------------|
| `notify` | Prints failure context + Copilot CLI commands | None — works on any agent |
| `headless` | Runs `autofix-runner.mjs` to investigate + open PR | Self-hosted agent with Node.js + PAT or az CLI |

The template is at `pipeline-templates/ado-autofix-step.yml`.

### GitHub Actions — Reusable Workflow

```yaml
# .github/workflows/ci.yml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  autofix:
    needs: build
    if: failure()
    uses: ./.github/workflows/autofix.yml
    with:
      mode: 'notify'
      max_retries: 3
```

The reusable workflow is at `pipeline-templates/github-autofix.yml`.

### Headless Runner (autofix-runner.mjs)

A standalone script that can be invoked from any CI/CD system:

```bash
# With PAT (no az CLI needed):
export AZURE_DEVOPS_PAT=your-pat-here
node autofix-runner.mjs \
  --org "myorg" \
  --project "MyProject" \
  --repo "my-repo" \
  --run-id "12345" \
  --branch "main" \
  --max-retries 3

# With az CLI:
node autofix-runner.mjs \
  --org "https://dev.azure.com/myorg" \
  --project "MyProject" \
  --repo "my-repo" \
  --run-id "12345" \
  --branch "main"
```

**What it does:**
1. Runs preflight check (REST API or CLI auth)
2. Fetches failure logs from the build
3. Extracts error summaries (secrets redacted)
4. Writes `autofix-context.json` with structured failure data
5. Creates a PR with failure analysis for developer review

**Flags:**

| Flag | Description |
|------|-------------|
| `--platform` | `github`, `ado`, or `auto` (default: auto-detect from env) |
| `--owner` | GitHub repo owner |
| `--repo` | Repository name |
| `--org` | ADO organization name or URL |
| `--project` | ADO project name |
| `--run-id` | Failed build run ID (required) |
| `--pipeline-id` | ADO pipeline definition ID |
| `--workflow-id` | GitHub workflow filename |
| `--branch` | Source branch name |
| `--max-retries` | Max fix attempts (default: 3) |
| `--dry-run` | Print what would happen without making changes |

**Output variables** (set automatically in pipelines):
- ADO: `autofixPrId`, `autofixPrUrl` (pipeline output variables)
- GitHub: `pr_id`, `pr_url` (step outputs via `$GITHUB_OUTPUT`)

### Recommended Approach

Start with **notify mode** (zero risk, human drives the fix):

```
Stage fails → Notify stage prints context → Developer opens Copilot CLI → Says "fix build 12345"
```

Graduate to **headless mode** once you trust the analysis quality:

```
Stage fails → Runner investigates → Opens PR with analysis → Developer reviews + applies fix
```
