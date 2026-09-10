import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Loads the repository-root .env.
 *
 * Workloom is a monorepo but a single deployment: the web app, the worker and
 * the CLI are three entrypoints into one installation, and asking a
 * self-hoster to maintain three .env files would be a poor trade for our
 * internal structure. So configuration lives in one file at the root and
 * every entrypoint reads it through here.
 *
 * Real environment variables always win. A container passing DATABASE_URL must
 * not be silently overridden by a stale .env left in a bind-mounted checkout.
 */

let loaded = false

export function loadDotEnv(startDir = process.cwd()): void {
  if (loaded) return
  loaded = true

  const root = findRepositoryRoot(startDir)
  if (!root) return

  const file = join(root, '.env')
  if (!existsSync(file)) return

  for (const [key, value] of Object.entries(parse(readFileSync(file, 'utf8')))) {
    process.env[key] ??= value
  }
}

function findRepositoryRoot(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Minimal .env parsing: KEY=value, # comments, optional surrounding quotes. */
function parse(contents: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '') result[key] = value
  }
  return result
}
