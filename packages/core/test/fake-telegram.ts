import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A stand-in for Telegram's Bot API, on a local port: enough of it for the
 * bot to connect, poll, download a photo, and reply. Everything the bot sends
 * is recorded for the test to read.
 */

export const FAKE_TOKEN = '4242424242:AAFakeTokenForTestsOnly_abcdefghijklmn'

export type Sent = { method: string; body: Record<string, any> }

export class FakeTelegram {
  readonly sent: Sent[] = []
  /** Updates `getUpdates` will hand out. */
  readonly queue: Array<{ update_id: number; [key: string]: unknown }> = []
  /** Files the bot can download, by file id. */
  readonly files = new Map<string, Buffer>()
  /** Answer every call with 401, as Telegram does for a revoked token. */
  unauthorized = false
  private server: Server | undefined
  url = ''

  async start(): Promise<string> {
    this.server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const path = request.url ?? ''
      const send = (status: number, payload: unknown, raw?: Buffer) => {
        response.writeHead(status, { 'content-type': raw ? 'application/octet-stream' : 'application/json' })
        response.end(raw ?? JSON.stringify(payload))
      }
      const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(path)
      if (file) {
        const bytes = this.files.get(decodeURIComponent(file[1]!))
        return bytes ? send(200, null, bytes) : send(404, { ok: false })
      }
      const call = /^\/bot([^/]+)\/(\w+)$/.exec(path)
      if (!call) return send(404, { ok: false, description: 'Not Found' })
      if (this.unauthorized || call[1] !== FAKE_TOKEN) return send(401, { ok: false, description: 'Unauthorized' })
      const method = call[2]!
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      this.sent.push({ method, body })
      switch (method) {
        case 'getMe':
          return send(200, { ok: true, result: { id: 4242424242, is_bot: true, first_name: 'Webloom', username: 'webloom_receipts_bot' } })
        case 'getUpdates': {
          const offset = (body.offset as number | undefined) ?? 0
          return send(200, { ok: true, result: this.queue.filter((u) => u.update_id >= offset) })
        }
        case 'getFile': {
          const bytes = this.files.get(body.file_id)
          if (!bytes) return send(400, { ok: false, description: 'Bad Request: invalid file_id' })
          return send(200, { ok: true, result: { file_id: body.file_id, file_path: `files/${body.file_id}`, file_size: bytes.byteLength } })
        }
        case 'sendMessage':
          return send(200, { ok: true, result: { message_id: this.sent.length, chat: { id: body.chat_id, type: 'private' }, date: 0, text: body.text } })
        default:
          return send(200, { ok: true, result: true })
      }
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
    return this.url
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  /** What the bot said, in order: one entry per message sent. */
  messages(chatId?: number): string[] {
    return this.sent.filter((s) => s.method === 'sendMessage' && (chatId === undefined || s.body.chat_id === chatId)).map((s) => s.body.text as string)
  }

  calls(method: string): Sent[] {
    return this.sent.filter((s) => s.method === method)
  }

  clear(): void {
    this.sent.length = 0
  }
}
