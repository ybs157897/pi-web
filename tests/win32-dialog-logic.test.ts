/**
 * 移植自 DSH 0.2.1-rc.2（MIT，见 vendor/DSH-LICENSE）。
 * 用假绑定（fake bindings）验证 Win32 COM 会话的调用时序：结果映射
 * （选中 / 取消 / 每一步的 HRESULT 失败）与「任何路径都释放资源」的保证。
 * 与平台无关，因此虽然真实对话框只存在于 Windows，测试仍可在此运行。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PICKFOLDERS, HRESULT_CANCELLED,
  runFolderDialog, type Win32DialogBindings, type Win32FolderDialog,
} from '../src/server/platform/win32-dialog-logic.ts'

const E_FAIL = 0x80004005 | 0

/** 假 COM 世界：暴露各绑定的 spy 与对话框方法 spy，供时序断言使用。 */
interface FakeWorld {
  bindings: Win32DialogBindings
  dpi: ReturnType<typeof vi.fn>
  pressAlt: ReturnType<typeof vi.fn>
  createDialog: ReturnType<typeof vi.fn>
  uninitialize: ReturnType<typeof vi.fn>
  dialog: {
    setOptions: ReturnType<typeof vi.fn>
    setTitle: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    resultPath: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  }
}

/**
 * 构造假 COM 绑定与对话框。
 * @param overrides 覆盖对话框方法的默认行为（如让 show 返回 E_FAIL）
 * @param coInit CoInitializeEx 的返回值（0 = S_OK，1 = S_FALSE 重入，其他 = 失败）
 * @returns 带 spy 的 FakeWorld，便于断言调用次数与顺序
 */
function world(overrides: Partial<Win32FolderDialog> = {}, coInit = 0): FakeWorld {
  const dialog = {
    setOptions: vi.fn(() => 0),
    setTitle: vi.fn(() => 0),
    show: vi.fn(() => 0),
    resultPath: vi.fn(() => ({ hr: 0, path: 'C:\\picked\\目录' })),
    release: vi.fn(),
    ...overrides,
  }
  const dpi = vi.fn()
  const pressAlt = vi.fn()
  const createDialog = vi.fn(() => dialog)
  const uninitialize = vi.fn()
  const bindings: Win32DialogBindings = {
    setThreadDpiAwareness: dpi,
    coInitializeSta: vi.fn(() => coInit),
    coUninitialize: uninitialize,
    createFolderDialog: createDialog,
    currentThreadId: vi.fn(() => 4242),
    pressAltForForeground: pressAlt,
  }
  return { bindings, dpi, pressAlt, createDialog, uninitialize, dialog: dialog as FakeWorld['dialog'] }
}

describe('runFolderDialog', () => {
  // 成功路径的完整时序：DPI 感知 → STA 初始化 → 选项/标题 → 显示前通知（带线程 id）→
  // 前台 Alt 键按压 → 阻塞 Show → 取结果；对话框 release 先于 apartment 卸载。
  it('sequences DPI, STA, options, title, show, result extraction, and apartment teardown', () => {
    const { bindings, dpi, pressAlt, dialog, uninitialize } = world()
    const showing = vi.fn()
    expect(runFolderDialog(bindings, 'Pick', showing)).toBe('C:\\picked\\目录')
    expect(dpi).toHaveBeenCalledOnce()
    expect(uninitialize).toHaveBeenCalledOnce()
    expect(dialog.release.mock.invocationCallOrder[0]).toBeLessThan(uninitialize.mock.invocationCallOrder[0] as number)
    expect(dialog.setOptions).toHaveBeenCalledWith(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR)
    expect(dialog.setTitle).toHaveBeenCalledWith('Pick')
    expect(showing).toHaveBeenCalledWith(4242)
    expect(showing.mock.invocationCallOrder[0]).toBeLessThan(dialog.show.mock.invocationCallOrder[0] as number)
    // 前台 Alt 键按压发生在「显示前通知」与阻塞 Show 之间。
    expect(pressAlt).toHaveBeenCalledOnce()
    expect(showing.mock.invocationCallOrder[0]).toBeLessThan(pressAlt.mock.invocationCallOrder[0] as number)
    expect(pressAlt.mock.invocationCallOrder[0]).toBeLessThan(dialog.show.mock.invocationCallOrder[0] as number)
    expect(dialog.release).toHaveBeenCalledOnce()
  })

  // 取消映射：用户取消（HRESULT_CANCELLED）返回 null，不读结果；
  // 对话框与 COM apartment 仍必须各释放一次。
  it('maps the cancelled HRESULT to null and still releases the dialog and apartment', () => {
    const { bindings, pressAlt, dialog, uninitialize } = world({ show: vi.fn(() => HRESULT_CANCELLED) })
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBeNull()
    expect(pressAlt).toHaveBeenCalledOnce()
    expect(dialog.resultPath).not.toHaveBeenCalled()
    expect(dialog.release).toHaveBeenCalledOnce()
    expect(uninitialize).toHaveBeenCalledOnce()
  })

  // 边界：COM apartment 已初始化时 CoInitializeEx 返回 S_FALSE（此处为 1），属合法重入。
  it('accepts the S_FALSE re-entry HRESULT from CoInitializeEx', () => {
    const { bindings } = world({}, 1)
    expect(runFolderDialog(bindings, 'Pick', vi.fn())).toBe('C:\\picked\\目录')
  })

  // 失败初始化：CoInitializeEx 失败时抛错、不创建对话框；按 COM 契约，
  // 失败的初始化不能配对 CoUninitialize。
  it('throws on a failing CoInitializeEx without creating a dialog or uninitializing', () => {
    const { bindings, createDialog, uninitialize } = world({}, E_FAIL)
    expect(() => runFolderDialog(bindings, 'Pick', vi.fn())).toThrow('CoInitializeEx failed: HRESULT 0x80004005')
    expect(createDialog).not.toHaveBeenCalled()
    // 失败的 CoInitializeEx 绝不能配对 CoUninitialize。
    expect(uninitialize).not.toHaveBeenCalled()
  })

  // 逐方法失败矩阵：SetOptions/SetTitle/Show/GetResult 任一步 HRESULT 失败，
  // 都抛出带方法名的错误，且对话框与 apartment 各释放一次。
  it.each([
    ['SetOptions', { setOptions: vi.fn(() => E_FAIL) }],
    ['SetTitle', { setTitle: vi.fn(() => E_FAIL) }],
    ['Show', { show: vi.fn(() => E_FAIL) }],
    ['GetResult', { resultPath: vi.fn(() => ({ hr: E_FAIL })) }],
  ] satisfies [string, Partial<Win32FolderDialog>][])('releases the dialog and apartment when %s fails', (what, overrides) => {
    const { bindings, dialog, uninitialize } = world(overrides)
    expect(() => runFolderDialog(bindings, 'Pick', vi.fn())).toThrow(`${what} failed: HRESULT 0x80004005`)
    expect(dialog.release).toHaveBeenCalledOnce()
    expect(uninitialize).toHaveBeenCalledOnce()
  })
})
