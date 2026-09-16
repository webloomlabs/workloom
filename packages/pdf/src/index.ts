import { renderToBuffer } from '@react-pdf/renderer'
import { documentElement } from './document.ts'
import type { DocumentPdfInput } from './types.ts'

export type { DocumentParty, DocumentPdfInput, DocumentPdfLine } from './types.ts'

/**
 * A quote or invoice as PDF bytes.
 *
 * Pure JavaScript: no headless browser, so it runs the same in a container as
 * on a laptop, and a server rendering an invoice cannot be made to fetch a URL
 * of someone else's choosing.
 */
export async function renderDocumentPdf(input: DocumentPdfInput): Promise<Buffer> {
  return renderToBuffer(documentElement(input))
}
