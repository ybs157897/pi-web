/** Only request-affecting provider fields belong here; display labels stay out of the saved-request check. */
export interface ProviderRequestDraft {
  baseUrl: string
  protocol: string
  models: unknown[]
}

export type ProviderCheckActivity = 'testing' | 'discovering'
export interface ProviderCheckFeedback {
  tone: 'success' | 'error'
  message: string
}
export interface ProviderEditorCheckState {
  savedRequest: string | null
  draftRequest: string | null
  credentialDrafted: boolean
  activity: ProviderCheckActivity | null
  activityId: number | null
  nextActivityId: number
  feedback: ProviderCheckFeedback | null
}

export function createProviderEditorCheckState(): ProviderEditorCheckState {
  return { savedRequest: null, draftRequest: null, credentialDrafted: false, activity: null, activityId: null, nextActivityId: 1, feedback: null }
}

function fingerprint(draft: ProviderRequestDraft): string {
  return JSON.stringify({ baseUrl: draft.baseUrl, protocol: draft.protocol, models: draft.models })
}

/** Loading the server copy establishes the baseline without marking the initial form dirty. */
export function loadProviderEditorRequest(draft: ProviderRequestDraft, nextActivityId = 1): ProviderEditorCheckState {
  const request = fingerprint(draft)
  return { savedRequest: request, draftRequest: request, credentialDrafted: false, activity: null, activityId: null, nextActivityId, feedback: null }
}

/** Update the draft and discard any check result tied to the previous editor contents. */
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

export function clearProviderEditorFeedback(state: ProviderEditorCheckState): ProviderEditorCheckState {
  return state.feedback === null ? state : { ...state, feedback: null }
}

export function isProviderEditorDirty(state: ProviderEditorCheckState): boolean {
  return state.savedRequest !== null && (state.draftRequest !== state.savedRequest || state.credentialDrafted)
}

/** Checks always target the persisted provider ID, so only the exact saved request can be checked. */
export function canCheckSavedProviderRequest(state: ProviderEditorCheckState): boolean {
  return state.savedRequest !== null && state.draftRequest === state.savedRequest
    && !state.credentialDrafted && state.activity === null
}

export function beginProviderCheck(
  state: ProviderEditorCheckState,
  activity: ProviderCheckActivity,
): ProviderEditorCheckState {
  if (!canCheckSavedProviderRequest(state)) return state
  return { ...state, activity, activityId: state.nextActivityId, nextActivityId: state.nextActivityId + 1, feedback: null }
}

/** Ignore late responses when a changed draft has already cancelled that check. */
export function finishProviderCheck(
  state: ProviderEditorCheckState,
  activity: ProviderCheckActivity,
  activityId: number,
  feedback: ProviderCheckFeedback | null,
): ProviderEditorCheckState {
  if (state.activity !== activity || state.activityId !== activityId) return state
  return { ...state, activity: null, activityId: null, feedback }
}

export function setProviderEditorFeedback(
  state: ProviderEditorCheckState,
  feedback: ProviderCheckFeedback,
): ProviderEditorCheckState {
  return { ...state, feedback }
}

/** A successful save makes the visible draft the new baseline and restores check actions. */
export function markProviderEditorSaved(
  state: ProviderEditorCheckState,
  draft: ProviderRequestDraft,
): ProviderEditorCheckState {
  const request = fingerprint(draft)
  return { ...state, savedRequest: request, draftRequest: request, credentialDrafted: false, activity: null, activityId: null, feedback: null }
}
