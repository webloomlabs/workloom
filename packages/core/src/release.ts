/**
 * Which slices have shipped.
 *
 * Several things are declared ahead of the code that fulfils them -- event
 * types an integration can subscribe to early, client-view sections that show
 * as "coming soon". This set is what turns each of those on, and the tests
 * that check a declaration is honoured key off it. Add a slice here as part of
 * its definition of done.
 */
export const SHIPPED_SLICES: ReadonlySet<string> = new Set(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7a'])

export function isShipped(slice: string): boolean {
  return SHIPPED_SLICES.has(slice)
}
