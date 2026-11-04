import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { receiptReadingSchema, type ReceiptExtractor, type ReceiptFile, type ReceiptHints, type ReceiptReading } from '@workloom/core/modules'
import { INSTRUCTIONS, receiptContext } from './prompt.ts'

/**
 * Reads receipts with Claude: the photo or PDF, the organization's categories,
 * and a schema the answer must fit. A refusal, an error, or an answer that
 * does not parse gives null, which leaves the draft for a person to fill in.
 */
export class ClaudeReceiptReader implements ReceiptExtractor {
  readonly name: string
  private readonly model: string
  private readonly client: Anthropic

  constructor(options: { apiKey: string; model: string; baseURL?: string }) {
    this.name = `anthropic:${options.model}`
    this.model = options.model
    this.client = new Anthropic({ apiKey: options.apiKey, timeout: 60_000, maxRetries: 2, ...(options.baseURL ? { baseURL: options.baseURL } : {}) })
  }

  async read(file: ReceiptFile, hints: ReceiptHints): Promise<ReceiptReading | null> {
    const data = file.bytes.toString('base64')
    const document: Anthropic.ContentBlockParam =
      file.contentType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: file.contentType, data } }

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: INSTRUCTIONS,
      // Reading a receipt is a simple task; low effort keeps it quick and cheap.
      output_config: { effort: 'low', format: zodOutputFormat(receiptReadingSchema) },
      messages: [{ role: 'user', content: [document, { type: 'text', text: receiptContext(hints) }] }],
    })

    // A declined or cut-off answer has nothing to use; the draft stays blank.
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null
    return response.parsed_output ?? null
  }
}
