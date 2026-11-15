import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pickWin32Directory } from '../platform/win32-dialog.ts'
import type { DirectoryEntry, DirectoryListing } from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** 面板标题，与 DSH 自带选择器一致。 */
const DIALOG_TITLE = 'Select Workspace Directory'

/**
 * macOS panel source, run by the system JXA host (`osascript -l JavaScript`),
 * copied from DSH so the same NSOpenPanel appears: directories only, creating
 * allowed, single selection, and a cancel printing an empty line rather than
 * failing. The menu install is what makes the panel's own text fields accept
 * paste, which AppleScript's `choose folder` helper cannot do.
 */
const MAC_PANEL = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  app.activateIgnoringOtherApps(true);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.canCreateDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.message = argv[0];
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}
`

const PICK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 功能：运行一个选择器命令并读取其单行输出。
 * @param command 可执行文件（zenity / kdialog）
 * @param args 命令参数
 * @param cancelledExitCodes 代表「用户取消」的退出码（这些工具以非零退出码报告取消）
 * @param signal 中止信号
 * @returns 所选路径；取消返回 null；命令失败返回 undefined（由调用方尝试下一个候选）
 */
async function runPicker(command: string, args: readonly string[], cancelledExitCodes: readonly number[], signal: AbortSignal): Promise<string | null> {
  const outcome = await new Promise<{ code: number | undefined; stdout: string }>((resolve) => {
    execFile(command, [...args], { timeout: PICK_TIMEOUT_MS, signal }, (error, out) => {
      resolve({ code: error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number }).code ?? 1, stdout: out })
    })
  }).catch(() => ({ code: 1, stdout: '' }))
  if (outcome.code === 0) {
    const picked = outcome.stdout.trim()
    return picked === '' ? null : picked
  }
  // 这些工具把「对话框被关掉」报告为非零退出码，而不是空输出。
  if (cancelledExitCodes.includes(Number(outcome.code))) return null
  return undefined as never
}

/**
 * 功能：打开操作系统的文件夹面板并返回所选目录。
 * 平台差异：macOS 用 DSH 同款 JXA 面板；Linux 依次尝试 zenity、kdialog；Windows
 * 走独立的 win32 dialog 宿主进程。两者皆无（或其他平台）抛 UNSUPPORTED，调用方
 * 据此回退到应用内浏览器（与 DSH 启动时选择器探测的分支一致）。
 * @param signal 中止信号：中止时必须把面板一起关掉
 * @returns 绝对路径；用户取消返回 null
 */
export async function pickNativeDirectory(signal: AbortSignal = new AbortController().signal): Promise<string | null> {
  if (process.platform === 'darwin') {
    const stdout = await new Promise<string>((resolve, reject) => {
      // 调用方的 signal 负责关面板：中止的请求不能把面板留在屏幕上。
      execFile('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, DIALOG_TITLE], { timeout: PICK_TIMEOUT_MS, signal }, (error, out) => {
        // 原始失败信息携带整段面板脚本，给客户端的副本要短。
        if (error !== null) { reject(new RuntimeError('PROVIDER_ERROR', '系统目录选择器已中止或不可用')); return }
        resolve(out)
      })
    })
    const picked = stdout.trim()
    return picked === '' ? null : picked
  }

  if (process.platform === 'win32') {
    // DSH 的 koffi 版 IFileOpenDialog 跑在独立子进程里，COM 故障不会拖垮宿主；
    // 驱动在中止时关闭对话框。
    return await pickWin32Directory(signal, DIALOG_TITLE)
  }

  if (process.platform === 'linux') {
    const picked = await runPicker('zenity', ['--file-selection', '--directory', `--title=${DIALOG_TITLE}`], [1], signal)
    if (picked !== undefined) return picked
    const fallback = await runPicker('kdialog', ['--getexistingdirectory', homedir(), '--title', DIALOG_TITLE], [1], signal)
    if (fallback !== undefined) return fallback
    throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的原生目录选择器')
  }

  // 其他平台使用应用内浏览器——与 DSH 给「无原生后端」宿主的界面一致。
  throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的原生目录选择器')
}

export type { DirectoryEntry, DirectoryListing } from '../../shared/types.ts'

const MAX_ENTRIES = 1_000
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 拒绝相对路径与 Windows 的「有根无盘符」路径，而不是把它们解析到宿主 cwd 之下。 */
function requireAbsolute(requested: string, code: 'directory-unreadable' | 'directory-create-failed'): string {
  const path = requested.trim()
  // 仅 Windows：`/foo` 与 `\foo` 有根但无盘符，会解析到宿主进程 cwd 之下；
  // POSIX 上 `/foo` 就是绝对路径。
  const rootedButDriveLess = process.platform === 'win32'
    && /^[\\/]/u.test(path)
    && !/^[A-Za-z]:/u.test(path)
  if (path === '' || !isAbsolute(path) || rootedButDriveLess) {
    throw new RuntimeError('INVALID_INPUT', code === 'directory-unreadable' ? '需要一个绝对路径' : '父目录需要一个绝对路径')
  }
  return path
}

/** 从目标目录向上走到根，构造面包屑（每级 name + path，顺序为根→目标）。 */
function crumbsFor(target: string): { name: string; path: string }[] {
  const chain: { name: string; path: string }[] = []
  let current = target
  while (true) {
    const parent = dirname(current)
    const name = parent === current ? current : basename(current)
    chain.unshift({ name, path: current })
    if (parent === current) return chain
    current = parent
  }
}

/**
 * 功能：为应用内目录浏览器列出一层目录。
 * @param requested 目标目录；空/缺省时用用户主目录，必须是绝对路径
 * @returns 当前路径、主目录、面包屑与子目录条目（跳过文件），条目超过 1000 截断并置 truncated
 * 内部逻辑：先 realpath 规范化（含解析到目录的符号链接）；符号链接用 stat 追查
 * 是否指向目录，损坏或成环的链接被跳过而不是让整层失败；条目按名称自然序排序。
 */
export async function listDirectories(requested?: string): Promise<DirectoryListing> {
  const home = homedir()
  const target = requested === undefined || requested.trim() === '' ? home : requireAbsolute(requested, 'directory-unreadable')
  let resolved: string
  try {
    resolved = await realpath(target)
  } catch (error) {
    throw new RuntimeError('NOT_FOUND', `无法读取目录：${error instanceof Error ? error.message : '未知错误'}`)
  }
  let dirents: Dirent[] = []
  try {
    dirents = await readdir(resolved, { withFileTypes: true })
  } catch (error) {
    throw new RuntimeError('NOT_FOUND', `无法读取目录：${error instanceof Error ? error.message : '未知错误'}`)
  }
  const entries: DirectoryEntry[] = []
  for (const dirent of dirents) {
    const child = join(resolved, dirent.name)
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      // 损坏与成环的链接被跳过，而不是让整层失败。
      try { isDirectory = (await stat(child)).isDirectory() } catch { isDirectory = false }
    }
    if (!isDirectory) continue
    entries.push({ name: dirent.name, path: child, hidden: dirent.name.startsWith('.') })
  }
  entries.sort((left, right) => NAME_ORDER.compare(left.name, right.name))
  const truncated = entries.length > MAX_ENTRIES
  return { path: resolved, home, crumbs: crumbsFor(resolved), entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated }
}

/**
 * 功能：在既有父目录下创建一个子文件夹（与 DSH 的浏览后端一致）。
 * @param parent 父目录（必须是绝对路径）
 * @param name 文件夹名（不得为空、`.`、`..` 或含分隔符）
 * 同名已存在抛 CONFLICT；其他创建失败抛 INVALID_INPUT。
 */
export async function createDirectory(parent: string, name: string): Promise<void> {
  const base = requireAbsolute(parent, 'directory-create-failed')
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[\/]/u.test(trimmed)) {
    throw new RuntimeError('INVALID_INPUT', '文件夹名称不能包含分隔符')
  }
  const target = join(base, trimmed)
  try {
    await mkdir(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new RuntimeError('CONFLICT', '同名文件夹已存在')
    throw new RuntimeError('INVALID_INPUT', `无法创建文件夹：${error instanceof Error ? error.message : '未知错误'}`)
  }
}
