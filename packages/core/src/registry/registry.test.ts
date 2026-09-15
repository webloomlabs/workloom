import { describe, expect, it } from 'vitest'
import '../modules/index.ts'
import { allProcedures } from './registry.ts'
import { isPermission } from '../permissions/statements.ts'

/**
 * Registry invariants.
 *
 * These are cheap and they police the properties that make one service layer
 * serve both the UI and the public API. Without them the failure mode is
 * silent: a feature exists in the app but not in the API, and nobody notices
 * until an integrator asks for it.
 */

const procedures = allProcedures()

describe('the registry', () => {
  it('has procedures registered', () => {
    // Guards against every assertion below passing vacuously because module
    // side-effect registration stopped working.
    expect(procedures.length).toBeGreaterThan(0)
  })

  it('gives every procedure a unique name', () => {
    const names = procedures.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every procedure a unique HTTP route', () => {
    const routes = procedures.map((p) => `${p.http.method} ${p.http.path}`)
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('requires a permission that actually exists', () => {
    for (const procedure of procedures) {
      const valid = procedure.permission === 'authenticated' || isPermission(procedure.permission)
      expect(valid, `${procedure.name} requires "${procedure.permission}"`).toBe(true)
    }
  })

  it('only lets read-only procedures skip a permission check', () => {
    // 'authenticated' is for endpoints that merely describe the caller. A
    // mutation reachable by any authenticated actor would be a privilege hole.
    for (const procedure of procedures) {
      if (procedure.permission === 'authenticated') {
        expect(procedure.readOnly, `${procedure.name} mutates but requires no permission`).toBe(true)
      }
    }
  })

  it('uses GET for reads and never for writes', () => {
    for (const procedure of procedures) {
      const isGet = procedure.http.method === 'GET'
      expect(isGet, `${procedure.name} is ${procedure.http.method} but readOnly=${!!procedure.readOnly}`)
        .toBe(!!procedure.readOnly)
    }
  })

  it('names procedures in entity.action form', () => {
    for (const procedure of procedures) {
      expect(procedure.name, procedure.name).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/)
    }
  })

  it('describes every procedure, since the summary becomes API documentation', () => {
    for (const procedure of procedures) {
      expect(procedure.summary.length, procedure.name).toBeGreaterThan(10)
    }
  })

  it('uses kebab-case segments and brace-style parameters, as OpenAPI requires', () => {
    // Literal segments lowercase-kebab; parameters camelCase inside braces.
    // Express-style `:id` would silently fail to appear in the OpenAPI paths.
    const path = /^(\/([a-z0-9]+(-[a-z0-9]+)*|\{[a-zA-Z][a-zA-Z0-9]*\}))+$/
    for (const procedure of procedures) {
      expect(procedure.http.path, procedure.name).toMatch(path)
      expect(procedure.http.path, procedure.name).not.toContain(':')
    }
  })
})
