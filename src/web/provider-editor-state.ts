/** 只有影响请求的 provider 字段进入这里；展示用标签不参与 saved-request 的脏检查。 */
export interface ProviderRequestDraft {
  baseUrl: string
  protocol: string
  models: unknown[]
}

/** 检查活动类型：连通性测试或模型发现。 */
export type ProviderCheckActivity = 'testing' | 'discovering'
/** 一次检查的结果反馈（tone 定成功/失败样式）。 */
export interface ProviderCheckFeedback {
  tone: 'success' | 'error'
  message: string
}
/** provider 编辑器「检查」动作的状态机：以 saved/draft 指纹的异同判断脏与可查。 */
export interface ProviderEditorCheckState {
  savedRequest: string | null
  draftRequest: string | null
  credentialDrafted: boolean
  activity: ProviderCheckActivity | null
  activityId: number | null
  nextActivityId: number
  feedback: ProviderCheckFeedback | null
}

/**
 * 功能：创建编辑器检查状态的初始值（无基线、无活动、无反馈）。
 * @returns 空白状态
 */
export function createProviderEditorCheckState(): ProviderEditorCheckState {
  return { savedRequest: null, draftRequest: null, credentialDrafted: false, activity: null, activityId: null, nextActivityId: 1, feedback: null }
}

/** 对请求草稿取指纹（JSON 序列化 baseUrl/protocol/models），作为脏检查依据。 */
function fingerprint(draft: ProviderRequestDraft): string {
  return JSON.stringify({ baseUrl: draft.baseUrl, protocol: draft.protocol, models: draft.models })
}

/**
 * 功能：载入服务端副本建立基线；初始表单不算脏。
 * @param draft 当前表单草稿
 * @param nextActivityId 后续分配活动 id 的起点
 * @returns saved 与 draft 同指纹的初始态
 */
export function loadProviderEditorRequest(draft: ProviderRequestDraft, nextActivityId = 1): ProviderEditorCheckState {
  const request = fingerprint(draft)
  return { savedRequest: request, draftRequest: request, credentialDrafted: false, activity: null, activityId: null, nextActivityId, feedback: null }
}

/**
 * 功能：更新草稿指纹，并丢弃绑定在旧编辑内容上的检查结果。
 * @param state 当前状态
 * @param draft 新草稿
 * @param credentialDrafted 凭据是否被改过（默认保持原值）
 * @returns 内容或凭据有变时清空 activity/activityId/feedback 的新状态；无变化原样返回
 */
export function updateProviderEditorRequest(
  state: ProviderEditorCheckState,
  draft: ProviderRequestDraft,
  credentialDrafted = state.credentialDrafted,
): ProviderEditorCheckState {
  const request = fingerprint(draft)
  const changed = request !== state.draftRequest || credentialDrafted !== state.credentialDrafted
  if (!changed) return state
  return { ...state, draftRequest: request, credentialDrafted, activity: null, activityId: null, feedback: null }
}

/**
 * 功能：清除当前反馈（幂等：无反馈时原样返回）。
 */
export function clearProviderEditorFeedback(state: ProviderEditorCheckState): ProviderEditorCheckState {
  return state.feedback === null ? state : { ...state, feedback: null }
}

/**
 * 功能：判断编辑器是否脏——有基线且草稿指纹不同或凭据被改过。
 */
export function isProviderEditorDirty(state: ProviderEditorCheckState): boolean {
  return state.savedRequest !== null && (state.draftRequest !== state.savedRequest || state.credentialDrafted)
}

/**
 * 功能：检查动作永远作用于已持久化的 provider id，因此只有草稿与已保存请求完全一致、
 * 凭据未改且没有进行中的活动时才允许检查。
 * @returns 可发起检查返回 true
 */
export function canCheckSavedProviderRequest(state: ProviderEditorCheckState): boolean {
  return state.savedRequest !== null && state.draftRequest === state.savedRequest
    && !state.credentialDrafted && state.activity === null
}

/**
 * 功能：发起一次检查活动：占用 activity 槽并分配自增 id。
 * @param state 当前状态
 * @param activity 活动类型
 * @returns 前置条件满足时进入活动态；不可检查时原样返回
 */
export function beginProviderCheck(
  state: ProviderEditorCheckState,
  activity: ProviderCheckActivity,
): ProviderEditorCheckState {
  if (!canCheckSavedProviderRequest(state)) return state
  return { ...state, activity, activityId: state.nextActivityId, nextActivityId: state.nextActivityId + 1, feedback: null }
}

/**
 * 功能：结束一次检查；草稿已被改动导致该检查被取消时，迟到响应直接忽略。
 * @param state 当前状态
 * @param activity 发起时的活动类型
 * @param activityId 发起时分配的 id
 * @param feedback 检查结果反馈
 * @returns id 匹配才落反馈并清活动槽；不匹配原样返回
 */
export function finishProviderCheck(
  state: ProviderEditorCheckState,
  activity: ProviderCheckActivity,
  activityId: number,
  feedback: ProviderCheckFeedback | null,
): ProviderEditorCheckState {
  if (state.activity !== activity || state.activityId !== activityId) return state
  return { ...state, activity: null, activityId: null, feedback }
}

/**
 * 功能：直接写入反馈（不走活动槽，用于本地立即产生的错误提示）。
 */
export function setProviderEditorFeedback(
  state: ProviderEditorCheckState,
  feedback: ProviderCheckFeedback,
): ProviderEditorCheckState {
  return { ...state, feedback }
}

/**
 * 功能：保存成功后把当前可见草稿设为新基线，恢复检查动作。
 * @returns 清空凭据脏标记与活动槽、指纹对齐的新状态
 */
export function markProviderEditorSaved(
  state: ProviderEditorCheckState,
  draft: ProviderRequestDraft,
): ProviderEditorCheckState {
  const request = fingerprint(draft)
  return { ...state, savedRequest: request, draftRequest: request, credentialDrafted: false, activity: null, activityId: null, feedback: null }
}
