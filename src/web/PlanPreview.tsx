import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import type { PlanDocument } from './plan-preview.ts'
import css from './PlanPreview.module.css'

export type { PlanDocument } from './plan-preview.ts'
export { latestPlan, planTitle } from './plan-preview.ts'

/**
 * DSH's plan preview: the complete Markdown of the latest submitted plan with the same
 * loading / failed / unavailable messages (`ui-plan/src/client/PlanPreview.tsx:28-39`,
 * `locales.ts:12-17`). The resource read is instant here because Pi derives the plan from
 * the already-loaded conversation detail, so the loading state only covers a pending read.
 */
export default function PlanPreview({ plan, loading = false, error = null }: {
  plan?: PlanDocument | null
  loading?: boolean
  error?: string | null
}) {
  const { t } = useUiPreferences()
  if (plan === undefined || plan === null) {
    return (
      <div className={css.message} role="status" data-plan-preview-state="unavailable">
        {loading ? t('正在读取计划…', 'Loading plan…')
          : error !== null && error !== '' ? t('无法读取计划', 'Could not load plan')
            : t('计划预览不可用', 'Plan preview is unavailable')}
        {!loading && error !== null && error !== '' && <p className={css.errorLine}>{error}</p>}
      </div>
    )
  }
  const title = plan.title ?? t('计划', 'Plan')
  return (
    <section className={css.preview} data-plan-preview={plan.title ?? ''} aria-label={title}>
      <div className={css.document}>
        <MarkdownText text={plan.markdown} labels={markdownLabels(t)} />
      </div>
    </section>
  )
}
