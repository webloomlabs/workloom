import { describe, expect, it } from 'vitest'
import '../modules/index.ts'
import { permissionsForRole } from '../permissions/roles.ts'
import { mcpToolByName, mcpTools, mcpToolsFor } from './mcp.ts'
import { allProcedures } from './registry.ts'

/**
 * The MCP tool list is generated from the registry, so these tests guard the
 * mapping rather than any individual tool.
 */
describe('the MCP tool catalogue', () => {
  const tools = mcpTools()

  it('exposes most of the registry', () => {
    // A catalogue that lost its tools would still pass every other check here.
    expect(tools.length).toBeGreaterThan(200)
  })

  it('gives every tool a valid, unique name', () => {
    const names = tools.map((t) => t.name)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(new Set(names).size).toBe(names.length)
  })

  it('describes every input as a plain JSON object schema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object')
      expect(tool.inputSchema, tool.name).not.toHaveProperty('$schema')
      expect(() => JSON.stringify(tool.inputSchema), tool.name).not.toThrow()
    }
  })

  it('leaves out file uploads, which a JSON tool call cannot carry', () => {
    const uploads = allProcedures().filter((p) => p.http.body === 'multipart')
    expect(uploads.length).toBeGreaterThan(0)
    for (const p of uploads) expect(mcpToolByName(p.name.replace(/\./g, '_')), p.name).toBeUndefined()
  })

  /**
   * Changing this list changes what an AI assistant can do to an
   * organization. It should be a reviewed diff, never an accident.
   */
  it('keeps the deliberately withheld procedures out', () => {
    const withheld = allProcedures()
      .filter((p) => p.mcp === false)
      .map((p) => p.name)
      .sort()
    expect(withheld).toEqual([
      'apiKey.create',
      'apiKey.revoke',
      'books.unlock',
      'documentSequence.update',
      'member.remove',
      'messagingIdentity.createLinkCode',
      'messagingIdentity.revoke',
      'oauthGrant.revoke',
      'organization.logo',
      'organization.removeLogo',
      'organization.update',
      'telegramBot.connect',
      'telegramBot.disconnect',
      'telegramBot.update',
      'telegramGroup.createLinkCode',
      'telegramGroup.revoke',
      'webhook.create',
      'webhook.delete',
      'webhook.rotateSecret',
      'webhook.test',
      'webhook.update',
      'webhookDelivery.retry',
    ])
    for (const name of withheld) expect(mcpToolByName(name.replace(/\./g, '_')), name).toBeUndefined()
  })

  it('marks reads, deletions, and outward sends so assistants can ask first', () => {
    const list = mcpToolByName('invoice_list')!
    expect(list.annotations.readOnlyHint).toBe(true)
    expect(list.annotations.destructiveHint).toBe(false)

    const remove = mcpToolByName('expense_delete')!
    expect(remove.annotations.readOnlyHint).toBe(false)
    expect(remove.annotations.destructiveHint).toBe(true)

    const send = mcpToolByName('invoice_send')!
    expect(send.annotations.openWorldHint).toBe(true)
  })

  it('offers each caller only what their permissions allow', () => {
    const developer = new Set(mcpToolsFor(permissionsForRole('developer')).map((t) => t.name))
    const owner = new Set(mcpToolsFor(permissionsForRole('owner')).map((t) => t.name))

    expect(developer.has('me_get')).toBe(true)
    expect(owner.has('invoice_create')).toBe(true)
    expect(developer.has('invoice_create')).toBe(false)
    expect(developer.size).toBeLessThan(owner.size)
    expect(mcpToolsFor(new Set()).every((t) => t.permission === 'authenticated')).toBe(true)
  })
})
