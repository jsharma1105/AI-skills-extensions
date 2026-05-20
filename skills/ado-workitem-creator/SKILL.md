---
name: ado-workitem-creator
description: Create ADO User Stories from feature descriptions or LLDs. On first use, prompts for your ADO organization, project, area path, and assignee email. Invoke when user says "create a user story", "create a work item", "add to backlog", "log this as an ADO story", or provides an LLD/feature description and wants it turned into an ADO User Story. Do NOT invoke for Bugs, Tasks, other projects, or other area paths unless the user confirms those defaults are acceptable.
---

# ADO Work Item Creator

Creates User Stories in Azure DevOps. Formats descriptions using the LLD template, estimates story points, and sets all required fields.

## First-Run Configuration

On the **first invocation** of this skill (or when config is missing), you MUST collect the following from the user using `ask_user` before proceeding:

```
ask_user:
  message: "I need to configure the ADO Work Item Creator for your environment. Please provide your Azure DevOps details."
  fields:
    - ado_org_url: (string) Your ADO organization URL (e.g., https://dev.azure.com/myorg or https://myorg.visualstudio.com)
    - ado_project: (string) Project name (e.g., MyProject)
    - area_path: (string) Area path for work items (e.g., MyProject\MyTeam)
    - iteration_path: (string) Iteration path (e.g., MyProject or MyProject\Sprint 1)
    - default_assignee: (string) Default assignee email (e.g., user@company.com)
```

After collecting, save to `~/.copilot/skills/ado-workitem-creator/config.json`:

```json
{
  "ado_org_url": "https://myorg.visualstudio.com",
  "ado_project": "MyProject",
  "area_path": "MyProject\\MyTeam",
  "iteration_path": "MyProject",
  "default_assignee": "user@company.com"
}
```

On subsequent invocations, read from `config.json`. If the user says "reconfigure" or "update config", re-prompt.

**Use `{{config.ado_org_url}}`, `{{config.ado_project}}`, `{{config.area_path}}`, `{{config.iteration_path}}`, `{{config.default_assignee}}` as placeholders throughout this skill.**

## Defaults (from config)

| Field | Source |
|-------|--------|
| Work Item Type | User Story |
| Organization | `{{config.ado_org_url}}` |
| Project | `{{config.ado_project}}` |
| Area Path | `{{config.area_path}}` |
| Iteration | `{{config.iteration_path}}` |
| Assigned To | `{{config.default_assignee}}` |

## Creation Workflow

### Step 1 — Parse the Input

Read the user's description or LLD text. Extract:

- **Title** — a concise action phrase (e.g., "Implement Service Bus trigger for position updates"). If the user didn't provide one, derive it from the core purpose of the work.
- **Assignee** — use strict precedence: (1) explicit "assign to X" instruction, (2) "assign to me/myself" → `{{config.default_assignee}}`, (3) no instruction → default `{{config.default_assignee}}`. **Do not infer** assignee from names appearing in the LLD body (reviewers, PO names, stakeholders, Q&A participants). If ambiguous, ask.
- **In-Scope work** — what is explicitly being built.
- **Out-of-Scope** — anything explicitly excluded, or leave blank.
- **Source/Target systems** — identify data sources (SourceDb, Service Bus, SQL, HTTP) and targets (AppDomain, queues, tables).
- **Integration methods** — Azure Function triggers, API endpoints, DB change tracking, etc.

### Step 2 — Estimate Story Points (Fibonacci)

Analyze complexity signals in the description and assign a Fibonacci number: **1, 2, 3, 5, 8, 13, 21**.

Use this rubric — calibrated for Azure Function / integration work:

| Points | What it signals |
|--------|----------------|
| 1–2 | Config/mapping/doc-only change, or a tiny tweak to an existing flow (no new components) |
| 3 | Isolated code change in one existing component (e.g., update a field mapping, add a query) |
| 5 | Small new function or straightforward enhancement to an existing integration — one system, normal happy-path logic |
| 8 | New Azure Function with one integration path **including** error handling, retry logic, DLQ, secrets/config, and basic observability |
| 13 | Multi-system orchestration: e.g., Service Bus + DB + downstream API with schema/contract changes, idempotency, replay, or significant ops concerns |
| 21 | Too large for one story — spans multiple epics, services, or teams |

**If the estimate would be 21:** do NOT create a single story. Instead, stop here and decompose the input into candidate sub-stories (2–8 pts each). Present the proposed breakdown and ask the user which ones to create. This matters — a 21-point story almost always means the scope isn't clear enough to implement.

Also consider: +1 Fibonacci level if schema/contract changes are involved; +1 level if backfill/data migration is required; +1 level if cross-team coordination is explicitly needed.

Briefly state your reasoning (e.g., "New Azure Function + Service Bus trigger + AppDomain DB write + error handling = 8 pts").

### Step 3 — Format the Description and Acceptance Criteria

Build two separate HTML blobs — one for **Description** and one for **Acceptance Criteria**. Keep both simple: use only `<h3>`, `<p>`, `<ul>`, `<li>`, `<strong>`, `<br>`. No tables, styles, classes, or scripts. No raw copy-paste from Word/Confluence. Summarize — do not dump the full LLD text verbatim. Cap total description HTML at ~2000 characters.

**Description** — see [lld-template.md](references/lld-template.md) for section guidance. Use this structure:

```html
<h3>Description</h3>
<p>[What is being built and why — 2-4 sentences max]</p>

<h3>In Scope</h3>
<ul><li>[item]</li>...</ul>

<h3>Out of Scope</h3>
<p>[If explicitly mentioned; omit otherwise]</p>

<h3>Non-Functional Requirements</h3>
<ul>
  <li><strong>Performance:</strong> [if mentioned]</li>
  <li><strong>Security:</strong> [if mentioned]</li>
  <li><strong>Reliability:</strong> [retry/DLQ/error handling if applicable]</li>
</ul>

<h3>Source(s)</h3>
<p>[SourceDb tables, Service Bus queue/topic, HTTP endpoint, etc.]</p>

<h3>Target</h3>
<p>[AppDomain model/DB table, output queue, downstream API, etc.]</p>

<h3>Integration Method</h3>
<p>[Azure Function trigger type, APIM baseroute, etc.]</p>

<h3>Open Items / TODO</h3>
<p>[Any unknowns or follow-up questions; omit if none]</p>
```

**Acceptance Criteria** — draft 3–5 testable criteria based on the description. If you cannot infer them, ask before creating. Format as HTML for the `Microsoft.VSTS.Common.AcceptanceCriteria` field:

```html
<ul>
  <li>Given [context], when [action], then [outcome]</li>
  <li>Given [context], when [action], then [outcome]</li>
</ul>
```

Escape any `&`, `<`, `>` characters from user-provided text before embedding in HTML.

### Step 4 — Show a Preview and Confirm

Before creating anything in ADO, present a clear summary:

```
📋 Work Item Preview
─────────────────────────────────────────
Title:         [title]
Type:          User Story
Area Path:     {{config.area_path}}
Iteration:     {{config.iteration_path}}
Assigned To:   [email]
Story Points:  [n]  ([one-line reasoning])

Description (summary):
[first 300 chars of description HTML, stripped to plain text]

Acceptance Criteria:
• [criterion 1]
• [criterion 2]
• [criterion 3]
─────────────────────────────────────────
Create this work item? (yes / edit / cancel)
```

If the user says **edit**, ask what they want to change and update before creating.
If the user says **cancel**, stop without creating anything.
If the user says **yes** (or equivalent), proceed to Step 5.

### Step 5 — Create the Work Item

Run this command exactly:

```powershell
az boards work-item create `
  --title "[TITLE]" `
  --type "User Story" `
  --description "[HTML_DESCRIPTION]" `
  --assigned-to "[ASSIGNEE_EMAIL]" `
  --area "{{config.area_path}}" `
  --iteration "{{config.iteration_path}}" `
  --fields "Microsoft.VSTS.Scheduling.StoryPoints=[N]" "Microsoft.VSTS.Common.AcceptanceCriteria=[HTML_AC]" `
  --org "{{config.ado_org_url}}" `
  --project "{{config.ado_project}}"
```

**Important notes:**
- Both `--description` and the `AcceptanceCriteria` field value must be valid, sanitized HTML (entities escaped, simple tags only, no newlines inside the string — use `<br>` instead).
- The `--fields` flag takes space-separated `field=value` pairs; wrap each value in double quotes.
- If the command fails with an auth error, tell the user to run `az login` and `az devops configure --defaults organization={{config.ado_org_url}}` first.
- If area or iteration path errors occur, suggest verifying with `az boards area project list --org {{config.ado_org_url}} --project {{config.ado_project}}`.

### Step 6 — Report the Result

Parse the JSON output from the command and display:

```
✅ Work Item Created!
─────────────────────────────────
ID:    #[id]
Title: [title]
URL:   {{config.ado_org_url}}/{{config.ado_project}}/_workitems/edit/[id]
Story Points: [n]
Assigned To:  [name]
─────────────────────────────────
```

If the command fails, show the exact error and suggest the most likely fix.

## Edge Cases

- **No title given**: Derive a title from the core noun + verb in the description (e.g., "Build API for teamname position sync").
- **Multiple developers mentioned**: Use only explicitly assigned developers. Do not infer from context — if unclear, ask.
- **Very vague input** (< 20 words): Ask one focused clarifying question before proceeding. Don't guess on scope.
- **Epic-level input** (estimate would be 21 pts or input clearly describes multiple independent deliverables): Stop. Decompose into sub-stories and show numbered list. Ask which to create. Do not compress into one large story.
- **LLD has multiple User Story entries**: List them numbered and ask "Which story do you want to create, or all of them?" Create one at a time unless the user says "all".
- **No clear acceptance criteria inferable**: Draft 2-3 reasonable criteria based on the description and ask the user to confirm before creating.
- **Acceptance criteria text contains quotes or special chars**: Escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` before embedding in HTML field value.
