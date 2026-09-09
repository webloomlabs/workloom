# Workloom — Project Specification

## 1. Project Overview

**Workloom** is an open-source, self-hostable operating system for digital agencies, software studios, and technology service businesses.

The project is being developed and dogfooded by **Webloom Labs**. Webloom Labs will be the first real-world user, allowing the product to be shaped around genuine agency workflows rather than theoretical requirements.

The goal is not to build another generic CRM, project manager, or accounting application. The goal is to connect the operational lifecycle of a digital agency into one system:

**Lead → Client → Proposal → Contract → Project → Tasks → Development → Deployment → Invoice → Payment → Maintenance → Reporting**

The software should provide a single source of truth for clients, projects, finances, infrastructure, support, automation, and eventually AI-assisted agency operations.

---

## 2. Vision

Build an open-source, self-hostable **agency operating system** that lets a digital agency manage its entire business from one place.

### Core principles

- **Open source first**
- **Self-hosting first**
- **Agency-specific rather than generic**
- **Automation-friendly**
- **API-first**
- **Integration-friendly**
- **AI-ready, but not AI-dependent**
- **Simple deployment**
- **No artificial feature restrictions in the open-source core**
- **Dogfooded by Webloom Labs**

The product should eventually support both:

1. Agencies that deploy and manage the software themselves.
2. Agencies that use a hosted/managed version.

---

# 3. Target Users

## Primary users

- Web development agencies
- Software development agencies
- Freelance development studios
- AI/automation agencies
- E-commerce development agencies
- Digital product studios
- Small technology consultancies

## Secondary users

- Creative agencies with technical delivery
- IT service companies
- Web maintenance businesses
- Small software consultancies

The initial product should focus on **small and medium-sized digital agencies**, where a single platform can replace a collection of disconnected tools.

---

# 4. Product Positioning

### Product category

> Open-source, self-hostable agency operating system.

### Not

- A generic CRM
- A generic project-management tool
- A generic accounting system
- An AI wrapper
- An ERP clone

### Differentiation

The system should understand relationships between agency operations.

For example:

```text
Client
  │
  ├── Contact
  ├── Project
  │     ├── Milestones
  │     ├── Tasks
  │     ├── Repository
  │     ├── Staging
  │     └── Production
  │
  ├── Contract
  ├── Invoice
  ├── Payment
  ├── Maintenance Plan
  └── Support Tickets
```

A project should not exist in isolation from the commercial and operational context surrounding it.

---

# 5. Product Lifecycle

The central agency lifecycle is:

```text
Lead
  ↓
Prospect
  ↓
Deal
  ↓
Client
  ↓
Proposal / Quote
  ↓
Contract
  ↓
Project
  ↓
Milestones
  ↓
Tasks
  ↓
Development
  ↓
Deployment
  ↓
Delivery
  ↓
Invoice
  ↓
Payment
  ↓
Maintenance / Support
  ↓
Reporting
```

This lifecycle should form the foundation of the product architecture.

---

# 6. Core Modules

## 6.1 Dashboard

The dashboard provides an overview of agency operations.

### Initial metrics

- Revenue
- Outstanding invoices
- Expenses
- Estimated profit
- Active projects
- Open tasks
- Upcoming deadlines
- Leads
- Sales pipeline
- Recent activity

The dashboard should be configurable in the future.

---

## 6.2 CRM

The CRM manages leads, prospects, clients, companies, and sales activities.

### Entities

```text
Lead
Company
Contact
Deal
Activity
Note
```

### Features

- Lead management
- Sales pipeline
- Lead source
- Contact management
- Company profiles
- Notes
- Activity history
- Deal values
- Deal stages
- Conversion tracking

Example pipeline:

```text
New Lead
   ↓
Contacted
   ↓
Qualified
   ↓
Proposal Sent
   ↓
Negotiation
   ↓
Won / Lost
```

---

# 7. Clients

The client module is the central relationship layer.

Each client can have:

- Company information
- Contacts
- Projects
- Quotes
- Contracts
- Invoices
- Payments
- Expenses
- Support tickets
- Maintenance plans
- Infrastructure
- Documents
- Activity history

The client should act as a unified view of everything related to that organization.

---

# 8. Projects

Projects represent client work and internal projects.

### Project structure

```text
Project
├── Client
├── Members
├── Milestones
├── Tasks
├── Time Entries
├── Documents
├── Repository
├── Environments
├── Deployments
└── Financial Information
```

### Features

- Project creation
- Project status
- Start/end dates
- Project budget
- Assigned team members
- Milestones
- Tasks
- Task dependencies
- Time tracking
- Project progress
- Internal notes
- Client-visible updates
- Project profitability

### Project statuses

Example:

```text
Planning
In Progress
On Hold
Review
Completed
Cancelled
```

---

# 9. Tasks and Work Management

Tasks should support both internal and client projects.

### Features

- Assignee
- Priority
- Status
- Due date
- Labels
- Milestone
- Project
- Comments
- Attachments
- Dependencies
- Time tracking

Example:

```text
Project
  └── Milestone
        ├── Task
        ├── Task
        └── Task
```

---

# 10. Finance

The finance module manages the commercial side of agency operations.

### Core entities

```text
Quote
Contract
Invoice
Payment
Expense
```

### Features

- Quotes
- Invoices
- Payment tracking
- Expense tracking
- Recurring invoices
- Tax configuration
- Currency support
- Payment status
- Financial reports
- Project profitability

### Invoice lifecycle

```text
Draft
  ↓
Sent
  ↓
Viewed
  ↓
Partially Paid
  ↓
Paid
```

Possible additional states:

```text
Overdue
Cancelled
Refunded
```

---

# 11. Service Catalogue

Agencies should be able to define their services.

Example:

```text
Services
├── Web Development
├── E-commerce Development
├── AI Integration
├── Mobile App Development
├── Automation
├── Maintenance
└── Hosting
```

Each service can contain:

- Name
- Description
- Pricing model
- Default price
- Billing type
- Estimated delivery time
- Internal cost estimate

This can later be used when generating proposals and quotes.

---

# 12. Infrastructure Management

Infrastructure is a major differentiator for an agency-focused platform.

The system should eventually track client infrastructure such as:

```text
Client
  │
  ├── Domains
  ├── Hosting
  ├── Servers
  ├── Applications
  ├── Environments
  ├── Deployments
  ├── SSL
  ├── Backups
  └── Monitoring
```

### Potential integrations

- Cloudflare
- Vercel
- GitHub
- GitLab
- Coolify
- VPS providers
- Uptime monitoring systems

### Important security requirement

Credentials and secrets must never be stored as plain text.

Use secure secret storage/encryption where credentials are required.

---

# 13. Support and Maintenance

Agencies frequently continue working with clients after project delivery.

The system should support:

### Support

- Support tickets
- Bug reports
- Feature requests
- Client requests
- Internal notes
- Priority
- SLA tracking
- Ticket status

### Maintenance

- Maintenance plans
- Recurring tasks
- Recurring billing
- Maintenance history
- Website/application health
- Client support history

Example:

```text
Client
  └── Maintenance Plan
        ├── Monthly Invoice
        ├── Security Updates
        ├── Backups
        ├── Performance Checks
        └── Support
```

---

# 14. Client Portal

Clients should eventually have a dedicated portal.

Clients can view:

- Projects
- Project progress
- Milestones
- Tasks intended for clients
- Proposals
- Contracts
- Invoices
- Payment status
- Documents
- Support tickets
- Maintenance status

The portal should expose only information explicitly marked as client-visible.

Internal agency notes must remain private.

---

# 15. Automation

Automation should be a first-class capability.

The platform should provide:

- Webhooks
- API keys
- Events
- Background jobs
- Scheduled actions
- Integration triggers

Example automations:

```text
Invoice becomes overdue
        ↓
Send reminder email
```

```text
Project completed
        ↓
Create maintenance onboarding tasks
        ↓
Create recurring invoice
```

```text
Domain expires in 30 days
        ↓
Notify account manager
```

```text
New deal marked Won
        ↓
Create project
        ↓
Create default milestones
        ↓
Create onboarding checklist
```

The system should integrate particularly well with automation platforms such as n8n, Make, and similar tools.

---

# 16. AI Layer

AI should be an optional intelligence layer on top of structured agency data.

The product should **not** depend on AI for its core functionality.

Potential capabilities:

### Agency assistant

Examples:

> "How much revenue did we generate from Shopify projects this year?"

> "Which projects are at risk of missing their deadlines?"

> "Summarize everything that happened with this client this month."

> "Which invoices are overdue?"

> "Which leads have not been contacted recently?"

### Content generation

- Proposal drafts
- Client updates
- Project summaries
- Meeting summaries
- Invoice reminder messages
- Internal reports

### AI agents

Eventually allow controlled agents to:

- Query agency data
- Create tasks
- Draft communications
- Analyze project health
- Generate reports
- Trigger approved workflows

All AI actions should respect permissions and provide an audit trail.

---

# 17. Integrations

The platform should be integration-friendly from the beginning.

Potential integrations:

```text
Development
├── GitHub
├── GitLab
├── Bitbucket
└── Sentry

Deployment
├── Vercel
├── Coolify
├── Docker
└── Cloudflare

Communication
├── Slack
├── Discord
├── Email
└── Microsoft Teams

Finance
├── Stripe
├── PayPal
└── Local payment providers

Automation
├── n8n
├── Make
└── Zapier

Productivity
├── Google Workspace
└── Microsoft 365

Monitoring
└── Uptime Cairn
```

Integrations should preferably be implemented as modular adapters rather than tightly coupling the core application to external services.

---

# 18. API

The API is a core product capability.

The system should provide:

- REST API
- API keys
- Webhooks
- Event system
- Authentication
- Authorization
- Rate limiting

Future possibilities:

- GraphQL
- Public developer API
- Integration SDK
- Plugin system

API design should be treated as a first-class architecture concern rather than something added after the UI.

---

# 19. Multi-Tenancy

Even though the first installation is for Webloom Labs, the architecture should support multiple organizations.

Recommended model:

```text
Instance
  │
  └── Organization(s)
        │
        ├── Users
        ├── Clients
        ├── Projects
        ├── Finance
        ├── Settings
        └── Integrations
```

A self-hosted instance could operate as:

### Single organization

```text
Workloom
└── Webloom Labs
```

### Multiple organizations

```text
Workloom
├── Agency A
├── Agency B
└── Agency C
```

This allows future expansion without rebuilding the data model.

---

# 20. Roles and Permissions

The application needs role-based access control.

Initial roles could include:

```text
Owner
Admin
Manager
Developer
Account Manager
Finance
Client
```

Permissions should be granular enough to control:

- Client access
- Project access
- Financial information
- Infrastructure
- Team management
- API keys
- Integrations
- AI capabilities
- Organization settings

---

# 21. Self-Hosting

Self-hosting must be a first-class feature rather than an afterthought.

## Initial deployment target

Docker Compose.

Example:

```bash
docker compose up -d
```

The installation should provide:

- Application
- PostgreSQL
- Optional Redis
- Worker processes
- Storage configuration

## Future deployment targets

- Coolify
- Kubernetes
- Docker Swarm
- Managed hosting

Documentation should make installation approachable for users who are comfortable with basic server administration.

---

# 22. Proposed Technology Stack

The initial implementation can use technologies already familiar to Webloom Labs.

### Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui

### Backend

- Next.js / Node.js
- TypeScript

### Database

- PostgreSQL

### ORM

- Prisma or Drizzle

### Authentication

- Better Auth, Auth.js, or equivalent

### Storage

- S3-compatible object storage

### Background processing

- Trigger.dev, BullMQ, or equivalent

### Automation

- n8n integration

### Deployment

- Docker
- Docker Compose
- Coolify

The exact stack can change during implementation, but the architecture should prioritize maintainability, portability, and self-hosting.

---

# 23. Open-Source Philosophy

The project should be genuinely open source.

The open-source core should not intentionally cripple fundamental functionality in order to force users into a hosted version.

Core functionality should include the capabilities necessary to run an agency independently.

Potential commercial offerings can focus on convenience and managed infrastructure rather than artificial limitations.

---

# 24. Potential Business Model

The project can eventually support:

## Self-hosted

Free and open source.

Users manage:

- Server
- Updates
- Backups
- Infrastructure

## Hosted

A managed cloud version can provide:

- Managed infrastructure
- Automatic updates
- Backups
- Monitoring
- Email delivery
- Scaling
- Support

Possible structure:

```text
Open Source
     │
     ├── Self-host
     │
     └── Hosted
           ├── Starter
           ├── Business
           └── Enterprise
```

Additional revenue opportunities:

- Managed hosting
- Premium support
- Enterprise support
- Managed backups
- Professional services
- Custom integrations
- Deployment assistance

---

# 25. MVP Scope

Do not attempt to build every module initially.

The first MVP should focus on the operational core.

## MVP v0.1

### Organizations

- Organization setup
- Users
- Basic roles
- Organization settings

### CRM

- Leads
- Companies
- Contacts
- Deals
- Pipeline
- Activities

### Clients

- Client profiles
- Contacts
- Activity history

### Projects

- Projects
- Members
- Milestones
- Tasks
- Status
- Deadlines
- Progress

### Finance

- Quotes
- Invoices
- Payments
- Expenses

### Dashboard

- Revenue
- Outstanding invoices
- Active projects
- Open tasks
- Upcoming deadlines
- Sales pipeline

### API

- Authentication
- API keys
- Basic REST API
- Webhooks

### Self-hosting

- Docker Compose
- PostgreSQL
- Environment configuration
- Database migrations
- Basic backup documentation

---

# 26. Post-MVP Roadmap

## Phase 2 — Agency Operations

- Client portal
- Time tracking
- Project profitability
- Contracts
- Documents
- Recurring invoices
- Recurring tasks
- Email integration
- Notifications

## Phase 3 — Infrastructure

- Domains
- Hosting
- Servers
- Applications
- Environments
- Deployments
- Cloudflare
- Vercel
- Coolify
- Monitoring

## Phase 4 — Automation

- Event system
- Scheduled jobs
- Workflow triggers
- n8n integration
- Advanced webhooks
- Automation templates

## Phase 5 — AI

- Agency assistant
- Project summaries
- Financial analysis
- Client summaries
- Proposal generation
- AI agents
- Natural-language reporting

## Phase 6 — Ecosystem

- Plugin system
- Integration marketplace
- Developer SDK
- Public API
- Hosted cloud version

---

# 27. Webloom Labs as the Reference Implementation

Webloom Labs should be the first production-like installation.

The team should use the platform to manage actual:

- Leads
- Clients
- Projects
- Tasks
- Quotes
- Invoices
- Payments
- Infrastructure
- Maintenance

This creates a continuous feedback loop:

```text
Use Workloom
      ↓
Find real problem
      ↓
Determine whether it is agency-generic
      ↓
Design feature
      ↓
Implement
      ↓
Dogfood
      ↓
Release
```

Not every Webloom Labs-specific requirement should become a core product feature.

A useful rule:

> If another digital agency is likely to experience the same problem, consider it a product feature.

---

# 28. Product Design Principles

### 28.1 Simple by default

The product should not feel like an enterprise ERP.

### 28.2 Progressive complexity

Basic users should see simple workflows. Advanced functionality should appear when needed.

### 28.3 Connected data

Avoid isolated modules.

A client should connect naturally to projects, invoices, support, and infrastructure.

### 28.4 Fast

Agency management software is used frequently throughout the day.

Performance should be treated as a product feature.

### 28.5 Developer-friendly

Because many target users are technology agencies:

- Excellent API
- Webhooks
- CLI possibilities
- Docker
- Environment configuration
- Documentation
- Extensibility

should be treated as important product features.

### 28.6 Privacy-friendly

Self-hosting should give agencies control over their operational and client data.

---

# 29. Security Requirements

Security is critical because the system may contain sensitive client and financial information.

Requirements include:

- Secure authentication
- Password hashing
- Session security
- Role-based authorization
- Organization-level data isolation
- Encryption for sensitive secrets
- Secure file storage
- Audit logs
- CSRF protection where applicable
- Rate limiting
- Input validation
- SQL injection protection
- Secure webhook validation
- Secure API keys
- Secret rotation
- Backup recommendations

Infrastructure credentials should receive especially strong protection.

---

# 30. Audit Logging

Important actions should be recorded.

Example:

```text
User: admin@example.com
Action: Invoice Updated
Resource: INV-1024
Time: 2026-09-09 15:30
Changes:
  Status: Draft → Sent
```

Audit logs should eventually cover:

- Authentication events
- Permission changes
- Client changes
- Financial changes
- Infrastructure changes
- API activity
- AI actions
- Automation execution

---

# 31. Data Portability

Users should never feel trapped by the platform.

The system should provide export capabilities for important data.

Potential exports:

- CSV
- JSON
- PDF
- Database backup

The project should document a clear migration and backup strategy.

---

# 32. Observability

The application should eventually expose:

- Application logs
- Worker logs
- Health checks
- Database health
- Background-job status
- Integration status
- Error tracking

A simple health endpoint should be available from the beginning.

---

# 33. Development Strategy

Development should follow vertical slices rather than building every backend model first and UI later.

Example:

```text
Client Management
├── Database
├── API
├── Permissions
├── UI
├── Tests
└── Audit Logging
```

Then move to:

```text
Projects
├── Database
├── API
├── Permissions
├── UI
├── Tests
└── Audit Logging
```

This makes every completed module usable and testable.

---

# 34. Testing Strategy

At minimum:

### Unit tests

For:

- Business logic
- Permissions
- Financial calculations
- Validation
- Utility functions

### Integration tests

For:

- API
- Database
- Authentication
- Webhooks
- Background jobs

### End-to-end tests

For critical workflows:

```text
Create Lead
→ Convert to Client
→ Create Project
→ Create Invoice
→ Record Payment
```

Self-hosting deployment should also be tested in a clean environment.

---

# 35. Documentation

The project should maintain excellent documentation.

Required documentation:

```text
docs/
├── installation
├── configuration
├── architecture
├── development
├── database
├── API
├── authentication
├── permissions
├── integrations
├── automation
├── self-hosting
├── backup-and-restore
├── troubleshooting
└── contributing
```

---

# 36. Repository Structure

A possible initial structure:

```text
agency-os/
├── apps/
│   └── web/
│
├── packages/
│   ├── ui/
│   ├── database/
│   ├── auth/
│   ├── api/
│   ├── config/
│   └── integrations/
│
├── workers/
│
├── docker/
│
├── docs/
│
├── scripts/
│
├── tests/
│
├── docker-compose.yml
├── .env.example
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

The exact monorepo structure can be changed based on implementation experience.

---

# 37. Initial Database Domain Model

A high-level model:

```text
Organization
├── User
├── Role
├── Client
│   ├── Contact
│   ├── Project
│   ├── Quote
│   ├── Contract
│   ├── Invoice
│   ├── Payment
│   ├── SupportTicket
│   └── MaintenancePlan
│
├── Lead
├── Deal
├── Project
│   ├── Milestone
│   ├── Task
│   ├── TimeEntry
│   └── Deployment
│
├── Expense
├── Service
├── Integration
├── Automation
└── AuditLog
```

Every organization-owned resource should have a clear tenant boundary.

---

# 38. Example End-to-End Workflow

A typical agency workflow should look like:

```text
1. New lead arrives
        ↓
2. Create Lead
        ↓
3. Qualify Lead
        ↓
4. Create Deal
        ↓
5. Deal Won
        ↓
6. Convert to Client
        ↓
7. Create Quote / Contract
        ↓
8. Create Project
        ↓
9. Generate default milestones
        ↓
10. Assign team
        ↓
11. Development
        ↓
12. Track tasks/time
        ↓
13. Deploy
        ↓
14. Deliver project
        ↓
15. Invoice client
        ↓
16. Record payment
        ↓
17. Create maintenance plan
        ↓
18. Continue support
```

The system should progressively automate this workflow.

---

# 39. Long-Term Vision

The long-term goal is to become the operational backbone of a digital agency.

An agency should be able to open the system and answer:

- Who are our clients?
- What are we currently building?
- What needs to be done today?
- Which projects are delayed?
- How profitable is each project?
- Who owes us money?
- What infrastructure do we manage?
- Which domains are expiring?
- Which clients need attention?
- What work is coming next?
- What can be automated?
- What happened with this client?
- What should we do next?

The ideal experience is:

> **One system to understand and operate the entire agency.**

---

# 40. Success Criteria

The project should be considered successful when:

1. Webloom Labs can use it for its daily operations.
2. A new agency can self-host it without specialized knowledge.
3. The core CRM/project/finance workflow works without external SaaS dependencies.
4. Data is connected across modules.
5. The API and webhook system allow external automation.
6. Integrations can be added without modifying the core architecture extensively.
7. The project has clear documentation and contribution guidelines.
8. Other agencies can deploy it and adapt it to their workflows.
9. AI can operate safely on top of the structured agency data.
10. The open-source project can eventually support a sustainable hosted/managed business.

---

# 41. Guiding Rule

The project should continuously answer one question:

> **"Does this help an agency run its business better?"**

Avoid feature bloat.

Build the smallest useful system first, dogfood it through Webloom Labs, generalize proven workflows, and gradually turn those workflows into an extensible open-source agency operating system.
