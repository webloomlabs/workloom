# Development

## Running from source

```bash
pnpm install
cp .env.example .env            # set the two secrets it names
pnpm services:up                # postgres, mailpit, minio in containers
pnpm db:migrate
pnpm dev                        # the app on :3000
pnpm worker                     # in another terminal
```

Mail is at <http://localhost:8025>. Object storage, if you switch to it, is at
<http://localhost:9001>.

Workspace packages ship TypeScript source rather than a build artifact, so there
is no build step in the dev loop. `tsc -b --noEmit` is the only type gate, which
is why `pnpm typecheck` is a required CI job.

## The commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` · `pnpm lint` | The static gates |
| `pnpm test:unit` | Pure logic. No database. Fast enough to run on save |
| `pnpm test:integration` | Real PostgreSQL through Testcontainers, real migrations, real RLS |
| `pnpm test:isolation` | Tenant isolation, as its own red/green signal |
| `pnpm test:e2e` | Playwright, against a running instance |
| `pnpm db:generate` | A migration for a schema change |
| `pnpm openapi:check` · `pnpm openapi:update` | The published API description |

## How the work is organised

Features ship as **vertical slices**: database, API, permissions, interface,
tests, audit entries and events, all before the next one starts. Each has a
specification in [development/slices/](development/slices/) whose definition of
done is a list of commands that either pass or fail — because much of the
implementation is done by AI agents, and an agent assessing its own work against
prose will conclude it is finished.

Read [architecture.md](architecture.md) before changing anything structural. The
constraint everything rests on: **`core` never imports `auth`**. Core functions
receive an `ActorContext` they never construct, which is what lets identical
business logic run from a page, the REST API, a job, and a test.

## Adding an operation

1. Declare it with `defineProcedure` in `packages/core/src/modules/…`: a name, a
   permission, input and output schemas, an HTTP binding, and the events it
   emits.
2. Write the handler. It takes `(ctx, input)`, calls `ctx.audit(...)` with what
   was *intended*, and `ctx.emit(...)` for anything the outside world cares
   about.
3. Add a fixture in `packages/core/test/procedures.test.ts`. The suite requires
   one for every mutation, and asserts each writes an audit entry, refuses an
   actor without its permission, and cannot reach another organization.
4. The REST route, the OpenAPI path, and the Server Action binding come for free.

## Tests worth understanding before you change them

- **`procedures.test.ts`** runs three guarantees over *every* registered
  procedure. Adding a mutation without deciding how to exercise it fails the file.
- **The isolation suites** derive their table list from the live database, so a
  table added in a later slice is probed automatically.
- **The golden tax fixtures** were written before the calculator they test. They
  run against the pure function, against a stored quote, and against a stored
  invoice before and after issuing.
- **`reports.test.ts`** raises a rate and asserts the historical margin does not
  move. That test is the only thing enforcing rate snapshotting.

## Conventions

- Comments explain *why*, never *what*. If a line needs explaining, the comment
  above it should say what would go wrong without it.
- Errors are written for whoever reads them. `code` for branching, `message` for
  people.
- Amounts are integer minor units, everywhere, always.
- Prefer a database constraint to a service check, and write both when the rule
  matters.
