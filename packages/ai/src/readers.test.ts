import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Each provider's reader against a local stand-in for its API: what it sends
 * (the receipt, the instructions, the schema), and what it makes of the answer
 * -- including the refusals and cut-off answers that must leave a draft blank.
 */

let server: Server
let base = ''
let reply: (path: string, body: any) => unknown = () => ({})
const requests: Array<{ path: string; body: any }> = []
let ai: typeof import('./index.ts')

const hints = { baseCurrency: 'LKR', today: '2026-11-04', categories: [{ key: 'software', name: 'Software' }] }
const jpeg = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), contentType: 'image/jpeg' as const }
const pdf = { bytes: Buffer.from('%PDF-1.4 receipt'), contentType: 'application/pdf' as const }
const answer = { isReceipt: true, supplier: 'Hostinger', description: 'Hosting', date: '2026-10-30', currency: 'LKR', total: '12500.00', tax: null, category: 'software', paymentMethod: 'card' }

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused@localhost/unused',
    APP_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    WORKLOOM_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    MAIL_DRIVER: 'memory',
    MAIL_FROM: 'test@example.com',
  })
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    requests.push({ path: request.url ?? '', body })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(reply(request.url ?? '', body)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ai = await import('./index.ts')
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  requests.length = 0
})

const reader = (provider: 'anthropic' | 'openai' | 'gemini' | 'groq', model: string, path = '') => ai.createReceiptReader({ provider, apiKey: 'test-key', model }, `${base}${path}`)

describe('Claude', () => {
  it('sends the photo with the schema, and reads the answer', async () => {
    reply = () => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    expect(await reader('anthropic', 'claude-opus-5-5').read(jpeg, hints)).toEqual(answer)
    const sent = requests[0]!.body
    expect(sent.model).toBe('claude-opus-5-5')
    expect(sent.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } })
    expect(sent.output_config.format.type).toBe('json_schema')
  })

  it('leaves a refusal blank', async () => {
    reply = () => ({ id: 'msg_2', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } })
    expect(await reader('anthropic', 'claude-opus-5-5').read(jpeg, hints)).toBeNull()
  })
})

describe('OpenAI', () => {
  const response = (content: unknown[], status = 'completed') => ({
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    status,
    model: 'gpt-6-luna',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content }],
  })

  it('sends a PDF as a file with strict structured output, and reads the answer', async () => {
    reply = () => response([{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }])
    expect(await reader('openai', 'gpt-6-luna', '/v1').read(pdf, hints)).toEqual(answer)
    const { path, body } = requests[0]!
    expect(path).toBe('/v1/responses')
    expect(body.input[0].content[0]).toMatchObject({ type: 'input_file', file_data: expect.stringMatching(/^data:application\/pdf;base64,/) })
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, schema: { additionalProperties: false } })
    expect(body.text.format.schema.required).toContain('total')
  })

  it('sends a photo as an image', async () => {
    reply = () => response([{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }])
    await reader('openai', 'gpt-6-luna', '/v1').read(jpeg, hints)
    expect(requests[0]!.body.input[0].content[0]).toMatchObject({ type: 'input_image', image_url: expect.stringMatching(/^data:image\/jpeg;base64,/) })
  })

  it('leaves a refusal or a cut-off answer blank', async () => {
    reply = () => response([{ type: 'refusal', refusal: 'No.' }])
    expect(await reader('openai', 'gpt-6-luna', '/v1').read(jpeg, hints)).toBeNull()
    reply = () => response([{ type: 'output_text', text: '{"isReceipt": tr', annotations: [] }], 'incomplete')
    expect(await reader('openai', 'gpt-6-luna', '/v1').read(jpeg, hints)).toBeNull()
  })
})

describe('Gemini', () => {
  it('sends the receipt inline with a JSON schema, and reads the answer', async () => {
    reply = () => ({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] })
    expect(await reader('gemini', 'gemini-3.5-flash-lite').read(pdf, hints)).toEqual(answer)
    const { path, body } = requests[0]!
    expect(path).toContain('/models/gemini-3.5-flash-lite:generateContent')
    expect(body.contents[0].parts[0].inlineData).toMatchObject({ mimeType: 'application/pdf' })
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { additionalProperties: false } })
    expect(JSON.stringify(body.systemInstruction)).toContain('bookkeeping')
  })

  it('leaves a blocked or cut-off answer blank', async () => {
    reply = () => ({ promptFeedback: { blockReason: 'SAFETY' } })
    expect(await reader('gemini', 'gemini-3.5-flash-lite').read(jpeg, hints)).toBeNull()
    reply = () => ({ candidates: [{ content: { role: 'model', parts: [{ text: '{"isRec' }] }, finishReason: 'MAX_TOKENS' }] })
    expect(await reader('gemini', 'gemini-3.5-flash-lite').read(jpeg, hints)).toBeNull()
  })
})

describe('Groq', () => {
  const completion = (content: string, finish = 'stop') => ({
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'qwen/qwen3.8-27b',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: finish }],
  })

  it('sends the photo to the OpenAI-compatible endpoint with a strict schema, and reads the answer', async () => {
    reply = () => completion(JSON.stringify(answer))
    expect(await reader('groq', 'qwen/qwen3.8-27b').read(jpeg, hints)).toEqual(answer)
    const { path, body } = requests[0]!
    expect(path).toBe('/chat/completions')
    expect(body.messages[1].content[0]).toMatchObject({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } })
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } })
  })

  it('does not send a PDF, which its vision models cannot read', async () => {
    expect(await reader('groq', 'qwen/qwen3.8-27b').read(pdf, hints)).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it('reads JSON wrapped in a fence, and leaves anything else blank', async () => {
    reply = () => completion('```json\n' + JSON.stringify(answer) + '\n```')
    expect(await reader('groq', 'qwen/qwen3.8-27b').read(jpeg, hints)).toEqual(answer)
    reply = () => completion('I think it was about 12,500 rupees.')
    expect(await reader('groq', 'qwen/qwen3.8-27b').read(jpeg, hints)).toBeNull()
  })
})

describe('choosing a provider', () => {
  it('takes the one named, or the first with a key, with its default model', async () => {
    const { receiptReaderSettings } = await import('@workloom/config')
    expect(receiptReaderSettings({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' })).toEqual({ provider: 'gemini', apiKey: 'g', model: 'gemini-3.5-flash-lite' })
    expect(receiptReaderSettings({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', RECEIPT_PROVIDER: 'groq', RECEIPT_MODEL: 'meta-models/muse-spark-open' })).toEqual({
      provider: 'groq',
      apiKey: 'q',
      model: 'meta-models/muse-spark-open',
    })
    expect(receiptReaderSettings({})).toBeNull()
  })
})
