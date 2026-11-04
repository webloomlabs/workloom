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
function press(from: Person, data: string) {
  const update = { update_id: nextUpdate++, callback_query: { id: `cb-${nextUpdate}`, from, data, message: { message_id: 1, chat: { id: from.id, type: 'private' }, date: 0 } } }
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
