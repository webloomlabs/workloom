import OpenAI from 'openai'
import type { ReceiptExtractor, ReceiptFile, ReceiptHints, ReceiptReading } from '@workloom/core/modules'
import { INSTRUCTIONS, parseReading, RECEIPT_JSON_SCHEMA, receiptContext } from './prompt.ts'

/**
 * Reads receipts with OpenAI, through the Responses API: the photo as an
 * image, a PDF as a file, and an answer held to the schema by strict
 * structured output. A refusal, a cut-off answer, or one that does not parse
 * gives null.
 */
export class OpenAIReceiptReader implements ReceiptExtractor {
  readonly name: string
  private readonly model: string
  private readonly client: OpenAI

  constructor(options: { apiKey: string; model: string; baseURL?: string }) {
    this.name = `openai:${options.model}`
    this.model = options.model
    this.client = new OpenAI({ apiKey: options.apiKey, timeout: 60_000, maxRetries: 2, ...(options.baseURL ? { baseURL: options.baseURL } : {}) })
  }

  async read(file: ReceiptFile, hints: ReceiptHints): Promise<ReceiptReading | null> {
    const dataUrl = `data:${file.contentType};base64,${file.bytes.toString('base64')}`
    const attachment: OpenAI.Responses.ResponseInputContent =
      file.contentType === 'application/pdf'
        ? { type: 'input_file', filename: 'receipt.pdf', file_data: dataUrl }
        : { type: 'input_image', image_url: dataUrl, detail: 'high' }

    const response = await this.client.responses.create({
      model: this.model,
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content: [attachment, { type: 'input_text', text: receiptContext(hints) }] }],
      text: { format: { type: 'json_schema', name: 'receipt', schema: RECEIPT_JSON_SCHEMA, strict: true } },
      max_output_tokens: 4000,
    })

    if (response.status === 'incomplete') return null
    // A refusal comes back as its own content item instead of the JSON.
    const refused = response.output.some((item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'))
    return refused ? null : parseReading(response.output_text)
  }
}
