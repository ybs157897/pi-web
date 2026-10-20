/** A skill discovered from a bundled or workspace-local skill directory. */
export interface SkillSummary {
  /** Stable, source-qualified identifier such as `agents:review-helper`. */
  id: string
  name: string
  description: string
  source: 'builtin' | 'agents' | 'pi'
  /** Absolute path to the skill's SKILL.md. */
  path: string
  /** SHA-256 of the exact SKILL.md bytes, used for optimistic updates. */
  version: string
  writable: boolean
}

export interface SkillCatalog {
  skills: SkillSummary[]
  diagnostics: Array<{ path: string; message: string }>
}

export interface SkillContent {
  skill: SkillSummary
  /** `SKILL.md` for the main prompt, otherwise a path relative to the skill directory. */
  resource: string
  content: string
  /** All safely readable files relative to the skill directory. */
  files: string[]
}

export interface SkillValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface SkillSaveInput {
  name: string
  content: string
  /** Current SHA-256 version required when replacing a changed existing SKILL.md. */
  expectedVersion?: string
}

export interface SkillSaveResult {
  skill: SkillSummary
  created: boolean
  unchanged: boolean
  validation: SkillValidation
}
