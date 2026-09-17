# Contributing

## Before you start

Open an issue describing the problem before writing a fix for it, unless the fix
is obvious and small. Workloom is an opinionated product and the architecture has
load-bearing decisions in it; a pull request that cuts across one is a waste of
your afternoon.

Read [development.md](development.md) to get it running, and
[architecture.md](architecture.md) for the decisions worth knowing about.

## What a change looks like

A change is ready when every layer of it exists: database, API, permissions,
interface, tests, audit entries, and the events it emits. A feature that reaches
the interface but not the API is a hole in both the audit log and the
integration story, and will be sent back.

Run the gates before opening a pull request:

```bash
pnpm typecheck && pnpm lint
pnpm test:unit && pnpm test:integration && pnpm test:isolation
pnpm db:generate     # must produce no diff
pnpm openapi:check
```

CI runs all of these plus the browser journeys, an image build, and a clean
install from the documentation alone.

## Tests

Write the test that would have caught the bug. For a new rule, prefer the level
that makes it impossible rather than merely checked:

- a database constraint or trigger, proved by a test that tries to violate it as
  a superuser,
- then a service check with a message a person can act on,
- then a browser journey for the path someone actually walks.

A test whose expectation is derived from the code it tests asserts nothing. The
export column lists and the OpenAPI snapshot are written out by hand or
committed for exactly that reason.

## Commits and pull requests

- One concern per pull request.
- Say what changes for a user, and what you decided against.
- If you found something surprising, write it down — the slice notes in
  [development/slices/](development/slices/) exist for that, and several of them
  have saved a later slice a day.

## Scope

Workloom is a product for agencies, dogfooded by one. A feature that only makes
sense for that one agency does not belong in it; generalise it or keep it out.
Phase 2 in [Roadmap.md](../Roadmap.md) is where larger things are queued.

## Licence

By contributing you agree your work is licensed under the repository's licence.
