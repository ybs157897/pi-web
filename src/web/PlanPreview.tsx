import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import type { PlanDocument } from './plan-preview.ts'
import css from './PlanPreview.module.css'

/** 计划文档类型，从 plan-preview.ts 转发导出。 */
export type { PlanDocument } from './plan-preview.ts'
/** 从 plan-preview.ts 转发导出的工具函数：取最近一次计划、取计划标题。 */
export { latestPlan, planTitle } from './plan-preview.ts'

/**
 * 功能：DSH 风格的计划预览——完整渲染最近一次提交计划的 Markdown，并沿用相同的
 * 加载中 / 失败 / 不可用文案（`ui-plan/src/client/PlanPreview.tsx:28-39`、`locales.ts:12-17`）。
 * @param props plan 计划文档（undefined/null 时显示占位提示）；loading 是否仍在读取；
 *              error 读取失败信息。
 * 内部逻辑：由于 Pi 直接从已加载的会话详情派生计划，读取是即时的，loading 仅覆盖短暂的
 * 挂起状态；无计划时按 loading/error 分支展示不同提示并附带错误行；有计划时以
 * MarkdownText 渲染全文，标题取 plan.title（缺省为「计划」）。
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
