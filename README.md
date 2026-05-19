# AI Skills & Extensions

Custom [GitHub Copilot CLI](https://docs.github.com/en/copilot) skills and extensions for .NET/Azure development workflows.

## ✨ First-Run Configuration

All skills prompt for your environment-specific settings on first use — no hardcoded values. Configuration is saved to `~/.copilot/skills/<skill-name>/config.json` and reused on subsequent invocations. Say "reconfigure" to re-prompt at any time.

## 📁 Structure

```
├── skills/                  # Copilot CLI Skills (SKILL.md-based)
│   ├── ado-workitem-creator/    # Create ADO User Stories from LLDs
│   └── azure-sql-ef-schema-sync/ # Propagate Azure SQL schema changes to EF Core projects
├── extensions/              # Copilot CLI Extensions (JavaScript-based tools)
│   └── build-autofix/           # Watch CI pipelines, investigate failures, auto-fix & PR
└── README.md
```

## 🛠 Skills

### ado-workitem-creator
Create Azure DevOps User Stories for team backlogs. Accepts LLD descriptions and converts them into properly formatted work items.

**First-run prompts:** ADO org URL, project, area path, iteration, default assignee email.

**Install:** Copy `skills/ado-workitem-creator/` to `~/.copilot/skills/ado-workitem-creator/`

### azure-sql-ef-schema-sync
Propagate Azure SQL schema changes (add/remove columns, updated relations/views) to all EF Core consuming projects. Covers re-scaffolding, NuGet package pipeline, and downstream code + test fixes.

**First-run prompts:** GitHub org, models repo name, scaffold script path, SQL server/database, ADO org/project, NuGet feed/package name, pipeline ID, workspace root.

**Install:** Copy `skills/azure-sql-ef-schema-sync/` to `~/.copilot/skills/azure-sql-ef-schema-sync/`

## 🔧 Extensions

### build-autofix
Watch CI/CD pipelines (GitHub Actions or Azure DevOps), investigate failures, apply fixes, and open PRs — all automated. Supports retry loops with configurable max attempts.

**Features:**
- Auto-detect platform (GitHub/ADO) from git remote
- Watch pipeline runs and poll until completion
- Investigate failure logs with structured error summaries
- Create fix branches, commit changes, and open PRs
- Full retry loop orchestration

**Install:** Copy `extensions/build-autofix/` to `~/.copilot/extensions/build-autofix/`

See [extensions/build-autofix/README.md](extensions/build-autofix/README.md) for detailed usage.

## 📦 Installation

1. Clone this repo
2. Copy the desired skill/extension folder to your `~/.copilot/skills/` or `~/.copilot/extensions/` directory
3. Restart Copilot CLI — the skill/extension will be available immediately
4. On first use, you'll be prompted to configure environment-specific settings

## 📄 License

MIT
