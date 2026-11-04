import { GoogleGenAI } from '@google/genai'
import type { ReceiptExtractor, ReceiptFile, ReceiptHints, ReceiptReading } from '@workloom/core/modules'
import { INSTRUCTIONS, parseReading, RECEIPT_JSON_SCHEMA, receiptContext } from './prompt.ts'

/**
 * Reads receipts with Gemini: the photo or PDF inline, and an answer held to
 * the schema with a JSON response type. A blocked prompt, a cut-off answer,
 * or one that does not parse gives null.
 */
export class GeminiReceiptReader implements ReceiptExtractor {
  readonly name: string
  private readonly model: string
  private readonly client: GoogleGenAI

  constructor(options: { apiKey: string; model: string; baseURL?: string }) {
    this.name = `gemini:${options.model}`
    this.model = options.model
    this.client = new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { timeout: 60_000, ...(options.baseURL ? { baseUrl: options.baseURL } : {}) } })
  }

  async read(file: ReceiptFile, hints: ReceiptHints): Promise<ReceiptReading | null> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: file.contentType, data: file.bytes.toString('base64') } }, { text: receiptContext(hints) }],
        },
      ],
      config: {
        systemInstruction: INSTRUCTIONS,
        responseMimeType: 'application/json',
        responseJsonSchema: RECEIPT_JSON_SCHEMA,
        maxOutputTokens: 4000,
      },
    })

    if (response.promptFeedback?.blockReason) return null
    const finish = response.candidates?.[0]?.finishReason
    if (finish && finish !== 'STOP') return null
    return parseReading(response.text)
  }
}
