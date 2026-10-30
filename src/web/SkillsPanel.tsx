import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillCatalog, SkillContent, SkillSummary, SkillValidation } from '../shared/skills.ts'
import type { WorkspaceSummary } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SkillsPanel.module.css'

interface SkillsPanelProps {
  initialWorkspaceId?: string
}

/** Read-only workspace skill catalog and source preview. */
export default function SkillsPanel({ initialWorkspaceId }: SkillsPanelProps) {
  const { settings } = useUiPreferences()
  const t = useCallback((chinese: string, english: string) => settings.locale === 'en' ? english : chinese, [settings.locale])
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '')
  const [workspacesLoading, setWorkspacesLoading] = useState(true)
  const [workspacesError, setWorkspacesError] = useState('')
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0)
  const [catalogState, setCatalogState] = useState<{ workspaceId: string; catalog: SkillCatalog } | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [skillId, setSkillId] = useState('')
  const [resource, setResource] = useState('')
  const [contentState, setContentState] = useState<{
    workspaceId: string
    skillId: string
    requestedResource: string
    content: SkillContent
  } | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState('')
  const [validationState, setValidationState] = useState<{
    workspaceId: string
    skillId: string
    result: SkillValidation
  } | null>(null)
  const [validationLoading, setValidationLoading] = useState(false)
  const [validationError, setValidationError] = useState('')
  const validationRequest = useRef(0)

  useEffect(() => () => { validationRequest.current += 1 }, [])

  useEffect(() => {
    let active = true
    setWorkspacesLoading(true)
    setWorkspacesError('')
    void api.listWorkspaces().then(({ workspaces: nextWorkspaces }) => {
      if (!active) return
      setWorkspaces(nextWorkspaces)
      setWorkspaceId(current => {
        const preferred = initialWorkspaceId && nextWorkspaces.some(workspace => workspace.id === initialWorkspaceId)
          ? initialWorkspaceId
          : undefined
        if (preferred) return preferred
        if (current && nextWorkspaces.some(workspace => workspace.id === current)) return current
        return nextWorkspaces[0]?.id ?? ''
      })
    }).catch(cause => {
      if (active) setWorkspacesError(errorMessage(cause, t('无法读取工作区列表', 'Could not load workspaces')))
    }).finally(() => {
      if (active) setWorkspacesLoading(false)
    })
    return () => { active = false }
  }, [initialWorkspaceId, t])

  useEffect(() => {
    if (!workspaceId) {
      setCatalogState(null)
      setCatalogLoading(false)
      setCatalogError('')
      setSkillId('')
      setResource('')
      return
    }
    let active = true
    setCatalogLoading(true)
    setCatalogError('')
    setCatalogState(null)
    setSkillId('')
    setResource('')
    setContentState(null)
    setContentError('')
    setValidationState(null)
    setValidationError('')
    setValidationLoading(false)
    validationRequest.current += 1
    void api.getSkills(workspaceId).then(catalog => {
      if (!active) return
      setCatalogState({ workspaceId, catalog })
      setSkillId(catalog.skills[0]?.id ?? '')
    }).catch(cause => {
      if (active) setCatalogError(errorMessage(cause, t('无法读取技能目录', 'Could not load the skill catalog')))
    }).finally(() => {
      if (active) setCatalogLoading(false)
    })
    return () => { active = false }
  }, [workspaceId, catalogRefreshKey, t])

  const catalog = catalogState?.workspaceId === workspaceId ? catalogState.catalog : null
  const selectedSkill = catalog?.skills.find(skill => skill.id === skillId) ?? null

  useEffect(() => {
    if (!workspaceId || !selectedSkill) {
      setContentState(null)
      setContentLoading(false)
      setContentError('')
      return
    }
    let active = true
    const requestedWorkspaceId = workspaceId
    const requestedSkillId = selectedSkill.id
    const requestedResource = resource
    setContentLoading(true)
    setContentError('')
    void api.getSkill(requestedWorkspaceId, requestedSkillId, requestedResource || undefined).then(content => {
      if (active) setContentState({
        workspaceId: requestedWorkspaceId,
        skillId: requestedSkillId,
        requestedResource,
        content,
      })
    }).catch(cause => {
      if (active) setContentError(errorMessage(cause, t('无法读取技能内容', 'Could not read the skill content')))
    }).finally(() => {
      if (active) setContentLoading(false)
    })
    return () => { active = false }
  }, [workspaceId, selectedSkill?.id, resource, t])

  const content = contentState?.workspaceId === workspaceId
    && contentState.skillId === skillId
    && contentState.requestedResource === resource
    ? contentState.content
    : null
  const validation = validationState?.workspaceId === workspaceId && validationState.skillId === skillId
    ? validationState.result
    : null
  const selectedWorkspace = workspaces.find(workspace => workspace.id === workspaceId)

  const changeWorkspace = (nextWorkspaceId: string) => {
    validationRequest.current += 1
    setWorkspaceId(nextWorkspaceId)
    setSkillId('')
    setResource('')
    setValidationState(null)
    setValidationError('')
    setValidationLoading(false)
  }

  const changeSkill = (nextSkillId: string) => {
    validationRequest.current += 1
    setSkillId(nextSkillId)
    setResource('')
    setValidationState(null)
    setValidationError('')
    setValidationLoading(false)
  }

  const validateSelectedSkill = async () => {
    if (!workspaceId || !selectedSkill || validationLoading) return
    const requestId = ++validationRequest.current
    const requestedWorkspaceId = workspaceId
    const requestedSkillId = selectedSkill.id
    setValidationLoading(true)
    setValidationError('')
    setValidationState(null)
    try {
      const result = await api.validateSkill(requestedWorkspaceId, requestedSkillId)
      if (validationRequest.current === requestId) {
        setValidationState({ workspaceId: requestedWorkspaceId, skillId: requestedSkillId, result })
      }
    } catch (cause) {
      if (validationRequest.current === requestId) {
        setValidationError(errorMessage(cause, t('技能校验失败', 'Could not validate the skill')))
      }
    } finally {
      if (validationRequest.current === requestId) setValidationLoading(false)
    }
  }

  const resources = content
    ? [...new Set([content.resource, ...content.files])]
    : []

  return <div className={css.panel}>
    <header className={css.header}>
      <div className={css.heading}>
        <h3>{t('技能', 'Skills')}</h3>
        <p>{t('查看工作区可用的技能、来源与校验结果。', 'Browse workspace skills, their sources and validation results.')}</p>
      </div>
      <Button size="sm" variant="outline" disabled={!workspaceId || catalogLoading || workspacesLoading} onClick={() => setCatalogRefreshKey(value => value + 1)}>
        <IconRefreshOutlineRegular size={14} aria-hidden="true" />
        {catalogLoading ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}
      </Button>
    </header>

    <p className={css.creatorHint}>
      {t('创建技能：在当前会话输入“帮我创建一个……技能”。工具是否可用及技能能否保存，取决于当前会话的访问权限和 Agent 预设开放的工具范围。', 'To create a skill, ask in the current chat: “Create a skill for …”. Available actions and saving depend on this conversation’s access mode and the tools enabled by its Agent preset.')}
    </p>

    <div className={css.workspacePicker}>
      <label htmlFor="skills-workspace">{t('工作区', 'Workspace')}</label>
      {workspacesLoading
        ? <p className={css.muted} role="status">{t('正在读取工作区…', 'Loading workspaces…')}</p>
        : <select id="skills-workspace" value={workspaceId} onChange={event => changeWorkspace(event.currentTarget.value)} disabled={workspaces.length === 0}>
          {workspaces.length === 0
            ? <option value="">{t('没有可用的工作区', 'No workspaces available')}</option>
            : workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>}
      {selectedWorkspace && <code className={css.path}>{selectedWorkspace.path}</code>}
      {workspacesError && <p className={css.error} role="alert">{workspacesError}</p>}
    </div>

    {!workspacesLoading && workspaces.length === 0 && !workspacesError && <p className={css.empty} role="status">
      {t('请先添加工作区，再查看其中的技能。', 'Add a workspace to browse its skills.')}
    </p>}

    {workspaceId && <>
      {catalogError && <p className={css.error} role="alert">{catalogError}</p>}
      {catalogLoading && <p className={css.muted} role="status">{t('正在扫描技能目录…', 'Scanning skill directories…')}</p>}

      {catalog && <>
        {catalog.diagnostics.length > 0 && <section className={css.diagnostics} aria-labelledby="skills-diagnostics-title">
          <h4 id="skills-diagnostics-title">{t('目录诊断', 'Catalog diagnostics')} · {catalog.diagnostics.length}</h4>
          <ul>{catalog.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.path}-${index}`}>
            <code>{diagnostic.path}</code><span>{diagnostic.message}</span>
          </li>)}</ul>
        </section>}

        {catalog.skills.length === 0
          ? <p className={css.empty} role="status">{t('这个工作区还没有发现技能。', 'No skills were found in this workspace.')}</p>
          : <>
            <div className={css.skillPicker}>
              <label htmlFor="skills-skill">{t('技能目录', 'Available skills')}</label>
              <select id="skills-skill" value={selectedSkill?.id ?? ''} onChange={event => changeSkill(event.currentTarget.value)}>
                {catalog.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
              </select>
              {selectedSkill?.description && <p className={css.muted}>{selectedSkill.description}</p>}
            </div>

            {selectedSkill && <SkillDetails
              skill={selectedSkill}
              content={content}
              contentLoading={contentLoading}
              contentError={contentError}
              resources={resources}
              resource={content?.resource ?? resource}
              onResourceChange={setResource}
              validating={validationLoading}
              validation={validation}
              validationError={validationError}
              onValidate={() => void validateSelectedSkill()}
            />}
          </>}
      </>}
    </>}
  </div>
}

function SkillDetails({
  skill, content, contentLoading, contentError, resources, resource, onResourceChange,
  validating, validation, validationError, onValidate,
}: {
  skill: SkillSummary
  content: SkillContent | null
  contentLoading: boolean
  contentError: string
  resources: string[]
  resource: string
  onResourceChange: (resource: string) => void
  validating: boolean
  validation: SkillValidation | null
  validationError: string
  onValidate: () => void
}) {
  const { t } = useUiPreferences()
  return <section className={css.details} aria-labelledby="skills-detail-title" aria-busy={contentLoading || validating}>
    <div className={css.detailHeader}>
      <div className={css.detailTitle}>
        <h4 id="skills-detail-title">{skill.name}</h4>
        <span className={css.sourceTag}>{sourceName(skill.source, t)}</span>
        <span className={css.sourceTag} data-writable={skill.writable || undefined}>
          {skill.writable ? t('可写', 'Writable') : t('只读', 'Read only')}
        </span>
      </div>
      <Button size="sm" variant="outline" disabled={validating} onClick={onValidate}>
        {validating ? t('校验中…', 'Validating…') : t('校验', 'Validate')}
      </Button>
    </div>

    <dl className={css.metadata}>
      <div><dt>{t('路径', 'Path')}</dt><dd><code>{skill.path}</code></dd></div>
      <div><dt>{t('内容版本（SHA-256）', 'Content version (SHA-256)')}</dt><dd><code>{skill.version}</code></dd></div>
    </dl>

    {validationError && <p className={css.error} role="alert">{validationError}</p>}
    {validation && <div className={css.validation} data-valid={validation.valid} role={validation.valid ? 'status' : 'alert'}>
      <h5>{validation.valid ? t('格式校验通过', 'Validation passed') : t('发现校验错误', 'Validation found errors')}</h5>
      {validation.errors.length > 0 && <ul className={css.validationErrors}>{validation.errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>}
      {validation.warnings.length > 0 && <div className={css.validationWarnings}>
        <span>{t('提示', 'Warnings')}</span>
        <ul>{validation.warnings.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>
      </div>}
    </div>}

    <div className={css.previewHeader}>
      <h5>{t('技能内容', 'Skill content')}</h5>
      {resources.length > 1 && <label className={css.resourcePicker}>
        <span>{t('文件', 'File')}</span>
        <select value={resource} onChange={event => onResourceChange(event.currentTarget.value)}>
          {resources.map(path => <option key={path} value={path}>{path}</option>)}
        </select>
      </label>}
    </div>
    {contentError && <p className={css.error} role="alert">{contentError}</p>}
    {contentLoading && <p className={css.muted} role="status">{t('正在读取技能内容…', 'Loading skill content…')}</p>}
    {content && <>
      <p className={css.resourcePath}><code>{content.resource}</code></p>
      <pre className={css.preview}>{content.content}</pre>
    </>}
  </section>
}

function sourceName(source: SkillSummary['source'], t: (chinese: string, english: string) => string): string {
  switch (source) {
    case 'builtin': return t('内置', 'Built in')
    case 'global': return t('全局 ~/.pi-web/skills', 'Global ~/.pi-web/skills')
    case 'agents': return '.agents/skills'
    case 'pi': return '.pi-web/skills'
    case 'plugin': return t('插件', 'Plugin')
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}
