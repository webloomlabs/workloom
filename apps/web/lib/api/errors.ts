import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@workloom/core'
import { ZodError } from 'zod'

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: Array<{ path: string; message: string }>
    request_id: string
  }
}

/**
 * Maps a thrown error onto the wire.
 *
 * Two decisions are load-bearing:
 *
 * 1. NotFoundError produces 404 even when the real cause is "this belongs to
 *    another organization". A 403 would confirm that the id exists somewhere,
 *    which leaks the existence of other tenants' records.
 *
 * 2. Unrecognised errors return a generic message. Postgres error text can
 *    carry column names, constraint names, and fragments of values; the
 *    detail belongs in the server log, indexed by request_id, not in a
 *    response to whoever triggered it.
 */
export function toApiError(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorBody } {
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'invalid_request',
          message: 'The request body failed validation.',
          details: error.issues.map((i) => ({
            path: i.path.join('.') || '(root)',
            message: i.message,
          })),
          request_id: requestId,
        },
      },
    }
  }

  if (error instanceof ForbiddenError) {
    return {
      status: 403,
      body: {
        error: {
          code: 'forbidden',
          message: `This action requires the "${error.permission}" permission.`,
          request_id: requestId,
        },
      },
    }
  }

  if (error instanceof NotFoundError) {
    return {
      status: 404,
      body: { error: { code: 'not_found', message: error.message, request_id: requestId } },
    }
  }

  if (error instanceof DomainError) {
    return {
      status: 422,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.field ? { details: [{ path: error.field, message: error.message }] } : {}),
          request_id: requestId,
        },
      },
    }
  }

  if (error instanceof ConflictError) {
    return {
      status: 409,
      body: { error: { code: 'conflict', message: error.message, request_id: requestId } },
    }
  }

  console.error(`[${requestId}] unhandled error`, error)
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'Something went wrong. Quote the request id if you report this.',
        request_id: requestId,
      },
    },
  }
}
