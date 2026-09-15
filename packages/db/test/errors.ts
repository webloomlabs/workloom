/**
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose message is
 * "Failed query: ...", putting the PostgreSQL error -- the part carrying the
 * constraint or policy that actually fired -- on `cause`. Asserting against
 * the outer message therefore silently passes for the wrong reason, so tests
 * unwrap first.
 */
export function pgErrorMessage(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

/** Runs `fn`, expecting it to reject, and returns the full error text. */
export async function captureError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    return pgErrorMessage(error)
  }
  throw new Error('expected the operation to be rejected, but it succeeded')
}
