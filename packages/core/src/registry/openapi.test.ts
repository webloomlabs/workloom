import { describe, expect, it } from 'vitest'
import '../modules/index.ts'
import { buildOpenApiDocument } from './openapi.ts'

/**
 * The published API description.
 *
 * `docs/openapi.json` is a product surface: people generate clients from it and
 * integrations are built against it. Committing it turns every change to the
 * API into a visible diff in review, which is the whole point -- a breaking
 * change should be something somebody approved, not something that happened.
 *
 * Regenerate after an intended change:
 *
 *   pnpm openapi:update
 */

/** Fixed, so the snapshot does not depend on whose machine generated it. */
const SERVER = 'https://workloom.example.com/api/v1'

describe('the OpenAPI document', () => {
  it('matches what is published in docs/openapi.json', async () => {
    const document = buildOpenApiDocument(SERVER)
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../../../../docs/openapi.json')
  })

  it('describes every route the API actually serves', () => {
    const document = buildOpenApiDocument(SERVER) as { paths: Record<string, Record<string, unknown>> }
    const operations = Object.values(document.paths).flatMap((methods) => Object.keys(methods))
    // A document that lost its operations would still match a snapshot
    // regenerated alongside the mistake; this will not.
    expect(operations.length).toBeGreaterThan(100)
  })
})
