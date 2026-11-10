import { db, sql } from '@workloom/db'

type LookupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs a credential lookup that cannot know its organization in advance.
 *
 * A presented API key or OAuth token is looked up before the organization is
 * known -- the organization is precisely what the lookup discovers. This
 * transaction sets `workloom.auth_lookup`, which the `*_authentication`
 * policies on api_keys, oauth_tokens, and oauth_grants check. The flag is
 * transaction-local and widens nothing but SELECT on those tables for the
 * length of `fn`. Ordinary access to them remains tenant-scoped.
 *
 * This is the one place the flag is set. A lint rule keeps it that way; see
 * docs/architecture.md.
 */
export async function withAuthLookup<T>(fn: (tx: LookupTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('workloom.auth_lookup', 'on', true)`)
    return fn(tx)
  })
}
