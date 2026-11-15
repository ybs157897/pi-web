/** 场景 F 复现：npm run check 相同参数（yieldTimeMs 30000, timeout 1200），验证 poll 增量。 */
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { createShellSessionTool } from '../src/server/tools/shell/session.ts'
import { disposeShellSessions } from '../src/server/tools/shell/runner.ts'
import { createWindowsPowerShellTool } from '../src/server/tools/shell/windows.ts'

const CWD = 'E:\\ai\\code\\pi-web'
const CONTEXT = {} as Context

function apiFor(): ToolExecutionApi {
  let text = ''
  return {
    env: new NodeExecutionEnv({ cwd: CWD }),
    callId: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    output: (chunk: string) => { text += chunk },
    retainedOutput: () => ({ text, truncated: false }),
    diagnostic: () => undefined,
  } as unknown as ToolExecutionApi
}

const pwsh = createWindowsPowerShellTool()
const shellSession = createShellSessionTool()

console.log('启动 npm run check（yieldTimeMs=30000, timeout=1200）…')
const t0 = Date.now()
const promoted = await pwsh.execute({
  command: 'npm run check',
  description: '复现场景F',
  workdir: CWD,
  yieldTimeMs: 30_000,
  timeout: 1200,
}, apiFor(), CONTEXT)
const out = promoted.structuredOutput as { status?: string; sessionId?: string; output?: string; fullOutputPath?: string }
console.log(`promote @${Date.now() - t0}ms:`, out.status, out.sessionId)
console.log('前台输出（含 vitest 进度）长度:', (out.output ?? '').length, '尾部:', JSON.stringify((out.output ?? '').slice(-150)))

await new Promise(r => setTimeout(r, 15_000))
console.log(`poll @${Date.now() - t0}ms（yieldTimeMs=30000）…`)
const poll = await shellSession.execute({ sessionId: out.sessionId as string, yieldTimeMs: 30_000 }, apiFor(), CONTEXT)
const p = poll.structuredOutput as { status?: string; exitCode?: number; output?: string; truncated?: boolean }
console.log(`poll 返回 @${Date.now() - t0}ms:`, p.status, 'exit', p.exitCode, 'truncated', p.truncated)
console.log('增量长度:', (p.output ?? '').length)
console.log('增量尾部 400 字:', JSON.stringify((p.output ?? '').slice(-400)))
console.log('spill 文件:', out.fullOutputPath)
disposeShellSessions()
