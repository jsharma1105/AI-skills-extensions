---
name: azure-sql-ef-schema-sync
description: Propagate Azure SQL schema changes (add/remove columns, updated relations/views) to all EF Core consuming projects. Use when a database table or view structure changes and you need to update entity classes, DbContext, business logic, and unit tests across a .NET solution. Covers re-scaffolding via ScaffoldDb.ps1, ADO NuGet package pipeline, impact-scoped NuGet updates with git merge, and downstream code + test fixes.
---

# Azure SQL → EF Core Schema Sync (AppModelsDB Workflow)

When a column, table, or view changes in the Azure SQL database, follow this workflow exactly.

> ⚠️ **If you are stuck or unsure at any step — DO NOT assume or guess. Stop and ask the user.**

---

## First-Run Configuration

On the **first invocation** (or when `~/.copilot/skills/azure-sql-ef-schema-sync/config.json` is missing), collect all configuration from the user using `ask_user`:

```
ask_user:
  message: "I need to configure the Azure SQL EF Core Schema Sync skill for your environment."
  fields:
    - github_org: (string) GitHub organization for the models repo (e.g., my-org)
    - models_repo_name: (string) Repository name for EF Core models (e.g., AppModelsDB)
    - scaffold_script_path: (string) Relative path to ScaffoldDb.ps1 inside the models repo (e.g., PKG_App.Models/App.Models/DevelopmentHelpers/ScaffoldDb.ps1)
    - sql_server: (string) Azure SQL server name (e.g., myapp-test.database.windows.net)
    - sql_database: (string) Azure SQL database name (e.g., myapp-testdb)
    - ado_org_url: (string) ADO organization URL (e.g., https://dev.azure.com/myorg)
    - ado_project: (string) ADO project name (e.g., MyProject)
    - nuget_feed_name: (string) NuGet feed name in ADO artifacts (e.g., InternalFeed)
    - nuget_package_name: (string) Full NuGet package name (e.g., MyCompany.App.Models)
    - pipeline_definition_id: (string) ADO pipeline definition ID for publishing the package (e.g., 15098)
    - workspace_root: (string) Root path where all repos are cloned (e.g., C:\Projects)
```

Save to `~/.copilot/skills/azure-sql-ef-schema-sync/config.json`:

```json
{
  "github_org": "my-org",
  "models_repo_name": "AppModelsDB",
  "scaffold_script_path": "PKG_App.Models/App.Models/DevelopmentHelpers/ScaffoldDb.ps1",
  "sql_server": "myapp-test.database.windows.net",
  "sql_database": "myapp-testdb",
  "ado_org_url": "https://dev.azure.com/myorg",
  "ado_project": "MyProject",
  "nuget_feed_name": "InternalFeed",
  "nuget_package_name": "MyCompany.App.Models",
  "pipeline_definition_id": "15098",
  "workspace_root": "C:\\Projects"
}
```

On subsequent invocations, read from `config.json`. If user says "reconfigure", re-prompt.

**Use `{{config.*}}` placeholders below — substitute from config at runtime.**

---

## Step 0 — Verify Models Repo Is Cloned

The EF Core models live in the **{{config.models_repo_name}}** repository.

**GitHub URL:** `https://github.com/{{config.github_org}}/{{config.models_repo_name}}`

```powershell
# Check if already cloned somewhere on the machine
Get-ChildItem -Path "{{config.workspace_root}}" -Recurse -Filter "ScaffoldDb.ps1" -Depth 6 -ErrorAction SilentlyContinue
```

If **not found**, stop and ask the user:
> "The {{config.models_repo_name}} repo does not appear to be cloned on this machine. Please clone it with `git clone https://github.com/{{config.github_org}}/{{config.models_repo_name}}.git` and re-run."

**Do not proceed until the repo is confirmed cloned.**

---

## Step 1 — Run ScaffoldDb.ps1

Navigate to the root of the cloned `{{config.models_repo_name}}` repo, then run:

```powershell
.\{{config.scaffold_script_path}}
```

### What the script does automatically
- Checks `dotnet ef` is installed (installs it globally if missing)
- Builds the project
- Connects to `{{config.sql_server}}` using **Active Directory Default** auth (your `az login` / VS credentials — no password)
- Re-scaffolds schemas (as configured in the script)
- Overwrites `Models/*.cs` and `AppDbContext.cs` with the latest schema

### Prerequisites
- Logged in to Azure AD: `az login`
- Your account has `db_datareader` on `{{config.sql_database}}`
- On VPN / corporate network

### If the script fails
See [references/scaffold-troubleshooting.md](references/scaffold-troubleshooting.md). **Do not guess at fixes — ask the user if the error isn't covered there.**

---

## Step 2 — Review What Changed

```powershell
git diff -- PKG_MyApp.AppEmployeeDB.Models/MyApp.AppEmployeeDB.Models/Models/
git diff -- PKG_MyApp.AppEmployeeDB.Models/MyApp.AppEmployeeDB.Models/AppDbContext.cs
```

Note the exact entity name(s) and property name(s) that changed — you'll need this for the impact scan in Step 5.

### Also Check View Entities After Any Column Addition

If a **column was added** to a table, check whether any scaffolded view entities reference that table and whether they also received the new column.

```powershell
# Diff all view entity files (EF Core scaffolds views as [Keyless] classes)
git diff -- PKG_MyApp.AppEmployeeDB.Models/MyApp.AppEmployeeDB.Models/Models/V*.cs

# Also search for any Keyless entity that may not follow the V* naming convention
git diff -- PKG_MyApp.AppEmployeeDB.Models/MyApp.AppEmployeeDB.Models/Models/ |
    Select-String "\[Keyless\]" -Context 0,5
```

**Expected outcome:** If the underlying SQL view definition includes the new column (e.g. via `SELECT *` or explicit column list that was updated), the scaffolded view entity class will show the new property in the diff.

**If a view entity is NOT updated but its SQL view references the changed table:**

- The view's SQL definition in Azure SQL has not yet been updated by a DBA to include the new column.
- After the view SQL is updated in the database, **re-run `ScaffoldDb.ps1`** (back to Step 1) to pick up the change.
- **Do not manually add properties to view entity classes** — the scaffold is the authoritative source of truth.

> ⚠️ If you find a view that logically depends on the new column but its entity class was not updated, **stop and ask the user** whether the view SQL has been updated in the database before proceeding.

---

## Step 3 — Commit and Push on the Working Branch

```powershell
# Confirm you're on the right branch (NOT main)
git branch --show-current
```

If on `main`, ask the user which feature/working branch to use before continuing.

```bash
git add PKG_MyApp.AppEmployeeDB.Models/MyApp.AppEmployeeDB.Models/Models/
git add PKG_MyApp.AppEmployeeDB.Models/MyApp.AppEmployeeDB.Models/AppDbContext.cs
git commit -m "chore: rescaffold EF models after schema change to <table-name>"
git push origin <working-branch>
```

---

## Step 4 — Run the ADO Pipeline & Determine New Version

### 4a — Find the Latest Published Version in the NuGet Feed

Query the {{config.nuget_feed_name}} feed for the latest `{{config.nuget_package_name}}` version:

```powershell
# Requires az devops CLI configured with your org
az artifacts universal list `
  --organization "{{config.ado_org_url}}" `
  --project "{{config.ado_project}}" `
  --feed "{{config.nuget_feed_name}}" `
  --package-name "{{config.nuget_package_name}}" 2>&1 | Select-Object -First 20
```

Or using dotnet:
```powershell
dotnet package search "{{config.nuget_package_name}}" `
  --source "{{config.ado_org_url}}/{{config.ado_project}}/_packaging/{{config.nuget_feed_name}}/nuget/v3/index.json" `
  --prerelease | Select-Object -First 10
```

Or browse directly: [{{config.nuget_feed_name}} feed]({{config.ado_org_url}}/{{config.ado_project}}/_artifacts/feed/{{config.nuget_feed_name}})

> If the CLI commands fail, ask the user to open the feed link above and share the latest version number.

### 4b — Calculate the New Version

Take the latest **stable** version (e.g., `0.24.5`) and increment the **patch** by 1:

```
0.24.5  →  0.24.6
0.32.0  →  0.32.1
1.0.0   →  1.0.1
```

> ⚠️ Do NOT increment based on prerelease versions — always find the latest **stable** version and add 1 to the patch number.

Because the pipeline runs from a **feature/working branch** (not `main`), the published package will be a **prerelease**:
```
0.24.6-alpha.20260415181200   ← what the pipeline will publish
```
The base version `0.24.6` must be set in the pipeline or the `.csproj` before running — ask the user how version is controlled in this repo's pipeline if unsure.

### 4c — Run the ADO Pipeline

Try automatically via the `az pipelines` CLI:

```powershell
# Configure your ADO org/project once
az devops configure --defaults organization="{{config.ado_org_url}}" project="{{config.ado_project}}"

# Get the current branch of the models repo
$branch = git -C "<path-to-models-repo>" branch --show-current

# Run pipeline definition {{config.pipeline_definition_id}} on that branch
az pipelines run `
  --id {{config.pipeline_definition_id}} `
  --branch $branch `
  --org "{{config.ado_org_url}}" `
  --project "{{config.ado_project}}"
```

Pipeline URL: {{config.ado_org_url}}/{{config.ado_project}}/_build?definitionId={{config.pipeline_definition_id}}

> If `az pipelines` is not available or the command fails, ask the user to open the pipeline URL above, click **Run pipeline**, select the working branch, and share the new package version when it completes.

### 4d — Wait for the Pipeline and Get the Exact Version

After the pipeline succeeds, get the exact prerelease version published:

```powershell
dotnet package search "{{config.nuget_package_name}}" `
  --source "{{config.ado_org_url}}/{{config.ado_project}}/_packaging/{{config.nuget_feed_name}}/nuget/v3/index.json" `
  --prerelease | Select-String "0.24.6"
```

Note the full version string (e.g., `0.24.6-alpha.20260415181200`) — you'll use this in Step 6.

---

## Step 5 — Impact Analysis: Find Only Affected Consuming Repos

**Do not update all consumers.** Only update repos where code actually references the changed entity or column.

```powershell
# Replace with the entity name that changed (e.g., carryoverroster, teamname_availability)
$changedEntity = "<entity-name>"

# Scan all local repos for references
Get-ChildItem -Recurse -Filter "*.cs" -Path "{{config.workspace_root}}" |
    Select-String $changedEntity -SimpleMatch |
    Where-Object { $_.Path -notmatch "{{config.models_repo_name}}" } |
    Select-Object Path -Unique
```

From the results, identify which `.csproj` files (repos) are impacted. Cross-reference against the known consumer list:

| Project (.csproj) | Repo folder |
|-------------------|-------------|
| `AppCarryOverRosters.csproj` | `AppProviderScheduling` |
| `QualMgrDBApi.csproj` | `AppProviderMgr` |
| `QualMgrApi.csproj` | `AppProviderMgr` |
| `AppEmployeeLookupApi.csproj` | `AppLookupAPI` |
| `TeamNameProfileApi.csproj` | `AppLookupAPI` |
| `TeamNamePositionQualificationStatus.csproj` | `AppLookupAPI` |
| `AppPlannedActivitySync.csproj` | `AppLookupAPI` |
| `AppHcmSyncFunction.csproj` | `AppLookupAPI` |
| `TransactionTableWatchSync.csproj` | `AppLookupAPI` |
| `AppSchedulerMgr.csproj` | `AppScheduler` |
| `cmsteamnamescheduler.csproj` | `AppScheduler` |
| `AppUserQualsSync.Infrastructure.csproj` | `apptraining` |
| `AppStatusSyncFunction.csproj` | `apptraining` |
| `AppPersonSyncFunction.csproj` | `apptraining` |
| `AppLogBook.csproj` | `apptraining` |
| `AppAvailabilitySync.Function.csproj` | `apptraining` |
| `AppCertificate.csproj` | `apptraining` |
| `Cmsgraphapi.csproj` | `CmsGraphApi` |
| `Pilot.PlannedAbsence.WebService.csproj` | `PlannedAbsence.WebService` |

**Only proceed with repos that appear in the scan results.**

> If you are unsure whether a repo is impacted, **ask the user — do not guess.**

---

## Step 6 — Update NuGet Version in Each Impacted Repo

For **each impacted repo**, follow this sequence:

### 6a — Pull Latest from Main First

```bash
cd <repo-root>
git fetch origin
git checkout main
git pull origin main
git checkout -b feature/update-ef-models-<entity>-<date>
```

### 6b — Resolve Any Merge Conflicts

If there are conflicts after pulling main:

```bash
git status   # shows conflicted files
```

For each conflicted file:
1. Open the file and look for `<<<<<<`, `=======`, `>>>>>>>`
2. Resolve by keeping the correct version
3. `git add <file>` after resolving

> If you encounter a conflict you are not sure how to resolve, **stop and ask the user** which version to keep. Never auto-resolve logic conflicts.

### 6c — Update the Package Version in .csproj

```xml
<!-- Before -->
<PackageReference Include="{{config.nuget_package_name}}" Version="0.32.0" />

<!-- After — use the exact prerelease version from Step 4d -->
<PackageReference Include="{{config.nuget_package_name}}" Version="0.24.6-alpha.20260415181200" />
```

> ⚠️ **Include the full prerelease suffix** (e.g., `-alpha.20260415181200`). The feature branch pipeline publishes prerelease packages. Omitting the suffix will fail to resolve the package.

Ensure `nuget.config` in the repo includes the **{{config.nuget_feed_name}}** feed and has `includePrerelease` support:

```xml
<configuration>
  <packageSources>
    <add key="{{config.nuget_feed_name}}" value="{{config.ado_org_url}}/{{config.ado_project}}/_packaging/{{config.nuget_feed_name}}/nuget/v3/index.json" />
  </packageSources>
</configuration>
```

### 6d — Restore Packages

```bash
dotnet restore
```

---

## Step 7 — Build to Surface All Errors

```bash
dotnet build 2>&1 | Select-String "error CS"
```

Common errors and fixes:

| Error | Cause | Fix |
|-------|-------|-----|
| `CS0117: does not contain definition for 'OldColumn'` | Removed column still referenced | Remove all usages |
| Object initializer missing required property | Non-nullable column added | Add `NewColumn = <default>` to all `new Entity { }` blocks |
| `CS1061: 'Entity' does not contain 'NavProp'` | Relation dropped | Remove `.Include(x => x.NavProp)` |
| `NU1102: Unable to find package` | Package not yet published / feed not configured | Verify pipeline succeeded and nuget.config has {{config.nuget_feed_name}} |

> If you hit an error not listed here, **ask the user** before making changes to fix it.

---

## Step 8 — Fix Business Logic & Unit Tests

See [references/testing-patterns.md](references/testing-patterns.md) for full patterns.

**Column added (nullable):** No compile errors — no initializer changes required.

**Column added (non-nullable):** Add the new property to all `new Entity { }` initializers in production code and test fixtures.

**View entity updated (column added to underlying SQL view):** The scaffolded view entity automatically includes the new property. Find any explicit projection mappings that need updating:

```powershell
# Replace ViewEntityName with the actual class name (e.g., VTeamNameAvailability)
$viewEntity = "<ViewEntityName>"

Get-ChildItem -Recurse -Filter "*.cs" -Path "C:\AppDomain" |
    Select-String $viewEntity -SimpleMatch |
    Where-Object { $_.Path -notmatch "AppModelsDB" } |
    Select-Object Path, LineNumber, Line
```

For each hit, update:
- `AutoMapper` profile `CreateMap<ViewEntityName, Dto>()` — add `.ForMember(dest => dest.NewColumn, opt => opt.MapFrom(src => src.NewColumn))`
- Manual `Select(x => new Dto { ... })` projections — add `NewColumn = x.NewColumn`
- Test fixture builders / mock data — add the new property with a sensible test value

> If a view entity is missing the new column after scaffolding, the SQL view definition was not updated. See the **Step 2 — Also Check View Entities** section and ask the user before proceeding.

**Column removed:** Find and remove all references:

```powershell
Get-ChildItem -Recurse -Filter "*.cs" |
    Select-String "\.OldColumnName" |
    Select-Object Path, LineNumber, Line
```

---

## Step 9 — Commit and Push Each Impacted Repo

```bash
git add .
git commit -m "chore: update {{config.nuget_package_name}} to <new-version> for <entity> schema change"
git push origin feature/update-ef-models-<entity>-<date>
```

Then open a PR in each repo targeting `main`.

---

## Step 10 — Final Verification Per Repo

```bash
dotnet build
dotnet test --no-build
```

---

## CLI Alternative for Learn MCP Tools

| MCP Tool | CLI Command |
|----------|-------------|
| `microsoft_docs_search(query: "...")` | `npx @microsoft/learn-cli search "..."` |
| `microsoft_docs_fetch(url: "...")` | `npx @microsoft/learn-cli fetch "..."` |

---

## Learn More

| Topic | Reference |
|-------|-----------|
| ScaffoldDb.ps1 errors | `references/scaffold-troubleshooting.md` |
| Test update patterns | `references/testing-patterns.md` |
| EF Core scaffold flags | `microsoft_docs_fetch(url="https://learn.microsoft.com/ef/core/cli/dotnet#dotnet-ef-dbcontext-scaffold")` |
| Azure Artifacts NuGet feed | [{{config.nuget_feed_name}} feed]({{config.ado_org_url}}/{{config.ado_project}}/_artifacts/feed/{{config.nuget_feed_name}}) |
| az pipelines run | `microsoft_docs_search(query="az pipelines run azure devops CLI branch")` |
| ADO pipeline | [Definition {{config.pipeline_definition_id}}]({{config.ado_org_url}}/{{config.ado_project}}/_build?definitionId={{config.pipeline_definition_id}}) |
