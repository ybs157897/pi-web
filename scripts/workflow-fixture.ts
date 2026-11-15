/**
 * live-workflow-check.ts 共享的 fixture：任务提示词、初始工作区文件、独立判分 oracle
 * 与三个变异体（mutant）。各 live 场景复用同一套材料，保证验收口径一致。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 功能：真实模型工作流验收（Pi/DSH 对照）共用的任务提示词。
 * @returns 不适用（导出常量）。
 * 内部逻辑：有意不点名任何计划类工具（如 enter_plan_mode），避免提示词本身引导模型走计划模式。
 */
export const WORKFLOW_PROMPT = [
  '请把当前工作区里的发票计算小项目完善到可交付。',
  '检查现有 calculator.mjs 和 invoice.json，修复 subtotal(items) 没有计算 quantity 的问题，保留这个导出接口。',
  'price 和 quantity 都必须是有限的非负数字，非法值需要抛错；quantity 为 0 时金额为 0。',
  '用 Node 自带测试框架覆盖正常计算、零数量和非法输入，写好 README.md 使用说明，实际运行测试并修复到通过。',
  '直接实施并完成验证，不需要询问我，也不要只交付方案；不要提交或访问网络。',
].join('\n')

/**
 * 功能：准备验收初始工作区——写入带缺陷的 calculator.mjs 与输入数据 invoice.json。
 * @param workspace 目标工作区目录（不存在则递归创建）。
 * @returns 无返回值（Promise，写完即结束）。
 * 内部逻辑：subtotal 故意漏算 quantity，验收要求模型修复它；文件内容即"坏实现"基线。
 */
export async function prepareWorkflowFixture(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'calculator.mjs'), 'export function subtotal(items) { return items.reduce((sum, item) => sum + item.price, 0) }\n')
  await writeFile(join(workspace, 'invoice.json'), '[{"price":4,"quantity":2},{"price":3,"quantity":3}]\n')
}

/**
 * 功能：独立判分 oracle——由脚本直接执行的断言脚本，与模型生成的测试完全分开。
 * @returns 不适用（导出常量）。
 * 内部逻辑：校验正确实现（17）、零数量（0）、负数/Infinity/非数字三种非法输入抛错；
 * 全部通过则打印 WORKFLOW_ORACLE_OK。放外部是防止模型把 oracle 一起改掉而失去判分基准。
 */
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

/**
 * 功能：三个变异体（mutant）的函数体——每个只改变被要求修复的行为，保留生成实现的其余校验与错误。
 * @returns 不适用（导出常量）。
 * 内部逻辑：ignoresQuantity 完全忽略 quantity；treatsZeroAsOne 把零数量当成 1；
 * omitsValidation 吞掉非法输入校验（仅在输入全部为对象时静默返回 0）。
 * 模型生成的测试必须杀掉全部变异体，才算覆盖到位。
 */
export const WORKFLOW_MUTANTS = {
  ignoresQuantity: 'const result = original(items); return items.reduce((sum, item) => sum + item.price, 0);',
  treatsZeroAsOne: 'const result = original(items); return result + items.reduce((sum, item) => sum + (item.quantity === 0 ? item.price : 0), 0);',
  omitsValidation: [
    'try { return original(items); } catch (error) {',
    '  const invalid = value => typeof value !== "number" || !Number.isFinite(value) || value < 0;',
    '  if (Array.isArray(items) && items.every(item => item !== null && typeof item === "object")',
    '      && items.some(item => invalid(item.price) || invalid(item.quantity))) return 0;',
    '  throw error;',
    '}',
  ].join('\n'),
} as const

/**
 * 功能：把一个变异体函数体包装成完整 mutant 模块源码。
 * @param body WORKFLOW_MUTANTS 中某个变异体的函数体代码。
 * @returns 完整 .mjs 模块文本：转发原始实现的导出，再以 original 别名引入并用 ${body} 覆盖 subtotal。
 * 内部逻辑：mutant 文件替换 calculator.mjs，原实现被改名为 workflow-original.mjs 供转发与比对。
 */
export function workflowMutantSource(body: string): string {
  return [
    'export * from "./workflow-original.mjs";',
    'import { subtotal as original } from "./workflow-original.mjs";',
    `export function subtotal(items) { ${body} }`,
  ].join('\n')
}
