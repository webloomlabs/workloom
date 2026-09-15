import { loadEnv } from '@workloom/config'
import { assertIsolationIntact, closePool } from '@workloom/db'
import { runMaintenance } from './maintenance.ts'
import { deliverDue } from './outbox/deliver.ts'
import { publishPendingEvents } from './outbox/publish.ts'

/**
 * The worker: publishes the outbox, delivers webhooks, and tidies up.
 *
 * Polling, not LISTEN/NOTIFY. A poll every second is invisible load for a
 * Postgres serving an agency, it needs no connection held open, and it cannot
 * miss a wake-up -- a notification lost during a reconnect would strand events
 * until the next one arrived. NOTIFY can be added later purely to cut latency;
 * polling stays as the floor.
 */

const POLL_MS = 1000
const MAINTENANCE_MS = 60 * 60 * 1000
const BATCH = 100

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`worker: ${signal} received, finishing the current batch`)
    stop.abort()
  })
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    stop.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function main() {
  loadEnv()
  // The worker reads every organization's events. Running it as a superuser
  // would silently remove the isolation the rest of the system relies on, so
  // it refuses exactly as the web app does.
  await assertIsolationIntact()
  console.log('worker: tenant isolation verified, dispatching')

  let lastMaintenance = 0
  let consecutiveErrors = 0

  while (!stop.signal.aborted) {
    try {
      let published = 0
      let batch: number
      do {
        batch = await publishPendingEvents(BATCH)
        published += batch
      } while (batch === BATCH && !stop.signal.aborted)

      const attempted = await deliverDue({ limit: 50, concurrency: 10 })

      if (published > 0 || attempted > 0) {
        console.log(`worker: published ${published} event(s), attempted ${attempted} delivery(ies)`)
      }

      if (Date.now() - lastMaintenance > MAINTENANCE_MS) {
        await runMaintenance()
        lastMaintenance = Date.now()
      }

      consecutiveErrors = 0
      if (published === 0 && attempted === 0) await sleep(POLL_MS)
    } catch (error) {
      consecutiveErrors += 1
      // Back off on repeated failures -- a database restart should not produce
      // a log line every second -- but keep trying: the outbox is durable, so
      // nothing is lost while the worker waits.
      const wait = Math.min(POLL_MS * 2 ** consecutiveErrors, 60_000)
      console.error(`worker: cycle failed, retrying in ${wait / 1000}s`, error)
      await sleep(wait)
    }
  }

  await closePool()
  console.log('worker: stopped')
}

main().catch(async (error) => {
  console.error('worker: failed to start\n', error)
  await closePool()
  process.exit(1)
})
