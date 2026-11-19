import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from './types.ts'
import type { WorkItemEvidence } from './workbench.ts'
import type { ConversationFailure } from './conversation-failure.ts'

export const escalationReasons = ['requirement_ambiguity', 'high_impact', 'scope_conflict', 'cannot_verify'] as const
export type EscalationReason = typeof escalationReasons[number]
export type DecisionReason = EscalationReason | 'accept_result'
export type DecisionEscalation = { reason: EscalationReason; why: string; evidence?: string[] }

export type DecisionInboxLink = {
  conversationId: string
  parentConversationId?: string
  workItemId?: string
  interactionId?: string
}

export type DecisionMailKind = 'choice' | 'confirmation' | 'review' | 'exception' | 'result'
export type DecisionMailFolder = 'pending' | 'snoozed' | 'archived'
export type DecisionMailResolution = 'answered' | 'cancelled' | 'superseded' | 'accepted' | 'revise'

export type DecisionMailSummary = {
  id: string
  kind: DecisionMailKind
  reason: DecisionReason
  link: DecisionInboxLink
  conversationTitle: string
  groupId: string
  groupTitle: string
  subject: string
  snippet: string
  createdAt: number
  settledAt?: number
  folder: DecisionMailFolder
  actionable: boolean
  snoozedUntil?: number
  resolution?: DecisionMailResolution
}

export type DecisionMail = DecisionMailSummary & {
  why: string
  evidence: WorkItemEvidence[]
  acceptance?: string[]
  body?: string
  questions?: AskUserQuestionItem[]
  answers?: AskUserQuestionAnswerItem[]
  approveLabel?: string
  attempt?: number
  failure?: ConversationFailure
}

export type UpdateDecisionMail = { action: 'archive' } | { action: 'restore' } | { action: 'snooze'; until: number }
export type ResultVerdict = { action: 'accept' | 'revise'; feedback?: string }
export type WorkItemVerdict = ResultVerdict & { attempt: number }
export type ObservedDecision = { kind: 'interaction'; id: string }
  | { kind: 'result' | 'failure'; itemId: string; attempt: number }
export type DecisionInboxPresence = {
  viewId: string
  sequence: number
  active: boolean
  observed: ObservedDecision[]
}
