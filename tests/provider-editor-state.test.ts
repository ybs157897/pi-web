/**
 * 供应商（provider）编辑器检查状态机测试。
 *
 * 关键契约：
 * - "对已保存配置发起连通性检查"仅当编辑器内容与已保存版本一致（clean）时可用；
 *   一旦 dirty（baseUrl/协议/模型/凭据改动）即禁用，保存后重新启用；
 * - 仅改动凭据（write-only 的 apiKey 草稿）也算未保存变更，且改回即恢复 clean；
 * - 每次检查有 activityId，草稿变更后旧检查的结果被丢弃（防过期反馈覆盖当前状态）。
 * 全部为纯状态函数，直接对返回的状态对象断言。
 */
import { describe, expect, it } from 'vitest'
import {
  beginProviderCheck, canCheckSavedProviderRequest, createProviderEditorCheckState,
  finishProviderCheck, isProviderEditorDirty, loadProviderEditorRequest, markProviderEditorSaved,
  updateProviderEditorRequest,
} from '../src/web/provider-editor-state.ts'
import type { ProviderRequestDraft } from '../src/web/provider-editor-state.ts'

/** 一个已保存的供应商请求草稿 fixture：网关地址 + openai-completions 协议 + 单模型。 */
const savedDraft: ProviderRequestDraft = {
  baseUrl: 'https://gateway.example/v1',
  protocol: 'openai-completions',
  models: [{ id: 'model-1', name: 'Model 1', input: ['text'] }],
}

/** 编辑器"已保存配置可检查"门控与过期反馈丢弃的状态机测试。 */
describe('provider editor saved-request checks', () => {
  // 验证主状态流转：加载即 clean 且可检查 → 改动 baseUrl 变 dirty、检查入口禁用、
  // beginProviderCheck 原样返回（拒绝发起）→ markProviderEditorSaved 后恢复 clean、检查重新可用。
  it('treats the loaded configuration as clean, blocks changed requests, and re-enables checks after save', () => {
    const loaded = loadProviderEditorRequest(savedDraft)
    expect(isProviderEditorDirty(loaded)).toBe(false)
    expect(canCheckSavedProviderRequest(loaded)).toBe(true)

    const changed = updateProviderEditorRequest(loaded, { ...savedDraft, baseUrl: 'https://new.example/v1' })
    expect(isProviderEditorDirty(changed)).toBe(true)
    expect(canCheckSavedProviderRequest(changed)).toBe(false)
    expect(beginProviderCheck(changed, 'testing')).toBe(changed)

    const saved = markProviderEditorSaved(changed, { ...savedDraft, baseUrl: 'https://new.example/v1' })
    expect(isProviderEditorDirty(saved)).toBe(false)
    expect(canCheckSavedProviderRequest(saved)).toBe(true)
  })

  // 验证两类隐式 dirty：仅传凭据标志（changedKey=true，write-only 字段不出现在请求草稿里）
  // 也算未保存变更，改回 false 即恢复 clean；替换模型列表同样使检查入口禁用。
  it('treats a write-only credential draft and model edits as unsaved request changes', () => {
    const loaded = loadProviderEditorRequest(savedDraft)
    const changedKey = updateProviderEditorRequest(loaded, savedDraft, true)
    expect(isProviderEditorDirty(changedKey)).toBe(true)
    expect(canCheckSavedProviderRequest(changedKey)).toBe(false)
    expect(isProviderEditorDirty(updateProviderEditorRequest(changedKey, savedDraft, false))).toBe(false)

    const changedModel = updateProviderEditorRequest(loaded, {
      ...savedDraft,
      models: [{ id: 'model-2', name: 'Model 2', input: ['text'] }],
    })
    expect(isProviderEditorDirty(changedModel)).toBe(true)
    expect(canCheckSavedProviderRequest(changedModel)).toBe(false)
  })

  // 验证过期反馈丢弃：第一次检查（first.activityId）发出后草稿被改动又还原、第二次检查启动，
  // 此时旧检查的结果带旧 activityId 迟到 → finishProviderCheck 原样返回且不写入 feedback；
  // 只有当前 activityId 匹配的结果才生效，且检查通过后入口恢复可用。
  it('drops feedback from an older request when a draft is changed and another check starts', () => {
    const loaded = loadProviderEditorRequest(savedDraft)
    const first = beginProviderCheck(loaded, 'testing')
    expect(first.activityId).not.toBeNull()

    const edited = updateProviderEditorRequest(first, { ...savedDraft, baseUrl: 'https://temporary.example/v1' })
    const restored = updateProviderEditorRequest(edited, savedDraft)
    const second = beginProviderCheck(restored, 'testing')
    expect(second.activityId).not.toBe(first.activityId)

    const lateFirstResult = finishProviderCheck(second, 'testing', first.activityId!, { tone: 'success', message: 'old response' })
    expect(lateFirstResult).toBe(second)
    expect(lateFirstResult.activityId).toBe(second.activityId)
    expect(lateFirstResult.feedback).toBeNull()

    const currentResult = finishProviderCheck(second, 'testing', second.activityId!, { tone: 'success', message: 'current response' })
    expect(currentResult.feedback?.message).toBe('current response')
    expect(canCheckSavedProviderRequest(currentResult)).toBe(true)
  })

  // 验证初始态（尚无已保存请求）：编辑器不算 dirty（没有可对比的旧值），但也不允许发起"对已保存配置的检查"。
  it('does not make a partially loaded editor eligible for a provider check', () => {
    const empty = createProviderEditorCheckState()
    expect(isProviderEditorDirty(empty)).toBe(false)
    expect(canCheckSavedProviderRequest(empty)).toBe(false)
  })
})
