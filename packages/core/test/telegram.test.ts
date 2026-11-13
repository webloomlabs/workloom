import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from '@workloom/db'
import { startTestDatabase, loadDbWithEnv, type TestDatabase } from '@workloom/db/testing'
import { FAKE_TOKEN, FakeTelegram } from './fake-telegram.ts'

/**
 * The Telegram bot (S19), against a fake Telegram and a fake receipt reader:
 * linking an account, a photo becoming a draft expense as the person who sent
 * it, the buttons under it, and everything that must be refused -- strangers,
 * stale codes, the same update twice, a forged webhook.
 */

let database: TestDatabase
let mod: Awaited<ReturnType<typeof loadDbWithEnv>>
let core: typeof import('../src/index.ts')
let registry: typeof import('../src/registry/index.ts')
let modules: typeof import('../src/modules/index.ts')

const telegram = new FakeTelegram()
const ORG = '01a0dd00-0000-7000-8000-0000000019aa'
const OTHER = '01a0dd00-0000-7000-8000-0000000019bb'
let owner: string
let developer: string
let manager: string
let otherOwner: string

beforeAll(async () => {
  process.env.TELEGRAM_API_BASE = await telegram.start()
  // An HTTPS address, so webhook mode can be set up; and a key, so reading can be turned on.
  process.env.APP_URL = 'https://workloom.example'
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used'
  database = await startTestDatabase()
  mod = await loadDbWithEnv(database.url)
  await mod.runMigrations()
  core = await import('../src/index.ts')
  registry = await import('../src/registry/index.ts')
  modules = await import('../src/modules/index.ts')
  owner = core.newId()
  developer = core.newId()
  manager = core.newId()
  otherOwner = core.newId()
  await mod.withoutTenant('test setup', async (db) => {
    await db.execute(sql`insert into organization (id, name, slug, base_currency, timezone) values
      (${ORG}::uuid, 'Webloom', 'webloom-s19', 'LKR', 'Asia/Colombo'), (${OTHER}::uuid, 'Other', 'other-s19', 'LKR', 'Asia/Colombo')`)
    await db.execute(sql`insert into "user" (id, name, email) values
      (${owner}::uuid, 'Shakil', 's19-owner@example.com'), (${developer}::uuid, 'Dev', 's19-dev@example.com'), (${manager}::uuid, 'Manager', 's19-manager@example.com'), (${otherOwner}::uuid, 'Other', 's19-other@example.com')`)
    await db.execute(sql`insert into member (id, organization_id, user_id, role) values
      (${core.newId()}::uuid, ${ORG}::uuid, ${owner}::uuid, 'owner'),
      (${core.newId()}::uuid, ${ORG}::uuid, ${developer}::uuid, 'developer'),
      (${core.newId()}::uuid, ${ORG}::uuid, ${manager}::uuid, 'manager'),
      (${core.newId()}::uuid, ${OTHER}::uuid, ${otherOwner}::uuid, 'owner')`)
  })
  await run('telegramBot.connect', { token: FAKE_TOKEN, mode: 'poll' })
  await run('organization.update', { receiptReadingEnabled: true })
})

afterAll(async () => {
  await telegram.stop()
  await mod?.closePool()
  await database?.stop()
})

type Role = 'owner' | 'developer' | 'manager'
const as = (userId: string, role: Role, organizationId = ORG) => ({ organizationId, actor: { type: 'user' as const, id: userId, label: role }, role, permissions: core.permissionsForRole(role) })
function run<T = any>(name: string, input: unknown, actor = as(owner, 'owner')): Promise<T> {
  return registry.executeProcedure(name, { ...actor, input }) as Promise<T>
}

const reading = {
  isReceipt: true,
  supplier: 'Hostinger',
  description: 'Web hosting, 12 months',
  date: '2026-10-30',
  currency: 'LKR',
  total: '12,500.00',
  tax: null,
  category: 'software',
  paymentMethod: 'card',
}
let extractor: InstanceType<typeof modules.FakeReceiptExtractor>
beforeEach(() => {
  extractor = new modules.FakeReceiptExtractor(reading)
  telegram.clear()
})

let nextUpdate = 1
let nextPerson = 9000
const person = () => ({ id: nextPerson++, first_name: 'Test', last_name: `Person ${nextPerson}` })
type Person = ReturnType<typeof person>
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(core.newId())])

function say(from: Person, text: string) {
  const update = { update_id: nextUpdate++, message: { message_id: nextUpdate, from, chat: { id: from.id, type: 'private' }, date: 0, text } }
  telegram.queue.push(update)
  return update
}
function photo(from: Person, caption?: string, bytes = jpeg()) {
  const fileId = `photo-${nextUpdate}`
  telegram.files.set(fileId, bytes)
  const update = {
    update_id: nextUpdate++,
    message: {
      message_id: nextUpdate,
      from,
      chat: { id: from.id, type: 'private' },
      date: 0,
      ...(caption ? { caption } : {}),
      photo: [
        { file_id: `${fileId}-small`, file_unique_id: 's', width: 90, height: 90, file_size: 10 },
        { file_id: fileId, file_unique_id: 'l', width: 1280, height: 1280, file_size: bytes.byteLength },
      ],
    },
  }
  telegram.queue.push(update)
  return update
}
function press(from: Person, data: string, text?: string) {
  const update = { update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, from, data, message: { message_id: 1, chat: { id: from.id, type: 'private' }, date: 0, ...(text ? { text } : {}) } } }
  telegram.queue.push(update)
  return update
}

/** What the worker does every few seconds: take new updates, then handle them. */
async function deliver() {
  await modules.pollTelegramBots()
  return modules.processTelegramInbox({ extractor })
}

async function linkAs(from: Person, userId: string, role: Role) {
  const { code } = await run<{ code: string }>('messagingIdentity.createLinkCode', {}, as(userId, role))
  say(from, `/start ${code}`)
  await deliver()
  return code
}

const telegramExpenses = async () =>
  (
    await mod.withTenant(ORG, (tx) =>
      tx.execute<{ id: string; status: string; description: string; supplier: string | null; amount_minor: number; category: string; created_by: string; source: string }>(
        sql`select id, status, description, supplier, amount_minor::int as amount_minor, category, created_by, source from expenses where source = 'telegram' order by created_at`,
      ),
    )
  ).rows

describe('connecting a bot', () => {
  it('refuses a token Telegram does not know, and a second bot', async () => {
    telegram.unauthorized = true
    await expect(run('telegramBot.connect', { token: FAKE_TOKEN }, as(otherOwner, 'owner', OTHER))).rejects.toMatchObject({ code: 'token_invalid' })
    telegram.unauthorized = false
    await expect(run('telegramBot.connect', { token: FAKE_TOKEN })).rejects.toMatchObject({ code: 'bot_exists' })
  })

  it('stores the token encrypted and shows who it is', async () => {
    const { bot } = await run('telegramBot.get', {})
    expect(bot).toMatchObject({ username: 'webloom_receipts_bot', mode: 'poll' })
    expect(await run('organization.get', {})).toMatchObject({ receiptReadingEnabled: true, receiptReadingAvailable: true })
    const { rows } = await mod.withTenant(ORG, (tx) => tx.execute<{ token_encrypted: string }>(sql`select token_encrypted from telegram_bots`))
    expect(rows[0]!.token_encrypted).not.toContain(FAKE_TOKEN)
  })

  it('is managed by owners and admins only', async () => {
    await expect(run('telegramBot.update', { paused: true }, as(developer, 'developer'))).rejects.toBeInstanceOf(core.ForbiddenError)
  })
})

describe('linking a Telegram account', () => {
  it('links the sender to the member who made the code, once', async () => {
    const shakil = person()
    const code = await linkAs(shakil, owner, 'owner')
    expect(telegram.messages(shakil.id)).toEqual([expect.stringMatching(/^Linked to Workloom as Shakil/)])

    // The same code again, from someone else: used up.
    const stranger = person()
    say(stranger, `/start ${code}`)
    await deliver()
    expect(telegram.messages(stranger.id)[0]).toMatch(/expired or was already used/)

    const { rows } = await mod.withTenant(ORG, (tx) =>
      tx.execute<{ actor_id: string; source: string }>(sql`select actor_id, source from audit_logs where action = 'messaging_identity.linked' order by created_at desc limit 1`),
    )
    expect(rows[0]).toEqual({ actor_id: owner, source: 'telegram' })
    expect((await run('messagingIdentity.list', {})).data.map((i: any) => i.userId)).toContain(owner)
  })

  it('refuses an expired code, and one made in another organization', async () => {
    const late = person()
    const { code } = await run<{ code: string }>('messagingIdentity.createLinkCode', {})
    await mod.withTenant(ORG, (tx) => tx.execute(sql`update messaging_link_codes set expires_at = now() - interval '1 minute'`))
    say(late, `/start ${code}`)
    await deliver()
    expect(telegram.messages(late.id)[0]).toMatch(/expired/)

    await run('telegramBot.connect', { token: FAKE_TOKEN, mode: 'poll' }, as(otherOwner, 'owner', OTHER))
    const elsewhere = await run<{ code: string }>('messagingIdentity.createLinkCode', {}, as(otherOwner, 'owner', OTHER))
    await run('telegramBot.disconnect', {}, as(otherOwner, 'owner', OTHER))
    const crosser = person()
    say(crosser, `/start ${elsewhere.code}`)
    await deliver()
    expect(telegram.messages(crosser.id)[0]).toMatch(/expired or was already used/)
    expect((await run('messagingIdentity.list', {})).data.some((i: any) => i.userId === otherOwner)).toBe(false)
  })
})

describe('a receipt photo', () => {
  it('from a stranger gets instructions, and nothing is stored', async () => {
    const stranger = person()
    const before = (await telegramExpenses()).length
    photo(stranger)
    await deliver()
    expect(telegram.messages(stranger.id)[0]).toMatch(/I don't know you yet/)
    expect(await telegramExpenses()).toHaveLength(before)
    expect(extractor.calls).toHaveLength(0)
  })

  it('from a linked member becomes a draft expense, read, as them', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    telegram.clear()
    photo(shakil, 'Hosting renewal')
    expect(await deliver()).toBe(1)

    const created = (await telegramExpenses()).at(-1)!
    expect(created).toMatchObject({ status: 'draft', description: 'Web hosting, 12 months', supplier: 'Hostinger', amount_minor: 1_250_000, category: 'software', created_by: owner, source: 'telegram' })
    expect(extractor.calls).toEqual([expect.objectContaining({ contentType: 'image/jpeg', hints: expect.objectContaining({ baseCurrency: 'LKR' }) })])

    const receipts = await run('expenseReceipt.list', { expenseId: created.id })
    expect(receipts.data).toEqual([expect.objectContaining({ contentType: 'image/jpeg', source: 'telegram' })])

    const reply = telegram.calls('sendMessage').at(-1)!.body
    expect(reply.text).toMatch(/Draft expense started: Web hosting/)
    expect(reply.text).toMatch(/Hostinger · LKR\s?12,500\.00 · 2026-10-30/)
    expect(reply.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])
    expect(reply.reply_markup.inline_keyboard[1][0].url).toBe(`https://workloom.example/expenses/${created.id}`)

    const { rows } = await mod.withTenant(ORG, (tx) =>
      tx.execute<{ actor_id: string; source: string }>(sql`select actor_id, source from audit_logs where action = 'expense.created' and entity_id = ${created.id}::uuid`),
    )
    expect(rows).toEqual([{ actor_id: owner, source: 'telegram' }])
  })

  it('arriving twice is one expense', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const before = (await telegramExpenses()).length
    photo(shakil)
    await deliver()
    // Telegram hands the same update out again (the offset was lost): stored once.
    await mod.withTenant(ORG, (tx) => tx.execute(sql`update telegram_bots set last_update_id = null`))
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before + 1)
  })

  it('still starts a blank draft when reading fails', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    extractor.answer = new Error('overloaded')
    photo(shakil, 'Lunch with Kyla')
    await deliver()
    expect((await telegramExpenses()).at(-1)).toMatchObject({ status: 'draft', description: 'Lunch with Kyla', amount_minor: 0 })
  })

  it('is not read when the organization has reading turned off', async () => {
    await run('organization.update', { receiptReadingEnabled: false })
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil)
    await deliver()
    expect(extractor.calls).toHaveLength(0)
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/Fill in the amount in Workloom/)
    await run('organization.update', { receiptReadingEnabled: true })
  })

  it('that is not a photo or PDF is turned away', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const before = (await telegramExpenses()).length
    photo(shakil, undefined, Buffer.from('<html>not a receipt</html>'))
    await deliver()
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/only take photos/)
    expect(await telegramExpenses()).toHaveLength(before)
  })
})

describe('the buttons under a draft', () => {
  async function draftFrom(from: Person) {
    photo(from)
    await deliver()
    return (await telegramExpenses()).at(-1)!.id
  }

  it('confirm as the person who pressed, and only once', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const id = await draftFrom(shakil)

    // A manager records expenses but may not confirm someone else's, from Telegram or anywhere.
    const colleague = person()
    await linkAs(colleague, manager, 'manager')
    press(colleague, `x:c:${id}`)
    await deliver()
    expect(telegram.calls('answerCallbackQuery').at(-1)!.body.text).toBe('You are not allowed to do that.')

    press(shakil, `x:c:${id}`)
    press(shakil, `x:c:${id}`)
    await deliver()
    const [confirmed] = (await telegramExpenses()).filter((e) => e.id === id)
    expect(confirmed!.status).toBe('confirmed')
    const { rows } = await mod.withTenant(ORG, (tx) =>
      tx.execute(sql`select 1 from events where type = 'expense.confirmed' and data->>'id' = ${id}`),
    )
    expect(rows).toHaveLength(1)
    expect(telegram.calls('editMessageText').at(-1)!.body.text).toMatch(/^Confirmed as EXP-/)
  })

  it('discard the draft', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const id = await draftFrom(shakil)
    press(shakil, `x:d:${id}`)
    await deliver()
    expect((await telegramExpenses()).some((e) => e.id === id)).toBe(false)
  })

  it('refuse a blank draft until it has an amount', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    extractor.answer = null
    const id = await draftFrom(shakil)
    press(shakil, `x:c:${id}`)
    await deliver()
    expect(telegram.calls('answerCallbackQuery').at(-1)!.body.text).toMatch(/Enter what it cost/)
  })
})

describe('a link that has ended', () => {
  it('is ignored once revoked', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const mine = (await run('messagingIdentity.list', {})).data.at(-1)
    await run('messagingIdentity.revoke', { id: mine.id })
    photo(shakil)
    await deliver()
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/I don't know you yet/)
  })

  it('is ignored when the member has left the organization', async () => {
    const leaver = core.newId()
    await mod.withoutTenant('test setup', async (db) => {
      await db.execute(sql`insert into "user" (id, name, email) values (${leaver}::uuid, 'Leaver', 's19-leaver@example.com')`)
      await db.execute(sql`insert into member (id, organization_id, user_id, role) values (${core.newId()}::uuid, ${ORG}::uuid, ${leaver}::uuid, 'manager')`)
    })
    const them = person()
    await linkAs(them, leaver, 'manager')
    await mod.withoutTenant('test: remove member', (db) => db.execute(sql`delete from member where user_id = ${leaver}::uuid`))
    const before = (await telegramExpenses()).length
    photo(them)
    await deliver()
    expect(telegram.messages(them.id).at(-1)).toMatch(/I don't know you yet/)
    expect(await telegramExpenses()).toHaveLength(before)
  })
})

describe('the webhook', () => {
  it('stores only what carries the bot’s own secret, once', async () => {
    await run('telegramBot.connect', { token: FAKE_TOKEN, mode: 'webhook' }, as(otherOwner, 'owner', OTHER))
    const setWebhook = telegram.calls('setWebhook').at(-1)!.body
    expect(setWebhook.url).toBe(`https://workloom.example/api/integrations/telegram/${OTHER}`)
    const secret = setWebhook.secret_token as string
    const update = { update_id: 777, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 0, text: 'hi' } }

    expect(await modules.receiveTelegramWebhook(OTHER, 'wrong', update)).toBe('refused')
    expect(await modules.receiveTelegramWebhook(OTHER, null, update)).toBe('refused')
    // The right secret at another organization's address: refused, not stored there.
    expect(await modules.receiveTelegramWebhook(ORG, secret, update)).toBe('refused')
    expect(await modules.receiveTelegramWebhook(OTHER, secret, update)).toBe('stored')
    expect(await modules.receiveTelegramWebhook(OTHER, secret, update)).toBe('duplicate')

    const { rows } = await mod.withTenant(OTHER, (tx) => tx.execute(sql`select 1 from telegram_updates`))
    expect(rows).toHaveLength(1)
    const inA = await mod.withTenant(ORG, (tx) => tx.execute(sql`select 1 from telegram_updates where update_id = 777`))
    expect(inA.rows).toHaveLength(0)
  })
})

describe('a group', () => {
  let nextGroup = -1001000
  const group = () => ({ id: nextGroup--, type: 'supergroup', title: `Webloom team ${nextGroup}` })
  type Group = ReturnType<typeof group>

  function inGroup(chat: Group, from: Person, extra: Record<string, unknown>) {
    const update = { update_id: nextUpdate++, message: { message_id: nextUpdate, from, chat, date: 0, ...extra } }
    telegram.queue.push(update)
    return update
  }
  function photoInGroup(chat: Group, from: Person) {
    const fileId = `group-photo-${nextUpdate}`
    telegram.files.set(fileId, jpeg())
    return inGroup(chat, from, { photo: [{ file_id: fileId, file_unique_id: 'g', width: 800, height: 800, file_size: 100 }] })
  }
  async function approve(chat: Group, from: Person) {
    const { code } = await run<{ code: string }>('telegramGroup.createLinkCode', {})
    inGroup(chat, from, { text: `/start@webloom_receipts_bot ${code}` })
    await deliver()
    return code
  }

  it('is silent until an owner or admin approves it', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = group()
    const before = (await telegramExpenses()).length
    photoInGroup(team, shakil)
    inGroup(team, shakil, { text: 'anyone there?' })
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)
    expect(telegram.messages(team.id)).toEqual([])
    await expect(run('telegramGroup.createLinkCode', {}, as(manager, 'manager'))).rejects.toBeInstanceOf(core.ForbiddenError)
  })

  it('is approved by the code Telegram’s add-to-group link carries, once', async () => {
    const team = group()
    const code = await approve(team, person())
    expect(telegram.messages(team.id)).toEqual([expect.stringMatching(/^This group is linked to Workloom/)])
    expect((await run('telegramGroup.list', {})).data.map((g: any) => g.title)).toContain(team.title)
    // The same code in another group: used up.
    const other = group()
    inGroup(other, person(), { text: `/link ${code}` })
    await deliver()
    expect(telegram.messages(other.id)).toEqual([expect.stringMatching(/expired or was already used/)])
    // A person's link code does not approve a group.
    const { code: personal } = await run<{ code: string }>('messagingIdentity.createLinkCode', {})
    const third = group()
    inGroup(third, person(), { text: `/link ${personal}` })
    await deliver()
    expect((await run('telegramGroup.list', {})).data.map((g: any) => g.title)).not.toContain(third.title)
  })

  it('turns a linked member’s receipt into their draft, details sent privately', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = group()
    await approve(team, shakil)
    telegram.clear()
    const before = (await telegramExpenses()).length
    photoInGroup(team, shakil)
    await deliver()

    const created = await telegramExpenses()
    expect(created).toHaveLength(before + 1)
    expect(created.at(-1)).toMatchObject({ status: 'draft', created_by: owner, supplier: 'Hostinger' })
    // The group sees one line; the amounts and buttons go to the sender.
    expect(telegram.messages(team.id)).toEqual([`Draft expense started for Shakil. The details are in your private chat with me.`])
    const privately = telegram.calls('sendMessage').find((c) => c.body.chat_id === String(shakil.id) || c.body.chat_id === shakil.id)!
    expect(privately.body.text).toMatch(/Hostinger · LKR\s?12,500\.00/)
    expect(privately.body.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])
  })

  it('ignores people who have not linked their Telegram', async () => {
    const team = group()
    await approve(team, person())
    telegram.clear()
    const before = (await telegramExpenses()).length
    photoInGroup(team, person())
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)
    expect(telegram.calls('sendMessage')).toEqual([])
  })

  it('stops when the bot is taken out, or the group is removed in Workloom', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = group()
    await approve(team, shakil)
    telegram.queue.push({ update_id: nextUpdate++, my_chat_member: { chat: team, from: shakil, new_chat_member: { status: 'kicked', user: { id: 4242424242 } } } })
    await deliver()
    expect((await run('telegramGroup.list', {})).data.map((g: any) => g.title)).not.toContain(team.title)
    const before = (await telegramExpenses()).length
    photoInGroup(team, shakil)
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)

    const second = group()
    await approve(second, shakil)
    const listed = (await run('telegramGroup.list', {})).data.find((g: any) => g.title === second.title)
    await run('telegramGroup.revoke', { id: listed.id })
    photoInGroup(second, shakil)
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)
  })

  it('takes an album as one expense, with the details sent privately', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = group()
    await approve(team, shakil)
    telegram.clear()
    const before = (await telegramExpenses()).length
    for (let i = 0; i < 3; i++) {
      const update = photoInGroup(team, shakil)
      ;(update.message as Record<string, unknown>).media_group_id = `group-album-${team.id}`
    }
    await modules.pollTelegramBots()
    expect(await modules.processTelegramInbox({ extractor, albumSettleMs: 0 })).toBe(3)
    const created = (await telegramExpenses()).slice(before)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ amount_minor: 3_750_000, created_by: owner })
    expect(telegram.messages(team.id)).toEqual([expect.stringMatching(/^Draft expense started for Shakil/)])
    const privately = telegram.calls('sendMessage').filter((c) => c.body.chat_id === String(shakil.id)).map((c) => c.body.text)
    expect(privately).toEqual([expect.stringMatching(/^Draft expense started: Web hosting, 12 months\n3 receipts, added up/)])
  })

  it('ignores an album from someone not linked', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = group()
    await approve(team, shakil)
    const stranger = person()
    telegram.clear()
    const before = (await telegramExpenses()).length
    for (let i = 0; i < 2; i++) {
      const update = photoInGroup(team, stranger)
      ;(update.message as Record<string, unknown>).media_group_id = `stranger-album-${team.id}`
    }
    await modules.pollTelegramBots()
    await modules.processTelegramInbox({ extractor, albumSettleMs: 0 })
    expect(await telegramExpenses()).toHaveLength(before)
    expect(telegram.calls('sendMessage')).toHaveLength(0)
  })

  it('ignores typed expenses: only receipts are taken in a group', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = group()
    await approve(team, shakil)
    telegram.clear()
    const before = (await telegramExpenses()).length
    inGroup(team, shakil, { text: '1500 taxi to the client' })
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)
    expect(telegram.calls('sendMessage')).toHaveLength(0)
  })

  it('follows a group that becomes a supergroup', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const team = { ...group(), type: 'group' }
    await approve(team, shakil)
    const upgraded = { id: nextGroup--, type: 'supergroup', title: team.title }
    inGroup(team, shakil, { migrate_to_chat_id: upgraded.id })
    await deliver()
    const before = (await telegramExpenses()).length
    photoInGroup(upgraded, shakil)
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before + 1)
  })
})

describe('a typed expense', () => {
  it('with an amount becomes a draft, as the person who typed it', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const before = (await telegramExpenses()).length
    say(shakil, '1500 taxi to the client #travel')
    await deliver()
    const all = await telegramExpenses()
    expect(all).toHaveLength(before + 1)
    const created = all.at(-1)!
    expect(created).toMatchObject({ status: 'draft', description: 'Taxi to the client', amount_minor: 150_000, category: 'travel', created_by: owner, source: 'telegram' })
    // Typed, not read: nothing is sent to a reader.
    expect(extractor.calls).toHaveLength(0)
    expect((await run('expenseReceipt.list', { expenseId: created.id })).data).toEqual([])

    const reply = telegram.calls('sendMessage').at(-1)!.body
    expect(reply.text).toMatch(/^Draft expense started: Taxi to the client\nLKR\s?1,500\.00/)
    expect(reply.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])
    press(shakil, `x:c:${created.id}`)
    await deliver()
    expect((await telegramExpenses()).find((e) => e.id === created.id)!.status).toBe('confirmed')
  })

  it('without an amount is not an expense', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const before = (await telegramExpenses()).length
    say(shakil, 'thanks!')
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/could not find an amount/)
  })

  it('in another currency waits for its rate', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    say(shakil, 'USD 20 Figma')
    await deliver()
    expect((await telegramExpenses()).at(-1)).toMatchObject({ status: 'draft', description: 'Figma', amount_minor: 0 })
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/Enter the USD to LKR rate/)
  })

  it('from a stranger is not an expense', async () => {
    const stranger = person()
    const before = (await telegramExpenses()).length
    say(stranger, '1500 taxi')
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)
    expect(telegram.messages(stranger.id).at(-1)).toMatch(/I don't know you yet/)
  })
})

describe('several receipts sent together', () => {
  /** A reader that answers each receipt in turn. */
  function inTurn(answers: Array<typeof reading | null>) {
    const fake = new modules.FakeReceiptExtractor(null)
    const read = fake.read.bind(fake)
    fake.read = (file, hints) => {
      fake.answer = answers.shift() ?? null
      return read(file, hints)
    }
    return fake
  }
  let nextAlbum = 1
  /** Photos sent as one album: each its own update, sharing a media group id. */
  function album(from: Person, count: number, caption?: string) {
    const id = `album-${nextAlbum++}`
    return Array.from({ length: count }, (_, i) => {
      const update = photo(from, i === 0 ? caption : undefined)
      ;(update.message as Record<string, unknown>).media_group_id = id
      return update
    })
  }
  /** Once the album has gone quiet. */
  const settled = async () => {
    await modules.pollTelegramBots()
    return modules.processTelegramInbox({ extractor, albumSettleMs: 0 })
  }
  const receiptsOf = async (expenseId: string) => (await run('expenseReceipt.list', { expenseId })).data as unknown[]
  const hosting = (total: string, category = 'hosting') => ({ ...reading, total, category })

  it('are one expense, added up, with every receipt -- once the album has gone quiet', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const before = (await telegramExpenses()).length
    extractor = inTurn([hosting('12,500.00'), hosting('2,500.00'), hosting('1,000.00')])
    album(shakil, 3)

    // Just arrived: the rest of the album may still be on its way.
    await deliver()
    expect(await telegramExpenses()).toHaveLength(before)

    expect(await settled()).toBe(3)
    const all = await telegramExpenses()
    expect(all).toHaveLength(before + 1)
    const created = all.at(-1)!
    expect(created).toMatchObject({ status: 'draft', amount_minor: 1_600_000, category: 'hosting', supplier: 'Hostinger', description: 'Web hosting, 12 months' })
    expect(await receiptsOf(created.id)).toHaveLength(3)
    expect(extractor.calls).toHaveLength(3)

    const replies = telegram.messages(shakil.id)
    expect(replies.at(-1)).toMatch(/^Draft expense started: Web hosting, 12 months\n3 receipts, added up into one expense\.\nHostinger · LKR\s?16,000\.00/)
    expect(replies.filter((m) => m.startsWith('Draft expense started'))).toHaveLength(1)

    // Handled: a later round leaves it alone.
    await settled()
    expect(await telegramExpenses()).toHaveLength(before + 1)
  })

  it('are filed under what most were read as, and the sender is told they disagree', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    extractor = inTurn([hosting('100.00', 'software'), hosting('200.00'), hosting('300.00')])
    album(shakil, 3)
    await settled()
    expect((await telegramExpenses()).at(-1)).toMatchObject({ amount_minor: 60_000, category: 'hosting' })
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/different categories \(Software and subscriptions, Hosting\); filed under Hosting/)
  })

  it('are filed under the category the caption names', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    extractor = inTurn([hosting('100.00', 'software'), hosting('200.00')])
    album(shakil, 2, '#travel')
    await settled()
    const created = (await telegramExpenses()).at(-1)!
    expect(created).toMatchObject({ amount_minor: 30_000, category: 'travel' })
    expect(telegram.messages(shakil.id).at(-1)).not.toMatch(/different categories/)
  })

  it('in two currencies are two expenses', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    const before = (await telegramExpenses()).length
    extractor = inTurn([hosting('100.00'), { ...hosting('20.00'), currency: 'USD' }, hosting('300.00')])
    album(shakil, 3)
    await settled()
    const created = (await telegramExpenses()).slice(before)
    expect(created.map((e) => e.amount_minor)).toEqual([40_000, 0])
    expect(await receiptsOf(created[0]!.id)).toHaveLength(2)
    expect(await receiptsOf(created[1]!.id)).toHaveLength(1)
    expect(telegram.messages(shakil.id).at(-1)).toMatch(/Enter the USD to LKR rate/)
  })

  it('are one blank expense when reading is off', async () => {
    await run('organization.update', { receiptReadingEnabled: false })
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    album(shakil, 2, 'Team dinner')
    await settled()
    const created = (await telegramExpenses()).at(-1)!
    expect(created).toMatchObject({ status: 'draft', description: 'Team dinner', amount_minor: 0 })
    expect(await receiptsOf(created.id)).toHaveLength(2)
    expect(extractor.calls).toHaveLength(0)
    await run('organization.update', { receiptReadingEnabled: true })
  })
})

// Last: the projects made here would change what every receipt above is asked.
describe('the project of a receipt', () => {
  let website: { id: string; name: string }
  let app: { id: string; name: string }
  beforeAll(async () => {
    website = await run('project.create', { name: 'Acme Website', status: 'in_progress' })
    app = await run('project.create', { name: 'Kyla App' })
    await run('project.create', { name: 'Old Cancelled Thing', status: 'cancelled' })
    const done = await run('project.create', { name: 'Finished Work' })
    await mod.withTenant(ORG, (tx) => tx.execute(sql`update projects set status = 'completed', completed_at = now() where id = ${done.id}::uuid`))
  })

  const projectOf = async (expenseId: string) =>
    (await mod.withTenant(ORG, (tx) => tx.execute<{ project_id: string | null; notes: string | null; description: string }>(sql`select project_id, notes, description from expenses where id = ${expenseId}::uuid`))).rows[0]!
  const lastReply = () => telegram.calls('sendMessage').at(-1)!.body
  const buttons = (body: any) => (body.reply_markup.inline_keyboard as any[][]).flat()

  it('is asked for, from the active projects, when the caption names none', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil, 'Bus to the client')
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    expect((await projectOf(id)).project_id).toBeNull()

    const reply = lastReply()
    expect(reply.text).toMatch(/Which project is this for\?$/)
    const labels = buttons(reply).map((b: any) => b.text)
    expect(labels).toEqual(['Acme Website', 'Kyla App', 'No project', 'Discard', 'Open in Workloom'])
    // No Confirm until a project is chosen.
    expect(labels).not.toContain('Confirm')

    const choice = buttons(reply).find((b: any) => b.text === 'Acme Website')
    press(shakil, choice.callback_data, reply.text)
    await deliver()
    expect((await projectOf(id)).project_id).toBe(website.id)
    expect(telegram.calls('answerCallbackQuery').at(-1)!.body.text).toBe('Filed under Acme Website')
    const edited = telegram.calls('editMessageText').at(-1)!.body
    expect(edited.text).toMatch(/^Draft expense started: Web hosting/)
    expect(edited.text).toMatch(/\nProject: Acme Website$/)
    expect(edited.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])

    press(shakil, `x:c:${id}`)
    await deliver()
    expect((await telegramExpenses()).find((e) => e.id === id)!.status).toBe('confirmed')
  })

  it('can be left empty', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil)
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    const none = buttons(lastReply()).find((b: any) => b.text === 'No project')
    press(shakil, none.callback_data, lastReply().text)
    await deliver()
    expect((await projectOf(id)).project_id).toBeNull()
    const edited = telegram.calls('editMessageText').at(-1)!.body
    expect(edited.text).toMatch(/\nProject: none$/)
    expect(edited.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])
  })

  it('is taken from the caption, and not asked', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil, 'Taxi for the kyla app launch')
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    expect(await projectOf(id)).toMatchObject({ project_id: app.id, notes: 'Taxi for the kyla app launch' })
    expect(lastReply().text).toMatch(/\nProject: Kyla App$/)
    expect(lastReply().reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])

    // A caption that is only the project's name is not kept as a note.
    extractor.answer = null
    photo(shakil, 'Acme Website')
    await deliver()
    const second = (await telegramExpenses()).at(-1)!.id
    expect(await projectOf(second)).toMatchObject({ project_id: website.id, notes: null, description: 'Receipt' })
  })

  it('is asked for when the caption names two, or a finished one', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil, 'Split between Acme Website and Kyla App')
    photo(shakil, 'Finished Work')
    await deliver()
    for (const e of (await telegramExpenses()).slice(-2)) expect((await projectOf(e.id)).project_id).toBeNull()
    for (const m of telegram.messages(shakil.id).slice(-2)) expect(m).toMatch(/Which project is this for\?$/)
  })

  it('is taken from a typed expense too', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    say(shakil, '1500 taxi for the kyla app launch')
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    expect(await projectOf(id)).toMatchObject({ project_id: app.id, description: 'Taxi for the kyla app launch' })
    expect(lastReply().text).toMatch(/\nProject: Kyla App$/)
  })

  it('is set only by someone allowed to change the expense', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil)
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    const choice = buttons(lastReply()).find((b: any) => b.text === 'Kyla App')
    const colleague = person()
    await linkAs(colleague, manager, 'manager')
    press(colleague, choice.callback_data)
    await deliver()
    expect(telegram.calls('answerCallbackQuery').at(-1)!.body.text).toBe('You are not allowed to do that.')
    expect((await projectOf(id)).project_id).toBeNull()
  })
})

// After the projects: the accounts made here are offered under every draft from now on.
describe('the account an expense was paid from', () => {
  let card: { id: string; name: string }
  beforeAll(async () => {
    await run('bankAccount.create', { name: 'Sampath current', openingBalanceMinor: 10_000_000, openingBalanceOn: '2026-01-01' })
    card = await run('bankAccount.create', { name: 'Amex card', kind: 'credit_card', openingBalanceOn: '2026-01-01' })
    // Not offered: another currency, and a closed account.
    await run('bankAccount.create', { name: 'Wise USD', currency: 'USD', openingBalanceOn: '2026-01-01' })
    const closed = await run('bankAccount.create', { name: 'Old savings', openingBalanceOn: '2026-01-01' })
    await run('bankAccount.archive', { id: closed.id })
  })

  const lastReply = () => telegram.calls('sendMessage').at(-1)!.body
  const buttons = (body: any) => (body.reply_markup.inline_keyboard as any[][]).flat()
  const accountOf = async (expenseId: string) =>
    (await mod.withTenant(ORG, (tx) => tx.execute<{ bank_account_id: string | null }>(sql`select bank_account_id from expenses where id = ${expenseId}::uuid`))).rows[0]!.bank_account_id

  it('is asked once the project is chosen, and taken from that account on confirm', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    photo(shakil, 'Bus to the client')
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    const question = lastReply()
    expect(question.text).toMatch(/Which project is this for\?$/)

    press(shakil, buttons(question).find((b: any) => b.text === 'No project').callback_data, question.text)
    await deliver()
    const asked = telegram.calls('editMessageText').at(-1)!.body
    expect(asked.text).toMatch(/\nProject: none\nWhich account was this paid from\?$/)
    // The default first, then by name; never another currency or a closed account.
    expect(buttons(asked).map((b: any) => b.text)).toEqual(['Sampath current (default)', 'Amex card', 'No account', 'Discard', 'Open in Workloom'])

    press(shakil, buttons(asked).find((b: any) => b.text === 'Amex card').callback_data, asked.text)
    await deliver()
    expect(await accountOf(id)).toBe(card.id)
    expect(telegram.calls('answerCallbackQuery').at(-1)!.body.text).toBe('Paid from Amex card')
    const answered = telegram.calls('editMessageText').at(-1)!.body
    expect(answered.text).toMatch(/\nProject: none\nPaid from: Amex card$/)
    expect(answered.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])

    press(shakil, `x:c:${id}`)
    await deliver()
    // Confirmed: the receipt's total has left the account.
    expect((await run('bankAccount.get', { id: card.id })).currentBalanceMinor).toBe(-1_250_000)
  })

  it('can be left empty', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    say(shakil, '1500 taxi for the kyla app launch')
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    // The project was named, so the account is the first question.
    const question = lastReply()
    expect(question.text).toMatch(/\nProject: Kyla App\nWhich account was this paid from\?$/)
    press(shakil, buttons(question).find((b: any) => b.text === 'No account').callback_data, question.text)
    await deliver()
    expect(await accountOf(id)).toBeNull()
    const answered = telegram.calls('editMessageText').at(-1)!.body
    expect(answered.text).toMatch(/\nPaid from: no account$/)
    expect(answered.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Confirm', 'Discard'])
  })

  it('is set only by someone allowed to change the expense', async () => {
    const shakil = person()
    await linkAs(shakil, owner, 'owner')
    say(shakil, '1500 taxi for the kyla app launch')
    await deliver()
    const id = (await telegramExpenses()).at(-1)!.id
    const choice = buttons(lastReply()).find((b: any) => b.text === 'Sampath current (default)')
    const colleague = person()
    await linkAs(colleague, manager, 'manager')
    press(colleague, choice.callback_data)
    await deliver()
    expect(telegram.calls('answerCallbackQuery').at(-1)!.body.text).toBe('You are not allowed to do that.')
    expect(await accountOf(id)).toBeNull()
  })
})
