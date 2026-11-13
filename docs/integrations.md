# Integrations

Workloom deliberately has **no built-in integrations** in v0.1, and depends on
no external service for anything in the core path. Leads, clients, projects,
time, quotes, invoices, payments and reporting all work with nothing but
PostgreSQL. That is an MVP exit criterion, not an accident.

What it has instead is a complete API and a complete event stream, so anything
you need to connect, you can connect today. See [automation.md](automation.md).

## What you connect yourself

| You want | Use |
| --- | --- |
| Email delivery | SMTP. Any provider. [configuration.md](configuration.md) |
| File storage | A disk, or any S3-compatible service |
| Accounting (Xero, QuickBooks) | The API and webhooks — read invoices and payments out |
| Chat notifications | A webhook endpoint |
| Receipts from a phone | The Telegram bot, below |
| Forms and lead capture | `POST /api/v1/leads` with a narrowly scoped key |
| Reporting and BI | The CSV/JSON exports, or read PostgreSQL directly |
| Payment collection | Out of scope in v0.1. Record payments through the API. |

## Telegram: receipts from a phone

Each organization can connect **its own** Telegram bot (Settings → Telegram).
Make one with [@BotFather](https://t.me/BotFather), paste its token, and choose
how messages arrive:

- **Polling** (the default): the worker asks Telegram for new messages every
  few seconds. Works behind NAT and on a laptop.
- **Webhook**: Telegram sends each message to
  `https://<APP_URL>/api/integrations/telegram/<organization id>`. Needs Workloom
  served over public HTTPS.

Each person then links their own Telegram account: **Link my Telegram** shows
a one-time code (ten minutes) to send the bot. After that, a photo or PDF they
send becomes a **draft** expense with the receipt attached, made as them, with
Confirm and Discard buttons under the bot's reply. If the caption names an
active project (one not completed, cancelled or archived), the expense is filed
under it; otherwise the bot first asks which project it is for, with a button
for each of the ten newest active projects and one for **No project**, and
shows Confirm once they have chosen. Anyone else who messages the
bot only gets told how to link; nothing they send is stored as an expense.

**Several receipts at once.** Photos or PDFs sent together as one album
become **one** draft expense: each receipt is read, their amounts added up,
and every receipt attached. The bot waits until the album has been quiet for
a few seconds, so all of it arrives first. The category is the one the caption
names (`#travel`, or a category's name), otherwise the one most of the
receipts were read as; when they disagree, the reply says so. Receipts in
different currencies cannot be added up, so each currency becomes its own
draft. With reading off, the album is still one draft, with every receipt
attached, for the amount to be filled in.

**Typing an expense.** No receipt? Type it to the bot in a private chat:
`1500 taxi to the client`, `USD 20 Figma #software`, `Lunch with Acme 3,200
yesterday`. The amount is the number with a currency beside it (a code, `$`,
`€`, `£`, `Rs`), otherwise the only or largest number; `today`, `yesterday`
or a `YYYY-MM-DD` date sets the day; `#tag` or a category's name sets the
category; a project's name files it there. The rest is the description. It
becomes a draft with the same buttons. A line with no amount in it is not an
expense: the bot says how to write one. In groups, the bot takes receipts
only, not typed expenses.

**In a group.** An owner or admin chooses **Add the bot to a group** in
Settings → Telegram, which gives Telegram's "add to group" link and a
one-time code. Once a group is approved:

- A photo or PDF posted by someone who has linked their Telegram becomes their
  draft expense. The group sees one line ("Draft expense started for…"); the
  amounts and the Confirm/Discard buttons go to them privately.
- Everyone else in the group is ignored, and in groups that are not approved
  the bot says nothing at all.
- Taking the bot out of the group, or **Remove** in settings, ends it.

Telegram only shows a bot the photos in a group if its **privacy mode is
off** (in @BotFather: `/setprivacy`, choose the bot, Disable) or it is an
admin of the group. Otherwise it sees only commands.

Messages are stored first and handled by the worker, so the worker must be
running. Telegram's update id makes a message delivered twice create one
expense, not two.

### Reading receipts with AI

Receipts can be read by **Anthropic Claude, OpenAI, Google Gemini, or Groq**.
Set the key for one of them on the app and worker (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY`; `RECEIPT_PROVIDER` picks
one when several are set, `RECEIPT_MODEL` changes the model — see
[configuration.md](configuration.md)). An owner or admin can then turn on
**Reading receipts**. Each receipt — from Telegram or dropped on a new
expense — is sent to that provider, and what the model reads (supplier, date,
total, tax, category) fills in the draft.

| Provider | Default model | Reads |
| --- | --- | --- |
| Anthropic | `claude-opus-5-5` | photos and PDFs |
| OpenAI | `gpt-6-luna` | photos and PDFs |
| Google Gemini | `gemini-3.5-flash-lite` | photos and PDFs |
| Groq | `qwen/qwen3.8-27b` | photos only; a PDF is stored unread |

Every provider gets the same instructions and must answer in the same JSON
schema. It is a suggestion: every value
is checked before it is saved, a person confirms the draft, and if reading
fails the draft is simply left blank. HEIC photos are stored but not read.

It is **off by default** for every organization, because it sends receipts —
which can carry names and card digits — to a third party. The settings page
names the provider and model before anyone turns it on.

## Reading the database directly

Nothing stops you pointing a BI tool at PostgreSQL, but connect it as a **role of
its own**, not as `workloom_app`, and remember that a superuser bypasses
row-level security entirely. A read-only role that is subject to the tenant
policies will see nothing unless it sets `workloom.org_id`; a read-only role that
is not subject to them will see every organization at once. Choose deliberately.

## Planned

The client portal, contracts and e-signature, accounting integrations, and
support ticketing are Phase 2 — see [Roadmap.md](../Roadmap.md). The MVP builds
the surfaces they attach to rather than the integrations themselves: the
client-visible flag, the signed-link pattern, and the event catalogue are
already here.
