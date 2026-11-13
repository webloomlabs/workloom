import { isCurrencyCode } from '../../money/currency.ts'
import { readAmount, receiptDate, type ReceiptDraft, type ReceiptHints } from './receipt-extraction.ts'

/**
 * Expenses from what people send the bot, besides a single receipt: a typed
 * line such as "1500 taxi to the client", and several receipts sent together
 * that are one expense.
 *
 * Both end as a `ReceiptDraft` -- the same shape reading a receipt gives -- so
 * they become a draft expense the same way, for a person to confirm. Pure:
 * tested on their own.
 */

/** Who filled in a draft from a typed message, for the record kept on the expense. */
export const TYPED_READER = 'message'

/** A draft made from several receipts: the total, and what each one said. */
export type CombinedDraft = ReceiptDraft & { receipts: Array<ReceiptDraft | null> }

const comparable = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/** Whether `name` appears in `text` as whole words. Both already comparable. */
function mentions(text: string, name: string): boolean {
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(text)
}

/**
 * The category a message names: `#travel`, or a category's key or name as
 * whole words ("travel", "Hosting"). "Other" is never named -- it is what is
 * left when nothing else is. Two different categories named is no answer.
 */
export function categoryNamed(text: string | null | undefined, categories: ReceiptHints['categories']): string | null {
  if (!text?.trim()) return null
  const said = comparable(text)
  const tags = [...said.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]!.replace(/[_-]/g, ' '))
  const candidates = categories.filter((c) => c.key !== 'other')
  const tagged = candidates.filter((c) => tags.some((t) => t === comparable(c.key).replace(/[_-]/g, ' ') || t === comparable(c.name)))
  if (tagged.length > 0) return tagged[0]!.key
  const found = candidates.filter((c) => mentions(said, comparable(c.key)) || mentions(said, comparable(c.name)))
  return found.length === 1 ? found[0]!.key : null
}

/** Currency codes people type in lower case. Others count only in capitals: "all", "top" and "cup" are words too. */
const COMMON_CODES = new Set(['usd', 'eur', 'gbp', 'aud', 'nzd', 'cad', 'sgd', 'lkr', 'inr', 'aed', 'jpy'])
const RUPEES = new Set(['LKR', 'INR', 'PKR', 'NPR', 'MUR', 'SCR'])

/** The currency a marker beside an amount means: a code, a symbol, or "Rs". Null when it is not one. */
function currencyOf(marker: string, base: string): string | null {
  const lower = marker.toLowerCase()
  if (lower === '$') return base.endsWith('D') ? base : 'USD'
  if (lower === '€') return 'EUR'
  if (lower === '£') return 'GBP'
  if (lower === 'rs' || lower === 'rs.') return RUPEES.has(base) ? base : 'INR'
  if (lower === '/-') return base
  if (/^[a-z]{3}$/i.test(marker) && (marker === marker.toUpperCase() || COMMON_CODES.has(lower))) {
    const code = marker.toUpperCase()
    return isCurrencyCode(code) ? code : null
  }
  return null
}

const MARKER = String.raw`[A-Za-z]{3}|[Rr]s\.?|\$|€|£`
/** One word that is an amount: "1500", "1,500.00", "2k", "$20", "Rs.1500", "20usd", "1500/-". */
const MONEY = new RegExp(String.raw`^(?<pre>${MARKER})?(?<num>\d[\d,]*(?:\.\d+)?)(?<k>[kK])?(?<post>${MARKER}|\/-)?$`)

type Candidate = { words: number[]; number: string; thousands: boolean; currency: string | null }

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * A typed line as the start of an expense: "1500 taxi to the client",
 * "USD 20 Figma #software", "Lunch with Acme 3,200 yesterday".
 *
 * The amount is the one with a currency beside it; failing that the only
 * number, or the largest. "yesterday", "today" or a YYYY-MM-DD date set the
 * day; `#tag` or a category's name sets the category. What is left is the
 * description. Null when there is no amount: a line without one is
 * conversation, not an expense.
 */
export function parseExpenseText(text: string, hints: ReceiptHints): ReceiptDraft | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  // A word without the punctuation that ends a phrase: "1500," or "(taxi)".
  const bare = words.map((w) => w.replace(/^[("']+/, '').replace(/[)"'!?;:,]+$/, '').replace(/\.$/, (dot) => (/rs\.$/i.test(w) ? dot : '')))
  const candidates: Candidate[] = []
  bare.forEach((word, i) => {
    const match = MONEY.exec(word)
    if (!match?.groups) return
    const { pre, num, k, post } = match.groups
    const attached = pre ?? post
    let currency = attached ? currencyOf(attached, hints.baseCurrency) : null
    // A marker that is not a currency ("abc123") makes the word not an amount.
    if (attached && !currency) return
    const used = [i]
    if (!currency) {
      // A marker on its own beside it: "LKR 1500", "Rs 1500", "20 USD".
      for (const j of [i - 1, i + 1]) {
        const beside = bare[j] && currencyOf(bare[j]!, hints.baseCurrency)
        if (beside) {
          currency = beside
          used.push(j)
          break
        }
      }
    }
    candidates.push({ words: used, number: num!, thousands: Boolean(k), currency })
  })
  if (candidates.length === 0) return null

  const valueOf = (c: Candidate) => {
    const minor = readAmount(c.number, c.currency ?? hints.baseCurrency)
    return minor === null ? null : c.thousands ? minor * 1000 : minor
  }
  const marked = candidates.filter((c) => c.currency !== null)
  const pick =
    marked[0] ??
    (candidates.length === 1 ? candidates[0]! : candidates.reduce((a, b) => ((valueOf(b) ?? -1) > (valueOf(a) ?? -1) ? b : a)))
  const amountMinor = valueOf(pick)
  if (amountMinor === null || amountMinor <= 0) return null

  const used = new Set(pick.words)
  let incurredOn: string | null = null
  bare.forEach((word, i) => {
    const lower = word.toLowerCase()
    const day = lower === 'today' ? hints.today : lower === 'yesterday' ? shiftDays(hints.today, -1) : receiptDate(word, hints.today)
    if (day && incurredOn === null) {
      incurredOn = day
      used.add(i)
    }
  })

  const category = categoryNamed(text, hints.categories)
  // A tag that named the category has said all it had to.
  words.forEach((word, i) => {
    if (word.startsWith('#') && category && categoryNamed(word, hints.categories) === category) used.add(i)
  })

  const description =
    words
      .filter((_, i) => !used.has(i))
      .join(' ')
      .replace(/^(?:(?:paid|spent|for|on|-|–|—|:)\s+)+/i, '')
      .replace(/[\s,;:\-–—]+$/, '')
      .trim()
      .slice(0, 500) || null

  return {
    supplier: null,
    description: description ? description[0]!.toLocaleUpperCase() + description.slice(1) : null,
    incurredOn,
    currency: pick.currency ?? hints.baseCurrency,
    amountMinor,
    taxMinor: null,
    category,
    paymentMethod: null,
    reader: TYPED_READER,
  }
}

/** The value most of them share, when there is one; ties go to the first seen. */
function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  for (const [value, n] of counts) if (best === null || n > counts.get(best)!) best = value
  return best
}

/** The one value they all share, or null when any differ or none is known. */
function shared<T>(values: Array<T | null>): T | null {
  const known = values.filter((v): v is T => v !== null)
  if (known.length !== values.length || known.length === 0) return null
  return known.every((v) => v === known[0]) ? known[0]! : null
}

/**
 * Several receipts in one currency, as one expense: their amounts added up,
 * the category most of them were read as (or the one the sender named), and
 * what each one said kept alongside. A receipt that could not be read adds
 * nothing to the total -- the sender is told, and fills it in.
 *
 * Null when none of them could be read: the draft is left blank.
 */
export function combineDrafts(drafts: Array<ReceiptDraft | null>, options: { currency: string; category?: string | null }): CombinedDraft | null {
  const read = drafts.filter((d): d is ReceiptDraft => d !== null)
  if (read.length === 0) return null
  const amounts = read.map((d) => d.amountMinor).filter((a): a is number => a !== null)
  const withAmount = read.filter((d) => d.amountMinor !== null)
  const suppliers = [...new Set(read.map((d) => d.supplier).filter((s): s is string => Boolean(s)))]
  const supplier = shared(read.map((d) => d.supplier))
  const description =
    drafts.length === 1
      ? read[0]!.description
      : (shared(read.map((d) => d.description)) ??
        (suppliers.length > 0 && suppliers.length <= 3 ? `${drafts.length} receipts: ${suppliers.join(', ')}` : `${drafts.length} receipts`))
  const dates = read.map((d) => d.incurredOn).filter((d): d is string => d !== null)
  return {
    supplier,
    description: description?.slice(0, 500) ?? null,
    // The day of the last of them: an expense is recorded when it is complete.
    incurredOn: dates.length > 0 ? dates.reduce((a, b) => (b > a ? b : a)) : null,
    currency: options.currency,
    amountMinor: amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) : null,
    // Tax adds up only when every receipt with an amount said what its tax was.
    taxMinor: withAmount.length > 0 && withAmount.every((d) => d.taxMinor !== null) ? withAmount.reduce((a, d) => a + d.taxMinor!, 0) : null,
    category: options.category ?? mostCommon(read.map((d) => d.category).filter((c): c is string => c !== null)),
    paymentMethod: shared(read.map((d) => d.paymentMethod)),
    reader: read[0]!.reader,
    receipts: drafts,
  }
}

/** The categories the receipts were read as, when they do not all agree. Empty when they do. */
export function disagreeingCategories(drafts: Array<ReceiptDraft | null>): string[] {
  const read = [...new Set(drafts.map((d) => d?.category).filter((c): c is string => Boolean(c)))]
  return read.length > 1 ? read : []
}
