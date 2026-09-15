import { describe, expect, it } from 'vitest'
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from './context.ts'

/**
 * Next.js can load this module more than once in a production server, so the
 * code that throws an error and the code that catches it may hold different
 * copies of its class. These tests load a second copy and check that errors
 * are still recognised across the two -- the failure they guard against turned
 * every validation message in the UI into "Something went wrong".
 */
describe('error classes across module copies', () => {
  it('recognise instances created by another copy of the module', async () => {
    // A query string makes Vite evaluate the file again as a separate module.
    const specifier = './context.ts?second-copy'
    const copy = (await import(/* @vite-ignore */ specifier)) as typeof import('./context.ts')
    expect(copy.DomainError).not.toBe(DomainError)

    expect(new copy.DomainError('bad', 'code', 'field')).toBeInstanceOf(DomainError)
    expect(new copy.NotFoundError('Thing')).toBeInstanceOf(NotFoundError)
    expect(new copy.ForbiddenError('lead:read')).toBeInstanceOf(ForbiddenError)
    expect(new copy.ConflictError('clash')).toBeInstanceOf(ConflictError)
    expect(new DomainError('bad')).toBeInstanceOf(copy.DomainError)
  })

  it('still tell the error kinds apart', () => {
    expect(new DomainError('bad')).not.toBeInstanceOf(NotFoundError)
    expect(new NotFoundError('Thing')).not.toBeInstanceOf(DomainError)
    expect(new Error('plain')).not.toBeInstanceOf(DomainError)
    expect(null).not.toBeInstanceOf(DomainError)
    expect(new DomainError('bad')).toBeInstanceOf(Error)
  })

  it('keep their fields', () => {
    const error = new DomainError('Unknown time zone', 'unknown_timezone', 'timezone')
    expect(error).toMatchObject({ name: 'DomainError', message: 'Unknown time zone', code: 'unknown_timezone', field: 'timezone' })
  })
})
