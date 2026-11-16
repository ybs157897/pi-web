import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateGlobalHome, piWebHome } from '../src/server/state/home.ts'

/** 已创建的临时目录根列表，用例结束后统一递归删除。 */
const roots: string[] = []

/**
 * 构造迁移夹具目录：home（目标）、legacy-data（旧应用数据）、legacy-pi（旧 ~/.pi）。
 * @returns 三个目录的绝对路径
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-home-'))
  roots.push(root)
  const home = join(root, 'home')
  const legacyData = join(root, 'legacy-data')
  const piHome = join(root, 'legacy-pi')
  await Promise.all([mkdir(legacyData, { recursive: true }), mkdir(piHome, { recursive: true })])
  return { root, home, legacyData, piHome }
}

/** 每个用例后：删除本组创建的所有临时目录。 */
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * 全局 home 目录迁移测试。
 *
 * 关键契约：
 * - piWebHome 默认解析为 ~/.pi-web，PI_WEB_HOME 环境变量可覆盖；
 * - migrateGlobalHome 一次性导入 Pi 文件（settings/models/auth/mcp.json）、把旧应用的
 *   providers.json 以覆盖层方式并入（同 id 的 provider 用应用的 baseUrl/models 但保留 Pi 的
 *   keep 标记），并按标记一次性复制应用数据（app-state.json、sqlite）；
 * - 标记保证导入只执行一次，即使旧文件后来变化也不重导；
 * - 已存在的全局 models.json / auth.json 不被迁移覆盖。
 */
describe('global home migration', () => {
  // 默认路径以 /.pi-web 结尾；PI_WEB_HOME 设置后直接采用该路径。
  it('derives ~/.pi-web and honors PI_WEB_HOME', () => {
    expect(piWebHome({})).toMatch(/\/\.pi-web$/)
    expect(piWebHome({ PI_WEB_HOME: '/tmp/custom-pi-web' })).toBe('/tmp/custom-pi-web')
  })

  // 导入 Pi 文件；providers.json 作为覆盖层并入（baseUrl/models 来自应用、keep 保留）；应用数据复制；标记使其只发生一次。
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

    // 标记让导入只发生一次，即使旧文件后来变化了。
    await writeFile(join(legacyData, 'app-state.json'), '{"version":2}')
    expect(await migrateGlobalHome(home, legacyData, { piHome })).toEqual([])
    expect(await readFile(join(home, 'app-state.json'), 'utf8')).toBe('{"version":1}')
  })

  // 目标目录已存在全局 models.json / auth.json 时完全不迁移它们，保留用户现有内容。
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
