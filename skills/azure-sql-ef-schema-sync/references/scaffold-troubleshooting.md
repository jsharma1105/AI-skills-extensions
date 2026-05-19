# ScaffoldDb.ps1 — Troubleshooting & Reference

> **Note:** All paths, server names, and database names below use `{{config.*}}` placeholders. These are populated from your `~/.copilot/skills/azure-sql-ef-schema-sync/config.json` collected on first run.

The scaffold script lives at:
```
{{config.models_repo_name}}\{{config.scaffold_script_path}}
```

Run from the **repo root**:
```powershell
.\{{config.scaffold_script_path}}
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-SkipBuild` | `$false` | Skip the internal `dotnet build` step. Used by MSBuild to avoid recursive loops. |

## What It Scaffolds

- **Schemas:** as configured in the script (e.g., `dbo`, `trng`, `stg`, etc.)
- **Output:** `Models/*.cs` + `AppDbContext.cs`
- **Flags used:** `--use-database-names`, `--no-pluralize`, `--no-onconfiguring`, `--force`

## Database Connection

- **Server:** `{{config.sql_server}}`
- **Database:** `{{config.sql_database}}`
- **Auth:** `Active Directory Default` (uses your Azure AD / `az login` credentials — no password)

---

## Common Errors

### ❌ Authentication failure / cannot connect

```
Microsoft.Data.SqlClient.SqlException: Login failed for user '<token-identified principal>'
```

**Fix:**
```bash
az login
# or in Visual Studio: Tools → Options → Azure Service Authentication → sign in
```
Ensure your Azure AD account has `db_datareader` on `{{config.sql_database}}`.

---

### ❌ dotnet ef not found

```
'dotnet-ef' was not found
```

**Fix:** The script auto-installs it, but if it still fails:
```bash
dotnet tool install --global dotnet-ef
# Then restart your terminal
```

---

### ❌ Build fails before scaffold runs

```
Build FAILED. Cannot proceed with scaffolding.
```

**Fix:** Fix any existing compile errors in the project first:
```bash
dotnet build
```

---

### ❌ Firewall / network blocked

```
A network-related or instance-specific error occurred
```

**Fix:** You must be on the corporate network or connected via VPN. The Azure SQL server has IP firewall rules.

---

### ❌ Script runs but no files changed

The DB schema may not have been deployed yet to the **test** database. Verify with the DB team that the migration was applied to `{{config.sql_database}}`.

---

## Running Manually Without the Script

If the script fails, run the scaffold command directly:

```powershell
dotnet ef dbcontext scaffold `
    "Server={{config.sql_server}},1433;Initial Catalog={{config.sql_database}};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Default;" `
    Microsoft.EntityFrameworkCore.SqlServer `
    --output-dir Models `
    --context AppDbContext `
    --context-dir . `
    --use-database-names `
    --no-pluralize `
    --no-onconfiguring `
    --force `
    --schema "dbo" `
    --no-build
```

> **Note:** Add `--schema` and `--table` flags as needed for your project's schemas.

---

## Visual Studio Auto-Scaffold on Build

The `.csproj` is configured to run `ScaffoldDb.ps1 -SkipBuild` automatically after every **local Visual Studio build** (not CI):

```xml
<Target Name="RunDbScaffold" AfterTargets="Build"
  Condition=" '$(RunScaffoldOnBuild)' == 'true'
           and '$(BuildingInsideVisualStudio)' == 'true'
           and '$(ContinuousIntegrationBuild)' != 'true'
           and '$(CI)' != 'true'
           and '$(TF_BUILD)' != 'True' ">
```

To **disable** auto-scaffold in VS: set `<RunScaffoldOnBuild>false</RunScaffoldOnBuild>` in your `.csproj` locally.


## Full Command Reference

```bash
dotnet ef dbcontext scaffold <CONNECTION> <PROVIDER> [options]
```

### Key Options

| Option | Short | Purpose |
|--------|-------|---------|
| `--output-dir` | `-o` | Where to put entity files |
| `--context-dir` | | Where to put the DbContext file |
| `--context` | `-c` | Name for the DbContext class |
| `--namespace` | `-n` | Namespace for entities |
| `--context-namespace` | | Separate namespace for DbContext |
| `--table` | `-t` | Only scaffold specific table(s) |
| `--schema` | | Only scaffold tables in specific schema |
| `--force` | `-f` | Overwrite existing files |
| `--no-onconfiguring` | | Suppress OnConfiguring (use DI instead) |
| `--no-pluralize` | | Disable pluralization of entity names |
| `--data-annotations` | | Use attributes instead of Fluent API |
| `--use-database-names` | | Use exact DB column names (no camelCase conversion) |

## Recommended Full Command

```bash
dotnet ef dbcontext scaffold \
  "Name=ConnectionStrings:DefaultConnection" \
  Microsoft.EntityFrameworkCore.SqlServer \
  --output-dir Models \
  --context-dir Data \
  --context AppDbContext \
  --namespace YourApp.Data.Models \
  --context-namespace YourApp.Data \
  --no-onconfiguring \
  --force
```

## Targeted Table Rescaffold

When only specific tables changed, resscaffold only those:

```bash
dotnet ef dbcontext scaffold \
  "Name=ConnectionStrings:DefaultConnection" \
  Microsoft.EntityFrameworkCore.SqlServer \
  --table dbo.Customers \
  --table dbo.Orders \
  --output-dir Models \
  --force
```

> **Note:** Scaffolding specific tables does NOT update the DbContext's `DbSet<>` properties for those tables. You may need to manually update the DbContext or rescaffold the full context.

## Scaffolding Views

Views are not scaffolded by default. To include them:

```bash
dotnet ef dbcontext scaffold "<conn>" Microsoft.EntityFrameworkCore.SqlServer \
  --table dbo.vw_CustomerSummary \
  --force
```

Scaffolded view entities have no primary key — EF Core marks them with `.HasNoKey()` in the DbContext. For views, never use `Add()`, `Update()`, or `Remove()`.

## Identifying What Changed After Rescaffold

Use git to see what EF generated differently:

```bash
git diff -- Models/
git diff -- Data/AppDbContext.cs
```

This clearly shows:
- New properties (columns added)
- Removed properties (columns dropped)
- Changed types (e.g., `int?` → `int`)
- New/removed `DbSet<>` entries
- New/removed `HasOne` / `HasMany` relationships

## Connection String Security

Never pass a literal connection string in CI/CD. Use one of:

```bash
# 1. From user secrets (local dev)
dotnet user-secrets set "ConnectionStrings:DefaultConnection" "<conn>"
dotnet ef dbcontext scaffold "Name=ConnectionStrings:DefaultConnection" ...

# 2. From environment variable
$env:ConnectionStrings__DefaultConnection = "<conn>"
dotnet ef dbcontext scaffold "Name=ConnectionStrings:DefaultConnection" ...

# 3. Managed Identity (production / CI with Azure)
# Connection string: "Server=tcp:myserver.database.windows.net,1433;Database=mydb;Authentication=Active Directory Default;"
```

## PMC (Visual Studio Package Manager Console) Equivalents

```powershell
Scaffold-DbContext "Name=ConnectionStrings:DefaultConnection" `
  Microsoft.EntityFrameworkCore.SqlServer `
  -OutputDir Models `
  -ContextDir Data `
  -Context AppDbContext `
  -NoOnConfiguring `
  -Force
```
