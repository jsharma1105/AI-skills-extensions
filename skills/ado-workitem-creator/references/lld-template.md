# LLD Template Reference

This is the standard Low-Level Design (LLD) template used by the MyTeam_Area team. Use it as the structure for ADO work item descriptions.

---

## Template Structure

### Description
What work is being done and why it is necessary. Include the feature context.

### Responsible Product Owner
`<Name>`

### In Scope
Describe the in-scope data and functionality for this work item.

### Out of Scope *(Optional)*
Describe any work that was discussed as NOT required for this task, but may be related.

### Non-Functional Requirements
- **Performance**: latency, throughput expectations
- **Security**: auth, secrets, encryption requirements
- **Scalability**: expected load, scaling strategy
- **Reliability**: retry logic, error handling, SLA expectations

### Workflow
Describe the trigger → processing → output flow. Reference diagrams if applicable.

Example component flow:
- Source → Azure Function (Trigger type) → Processing Logic → Target

### ADO User Story Reference
*Standard story types used in this team:*

| Story Type | Description |
|------------|-------------|
| Azure Function (Build) | Scaffold new Azure Function project |
| Azure Function BUILD | Build/implement function logic |
| BUILD API endpoints | Implement API controller and routes |
| APIM baseroute | Configure API Management base route |

### Source(s)
- **Qualtero** — new tables/columns being consumed
- **Service Bus** — queue/topic names
- **HTTP** — endpoint URLs, trigger routes

### Target
- **JCTE (Model)** — target data model / DB tables
- Output queue, downstream API, etc.

### Integration Method
- HTTP Trigger (API-based)
- SQL Trigger (Change Tracking-based)
- Service Bus Trigger
- Timer Trigger

### Repositories
Links to relevant code repositories.

### Documentation
Links to related documents (LLD, architecture diagrams, etc.).

### TODO / Special Logic
- Mapping rules between source and target models
- Common/shared logic that may need a NuGet package or shared service
- Open questions and decisions pending

### Q&A
Relevant discussion points and decisions made with the Product Owner.

### Appendix
- Sample data / actual class definitions
- Data mapping (source to target models)
- External references

---

## HTML Rendering Notes

When populating the ADO description field, render each section as HTML:
- Use `<h3>` for section headers
- Use `<ul><li>` for lists
- Use `<p>` for paragraphs
- Use `<strong>` for emphasis
- Omit sections where no information is available
