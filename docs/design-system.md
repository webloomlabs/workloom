# Design system

Every screen in Workloom is built from one small set of tokens and components in
`packages/ui`. The point is not decoration. It is that a change of colour, radius
or density is one edit rather than nine hundred, and that two screens written
months apart still look like the same product.

The rule that makes it work: **a component never names a palette colour.** There
is no `neutral-800`, no `red-600`, no `bg-white` anywhere in `apps/web`. There
are roles — surface, line, ink, muted, critical — and the theme decides what
they are worth.

## The two layers

`packages/ui/src/theme.css` holds both.

1. **Raw values** as `--wl-*` custom properties, redefined per theme on the
   `<html>` element. Dark is the default: the product is looked at all day, and
   it is the surface the interface was drawn against.
2. **Tailwind's colour scale** built from them in `@theme inline`, so `bg-surface`
   compiles to `background-color: var(--wl-surface)` and follows whichever theme
   is live. Switching themes rewrites no markup and re-renders no component; the
   variables simply resolve differently.

```css
:root, :root[data-theme='dark'], [data-wl-theme='dark'] { --wl-surface: #191817; … }
:root[data-theme='light'], [data-wl-theme='light']      { --wl-surface: #ffffff; … }

@theme inline { --color-surface: var(--wl-surface); … }
```

`[data-wl-theme]` exists so a subtree can opt out of the document's theme. The
one place that uses it is the client's view of an invoice at `/i/[token]`: a
document a client opens should look like a document, not like the agency's
console, so that page is light whatever the operator prefers.

## The tokens

| Role | Token | What it is for |
| --- | --- | --- |
| Elevation | `canvas` | The page behind everything |
| | `surface` | Cards, the sidebar, the header |
| | `raised` | Hover fills, chips, inert wells inside a card |
| | `inset` | Form controls, which sit *into* the surface |
| | `overlay` | The scrim behind a dialog |
| Hairlines | `line` | Separates two things |
| | `line-strong` | Outlines something interactive |
| Type | `ink` | Body copy and headings |
| | `muted` | Secondary text, labels, most table cells |
| | `faint` | Placeholders, column heads, disabled text |
| Brand | `accent` / `accent-hover` | Primary actions, the current-page mark |
| | `accent-ink` | Text *on* the accent |
| | `accent-text` | The accent used as text, darkened for the light theme |
| | `accent-soft` | The accent as a wash, behind a badge |
| Status | `positive` `caution` `critical` `info` | The foreground of a state |
| | `*-soft` | The wash each one sits on |
| | `critical-ink` | Text on a filled destructive button |
| State | `hover` `selected` | Translucent, so they work on any surface |

Radii (`rounded-md|lg|xl`), shadows (`shadow-sm|md|lg`) and the font stacks come
from the same block. Spacing and type scale are Tailwind's own, unchanged — the
defaults are good and a second scale would only be a second thing to remember.

## The components

All of them are exported from `@workloom/ui`.

- **Chrome.** `PageHeader` (title, description, breadcrumb, actions — every page
  opens with one), `Toolbar`, `Separator`, `Placeholder`.
- **Surfaces.** `Card`, `CardHeader`, `CardBody`, `CardFooter`, `Alert`,
  `EmptyState`.
- **Data.** `Table`, `Th`, `Td`, `Tr`, `Badge`, `Avatar`, `Stat`, `Delta`,
  `Meter`, `Kbd`.
- **Forms.** `Field`, `Input`, `Textarea`, `Select`, `SearchInput`, `Checkbox`,
  `Label`.
- **Actions.** `Button`, `IconButton`, `LinkButton`, and `buttonStyles()`.
- **Icons.** A hand-drawn 24×24 stroke set (`HomeIcon`, `SearchIcon`, …). No icon
  dependency: the whole set is a few kilobytes and a self-hosted install pulls
  nothing at build time.

### Styles without the element

Half this app's actions are navigations — "New invoice" is a link, not a form
control — so the button's appearance is available without its element:

```tsx
<Link href="/invoices/new" className={buttonStyles()}>New invoice</Link>
```

`tabStyles(active)`, `pillStyles(active)` and `navItemStyles(active)` exist for
the same reason: every tab strip and filter in Workloom is a set of links,
because a filtered list should be a URL someone can send to a colleague.

## The application frame

`apps/web/components/app-shell.tsx` is the signed-in frame: a sidebar of grouped
sections, a top bar, and the page. It is one client component because the drawer
a narrow screen opens and the rail a wide one collapses to are shared state.
Everything that needs the server — the organization switcher, the running timer,
the sign-out form — is passed in already rendered.

Navigation is described on the server and drawn on the client, so the server
names an icon (`icon: 'invoices'`) and `components/nav-icons.tsx` turns the name
back into a glyph. Sections are filtered by permission, which is a courtesy and
not a control: every page's data comes from a procedure that checks again.

`⌘K` opens a palette that jumps between the sections the viewer can open. It
deliberately does not search records — a box labelled "search" that quietly only
looks at contacts is worse than no box at all.

## Themes

Dark is the default and stays until someone asks otherwise. The choice lives in
`localStorage` under `workloom-theme` and is applied by an inline script in the
root layout, before the first paint, so a light-theme visitor never gets a dark
flash. The toggle is in the top bar.

## Adding to it

- **A new colour** means a new token in both themes, or — far more often — it
  means one of the existing roles already covers it.
- **A new component** belongs in `packages/ui` the second time it is needed, not
  the first. Give it the props the app actually passes, not the props a
  component library would have.
- **A one-off layout** is fine in `apps/web` with utility classes, as long as
  every colour in it is a token.

## What is checked

`pnpm typecheck` and `pnpm lint` cover the code. For the colours, this holds the
line:

```bash
grep -rnE '(text|bg|border|divide|ring)-(neutral|gray|slate|zinc|red|green|amber|blue)-[0-9]' \
  --include='*.tsx' apps/web packages/ui
```

It should print nothing. If it prints something, that line names a crayon
instead of a role, and the theme it breaks is the one nobody had open.
