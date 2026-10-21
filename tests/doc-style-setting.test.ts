import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppStateStore } from '../src/server/app-state.ts'
import { createApp } from '../src/server/app.ts'
import { createRuntime } from '../src/server/runtime.ts'
import { DOC_STYLE_ICONS, DOC_STYLE_INSTRUCTION } from '../src/server/doc-style-instruction.ts'
import type { WorkspaceSummary } from '../src/shared/types.ts'

const NOW = 1_800_000_000_000
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** A store over a throwaway data directory; the caller removes the directory afterwards. */
async function store(dataDir: string): Promise<AppStateStore> {
  const workspace: WorkspaceSummary = { id: 'ws-doc-style', name: 'Doc style', path: dataDir, createdAt: NOW, updatedAt: NOW }
  const opened = await AppStateStore.open({ dataDir, defaultWorkspace: workspace })
  cleanups.push(async () => { await rm(dataDir, { recursive: true, force: true }) })
  return opened
}

/** A demo runtime over a throwaway data directory; it writes its own app-state.json. */
async function runtime(): Promise<{ dataDir: string; runtime: Awaited<ReturnType<typeof createRuntime>> }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-doc-style-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  const created = await createRuntime({ dataDir, workspace, piDir, demo: true })
  cleanups.push(async () => { await created.close(); await rm(root, { recursive: true, force: true }) })
  return { dataDir, runtime: created }
}

describe('结论文档排版设置', () => {
  it('把没有该字段的老状态文件读成开启', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pi-web-doc-style-legacy-'))
    cleanups.push(async () => { await rm(dataDir, { recursive: true, force: true }) })
    await writeFile(join(dataDir, 'app-state.json'), JSON.stringify({
      version: 1,
      settings: {
        theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 11,
        transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed',
        codingViews: true, busySendMode: 'followUp', defaultThinkingLevel: 'medium', defaultAccessMode: 'fullAccess',
      },
      workspaces: [], plugins: {}, presets: [], automations: [], feedback: [],
    }))
    const opened = await store(dataDir)
    expect(opened.snapshot().settings.docStyle).toBe(true)
  })

  it('新建的配置默认开启', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pi-web-doc-style-fresh-'))
    const opened = await store(dataDir)
    expect(opened.snapshot().settings.docStyle).toBe(true)
  })

  it('通过设置更新接口改成 false 并写进状态文件', async () => {
    const { dataDir, runtime: instance } = await runtime()
    expect(instance.settings().docStyle).toBe(true)
    const updated = await instance.updateSettings({ docStyle: false })
    expect(updated.docStyle).toBe(false)
    expect(instance.settings().docStyle).toBe(false)
    const stored = JSON.parse(await readFile(join(dataDir, 'app-state.json'), 'utf8')) as { settings: { docStyle: boolean } }
    expect(stored.settings.docStyle).toBe(false)
    const reopened = await AppStateStore.open({
      dataDir,
      defaultWorkspace: { id: 'ws-doc-style', name: 'Doc style', path: dataDir, createdAt: NOW, updatedAt: NOW },
    })
    expect(reopened.snapshot().settings.docStyle).toBe(false)
  })

  it('设置接口接受 docStyle 这一项', async () => {
    const { runtime: instance } = await runtime()
    const app = createApp(instance, { demo: true })
    cleanups.push(async () => { await app.shutdown() })
    const response = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docStyle: false }),
    })
    expect(response.status).toBe(200)
    expect((await response.json() as { docStyle: boolean }).docStyle).toBe(false)
    const current = await app.request('/api/settings')
    expect((await current.json() as { docStyle: boolean }).docStyle).toBe(false)
  })

  it('格式契约指令给出三个结构化块的写法', () => {
    expect(DOC_STYLE_INSTRUCTION).toContain('```doc')
    expect(DOC_STYLE_INSTRUCTION).toContain('type: cards')
    expect(DOC_STYLE_INSTRUCTION).toContain('type: compare')
    expect(DOC_STYLE_INSTRUCTION).toContain('type: note')
    expect(DOC_STYLE_INSTRUCTION).toContain('badge: check')
    expect(DOC_STYLE_INSTRUCTION).toContain('badge: cross')
  })

  it('格式契约指令列出全部图标白名单', () => {
    for (const icon of DOC_STYLE_ICONS) expect(DOC_STYLE_INSTRUCTION).toContain(icon)
  })
})
