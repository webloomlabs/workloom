import { z } from 'zod'
import { loadDotEnv } from './dotenv.ts'

/**
 * Environment configuration.
 *
 * Parsed once, at startup, and never read from `process.env` again. A
 * misconfigured self-hosted install should fail immediately with a message
 * naming every problem at once -- not fail later with a stack trace from
 * three layers down, and not fail one variable at a time across five restarts.
 */

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')

/** 32 bytes, base64-encoded. Generate with: openssl rand -base64 32 */
const encryptionKey = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, 'base64').length === 32
    } catch {
      return false
    }
  },
  { message: 'must be 32 bytes, base64-encoded (generate: openssl rand -base64 32)' },
)

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: z.coerce.number().int().positive().default(3000),

    /** Public origin the app is served from. Used for links in outbound email. */
    APP_URL: z.url(),

    DATABASE_URL: z.string().min(1),
    /** Connection pool size per process. */
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
    /**
     * Allow the app to start while connected as a database superuser.
     * Superusers bypass row-level security, so this disables tenant
     * isolation entirely. Intended for tooling only -- never set it in
     * production.
     */
    DANGEROUSLY_ALLOW_SUPERUSER_DB: bool.default(false),

    BETTER_AUTH_SECRET: z.string().min(32),
    /** Encrypts webhook signing secrets and integration credentials at rest. */
    WORKLOOM_ENCRYPTION_KEY: encryptionKey,

    /**
     * Optional. When unset, queues and rate limiting run on Postgres, which
     * is the default and the well-tested path. Redis is an opt-in upgrade
     * for larger installations.
     */
    REDIS_URL: z.url().optional(),

    /**
     * `smtp` delivers mail. `memory` keeps sent messages in process for tests
     * to inspect, and is refused in production.
     */
    MAIL_DRIVER: z.enum(['smtp', 'memory']).default('smtp'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: bool.default(false),
    MAIL_FROM: z.email(),

    STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage-data'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),

    /**
     * Webhook URLs resolving to loopback, private, or link-local addresses are
     * rejected by default. Workloom is typically self-hosted inside a private
     * network, where such a URL is an SSRF vector against internal services.
     */
    WORKLOOM_ALLOW_PRIVATE_WEBHOOKS: bool.default(false),
  })
  .superRefine((v, ctx) => {
    if (v.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!v[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `required when STORAGE_DRIVER is "s3"`,
          })
        }
      }
    }
    if (v.MAIL_DRIVER === 'smtp' && !v.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'required when MAIL_DRIVER is "smtp"' })
    }
    if (v.NODE_ENV === 'production' && v.MAIL_DRIVER === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_DRIVER'],
        message: 'cannot be "memory" in production -- invitations and invoices would silently never send',
      })
    }
    if (v.NODE_ENV === 'production' && v.DANGEROUSLY_ALLOW_SUPERUSER_DB) {
      ctx.addIssue({
        code: 'custom',
        path: ['DANGEROUSLY_ALLOW_SUPERUSER_DB'],
        message:
          'cannot be enabled in production -- a superuser connection bypasses row-level security, ' +
          'which removes all isolation between organizations',
      })
    }
  })

export type Env = z.infer<typeof schema>

export class EnvironmentError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const lines = issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    super(
      `Invalid environment configuration:\n\n${lines.join('\n')}\n\n` +
        `See .env.example for the full list of variables and docs/configuration for details.\n`,
    )
    this.name = 'EnvironmentError'
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source === process.env) loadDotEnv()
  const result = schema.safeParse(source)
  if (!result.success) throw new EnvironmentError(result.error.issues)
  return result.data
}

let cached: Env | undefined

/**
 * The parsed environment. Lazy so that importing this module never throws at
 * import time -- tests and tooling can import the schema without a full
 * environment present.
 */
export const env = new Proxy({} as Env, {
  get(_, prop: string) {
    cached ??= loadEnv()
    return cached[prop as keyof Env]
  },
})
