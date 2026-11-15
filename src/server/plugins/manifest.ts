import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PluginCapabilities } from '../../shared/plugins.ts'
import { RuntimeError } from '../runtime-errors.ts'
import {
  MAX_PLUGIN_MANIFEST_BYTES,
  PLUGIN_MANIFEST_DIRECTORIES,
  parsePluginManifest,
  pluginServerName,
  safePluginRelativePath,
  type PluginManifest,
} from './types.ts'

const MAX_SKILL_DIRECTORIES = 500

/** 已加载并校验通过的插件包：manifest 与声明的技能根目录均已物化。 */
export interface LoadedPluginPackage {
  root: string
  manifestPath: string
  manifest: PluginManifest
  /** 真实存在的声明技能根，每个根下附带找到的技能目录名。 */
  skillRoots: Array<{ path: string; names: string[] }>
  capabilities: PluginCapabilities
}

/** 判断 target 是否位于 root 内（含等于 root 自身），用于防路径逃逸。 */
function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** 抛出插件来源非法错误（错误码 PLUGIN_SOURCE_INVALID）。 */
function invalid(message: string): never {
  throw new RuntimeError('PLUGIN_SOURCE_INVALID', message)
}

/** 读取一个有大小上限的常规文件；插件包内一律不允许跟随符号链接。 */
async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return invalid(`Missing file: ${path}`)
  }
  if (info.isSymbolicLink()) return invalid(`Symbolic links are not allowed in plugin packages: ${path}`)
  if (!info.isFile()) return invalid(`Expected a regular file: ${path}`)
  if (info.size > limit) return invalid(`File is too large: ${path}`)
  return await readFile(path)
}

/** 列出目录下的子目录名（跳过文件），上限 MAX_SKILL_DIRECTORIES；子目录是符号链接即报错；结果按名称排序。 */
async function directoryNames(path: string): Promise<string[]> {
  const names: string[] = []
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (names.length >= MAX_SKILL_DIRECTORIES) break
    if (item.isSymbolicLink()) return invalid(`Skill directory cannot be a symbolic link: ${item.name}`)
    if (item.isDirectory()) names.push(item.name)
  }
  return names.sort()
}

/**
 * 功能：加载并校验一个已物化的插件包（manifest + 声明的技能根目录）。
 * @param root 插件包根目录（staging 或最终安装位置）
 * @param pluginId 插件 ID，用于拼装能力名（如技能 ID `pluginId:技能名`）
 * @returns LoadedPluginPackage；任何非法情况（缺 manifest、符号链接、路径逃逸、声明技能不存在）都抛 PLUGIN_SOURCE_INVALID
 * 内部逻辑：按兼容目录顺序（.pi-plugin/.zcode-plugin/.claude-plugin）找 plugin.json，
 * 符号链接跳过；manifest 经 parsePluginManifest 校验；声明的每个技能根必须真实存在、
 * 非符号链接、且是根内目录，其中含非链接 SKILL.md 文件的子目录才算可用技能。
 */
export async function loadPluginPackage(root: string, pluginId: string): Promise<LoadedPluginPackage> {
  const canonicalRoot = resolve(root)
  let manifestPath: string | undefined
  for (const directory of PLUGIN_MANIFEST_DIRECTORIES) {
    const candidate = join(canonicalRoot, directory, 'plugin.json')
    try {
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) continue
      if (info.isFile()) {
        manifestPath = candidate
        break
      }
    } catch {
      // 继续找下一个兼容的 manifest 目录。
    }
  }
  if (manifestPath === undefined) invalid('plugin.json was not found in .pi-plugin, .zcode-plugin, or .claude-plugin')

  let value: unknown
  try {
    value = JSON.parse((await readRegularFile(manifestPath, MAX_PLUGIN_MANIFEST_BYTES)).toString('utf8'))
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    return invalid(`plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = parsePluginManifest(value)

  const skillRoots: LoadedPluginPackage['skillRoots'] = []
  for (const declared of manifest.skills) {
    const normalized = safePluginRelativePath(declared)
    if (normalized === undefined) invalid(`Skill path must stay inside the plugin: ${declared}`)
    const directory = resolve(canonicalRoot, normalized)
    if (!within(canonicalRoot, directory)) invalid(`Skill path escapes the plugin: ${declared}`)
    let info
    try {
      info = await lstat(directory)
    } catch {
      return invalid(`Declared skill directory does not exist: ${declared}`)
    }
    if (info.isSymbolicLink()) invalid(`Skill directory cannot be a symbolic link: ${declared}`)
    if (!info.isDirectory()) invalid(`Declared skill path is not a directory: ${declared}`)
    const names = await directoryNames(directory)
    const usable: string[] = []
    for (const name of names) {
      try {
        const skillFile = await lstat(join(directory, name, 'SKILL.md'))
        if (skillFile.isFile() && !skillFile.isSymbolicLink()) usable.push(name)
      } catch {
        // 没有 SKILL.md 的目录不算技能。
      }
    }
    skillRoots.push({ path: directory, names: usable })
  }

  return {
    root: canonicalRoot,
    manifestPath,
    manifest,
    skillRoots,
    capabilities: {
      skills: skillRoots.flatMap(rootEntry => rootEntry.names.map(name => `${pluginId}:${name}`)),
      mcpServers: Object.keys(manifest.mcpServers).map(server => pluginServerName(manifest.name, server)),
      uiSurfaces: manifest.uiSurfaces.map(surface => surface.id),
      unsupported: [...manifest.unsupported],
    },
  }
}
