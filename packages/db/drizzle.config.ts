import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Policies are hand-written in custom migrations rather than generated.
  // Row-level security is the security boundary; it should not silently
  // change shape because drizzle-kit was upgraded.
  // TypeScript names are camelCase; columns are snake_case.
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
