import { buildDueTaxPacks, pollTelegramBots, processTelegramInbox } from '@workloom/core/modules'

/**
 * The bot's two loops, one pass each: ask Telegram for new messages for bots
 * that poll, then work through every organization's inbox. Webhook bots only
 * need the second -- their messages are stored by the web app as they arrive.
 * Each catches its own failure, so neither can stop the other or the worker.
 */
export async function runTelegram(): Promise<void> {
  try {
    const polled = await pollTelegramBots()
    if (polled > 0) console.log(`worker: took ${polled} Telegram update(s)`)
  } catch (error) {
    console.error('worker: Telegram polling failed', error)
  }
  try {
    const processed = await processTelegramInbox()
    if (processed > 0) console.log(`worker: handled ${processed} Telegram update(s)`)
  } catch (error) {
    console.error('worker: Telegram inbox failed', error)
  }
}

/** Builds tax packs people have asked for. Rare, and slow when it happens, so it runs on its own. */
export async function runTaxPacks(): Promise<void> {
  try {
    const built = await buildDueTaxPacks()
    if (built > 0) console.log(`worker: built ${built} tax pack(s)`)
  } catch (error) {
    console.error('worker: building tax packs failed', error)
  }
}
