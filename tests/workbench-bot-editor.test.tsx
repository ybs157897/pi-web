// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkbenchBotEditor } from '../src/web/WorkbenchBotEditor.tsx'
import { workbenchApi } from '../src/web/workbench-api.ts'
import { api } from '../src/web/api.ts'
import type { WorkbenchAgent } from '../src/shared/workbench.ts'
import type { ModelCatalog } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

const bot: WorkbenchAgent = { id: 'bot-1', name: '编目助手', role: '编目', description: '', skills: [], status: 'idle',
  config: { origin: 'user', accessMode: 'workspaceWrite', instructions: '', skillIds: null, icon: 'book' } }
const catalog: ModelCatalog = {
  models: [{ provider: 'test', modelId: 'reading', name: '阅读模型', reasoning: false, available: true }],
  providers: [], defaultModel: { provider: 'test', modelId: 'reading' }, thinkingLevels: ['off'],
}
beforeEach(() => {
  setupRenderingDom()
  vi.spyOn(api, 'getSkills').mockResolvedValue({ diagnostics: [], skills: [
    { id: 'builtin:cataloguing', source: 'builtin', name: '编目', description: '编目规范', writable: false, version: '1', path: '/cataloguing' },
  ] })
})
afterEach(() => { cleanup();vi.restoreAllMocks() })

it('creates a named Bot with workspace scope, inherited model and all skills', async () => {
  const create = vi.spyOn(workbenchApi, 'createBot').mockResolvedValue(bot)
  const saved = vi.fn()
  render(<WorkbenchBotEditor workspaceId="space" catalog={catalog} accessModes={['readOnly','workspaceWrite','fullAccess']}
    onClose={vi.fn()} onSaved={saved} />)
  const permissions = within(screen.getByRole('combobox', { name: '权限上限' }))
  expect(permissions.getAllByRole('option').map(option => option.textContent)).toEqual(['仅可查看', '工作区内修改', '完全权限'])
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '编目助手' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '创建 Bot' }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith(bot))
  expect(create).toHaveBeenCalledWith('space', expect.objectContaining({ model: null, name: '编目助手', accessMode: 'workspaceWrite', skillIds: null }))
  expect(create.mock.calls[0]?.[1]).not.toHaveProperty('role')
})

it('edits model, portrait, instructions, access and active skills on the same Bot', async () => {
  const update = vi.spyOn(workbenchApi, 'updateBot').mockResolvedValue(bot)
  render(<WorkbenchBotEditor agent={bot} workspaceId="space" catalog={catalog} accessModes={['readOnly','workspaceWrite']}
    onClose={vi.fn()} onSaved={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '更换头像' }))
  fireEvent.click(screen.getByRole('button', { name: '艾达' }))
  fireEvent.change(screen.getByLabelText('工作指令'), { target: { value: '先核对藏品登记号' } })
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: JSON.stringify(['test', 'reading']) } })
  fireEvent.change(screen.getByLabelText('权限上限'), { target: { value: 'readOnly' } })
  fireEvent.click(screen.getByLabelText('全部可用技能'))
  fireEvent.click(await screen.findByRole('checkbox', { name: /编目/ }))
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith('space', 'bot-1', {
    icon: 'database', model: { provider: 'test', modelId: 'reading' }, instructions: '先核对藏品登记号', accessMode: 'readOnly', skillIds: ['builtin:cataloguing'],
  }))
})
