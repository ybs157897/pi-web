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

export interface LoadedPluginPackage {
  root: string
  manifestPath: string
  manifest: PluginManifest
  /** Declared skill roots that actually exist, each with the skill directory names found under it. */
  skillRoots: Array<{ path: string; names: string[] }>
  capabilities: PluginCapabilities
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function invalid(message: string): never {
  throw new RuntimeError('PLUGIN_SOURCE_INVALID', message)
}

/** Read one bounded regular file; plugin packages never get to follow a symlink. */
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

async function directoryNames(path: string): Promise<string[]> {
  const names: string[] = []
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (names.length >= MAX_SKILL_DIRECTORIES) break
    if (item.isSymbolicLink()) return invalid(`Skill directory cannot be a symbolic link: ${item.name}`)
    if (item.isDirectory()) names.push(item.name)
  }
  return names.sort()
}

/** Load and validate a materialized plugin package (manifest + declared skill roots). */
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
      // Keep looking in the next compatible manifest directory.
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
        // A directory without SKILL.md is not a skill.
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
