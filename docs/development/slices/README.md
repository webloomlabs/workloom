# Slices

Work ships as vertical slices. A slice is not done when the code exists — it is
done when every layer exists: database, API, permissions, UI, tests, audit
logging, and the events it emits.

Each slice has a file here stating its **definition of done as commands that
either pass or fail**. This matters because much of the implementation is done
by AI agents, and an agent assessing its own work against prose will conclude
it is finished. A command exiting non-zero will not.

## Convention

```markdown
# S<n> — <name>

**Depends on:** S<n-1>
**Amends:** (any plan or roadmap decision this slice changed, and why)

## Scope
What is in. What is explicitly out, and which slice it belongs to instead.

## Definition of done
Numbered checks, each a command and its expected result.

## Notes
Anything a later slice needs to know — decisions taken, surprises found.
```

## Status

| Slice | State |
| --- | --- |
| [S0 — Platform skeleton](S0.md) | Done |
| [S1 — Identity & tenancy](S1.md) | Done |
| [S2 — Outbox, events, webhooks](S2.md) | Done |
| [S3 — CRM](S3.md) | Done |
| [S4 — Client view](S4.md) | Done |
| [S5 — Projects, milestones, tasks](S5.md) | Done |
| S6 — Time tracking | Next |
| S7 — Finance (7a/7b/7c) | |
| S8 — Profitability & reporting | |
| S9 — Dashboard | |
| S10 — Release hardening | |
