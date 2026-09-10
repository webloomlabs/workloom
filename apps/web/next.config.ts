import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship TypeScript source rather than a build artifact,
  // so there is no build step in the dev loop. Next compiles them itself.
  transpilePackages: ['@workloom/config', '@workloom/db', '@workloom/storage'],
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // The Postgres driver is native and must not be bundled.
  serverExternalPackages: ['pg'],
}

export default config
