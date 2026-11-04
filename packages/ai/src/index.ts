import { env, receiptReaderSettings, type ReceiptReaderSettings } from '@workloom/config'
import { receiptExtractor, setReceiptExtractor, type ReceiptExtractor } from '@workloom/core/modules'
import { ClaudeReceiptReader } from './anthropic.ts'
import { GeminiReceiptReader } from './gemini.ts'
import { GroqReceiptReader } from './groq.ts'
import { OpenAIReceiptReader } from './openai.ts'

export { ClaudeReceiptReader } from './anthropic.ts'
export { GeminiReceiptReader } from './gemini.ts'
export { GroqReceiptReader } from './groq.ts'
export { OpenAIReceiptReader } from './openai.ts'

/** The reader for a provider. `baseURL` is for tests and proxies. */
export function createReceiptReader(settings: ReceiptReaderSettings, baseURL?: string): ReceiptExtractor {
  const options = { apiKey: settings.apiKey, model: settings.model, ...(baseURL ? { baseURL } : {}) }
  switch (settings.provider) {
    case 'anthropic':
      return new ClaudeReceiptReader(options)
    case 'openai':
      return new OpenAIReceiptReader(options)
    case 'gemini':
      return new GeminiReceiptReader(options)
    case 'groq':
      return new GroqReceiptReader(options)
  }
}

/**
 * Installs the receipt reader for this process, from whichever provider's key
 * is configured. Safe to call more than once. Without a key nothing is
 * installed, and receipts are stored for a person to fill in. Returns which
 * provider and model, or null.
 */
export function installReceiptReader(): ReceiptReaderSettings | null {
  const settings = receiptReaderSettings(env)
  if (!settings) return null
  if (!receiptExtractor()) setReceiptExtractor(createReceiptReader(settings))
  return settings
}
