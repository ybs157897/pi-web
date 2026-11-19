import { useRef, useState } from 'react'
import { AlertCircle, CirclePause, RefreshCw } from 'lucide-react'
import type { ConversationFailure, ConversationFailureCode, ConversationRetry } from '../shared/conversation-failure.ts'
import { ApiFailure } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './ConversationFailureNotice.module.css'

const english: Record<ConversationFailureCode, string> = {
  MODEL_UNAVAILABLE: 'This model is unavailable. Select an available model to continue.',
  MODEL_AUTH_FAILED: 'The provider refused the request. Check its credentials or account permissions, or choose another model.',
  MODEL_RATE_LIMITED: 'The model is rate limited (429). Wait and retry this turn, or choose another model.',
  MODEL_QUOTA_EXCEEDED: 'The account has insufficient model quota. Check its quota or choose another model.',
  MODEL_TIMEOUT: 'The model request timed out. Retry this turn or choose another model.',
  MODEL_CONNECTION_FAILED: 'The model could not be reached. Check the provider URL and network, or choose another model.',
  MODEL_CONTEXT_LIMIT: 'The conversation exceeds the model context limit. Compact it or choose a longer-context model.',
  MODEL_PROVIDER_FAILED: 'The model provider could not finish this turn. Retry or check the model settings.',
  WORKBENCH_TIMEOUT: 'This work item reached its 15-minute execution limit. You can resume from the saved progress.',
  CONVERSATION_INTERRUPTED: 'The turn was stopped. You can resume from the saved conversation.',
  CONVERSATION_FAILED: 'The turn did not finish. You can try again.',
}

type Props = {
  failure: ConversationFailure
  onRetry?: () => Promise<void> | void
  onModelSettings?: () => void
  onCompact?: () => void
}

export default function ConversationFailureNotice({ failure, onRetry, onModelSettings, onCompact }: Props) {
  const { t } = useUiPreferences()
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const stopped = failure.code === 'CONVERSATION_INTERRUPTED'
  const Icon = stopped ? CirclePause : AlertCircle
  const message = t(failure.message, failure.code === 'MODEL_RATE_LIMITED' && failure.retryAttempts
    ? 'The model is still rate limited (429) after automatic retries. This turn stopped. Wait and retry, or choose another model.'
    : english[failure.code] ?? 'The turn could not complete.')
  async function retry() {
    if (pendingRef.current || !onRetry) return
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    try {
      await onRetry()
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : t('未能重试，请检查连接后再试。', 'Retry failed. Check the connection and try again.'))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  return (
    <div className={css.notice} data-conversation-failure={failure.code}>
      <div className={css.body} role={stopped ? 'status' : 'alert'}>
        <Icon aria-hidden size={16} />
        <div><p>{message}</p><code>{failure.code}</code></div>
      </div>
      <div className={css.actions}>
        {onModelSettings && failure.code.startsWith('MODEL_') && <button type="button" disabled={pending} onClick={onModelSettings}>
          {t('模型设置', 'Model settings')}
        </button>}
        {onCompact && failure.action === 'compact' && <button type="button" disabled={pending} onClick={onCompact}>
          {t('压缩会话', 'Compact conversation')}
        </button>}
        {onRetry && <button type="button" disabled={pending} onClick={() => { void retry() }}>
          <RefreshCw aria-hidden size={13} />{pending ? t('正在重试…', 'Retrying…')
            : stopped ? t('继续本轮', 'Continue turn') : failure.retryable ? t('重试本轮', 'Retry this turn') : t('检查后继续', 'Continue after checking')}
        </button>}
      </div>
      {error && <p className={css.attemptError} role="status">{error}</p>}
    </div>
  )
}

export function ConversationRetryNotice({ retry }: { retry: ConversationRetry }) {
  const { t } = useUiPreferences()
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(retry.nextAt)
  return (
    <div className={css.retrying} data-conversation-retry={retry.failure.code} role="status">
      <RefreshCw aria-hidden size={14} />
      {retry.failure.code === 'MODEL_RATE_LIMITED' ? t('模型限流，正在自动重试', 'Model rate limited. Retrying automatically')
        : t('正在自动重试模型请求', 'Retrying the model request automatically')}
      <span>{t(`第 ${retry.attempt} 次 · ${time}`, `Attempt ${retry.attempt} · ${time}`)}</span>
    </div>
  )
}
