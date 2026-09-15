const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025'

type Summary = { ID: string; Subject: string; To: Array<{ Address: string }> }

/** Waits for the newest message to an address matching `subject`, and returns its first link. */
export async function linkFromEmail(to: string, subject: RegExp, linkPattern: RegExp): Promise<string> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
    const { messages } = (await response.json()) as { messages: Summary[] }
    const match = messages.find((m) => subject.test(m.Subject))
    if (match) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json()) as { Text: string }
      const link = detail.Text.match(linkPattern)?.[0]
      if (link) return link
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`No email to ${to} matching ${subject} arrived within 20s`)
}
