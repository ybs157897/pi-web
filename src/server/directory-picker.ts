import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pickWin32Directory } from './win32-dialog.ts'
import type { DirectoryEntry, DirectoryListing } from '../shared/types.ts'
import { RuntimeError } from './runtime-errors.ts'

/** Panel prompt, matching DSH's own picker title. */
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
 * Run one picker command and read its single-line answer.
 * @returns the selected path, or null when the operator cancelled.
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
  // These tools report a dismissed dialog as a nonzero exit, not as an empty answer.
  if (cancelledExitCodes.includes(Number(outcome.code))) return null
  return undefined as never
}

/**
 * Open the operating system's folder panel and return what the operator picked.
 * macOS uses DSH's own JXA panel; Linux uses the desktop's zenity or kdialog.
 * A host with neither reports UNSUPPORTED, and the caller falls back to the
 * in-app browser (the same split DSH's boot-time picker probe makes).
 * @returns the absolute path, or null when the panel was cancelled.
 */
export async function pickNativeDirectory(signal: AbortSignal = new AbortController().signal): Promise<string | null> {
  if (process.platform === 'darwin') {
    const stdout = await new Promise<string>((resolve, reject) => {
      // The caller's signal closes the panel: an aborted request must not leave it on screen.
      execFile('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, DIALOG_TITLE], { timeout: PICK_TIMEOUT_MS, signal }, (error, out) => {
        // The raw failure carries the whole panel script; keep the client copy short.
        if (error !== null) { reject(new RuntimeError('PROVIDER_ERROR', '系统目录选择器已中止或不可用')); return }
        resolve(out)
      })
    })
    const picked = stdout.trim()
    return picked === '' ? null : picked
  }

  if (process.platform === 'win32') {
    // DSH's koffi-backed IFileOpenDialog runs in its own child process so a COM
    // fault cannot take the host down; the driver closes the dialog on abort.
    return await pickWin32Directory(signal, DIALOG_TITLE)
  }

  if (process.platform === 'linux') {
    const picked = await runPicker('zenity', ['--file-selection', '--directory', `--title=${DIALOG_TITLE}`], [1], signal)
    if (picked !== undefined) return picked
    const fallback = await runPicker('kdialog', ['--getexistingdirectory', homedir(), '--title', DIALOG_TITLE], [1], signal)
    if (fallback !== undefined) return fallback
    throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的原生目录选择器')
  }

  // Other platforms get the in-app browser, the same surface DSH gives a host
  // whose picker probe finds no native backend.
  throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的原生目录选择器')
}

export type { DirectoryEntry, DirectoryListing } from '../shared/types.ts'

const MAX_ENTRIES = 1_000
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Reject relative and Windows root-relative paths instead of resolving them under the host's cwd. */
function requireAbsolute(requested: string, code: 'directory-unreadable' | 'directory-create-failed'): string {
  const path = requested.trim()
  // Windows-only: `/foo` and `\foo` are rooted but drive-less there, and would
  // resolve under the host process's cwd. On POSIX `/foo` is simply absolute.
  const rootedButDriveLess = process.platform === 'win32'
    && /^[\\/]/u.test(path)
    && !/^[A-Za-z]:/u.test(path)
  if (path === '' || !isAbsolute(path) || rootedButDriveLess) {
    throw new RuntimeError('INVALID_INPUT', code === 'directory-unreadable' ? '需要一个绝对路径' : '父目录需要一个绝对路径')
  }
  return path
}

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

/** List one directory level for the in-app picker, following symlinks to directories. */
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
      // Broken and cyclic links are skipped rather than failing the whole level.
      try { isDirectory = (await stat(child)).isDirectory() } catch { isDirectory = false }
    }
    if (!isDirectory) continue
    entries.push({ name: dirent.name, path: child, hidden: dirent.name.startsWith('.') })
  }
  entries.sort((left, right) => NAME_ORDER.compare(left.name, right.name))
  const truncated = entries.length > MAX_ENTRIES
  return { path: resolved, home, crumbs: crumbsFor(resolved), entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated }
}

/** Create one child directory under an existing parent, like DSH's browse backend. */
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
