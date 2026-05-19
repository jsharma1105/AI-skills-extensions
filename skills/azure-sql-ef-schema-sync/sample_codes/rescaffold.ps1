#!/usr/bin/env pwsh
# rescaffold.ps1
# Run this script from the infrastructure/data project directory whenever
# the Azure SQL schema changes. Updates all EF Core entity files.

param(
    [string]$Project       = ".",                    # Path to the .csproj with DbContext
    [string]$StartupProject = "../MyApp.Api",         # Path to the startup project
    [string]$OutputDir     = "Models",
    [string]$ContextDir    = "Data",
    [string]$ContextName   = "AppDbContext",
    [string[]]$Tables      = @()                      # Empty = all tables
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Build the scaffold arguments
$scaffoldArgs = @(
    "ef", "dbcontext", "scaffold",
    "Name=ConnectionStrings:DefaultConnection",
    "Microsoft.EntityFrameworkCore.SqlServer",
    "--project", $Project,
    "--startup-project", $StartupProject,
    "--output-dir", $OutputDir,
    "--context-dir", $ContextDir,
    "--context", $ContextName,
    "--no-onconfiguring",
    "--force"
)

# Add table filters if specified
foreach ($table in $Tables) {
    $scaffoldArgs += "--table"
    $scaffoldArgs += $table
}

Write-Host "Re-scaffolding EF Core entities..." -ForegroundColor Cyan
dotnet @scaffoldArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "Scaffold failed. Check connection string and EF Core tools version."
    exit 1
}

Write-Host "`nScaffold complete. Checking for compilation errors..." -ForegroundColor Cyan

# Build the solution to find broken references
dotnet build (Split-Path $Project -Parent) 2>&1 | Where-Object { $_ -match "error CS" }

Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "  1. Review: git diff -- $OutputDir/" -ForegroundColor White
Write-Host "  2. Fix any 'error CS' above in consuming projects" -ForegroundColor White
Write-Host "  3. Update unit test builders and fixtures" -ForegroundColor White
Write-Host "  4. Run: dotnet test" -ForegroundColor White
