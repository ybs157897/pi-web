/**
 * 移植自 DSH 0.2.1-rc.2（MIT，见 vendor/DSH-LICENSE）。
 * Win32 `IFileOpenDialog` 文件夹选择器 COM 会话的纯时序编排，平台绑定可注入，
 * 因此每条结果路径（选中、取消、HRESULT 失败、清理顺序）在任何平台都可测。
 * koffi 实现的绑定在 `win32-dialog-bindings.ts`，只有真正的 win32 进程才会加载它。
 */

/** `HRESULT_FROM_WIN32(ERROR_CANCELLED)`：用户关闭了对话框。 */
export const HRESULT_CANCELLED = 0x800704c7 | 0

/** `FOS_PICKFOLDERS`：对话框选择目录而非文件。 */
export const FOS_PICKFOLDERS = 0x20
/** `FOS_FORCEFILESYSTEM`：只允许选有文件系统路径的结果。 */
export const FOS_FORCEFILESYSTEM = 0x40
/** `FOS_NOCHANGEDIR`：绝不改动进程工作目录。 */
export const FOS_NOCHANGEDIR = 0x8

/** 一个已创建的文件夹对话框：时序编排所需的虚表调用。 */
export interface Win32FolderDialog {
  /**
   * `IFileDialog::SetOptions`。
   * @param options - 要应用的 `FOS_*` 标志并集。
   * @returns 调用的 HRESULT。
   */
  setOptions(options: number): number
  /**
   * `IFileDialog::SetTitle`。
   * @param title - 对话框标题文本。
   * @returns 调用的 HRESULT。
   */
  setTitle(title: string): number
  /**
   * 无属主窗口的 `IModalWindow::Show`；阻塞调用线程直到用户选择或关闭。
   * @returns 调用的 HRESULT（用户关闭时为 `HRESULT_CANCELLED`）。
   */
  show(): number
  /**
   * `IFileDialog::GetResult` + `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)`，
   * 释放 shell item 并释放 COM 字符串。
   * @returns 调用链的 HRESULT，成功时附带所选路径。
   */
  resultPath(): { hr: number; path?: string }
  /** 释放对话框的 COM 引用。 */
  release(): void
}

/** 对话框时序所依赖的线程级原生表面。 */
export interface Win32DialogBindings {
  /**
   * 让调用线程启用它支持的最佳 DPI 感知（per-monitor-v2，其次 per-monitor，
   * 再次 system-aware），逐个检查调用结果。刻意做成尽力而为：宿主一个都不接受
   * （或 API 缺失，1607 之前）时仍显示现代对话框——缩放超 100% 时可能发虚——
   * 因为外观退化不能换来整层功能缺失。
   */
  setThreadDpiAwareness(): void
  /**
   * 在调用线程上执行 `CoInitializeEx(COINIT_APARTMENTTHREADED)`。
   * @returns 调用的 HRESULT（`S_FALSE` 重入仍算成功）。
   */
  coInitializeSta(): number
  /**
   * 在调用线程上执行 `CoUninitialize` —— COM 要求每次成功的 `CoInitializeEx`
   * （含 `S_FALSE`）配对一次，即使线程在会话结束后立刻退出。
   */
  coUninitialize(): void
  /**
   * `CoCreateInstance(CLSID_FileOpenDialog)`。
   * @returns 已创建的对话框表面；创建失败时抛出。
   */
  createFolderDialog(): Win32FolderDialog
  /**
   * `GetCurrentThreadId` —— 驱动从外部关闭本线程窗口所需的线程 id。
   * @returns 调用线程的原生 id。
   */
  currentThreadId(): number
  /**
   * 让 `Show` 即将创建的对话框有能力夺取前台。Windows 只把激活权给前台进程、
   * 它启动的进程或最近收到输入的进程；后台宿主（web GUI server）spawn 的 worker
   * 三者都不满足，对话框会开在所有窗口后面。通过 `keybd_event` 合成一次 Alt
   * 按键（按下再抬起）让本进程算作最近输入者——社区流传的技巧，无文档契约。
   * 必须在 `Show` 前一刻调用。进程已持有前台权（控制台启动的 CLI）时按键无效果，
   * 但焦点窗口仍会收到这次 Alt，可能在对话框激活前短暂高亮其菜单栏。
   */
  pressAltForForeground(): void
}

/**
 * HRESULT 表示失败时抛出。
 * @param hr - 要检查的 HRESULT。
 * @param what - 失败调用的名称（进错误消息）。
 * @returns 成功的 HRESULT 原样返回。
 */
function check(hr: number, what: string): number {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`)
  return hr
}

/**
 * 功能：在调用线程上跑完一次模态文件夹选择会话：DPI 启用、STA 初始化、创建
 * 对话框、`Show`、提取结果，任何路径都释放对话框。
 * @param bindings - 原生表面（生产为 koffi 实现，测试为假实现）。
 * @param title - 对话框标题文本。
 * @param onShowing - 在阻塞的 `Show` 前一刻以原生线程 id 调用，其他线程上的
 *   驱动借此关闭对话框。
 * @returns 所选文件系统路径；用户取消返回 null。
 * 内部逻辑：COM 配对语义——CoInitializeEx 成功（含 S_FALSE）后每条路径都必须
 * CoUninitialize 恰好一次；对话框释放挂在内层 finally；HRESULT_CANCELLED 直接
 * 返回 null，其余负值 HRESULT 转成带调用名的错误。
 */
export function runFolderDialog(
  bindings: Win32DialogBindings,
  title: string,
  onShowing: (threadId: number) => void,
): string | null {
  bindings.setThreadDpiAwareness()
  check(bindings.coInitializeSta(), 'CoInitializeEx')
  // 从这里起 COM 单元已初始化（S_OK 或 S_FALSE），每条路径都必须恰好
  // 反初始化一次。
  try {
    const dialog = bindings.createFolderDialog()
    try {
      check(dialog.setOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR), 'SetOptions')
      check(dialog.setTitle(title), 'SetTitle')
      onShowing(bindings.currentThreadId())
      bindings.pressAltForForeground()
      const shown = dialog.show()
      if (shown === HRESULT_CANCELLED) return null
      check(shown, 'Show')
      const result = dialog.resultPath()
      check(result.hr, 'GetResult')
      return result.path as string
    } finally {
      dialog.release()
    }
  } finally {
    bindings.coUninitialize()
  }
}
