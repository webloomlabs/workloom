import { env } from '@workloom/config'
import { Card, CardHeader } from '@workloom/ui'

/**
 * How to point an AI assistant at this installation. Shown wherever people
 * manage the credentials an assistant would use.
 */
export function McpConnectCard() {
  const url = `${env.APP_URL.replace(/\/+$/, '')}/api/mcp`
  return (
    <Card>
      <CardHeader
        title="Connect an AI assistant"
        description="ChatGPT, Claude, Cursor, and other MCP clients can work in Workloom as you, limited to what your role and the access you grant allow."
      />
      <div className="space-y-4 p-5 text-sm">
        <div>
          <p className="font-medium text-ink">MCP server URL</p>
          <code className="mt-1 block rounded-md bg-canvas px-3 py-2 font-mono text-xs break-all">{url}</code>
        </div>
        <div>
          <p className="font-medium text-ink">ChatGPT and Claude</p>
          <p className="mt-1 text-muted">
            Add a custom connector with the URL above. You’ll be asked to sign in to Workloom and choose what the
            assistant may do. In Claude: Settings → Connectors → Add custom connector. In ChatGPT: Settings → Apps &amp;
            Connectors → Advanced → Developer mode, then Create.
          </p>
        </div>
        <div>
          <p className="font-medium text-ink">Claude Code, Cursor, and other tools, with an API key</p>
          <code className="mt-1 block rounded-md bg-canvas px-3 py-2 font-mono text-xs break-all">
            {`claude mcp add --transport http workloom ${url} --header "Authorization: Bearer <your API key>"`}
          </code>
        </div>
        <p className="text-muted">
          Actions an assistant takes appear in the audit log as “AI assistant (MCP)”. Disconnect an assistant in
          Settings → Connected apps.
        </p>
      </div>
    </Card>
  )
}
