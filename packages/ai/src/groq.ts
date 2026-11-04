import OpenAI from 'openai'
import type { ReceiptExtractor, ReceiptFile, ReceiptHints, ReceiptReading } from '@workloom/core/modules'
import { INSTRUCTIONS, parseReading, RECEIPT_JSON_SCHEMA, receiptContext } from './prompt.ts'

/** Groq's OpenAI-compatible endpoint, which its documentation points the OpenAI SDK at. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

/**
 * Reads receipts with a vision model on Groq, through its OpenAI-compatible
 * chat completions. Groq's vision models take images, not PDFs: a PDF is left
 * unread, and its draft blank for a person to fill in.
 */
export class GroqReceiptReader implements ReceiptExtractor {
  readonly name: string
  private readonly model: string
  private readonly client: OpenAI

  constructor(options: { apiKey: string; model: string; baseURL?: string }) {
    this.name = `groq:${options.model}`
    this.model = options.model
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? GROQ_BASE_URL, timeout: 60_000, maxRetries: 2 })
  }

  async read(file: ReceiptFile, hints: ReceiptHints): Promise<ReceiptReading | null> {
    if (file.contentType === 'application/pdf') return null
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${file.contentType};base64,${file.bytes.toString('base64')}` } },
            { type: 'text', text: receiptContext(hints) },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'receipt', schema: RECEIPT_JSON_SCHEMA, strict: true } },
    })
    const choice = completion.choices[0]
    if (!choice || choice.finish_reason !== 'stop' || choice.message.refusal) return null
    return parseReading(choice.message.content)
  }
}
