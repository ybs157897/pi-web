import { describe, expect, it } from 'vitest'
import {
  beginProviderCheck, canCheckSavedProviderRequest, createProviderEditorCheckState,
  finishProviderCheck, isProviderEditorDirty, loadProviderEditorRequest, markProviderEditorSaved,
  updateProviderEditorRequest,
} from '../src/web/provider-editor-state.ts'
import type { ProviderRequestDraft } from '../src/web/provider-editor-state.ts'

const savedDraft: ProviderRequestDraft = {
  baseUrl: 'https://gateway.example/v1',
  protocol: 'openai-completions',
  models: [{ id: 'model-1', name: 'Model 1', input: ['text'] }],
}

describe('provider editor saved-request checks', () => {
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

  it('does not make a partially loaded editor eligible for a provider check', () => {
    const empty = createProviderEditorCheckState()
    expect(isProviderEditorDirty(empty)).toBe(false)
    expect(canCheckSavedProviderRequest(empty)).toBe(false)
  })
})
