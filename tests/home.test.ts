import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateGlobalHome, piWebHome } from '../src/server/state/home.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-home-'))
  roots.push(root)
  const home = join(root, 'home')
  const legacyData = join(root, 'legacy-data')
  const piHome = join(root, 'legacy-pi')
  await Promise.all([mkdir(legacyData, { recursive: true }), mkdir(piHome, { recursive: true })])
  return { root, home, legacyData, piHome }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('global home migration', () => {
  it('derives ~/.pi-web and honors PI_WEB_HOME', () => {
    expect(piWebHome({})).toMatch(/\/\.pi-web$/)
    expect(piWebHome({ PI_WEB_HOME: '/tmp/custom-pi-web' })).toBe('/tmp/custom-pi-web')
  })

  it('imports Pi files, layers the legacy app providers over them, and copies app data once', async () => {
    const { home, legacyData, piHome } = await fixture()
    await writeFile(join(piHome, 'settings.json'), JSON.stringify({ defaultProvider: 'pi-provider', defaultModel: 'pi-model' }))
    await writeFile(join(piHome, 'models.json'), JSON.stringify({
      providers: { 'pi-provider': { keep: true, baseUrl: 'https://pi.example/v1', models: [{ id: 'pi-model' }] } },
    }))
    await writeFile(join(piHome, 'auth.json'), JSON.stringify({ 'pi-provider': { type: 'api_key', key: 'pi-key' } }))
    await writeFile(join(piHome, 'mcp.json'), JSON.stringify({ servers: {} }))
    await writeFile(join(legacyData, 'providers.json'), JSON.stringify({
      providers: [{
        id: 'pi-provider', name: 'App Provider', baseUrl: 'https://app.example/v1', api: 'openai-completions',
        models: [{ id: 'app-model' }],
      }],
      credentials: { 'app-provider': { type: 'api_key', key: 'app-key' } },
    }))
    await writeFile(join(legacyData, 'app-state.json'), '{"version":1}')
    await writeFile(join(legacyData, 'pi-durable.sqlite'), 'sqlite')

    const migrated = await migrateGlobalHome(home, legacyData, { piHome })
    expect(migrated.length).toBeGreaterThan(0)
    const models = JSON.parse(await readFile(join(home, 'models.json'), 'utf8'))
    expect(models.providers['pi-provider']).toMatchObject({ keep: true, baseUrl: 'https://app.example/v1', models: [{ id: 'app-model' }] })
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    expect(auth['pi-provider']).toEqual({ type: 'api_key', key: 'pi-key' })
    expect(auth['app-provider']).toEqual({ type: 'api_key', key: 'app-key' })
    expect(await readFile(join(home, 'app-state.json'), 'utf8')).toBe('{"version":1}')
    expect(await readFile(join(home, 'pi-durable.sqlite'), 'utf8')).toBe('sqlite')
    expect(await readFile(join(home, 'mcp.json'), 'utf8')).toBe('{"servers":{}}')

    // The marker makes the import one-time even if the old files change later.
    await writeFile(join(legacyData, 'app-state.json'), '{"version":2}')
    expect(await migrateGlobalHome(home, legacyData, { piHome })).toEqual([])
    expect(await readFile(join(home, 'app-state.json'), 'utf8')).toBe('{"version":1}')
  })

  it('leaves an existing global models.json and auth.json alone', async () => {
    const { home, legacyData, piHome } = await fixture()
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { mine: { baseUrl: 'https://mine.example/v1', models: [{ id: 'm' }] } } }))
    await writeFile(join(home, 'auth.json'), JSON.stringify({ mine: { type: 'api_key', key: 'mine-key' } }))
    await writeFile(join(legacyData, 'providers.json'), JSON.stringify({
      providers: [{ id: 'legacy', name: 'Legacy', baseUrl: 'https://legacy.example/v1', models: [{ id: 'l' }] }],
      credentials: { legacy: { type: 'api_key', key: 'legacy-key' } },
    }))
    await migrateGlobalHome(home, legacyData, { piHome })
    const models = JSON.parse(await readFile(join(home, 'models.json'), 'utf8'))
    expect(Object.keys(models.providers)).toEqual(['mine'])
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    expect(Object.keys(auth)).toEqual(['mine'])
  })
})
