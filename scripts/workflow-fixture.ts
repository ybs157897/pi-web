import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Shared task for real-model Pi/DSH comparisons; deliberately does not name planning tools. */
export const WORKFLOW_PROMPT = [
  '请把当前工作区里的发票计算小项目完善到可交付。',
  '检查现有 calculator.mjs 和 invoice.json，修复 subtotal(items) 没有计算 quantity 的问题，保留这个导出接口。',
  'price 和 quantity 都必须是有限的非负数字，非法值需要抛错；quantity 为 0 时金额为 0。',
  '用 Node 自带测试框架覆盖正常计算、零数量和非法输入，写好 README.md 使用说明，实际运行测试并修复到通过。',
  '直接实施并完成验证，不需要询问我，也不要只交付方案；不要提交或访问网络。',
].join('\n')

export async function prepareWorkflowFixture(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'calculator.mjs'), 'export function subtotal(items) { return items.reduce((sum, item) => sum + item.price, 0) }\n')
  await writeFile(join(workspace, 'invoice.json'), '[{"price":4,"quantity":2},{"price":3,"quantity":3}]\n')
}

/** Independent oracle, kept outside the agent's generated tests. */
export const WORKFLOW_ORACLE = [
  'import assert from "node:assert/strict";',
  'import { subtotal } from "./calculator.mjs";',
  'assert.equal(subtotal([{price:4,quantity:2},{price:3,quantity:3}]),17);',
  'assert.equal(subtotal([{price:9,quantity:0}]),0);',
  'assert.throws(()=>subtotal([{price:2,quantity:-1}]));',
  'assert.throws(()=>subtotal([{price:Infinity,quantity:1}]));',
  'assert.throws(()=>subtotal([{price:2,quantity:"3"}]));',
  'console.log("WORKFLOW_ORACLE_OK");',
].join('\n')
