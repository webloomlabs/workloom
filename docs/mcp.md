# AI assistants (MCP)

Workloom is an [MCP](https://modelcontextprotocol.io) server. Connect ChatGPT,
Claude, Cursor, or any other MCP client, and the assistant can look things up and
do work in Workloom: find an overdue invoice, log time against a project, add a
lead, draft a quote.

An assistant acts **as the person who connected it**. It can never do more than
that person's role allows *right now*, narrowed further by whatever access they
chose when connecting. Everything it does goes through the same service layer as
the interface and the API, with the same permission checks, and lands in the
audit log marked **AI assistant (MCP)**.

- **URL:** `https://<your-workloom>/api/mcp`
- **Transport:** Streamable HTTP, stateless, JSON responses
- **Authentication:** OAuth 2.1 (for ChatGPT and Claude), or an API key

## Connecting

### Claude (claude.ai, Claude Desktop)

Settings → Connectors → **Add custom connector**. Paste the URL and connect. You
are sent to Workloom to sign in and choose what Claude may do:

- **Organization**, if you belong to more than one.
- **Full access**, which is everything you can do, or **Restricted**, which is
  only the permissions you tick. For example, read-only everywhere.

Claude registers itself automatically (Dynamic Client Registration), so there is
no client ID to copy.

### ChatGPT

Settings → Apps & Connectors → Advanced → turn on **Developer mode**, then
**Create**. Paste the URL and choose OAuth. The consent screen is the same as
Claude's.

### Claude Code, Cursor, and other tools, with an API key

Create a key in **Settings → API keys**. A restricted key is the safer choice.
Then send the key as a bearer token:

```bash
claude mcp add --transport http workloom https://<your-workloom>/api/mcp \
  --header "Authorization: Bearer wl_live_..."
```

Most clients that take a JSON config accept the same thing:

```json
{
  "mcpServers": {
    "workloom": {
      "type": "http",
      "url": "https://<your-workloom>/api/mcp",
      "headers": { "Authorization": "Bearer wl_live_..." }
    }
  }
}
```

## What an assistant can do

Every procedure, the same operations the REST API offers, is a tool, named after
it: `invoice.list` is `invoice_list` and `timeEntry.create` is
`timeEntry_create`. An assistant is offered only the tools its credential
permits, so a read-only connection sees only read tools. New features become
tools automatically.

Tools carry hints that clients use to decide when to ask before acting. Reads are
marked read-only. Deletions, cancellations and the like are marked destructive.
Sending an invoice or quote is marked as reaching outside Workloom.

Some operations are **never offered to an assistant**, whatever its access, because
a prompt-injected assistant could misuse them:

| Withheld | Why |
| --- | --- |
| `apiKey.create`, `apiKey.revoke`, `oauthGrant.revoke` | Credentials are managed by people |
| `webhook.*` changes, `webhook.test`, `webhookDelivery.retry` | A webhook streams records to any URL |
| `organization.update` | Includes the payment details printed on invoices |
| `member.remove` | Access control |
| `books.unlock` | Reopening a closed period is an accountant's decision |
| `documentSequence.update` | Invoice numbering must stay deliberate |
| Telegram bot and account-linking changes | Integration credentials |
| File uploads (receipts, attachments, documents, logo) | A JSON tool call cannot carry a file |

The list is the `mcp: false` flag on each procedure, and a unit test keeps a
snapshot of it, so any change to it shows up in review.

## Managing connections

**Settings → Connected apps** lists the assistants connected through OAuth.
Everyone sees and can disconnect their own; owners and admins see and can
disconnect everyone's. Disconnecting takes effect on the assistant's next request.

Connections also end on their own:

- **Demoting** someone narrows their connected apps immediately.
- **Removing** someone from the organization ends their connected apps immediately.
- **Reconnecting** the same app replaces the earlier connection.
- A **refresh token used twice** (after a short grace period for clients that
  refresh twice at once) is treated as stolen, and the whole connection is revoked.

## How the OAuth server works

Workloom is its own authorization server. Better Auth has no OAuth provider, and
the rules that matter are Workloom's own: a grant is an API key in all but name.

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/api/mcp` | RFC 9728: which server authorizes the MCP endpoint |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: endpoints and capabilities |
| `POST /api/oauth/register` | RFC 7591 Dynamic Client Registration |
| `GET /oauth/authorize` | The consent screen |
| `POST /api/oauth/token` | Authorization code (PKCE S256 required) and refresh token grants |
| `POST /api/oauth/revoke` | RFC 7009; revoking either token ends the connection |

- **Token lifetimes:** access tokens (`wl_oat_…`) last an hour. Refresh tokens
  (`wl_ort_…`) last 60 days and are rotated on every use. Both are opaque and
  stored as SHA-256 digests, like API keys.
- **Audience:** tokens are bound to `https://<your-workloom>/api/mcp`
  (RFC 8707). They are refused by the REST API, and API keys are accepted at both.
- **Registered redirect URIs** must be `https`, `http` on localhost, or a
  private-use scheme. Registrations nobody connects within a day are removed by
  the worker.
- **Consent screen:** it names the app as it named itself, and shows where you
  will be returned (for example `claude.ai`). Only allow an app you started
  connecting yourself.

`APP_URL` must be the public `https://` address people use. The issuer, the
resource, and every URL in the metadata derive from it, and clients compare them
exactly.

## Trying it

```bash
# Unauthenticated: 401, with the metadata URL in WWW-Authenticate
curl -i -X POST https://<your-workloom>/api/mcp

# With an API key
curl https://<your-workloom>/api/mcp \
  -H "Authorization: Bearer wl_live_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, and either
add the `Authorization` header or use its OAuth flow.
