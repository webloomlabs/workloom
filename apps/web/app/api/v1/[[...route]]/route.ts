import { createApiApp } from '@/lib/api/app'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The public REST API, mounted as a catch-all so that routing is driven by
 * the procedure registry rather than by the filesystem. Adding a procedure
 * adds an endpoint; there is no second place to remember to edit.
 */
const app = createApiApp()

const handler = (request: Request) => app.fetch(request)

export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as DELETE,
  handler as PUT,
  handler as OPTIONS,
}
