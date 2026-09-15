import { authGET, authPOST } from '@workloom/auth'

export const runtime = 'nodejs'

/** Better Auth owns sign-up, sign-in, sessions, invitations, and organizations. */
export { authGET as GET, authPOST as POST }
