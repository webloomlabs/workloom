import { env } from '@workloom/config'
import { newId } from '@workloom/core/ids'
// The auth tables are not tenant-scoped, so Better Auth is one of the few
// places permitted to use the unscoped client. See docs/architecture.md.
import { db, desc, eq, schema } from '@workloom/db'
import { invitationEmail, passwordResetEmail, sendEmail, verifyEmailEmail } from '@workloom/emails'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins/organization'
import { nextCookies, toNextJsHandler } from 'better-auth/next-js'
import { accessControl, roles } from './access-control.ts'
import { organizationAuditHooks, recordSignIn } from './audit-hooks.ts'

const INVITATION_EXPIRY_DAYS = 7

export const auth = betterAuth({
  appName: 'Workloom',
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
    },
  }),

  advanced: {
    database: {
      // UUIDv7, matching every other identifier in the system, so that auth
      // tables and domain tables share one key type and foreign keys are
      // possible between them.
      generateId: () => newId(),
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    /**
     * Single-tenant installations have no public sign-up. Accounts are
     * created by an administrator -- the first through the setup screen, the
     * rest from Settings -> Members -- which is why `provisionUser` writes
     * the user and credential rows itself rather than calling this endpoint.
     * Nothing else creates accounts, so closing the endpoint closes the door.
     */
    disableSignUp: !env.MULTI_TENANT,
    async sendResetPassword({ user, url }) {
      await sendEmail(passwordResetEmail({ to: user.email, resetUrl: url }))
    },
  },

  /**
   * Verification is required before a person can accept an invitation.
   *
   * Without it, an invitation link that leaks -- through a forwarded email, a
   * browser history, a proxy log -- plus a sign-up using the invitee's address
   * would be enough to join someone else's organization. Confirming control of
   * the inbox closes that.
   *
   * Single-tenant installations have neither sign-up nor invitations: an
   * administrator creates each account with the address they already know, so
   * there is nothing left for verification to establish, and requiring it
   * would make a working mail server a condition of adding a colleague.
   * `provisionUser` marks those accounts verified for that reason.
   */
  emailVerification: {
    sendOnSignUp: env.MULTI_TENANT,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    async sendVerificationEmail({ user, url }) {
      await sendEmail(verifyEmailEmail({ to: user.email, name: user.name, verifyUrl: url }))
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },

  databaseHooks: {
    session: {
      create: {
        /**
         * A new session starts in the organization the person most recently
         * joined, rather than in none. Without this, everyone with exactly one
         * organization -- nearly everyone -- is sent to a picker with one
         * option after every sign-in.
         */
        async before(session) {
          if (session.activeOrganizationId) return
          const [latest] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(desc(schema.member.createdAt))
            .limit(1)
          if (latest) return { data: { ...session, activeOrganizationId: latest.organizationId } }
        },
        async after(session, context) {
          await recordSignIn(session, context as never)
        },
      },
    },
  },

  plugins: [
    organization({
      ac: accessControl,
      roles,
      creatorRole: 'owner',
      /**
       * A person may belong to several organizations -- an agency using
       * Workloom for itself and for a subsidiary, or a contractor working
       * across two. The tenant boundary is the organization, not the user.
       *
       * A single-tenant installation has exactly one, created at setup, so
       * the endpoint that would make a second is closed rather than merely
       * hidden from the navigation.
       */
      allowUserToCreateOrganization: env.MULTI_TENANT,
      invitationExpiresIn: 60 * 60 * 24 * INVITATION_EXPIRY_DAYS,
      // Explicit, so a future default change cannot quietly weaken it.
      requireEmailVerificationOnInvitation: true,
      organizationHooks: organizationAuditHooks,

      async sendInvitationEmail(data) {
        const acceptUrl = `${env.APP_URL}/accept-invitation/${data.id}`
        await sendEmail(
          invitationEmail({
            to: data.email,
            organizationName: data.organization.name,
            inviterName: data.inviter.user.name || data.inviter.user.email,
            role: data.role,
            acceptUrl,
            expiresInDays: INVITATION_EXPIRY_DAYS,
          }),
        )
      },
    }),
    // Lets Server Actions set session cookies. Must stay the LAST plugin:
    // it post-processes the responses of every plugin before it.
    nextCookies(),
  ],
})

export type Auth = typeof auth

/**
 * Next.js route handler for Better Auth.
 *
 * Exported from here so that `better-auth` stays a dependency of this package
 * alone. The web app should not need to know which library provides sessions.
 */
export const { GET: authGET, POST: authPOST } = toNextJsHandler(auth)
