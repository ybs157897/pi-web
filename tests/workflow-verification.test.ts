import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_MUTANTS, workflowMutantSource } from '../scripts/workflow-fixture.ts'

/**
 * 工作流评估的 oracle 质量测试：每个变异体（mutant）必须恰好破坏一项必需行为，
 * 且不得因为「校验差异」（无关的参数校验不同）而被无关测试捕获失败——
 * 否则说明评估用例区分力不足，变异体与原实现无法被正确判定。
 */
describe('workflow evaluation defects', () => {
  it('changes one required behavior without failing tests through unrelated validation differences', async () => {
    // 流程：把原实现与各变异体写成临时 .mjs 动态 import，
    // 验证 ignoresQuantity / treatsZeroAsOne 保留完整入参校验（TypeError/RangeError），
    // 而各变异体的核心行为差异（数量被忽略、0 视为 1、校验被删）能被精确区分。
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
