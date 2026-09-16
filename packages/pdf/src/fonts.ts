import { fileURLToPath } from 'node:url'
import { Font } from '@react-pdf/renderer'

/**
 * The font the documents are drawn in, embedded rather than referenced.
 *
 * A PDF that names a font the reader does not have renders as empty boxes, and
 * the standard PDF fonts cover little beyond Latin-1. Noto Sans is embedded
 * (subsetted by the renderer, so a page costs a few kilobytes) and covers
 * Latin, Greek, Cyrillic, and Vietnamese. Scripts beyond those -- CJK, Arabic,
 * Devanagari -- need their own font; see docs/configuration.md.
 *
 * SIL Open Font License 1.1: ../fonts/OFL.txt.
 */
export const FONT_FAMILY = 'Noto Sans'

/**
 * An absolute path, not a URL or a buffer: the renderer reads the file itself.
 * A deployment that bundles the server (S10's container) must copy ../fonts
 * alongside it.
 */
const file = (name: string) => fileURLToPath(new URL(`../fonts/${name}`, import.meta.url))

let registered = false

export function registerFonts(): void {
  if (registered) return
  Font.register({
    family: FONT_FAMILY,
    fonts: [
      { src: file('NotoSans-Regular.ttf') },
      { src: file('NotoSans-Bold.ttf'), fontWeight: 700 },
    ],
  })
  // Long descriptions break anywhere rather than running off the page.
  Font.registerHyphenationCallback((word) => [word])
  registered = true
}
