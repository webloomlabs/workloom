# Workloom — User Stories

These stories describe what each role needs Workloom to do for the **business**,
not for the codebase. Each one names the commercial reason it exists, because a
feature that cannot be traced back to money earned, money collected, or time not
wasted does not belong in the product ([Roadmap.md](Roadmap.md), Phase 2 guiding
rule).

The lifecycle they collectively cover is the one the product is built around:

```text
Lead → Client → Quote → Project → Tasks → Time → Invoice → Payment → Maintenance → Reporting
```

## The roles

Six fixed internal roles, as defined in [docs/permissions.md](docs/permissions.md),
plus the client, who is external and has no account in the MVP.

| Role | Owns | Stories |
| --- | --- | --- |
| **Owner** | The installation and the business result | US-01, US-02 |
| **Admin** | Operations, access, and integrations | US-03, US-04, US-14 |
| **Account manager** | The client relationship and the sale | US-05, US-06, US-07, US-08 |
| **Manager** | Delivery, and whether delivery is still worth it | US-09, US-10, US-11 |
| **Developer** | The work itself, and their own time | US-12, US-13 |
| **Finance** | Billing, collection, and reconciliation | US-14, US-15, US-16 |
| **Client** | Nothing in the system — they receive its output | US-17 *(Phase 2)* |

Each story carries **Why it matters** (the business case), **Acceptance
criteria** (what "done" means commercially), and **Boundary** (what the role
must *not* be able to do — these separations are product decisions, each pinned
by a test).

---

## Owner

### US-01 — Stand up the agency's own installation and keep it closed

> As the **owner**, I want to install Workloom on infrastructure I control and
> have it refuse public sign-up, so that client commercial data never sits in a
> vendor's database and nobody joins the agency's system without being invited.

**Why it matters.** Agencies hold their clients' contracts, prices, and margins.
Self-hosting is the sales answer to "where does our data live?", and a closed
installation means the member list is the payroll list — no stale accounts to
audit later.

**Acceptance criteria**
- One `docker compose up` brings up a working installation; a setup screen
  creates the owner account and the organization, then closes permanently.
- There is no self-service sign-up route afterwards; members arrive only by
  invitation.
- The installation refuses to start as a database superuser, so tenant isolation
  is never silently absent.
- The owner can delete the organization — and is the only role that can.

**Boundary.** Everything is permitted to the owner; the single difference from an
admin is `organization:delete`.

### US-02 — Know whether the agency is actually making money

> As the **owner**, I want revenue, outstanding invoices, expenses, estimated
> profit, and per-project profitability on one screen, so that I can decide what
> to sell more of and which client is quietly costing us money.

**Why it matters.** Agencies rarely fail on revenue; they fail on unbilled time
and on projects that overrun silently. Profit per project is the number that
changes pricing, and it is only trustworthy if time, rates, and expenses come
from the same system that ran the work.

**Acceptance criteria**
- The dashboard shows revenue, outstanding invoices, expenses, estimated profit,
  active projects, open tasks, upcoming deadlines, and the sales pipeline.
- Project profitability compares invoiced value against logged time at the rate
  captured on each entry, plus expenses charged to the project.
- Figures reconcile with the finance module — one source of truth, not a second
  set of numbers.
- Everything can be exported, so the agency's accountant never needs a login.

---

## Admin

### US-03 — Give each person exactly the access their job needs

> As an **admin**, I want to invite a person with one of six roles and trust that
> the role decides what they see, so that a contractor on delivery never reads a
> client's margin and nobody has to be "careful" with a shared login.

**Why it matters.** Rate cards and margins leaking into delivery conversations
costs the agency negotiating position, and shared logins destroy the audit trail
exactly when a dispute needs it. Least privilege has to be the default, not a
configuration project.

**Acceptance criteria**
- Invitation by email, with a role chosen at invite time and changeable later.
- Removing a member revokes access immediately while leaving their recorded work
  — time entries, comments, tickets — intact and attributed.
- Every permission-bearing action is written to an audit log the owner, admins,
  managers, and finance can read.
- A member's role can be changed without recreating their account or losing
  their history.

**Boundary.** Managers, developers, account managers, and finance can read the
member list but cannot invite, change, or remove anyone.

### US-04 — Connect Workloom to the tools the agency already runs

> As an **admin**, I want scoped API keys and signed webhooks, so that our
> automations can act on agency events without anyone pasting a password into a
> script.

**Why it matters.** The operational savings of an agency OS come from removing
manual hand-offs — a won deal that creates a project, an expiring domain that
warns the account manager. That only works if events leave the system reliably
and keys can be revoked without a redeploy.

**Acceptance criteria**
- API keys are created with explicit scopes drawn from the same permission list
  the roles use, are shown once, and can be revoked.
- Webhooks are signed, retried on failure, and their deliveries are visible.
- API writes are idempotent, so a retried automation cannot double-invoice a
  client.
- The published API description matches the running code.

---

## Account manager

### US-05 — Work a lead through the pipeline without a spreadsheet

> As an **account manager**, I want leads, companies, contacts, deals, and logged
> activity in one pipeline, so that I know what to chase today and the agency can
> see which lead sources are worth the marketing spend.

**Why it matters.** Lost follow-ups are the cheapest revenue an agency ever
leaves on the table. Lead source on every deal turns marketing from an opinion
into a measured cost per won deal.

**Acceptance criteria**
- A lead records its source and moves through New → Contacted → Qualified →
  Proposal Sent → Negotiation → Won/Lost.
- Calls, emails, and meetings are logged as activity against the company and
  contact, and remain visible after conversion.
- Deals carry a value, so the pipeline total is a forecast rather than a count.
- The pipeline can be read by owners, admins, and managers — and by nobody in
  delivery.

### US-06 — Turn a won deal into a client and a project without retyping anything

> As an **account manager**, I want a won deal to convert into a client with its
> contacts and history carried over, so that delivery starts from what was sold
> rather than from someone's memory of the call.

**Why it matters.** The gap between sale and kickoff is where agencies lose
margin: scope agreed verbally, re-explained badly, delivered differently. The
conversion is the moment that promise becomes auditable.

**Acceptance criteria**
- Conversion creates the client from the lead, keeping contacts, notes, and the
  full activity history linked.
- The resulting client view shows projects, quotes, invoices, payments, tickets,
  maintenance plans, infrastructure, and documents in one place.
- The original lead record is retained for source and conversion reporting.
- Converting is a distinct, permissioned action — not a side effect of an edit.

### US-07 — Quote from the service catalogue and send it the same day

> As an **account manager**, I want to build a quote from priced catalogue
> services, apply the right tax, and send it as a PDF, so that proposals go out
> while the client is still interested and every line is priced consistently.

**Why it matters.** Quote turnaround wins work, and ad-hoc pricing is where
agencies undercharge. A catalogue makes the agency's own price list the default
and makes an exception a visible decision.

**Acceptance criteria**
- Lines are drawn from the service catalogue with default price and billing type.
- Tax is selected per line from configured rates; totals are computed on an exact
  money engine, never floating point.
- The quote is sent, its state tracked, and a PDF delivered to the contact.
- An accepted quote carries into the project and the billing plan rather than
  being re-entered.

**Boundary.** The account manager chooses the tax on a line but cannot create or
change tax rates — that stays with finance.

### US-08 — Charge for scope that grew

> As an **account manager**, I want to raise a priced revision when a client asks
> for more, and record their acceptance, so that extra work is paid work and the
> delivery dates move with it.

**Why it matters.** Unbilled scope creep is the single largest margin leak in
agency work. Separating "offer a change" from "the client agreed to it" gives the
agency a defensible record when the final invoice is questioned.

**Acceptance criteria**
- A revision records the scope change, its price, and any extension to the
  project's dates.
- Sending and accepting are separate actions; acceptance is the commercial
  commitment.
- An accepted revision flows into what is billable on the project.
- Delivery staff see that scope and dates changed; the amount is hidden from
  anyone without financial reporting access.

**Boundary.** The account manager can delete a draft revision, but ending a
recurring billing schedule is done by ending it — not deleting it — so the record
of what was agreed survives.

---

## Manager

### US-09 — Plan delivery so the team knows the order of work

> As a **manager**, I want projects with milestones, tasks, dependencies, and
> assignees, so that the team works in the right sequence and I can tell a client
> the real date rather than a hopeful one.

**Why it matters.** Agency credibility is mostly date credibility. Dependencies
make the critical path explicit, which is what turns a slipped task into a
renegotiated milestone instead of a missed deadline discovered late.

**Acceptance criteria**
- A project has a status, start and end dates, a budget, and assigned members.
- Milestones group tasks; tasks carry assignee, priority, status, due date,
  labels, comments, and attachments.
- A task can depend on another, and the effect of a slip is visible.
- Internal notes are distinguishable from client-visible updates from the start,
  so the future portal can honour the flag.

### US-10 — Tell early whether a project is still worth continuing

> As a **manager**, I want logged time, budget, and margin on the project I run,
> so that I can escalate or renegotiate while there is still room to, not at
> invoice time.

**Why it matters.** This is the one place the product deliberately gives a
delivery role financial visibility: judging whether to keep going requires
knowing what the work is earning. A manager who sees margin at 60% complete can
raise a revision (US-08); one who sees it at handover can only absorb the loss.

**Acceptance criteria**
- Logged time, at the rate captured on each entry, is shown against budget.
- Expenses charged to the project are included in the margin.
- Financial reports for the project are readable by the manager.
- Over-budget and approaching-deadline projects are surfaced rather than sought.

**Boundary.** A manager sets rates and reads financial reports but **cannot raise
an invoice** — billing is a finance duty, and the separation keeps the person who
agreed the work from also being the person who bills it.

### US-11 — Keep the agency's commitments and client infrastructure from lapsing

> As a **manager**, I want maintenance plans with their visit history and client
> infrastructure with renewal dates, so that retainers deliver what was sold and
> no client's domain or certificate expires on our watch.

**Why it matters.** A lapsed domain or certificate is a client-facing outage the
agency caused, and it costs the relationship, not just the renewal fee.
Retainers, meanwhile, are the agency's recurring revenue — they are only
defensible if the visits that were promised are recorded.

**Acceptance criteria**
- Maintenance plans record inclusions and a history of visits performed.
- Domains, hosting, servers, applications, certificates, and SaaS each carry an
  environment, a renewal date, and a renewal cost.
- A scheduled sweep announces renewals approaching and flags those that passed.
- Only owners, admins, and managers can change an infrastructure record.

---

## Developer

### US-12 — See today's work and log time against it in seconds

> As a **developer**, I want my assigned tasks and a fast way to record time on
> them, so that the agency bills what was actually done and I am not reconstructing
> my week on a Friday afternoon.

**Why it matters.** Unlogged time is unbilled revenue, and time logged from
memory is both inaccurate and unusable as evidence in a billing dispute. Making
logging cheaper than forgetting is a direct revenue mechanism.

**Acceptance criteria**
- A developer sees tasks assigned to them, with due dates and priority.
- Time is logged against a task, with the applicable rate copied onto the entry
  at the time of logging, so later rate changes never rewrite history.
- A developer can create and update tasks and comment on them.
- A developer can correct their own entries.

**Boundary.** A developer cannot see or change anyone else's time, and cannot
read an invoice, a payment, or a margin: commercial terms are not delivery
information.

### US-13 — Answer a client's support ticket inside the agreed response time

> As a **developer**, I want the tickets that need me, with their service-level
> clocks visible, so that the agency meets the response times it sold and the
> client gets an answer rather than an internal note.

**Why it matters.** Support SLAs are contractual. Missing them triggers credits,
churn, and the reputational damage that costs the next referral — all for work
the agency has already been paid to do.

**Acceptance criteria**
- Tickets show both service-level clocks — time to first response and time to
  resolution.
- Replies are explicitly internal or client-visible, and the two cannot be
  confused.
- A developer can read and update a ticket, including replying.
- Breaching, or nearly breaching, a service level is visible before it happens.

**Boundary.** A developer does not raise or delete tickets: what a client is owed,
and when that obligation is finished with, is not a delivery decision. Finance
does not read tickets at all — a client's problems are not billing information.

---

## Finance

### US-14 — Raise and send an invoice the client can actually pay

> As **finance**, I want to release a billing stage or bill tracked time as a
> numbered invoice, send it as a PDF, and give the client a link, so that money
> is requested promptly and in the form the client's accounts payable expects.

**Why it matters.** Days-sales-outstanding is a cash-flow problem disguised as an
admin problem. Every day between "work delivered" and "invoice sent" is a day the
agency funds its client, and staged billing is what draws money down against a
contract rather than waiting for the end.

**Acceptance criteria**
- A project's staged billing plan can release the draft invoice for a stage;
  doing so requires invoice creation rights as well.
- Tracked, billable time can be turned into invoice lines.
- Invoices move Draft → Sent → Viewed → Partially Paid → Paid, with Overdue,
  Cancelled, and Refunded available.
- Each invoice produces a PDF and can be emailed with a client-accessible link.
- Recurring schedules raise a **draft** each period, which a person issues — the
  system never sends money requests to a client unattended.

**Boundary.** Managers cannot create invoices; account managers can create and
send but cannot cancel, update, or delete one.

### US-15 — Record money received and match it to the bank

> As **finance**, I want to record payments, refunds, and expenses and reconcile
> them against bank transactions, so that the agency's view of what is paid
> matches the bank's, without a monthly spreadsheet exercise.

**Why it matters.** Chasing a client who has already paid damages the
relationship; failing to chase one who has not costs cash. Reconciliation is what
makes the paid/unpaid state trustworthy enough to act on — and what makes the
year-end close a day instead of a week.

**Acceptance criteria**
- Payments are recorded against an invoice, including partial payments, and the
  invoice state follows automatically.
- Refunds and expenses are recorded, with expenses attributable to a project so
  they reach profitability.
- Bank transactions can be matched to payments and expenses, and a match can be
  undone.
- Only finance, owners, and admins can record money received.

**Boundary.** Finance owns rates and billing but cannot reassign a task and
cannot rewrite what people recorded working — the billing basis stays what the
team actually reported.

### US-16 — Chase what is overdue before the client stops answering

> As **finance**, I want overdue invoices identified automatically with the
> client's full payment history to hand, so that collection is a short routine
> rather than a monthly reconstruction.

**Why it matters.** Collection success falls sharply with age. An agency that
chases at day 31 collects what one chasing at day 90 writes off, and knowing a
client's history is what decides whether to send a reminder or stop delivery.

**Acceptance criteria**
- A scheduled sweep marks invoices overdue on their due date without anyone
  running it.
- Outstanding balance by client is visible, with the invoices behind it.
- Account managers can see whether a client has paid, so they are not chasing
  blind — without being able to record a payment themselves.
- Everything needed to chase is on the client view: invoices, payments, and the
  contacts to send to.

---

## Client *(Phase 2 — client portal)*

### US-17 — See progress and pay without emailing anyone

> As a **client**, I want to see my project's progress, the updates meant for me,
> my invoices and what I owe, and to pay online, so that I stay confident in the
> agency without needing a status call.

**Why it matters.** Status requests are unbilled agency time, and perceived
silence is the most common reason a client believes a project is in trouble. A
portal that pays for itself twice: fewer "any update?" emails, and invoices paid
sooner because paying takes one click.

**Acceptance criteria**
- The portal shows projects, progress, milestones, and only those tasks and
  updates flagged client-visible — the flag shipped in the MVP precisely so this
  cannot leak internal notes.
- Quotes, contracts, invoices, payment status, documents, and tickets are
  visible to the client they belong to and to no other.
- The client can raise and follow a support ticket.
- An invoice can be paid from the portal, and the payment reconciles against the
  invoice (US-15) without manual entry.

**Boundary.** The client has no internal account and no visibility of time
entries, costs, margins, or any other client's data. Tenant and client isolation
is enforced by row-level security, independent of these permissions.

---

## Coverage

| Lifecycle stage | Stories | Primary roles |
| --- | --- | --- |
| Install & access | US-01, US-03, US-04 | Owner, Admin |
| Lead → Deal | US-05 | Account manager |
| Deal → Client | US-06 | Account manager |
| Quote / Proposal | US-07 | Account manager |
| Project & Tasks | US-09, US-12 | Manager, Developer |
| Scope change | US-08, US-10 | Account manager, Manager |
| Time → Invoice | US-12, US-14 | Developer, Finance |
| Payment | US-15, US-16, US-17 | Finance, Client |
| Maintenance & Support | US-11, US-13 | Manager, Developer |
| Reporting | US-02, US-10 | Owner, Manager |

**Not covered here, deliberately.** Contracts with e-signature, email-to-ticket,
notifications, deployments and monitoring, the automation workflow builder, the
AI layer, and the plugin ecosystem are Phase 2 items whose stories should be
written when they are picked up — each still has to pass the same test: *does
this help an agency run its business better?*
