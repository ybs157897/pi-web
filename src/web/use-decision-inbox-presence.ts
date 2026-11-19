import { useEffect, useRef, type RefObject } from 'react'
import type { DecisionInboxPresence, ObservedDecision } from '../shared/decision-inbox.ts'
import type { InteractionRequest } from '../shared/types.ts'
import type { WorkItem } from '../shared/workbench.ts'
import { request } from './api.ts'
import { DECISION_INBOX_CHANGED } from './decision-inbox-api.ts'

const HEARTBEAT_MS = 4_000
const MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]'

type ConversationActivity = {
  surface?: RefObject<HTMLElement>
  interactions?: readonly InteractionRequest[]
  item?: WorkItem
}

function observedDecisions(activity: ConversationActivity | undefined): ObservedDecision[] {
  const observed: ObservedDecision[] = []
  // QuestionComposer shows the newest pending card. Older ones are still recoverable in the inbox.
  const current = activity?.interactions?.reduce<InteractionRequest | undefined>((latest, item) => {
    if (item.status !== 'pending') return latest
    if (item.kind === 'question' ? !item.questions?.length : item.kind !== 'plan-review' || !item.detail?.trim()) return latest
    return !latest || item.createdAt > latest.createdAt ? item : latest
  }, undefined)
  if (current) observed.push({ kind: 'interaction', id: current.id })
  const item = activity?.item
  if (item?.status === 'pending_review') observed.push({ kind: 'result', itemId: item.id, attempt: item.attempt })
  if (item?.status === 'needs_human' && item.error && item.failure?.code !== 'CONVERSATION_INTERRUPTED') {
    observed.push({ kind: 'failure', itemId: item.id, attempt: item.attempt })
  }
  return observed
}

export function useDecisionInboxPresence(
  workspaceId: string | undefined,
  conversationId: string | undefined,
  activity?: ConversationActivity,
): void {
  const surface = activity?.surface
  const observations = JSON.stringify(observedDecisions(activity))
  const latestObserved = useRef<ObservedDecision[]>([])
  const scheduleReport = useRef<(() => void)>()

  useEffect(() => {
    if (!workspaceId || !conversationId) return
    const viewId = globalThis.crypto.randomUUID()
    const path = `/api/workbench/${encodeURIComponent(workspaceId)}/inbox/presence/${encodeURIComponent(conversationId)}`
    let sequence = 0
    let active = false
    let sent = ''
    let observationReceipt = ''
    let activation = 0
    let pageHidden = false
    let frame: number | undefined

    function send(nextActive: boolean, force = false) {
      if (!active && !nextActive) return
      const observation = JSON.stringify(latestObserved.current)
      const fingerprint = JSON.stringify([nextActive, observation])
      if (!force && fingerprint === sent) return
      const activityChanged = active !== nextActive
      if (activityChanged) {
        ++activation
        observationReceipt = ''
      }
      const currentActivation = activation
      const observed = nextActive && observationReceipt !== observation ? latestObserved.current : []
      active = nextActive
      sent = fingerprint
      const input: DecisionInboxPresence = { viewId, sequence: ++sequence, active, observed }
      void request(path, { method: 'POST', body: JSON.stringify(input), keepalive: !active })
        .then(() => {
          if (nextActive && currentActivation === activation && observed.length > 0) observationReceipt = observation
          if (activityChanged || observed.length > 0) {
            window.dispatchEvent(new CustomEvent(DECISION_INBOX_CHANGED, { detail: { workspaceId } }))
          }
        }).catch(() => {
          // Missing heartbeats expire server-side. The next report can still acknowledge the activity.
          if (sent === fingerprint) sent = ''
        })
    }

    function sync(force = false) {
      const node = surface?.current
      const showing = !surface || !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible'
      const blocked = Array.from(document.querySelectorAll(MODAL)).some(modal => modal.getClientRects().length > 0
        && getComputedStyle(modal).visibility === 'visible')
      send(showing && !blocked && !pageHidden && document.visibilityState === 'visible' && document.hasFocus(), force)
    }

    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        sync()
      })
    }
    scheduleReport.current = schedule
    const heartbeat = window.setInterval(() => sync(true), HEARTBEAT_MS)
    const check = () => sync()
    const hide = () => { pageHidden = true; send(false) }
    const show = () => { pageHidden = false; schedule() }
    const observer = typeof ResizeObserver !== 'undefined' && surface?.current ? new ResizeObserver(check) : undefined
    if (observer && surface?.current) observer.observe(surface.current)
    const modalObserver = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes'
        ? record.target instanceof Element && record.target.matches('dialog, [role="dialog"]')
        : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && (node.matches(MODAL) || node.querySelector(MODAL))))) check()
    })
    modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['open', 'aria-modal', 'aria-hidden', 'hidden'] })
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('blur', check)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    schedule()
    return () => {
      scheduleReport.current = undefined
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.clearInterval(heartbeat)
      observer?.disconnect()
      modalObserver.disconnect()
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('blur', check)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
      send(false)
    }
  }, [workspaceId, conversationId, surface])

  useEffect(() => {
    latestObserved.current = JSON.parse(observations) as ObservedDecision[]
    scheduleReport.current?.()
  }, [observations])
}
