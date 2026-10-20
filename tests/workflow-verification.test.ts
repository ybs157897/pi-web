import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_MUTANTS, workflowMutantSource } from '../scripts/workflow-fixture.ts'

describe('workflow evaluation defects', () => {
  it('changes one required behavior without failing tests through unrelated validation differences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workflow-oracle-'))
    try {
      await writeFile(join(root, 'workflow-original.mjs'), `
        export function subtotal(items) {
          if (!Array.isArray(items)) throw new TypeError("items");
          for (const {price, quantity} of items) {
            if (typeof price !== "number" || typeof quantity !== "number") throw new TypeError("types");
            if (!Number.isFinite(price) || !Number.isFinite(quantity) || price < 0 || quantity < 0) throw new RangeError("range");
          }
          return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        }`)
      const modules: Record<string, { subtotal(items: unknown): number }> = {}
      for (const [name, body] of Object.entries(WORKFLOW_MUTANTS)) {
        const path = join(root, `${name}.mjs`)
        await writeFile(path, workflowMutantSource(body))
        modules[name] = await import(/* @vite-ignore */ pathToFileURL(path).href)
      }
      for (const name of ['ignoresQuantity', 'treatsZeroAsOne']) {
        expect(() => modules[name]!.subtotal([{ price: 'bad', quantity: 1 }])).toThrow(TypeError)
        expect(() => modules[name]!.subtotal([{ price: 1, quantity: -1 }])).toThrow(RangeError)
      }
      expect(modules.ignoresQuantity!.subtotal([{ price: 3, quantity: 2 }])).toBe(3)
      expect(modules.treatsZeroAsOne!.subtotal([{ price: 3, quantity: 2 }])).toBe(6)
      expect(modules.treatsZeroAsOne!.subtotal([{ price: 3, quantity: 0 }])).toBe(3)
      expect(modules.omitsValidation!.subtotal([{ price: 3, quantity: 2 }])).toBe(6)
      expect(modules.omitsValidation!.subtotal([{ price: 3, quantity: 0 }])).toBe(0)
      expect(() => modules.omitsValidation!.subtotal(null)).toThrow(TypeError)
      expect(modules.omitsValidation!.subtotal([{ price: 3, quantity: -1 }])).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
