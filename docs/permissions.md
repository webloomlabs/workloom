# Permissions

Six roles, fixed. Custom roles are Phase 2; a fixed matrix is far easier to
reason about and to test exhaustively, and the shape anticipates the change.

Permissions are `resource:action` strings, defined once in
`packages/core/src/permissions/statements.ts` and consumed by the role matrix,
the procedure registry, API key scopes, and Better Auth alike — rather than each
keeping its own list and drifting apart.

## The roles

| Role | For |
| --- | --- |
| **Owner** | Owns the installation. Everything, including deleting the organization. |
| **Admin** | Everything operational. Differs from owner by exactly one permission: `organization:delete`. |
| **Manager** | Runs delivery. Full access to work and clients, and can see money — judging whether a project is worth continuing requires it. |
| **Developer** | Does the work. Projects, tasks, and their own time. No commercial terms at all. |
| **Account manager** | Owns relationships. Full CRM, can quote, can see whether a client has paid. Does not record payments or manage delivery internals. |
| **Finance** | Owns the money. Everything financial, plus the client and project context needed to bill correctly. Nothing that changes delivery. |

## Deliberate separations

These are product decisions, and each is pinned by a test. If one changes, it
was a decision.

- A **developer** cannot read an invoice, a payment, or a margin. Commercial
  terms are not delivery information.
- A developer logs their own time but cannot see or change anyone else's.
- A **manager** can set rates and read financial reports, but cannot raise an
  invoice. Billing is a finance duty.
- **Finance** owns rates and billing but cannot reassign a task, and cannot
  rewrite what people recorded working.
- An **account manager** can quote and can choose the tax on a line, but cannot
  configure tax rates, and cannot record money received.
- A developer answers **tickets** but does not raise or delete them: what a
  client is owed, and when it is finished with, is not theirs to decide.
- **Finance** does not read support tickets — a client's problems are not
  billing information — but does read maintenance plans and infrastructure,
  because both are what the money is for.
- An **account manager** sets up a recurring schedule but cannot delete one:
  ending it leaves the record of what was agreed, deleting it does not.
- Only owners, admins, and managers touch **infrastructure**. A lapsed domain
  is an outage, and the list of who can change one stays short.
- Everyone can see the organization they belong to.

## The matrix

● granted · · not granted

**organization**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `organization:read` | ● | ● | ● | ● | ● | ● |
| `organization:update` | ● | ● | · | · | · | · |
| `organization:delete` | ● | · | · | · | · | · |

**member**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `member:read` | ● | ● | ● | ● | ● | ● |
| `member:invite` | ● | ● | · | · | · | · |
| `member:update` | ● | ● | · | · | · | · |
| `member:remove` | ● | ● | · | · | · | · |

**apiKey**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `apiKey:read` | ● | ● | · | · | · | · |
| `apiKey:create` | ● | ● | · | · | · | · |
| `apiKey:revoke` | ● | ● | · | · | · | · |

**webhook**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `webhook:read` | ● | ● | · | · | · | · |
| `webhook:create` | ● | ● | · | · | · | · |
| `webhook:update` | ● | ● | · | · | · | · |
| `webhook:delete` | ● | ● | · | · | · | · |

**auditLog**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `auditLog:read` | ● | ● | ● | · | · | ● |

**company**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `company:read` | ● | ● | ● | ● | ● | ● |
| `company:create` | ● | ● | ● | · | ● | · |
| `company:update` | ● | ● | ● | · | ● | · |
| `company:archive` | ● | ● | ● | · | ● | · |

**contact**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `contact:read` | ● | ● | ● | ● | ● | ● |
| `contact:create` | ● | ● | ● | · | ● | · |
| `contact:update` | ● | ● | ● | · | ● | · |
| `contact:archive` | ● | ● | ● | · | ● | · |

**lead**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `lead:read` | ● | ● | ● | · | ● | · |
| `lead:create` | ● | ● | ● | · | ● | · |
| `lead:update` | ● | ● | ● | · | ● | · |
| `lead:convert` | ● | ● | ● | · | ● | · |
| `lead:archive` | ● | ● | ● | · | ● | · |

**deal**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `deal:read` | ● | ● | ● | · | ● | · |
| `deal:create` | ● | ● | ● | · | ● | · |
| `deal:update` | ● | ● | ● | · | ● | · |
| `deal:archive` | ● | ● | ● | · | ● | · |

**activity**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `activity:read` | ● | ● | ● | ● | ● | · |
| `activity:create` | ● | ● | ● | · | ● | · |
| `activity:update` | ● | ● | ● | · | ● | · |
| `activity:delete` | ● | ● | ● | · | ● | · |

**project**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `project:read` | ● | ● | ● | ● | ● | ● |
| `project:create` | ● | ● | ● | · | · | · |
| `project:update` | ● | ● | ● | · | · | · |
| `project:archive` | ● | ● | ● | · | · | · |

**projectRevision**

Scope and price variations, and extensions to a project's dates. `accept` is the
commercial decision — agreeing that the client owes more — so it is separate from
editing the offer. A developer sees that the scope changed and by when; the
amount is hidden from anyone without `report:readFinancial`.

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `projectRevision:read` | ● | ● | ● | ● | ● | ● |
| `projectRevision:create` | ● | ● | ● | · | ● | · |
| `projectRevision:update` | ● | ● | ● | · | ● | · |
| `projectRevision:send` | ● | ● | ● | · | ● | · |
| `projectRevision:accept` | ● | ● | ● | · | ● | · |
| `projectRevision:delete` | ● | ● | ● | · | ● | · |

**projectBilling**

A project's staged billing plan. `release` raises the draft invoice for a stage,
which is what draws money down against the contract, so it also requires
`invoice:create`. A developer gets nothing: a delivery person has no business
seeing the price schedule.

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `projectBilling:read` | ● | ● | ● | · | ● | ● |
| `projectBilling:update` | ● | ● | ● | · | ● | ● |
| `projectBilling:release` | ● | ● | ● | · | ● | ● |

**milestone**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `milestone:read` | ● | ● | ● | ● | ● | ● |
| `milestone:create` | ● | ● | ● | · | · | · |
| `milestone:update` | ● | ● | ● | · | · | · |
| `milestone:delete` | ● | ● | ● | · | · | · |

**task**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `task:read` | ● | ● | ● | ● | ● | ● |
| `task:create` | ● | ● | ● | ● | · | · |
| `task:update` | ● | ● | ● | ● | · | · |
| `task:delete` | ● | ● | ● | · | · | · |

**comment**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `comment:create` | ● | ● | ● | ● | ● | ● |
| `comment:moderate` | ● | ● | ● | · | · | · |

**timeEntry**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `timeEntry:read` | ● | ● | ● | ● | · | ● |
| `timeEntry:create` | ● | ● | ● | ● | · | · |
| `timeEntry:update` | ● | ● | ● | ● | · | · |
| `timeEntry:delete` | ● | ● | ● | ● | · | · |

**timeEntryAll**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `timeEntryAll:read` | ● | ● | ● | · | · | ● |
| `timeEntryAll:manage` | ● | ● | ● | · | · | · |

**rate**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `rate:update` | ● | ● | ● | · | · | ● |

**service**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `service:read` | ● | ● | ● | · | ● | ● |
| `service:create` | ● | ● | ● | · | · | ● |
| `service:update` | ● | ● | ● | · | · | ● |
| `service:archive` | ● | ● | ● | · | · | ● |

**taxRate**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `taxRate:read` | ● | ● | ● | · | ● | ● |
| `taxRate:create` | ● | ● | · | · | · | ● |
| `taxRate:update` | ● | ● | · | · | · | ● |
| `taxRate:archive` | ● | ● | · | · | · | ● |

**quote**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `quote:read` | ● | ● | ● | · | ● | ● |
| `quote:create` | ● | ● | ● | · | ● | ● |
| `quote:update` | ● | ● | ● | · | ● | ● |
| `quote:send` | ● | ● | ● | · | ● | ● |
| `quote:delete` | ● | ● | · | · | · | ● |

**invoice**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `invoice:read` | ● | ● | ● | · | ● | ● |
| `invoice:create` | ● | ● | · | · | ● | ● |
| `invoice:update` | ● | ● | · | · | · | ● |
| `invoice:send` | ● | ● | · | · | ● | ● |
| `invoice:cancel` | ● | ● | · | · | · | ● |
| `invoice:delete` | ● | ● | · | · | · | ● |

**payment**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `payment:read` | ● | ● | ● | · | ● | ● |
| `payment:create` | ● | ● | · | · | · | ● |
| `payment:update` | ● | ● | · | · | · | ● |
| `payment:delete` | ● | ● | · | · | · | ● |

**expense**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `expense:read` | ● | ● | ● | · | ● | ● |
| `expense:create` | ● | ● | ● | · | · | ● |
| `expense:update` | ● | ● | · | · | · | ● |
| `expense:delete` | ● | ● | · | · | · | ● |

**ticket**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `ticket:read` | ● | ● | ● | ● | ● | · |
| `ticket:create` | ● | ● | ● | · | ● | · |
| `ticket:update` | ● | ● | ● | ● | ● | · |
| `ticket:delete` | ● | ● | ● | · | ● | · |

**maintenancePlan**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `maintenancePlan:read` | ● | ● | ● | ● | ● | ● |
| `maintenancePlan:create` | ● | ● | ● | · | ● | · |
| `maintenancePlan:update` | ● | ● | ● | · | ● | · |
| `maintenancePlan:delete` | ● | ● | ● | · | ● | · |

**infrastructure**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `infrastructure:read` | ● | ● | ● | ● | ● | ● |
| `infrastructure:create` | ● | ● | ● | · | · | · |
| `infrastructure:update` | ● | ● | ● | · | · | · |
| `infrastructure:delete` | ● | ● | ● | · | · | · |

**document**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `document:read` | ● | ● | ● | ● | ● | ● |
| `document:create` | ● | ● | ● | · | ● | · |
| `document:update` | ● | ● | ● | · | ● | · |
| `document:delete` | ● | ● | ● | · | ● | · |

**billingSchedule**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `billingSchedule:read` | ● | ● | ● | · | ● | ● |
| `billingSchedule:create` | ● | ● | · | · | ● | ● |
| `billingSchedule:update` | ● | ● | · | · | ● | ● |
| `billingSchedule:delete` | ● | ● | · | · | · | ● |

**report**

| Permission | Owner | Admin | Manager | Developer | Account mgr | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| `report:read` | ● | ● | ● | ● | ● | ● |
| `report:readFinancial` | ● | ● | ● | · | · | ● |

## How it is enforced

Every procedure declares the one permission it needs, and the registry checks it
**before** the input is even parsed — so an unauthorised caller learns nothing
from a validation message. A few procedures require a second permission inside
the handler where the work genuinely spans two areas; billing tracked time needs
`invoice:update` and `timeEntry:read`.

A test asserts that every registered procedure refuses an actor lacking its
permission. Another asserts the matrix only ever grants permissions that exist —
a typo would otherwise grant nothing at all, silently.

Permissions answer *what*; row-level security answers *whose*. They are
independent: see [architecture.md](architecture.md).
