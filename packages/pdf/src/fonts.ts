import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
 * Where the font files are, at runtime.
 *
 * Beside this module when the application runs from the repository. A bundled
 * server -- the container -- compiles this file into a chunk somewhere else
 * entirely, so it sets `WORKLOOM_FONT_DIR` instead and nothing has to guess.
 *
 * Built from `fileURLToPath(import.meta.url)` rather than `new URL('../fonts',
 * …)`, because a bundler reads the second as a module reference and tries to
 * resolve a directory it cannot.
 */
function directory(): string {
  const configured = process.env.WORKLOOM_FONT_DIR
  if (configured) return configured
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts')
}

function file(name: string): string {
  const path = join(directory(), name)
  if (!existsSync(path)) {
    // Loudly, and once, rather than as blank boxes on a client's invoice.
    throw new Error(
      `Font not found: ${path}. Set WORKLOOM_FONT_DIR to the directory holding ` +
        `the .ttf files shipped in packages/pdf/fonts.`,
    )
  }
  return path
}

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
