/** 场景 F 疑点对照：promote 后孙进程输出是否进入会话增量。 */
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

// 每 1.5s 打一行，共 20 行（30s），跨过默认 10s yield 点。
const TICKER = 'node -e "let n=0; const t=setInterval(()=>{n++;console.log(\'gc-\'+n); if(n>=20)clearInterval(t)},1500)"'

async function run(label: string, command: string): Promise<void> {
  console.log(`\n===== ${label} =====`)
  const promoted = await pwsh.execute({ command, description: label }, apiFor(), CONTEXT)
  const out = promoted.structuredOutput as { status?: string; sessionId?: string; output?: string }
  console.log('promote:', out.status, out.sessionId, '| 前台输出尾部:', JSON.stringify((out.output ?? '').slice(-120)))
  if (out.status !== 'running') return
  const poll = await shellSession.execute({ sessionId: out.sessionId as string, yieldTimeMs: 25_000 }, apiFor(), CONTEXT)
  const p = poll.structuredOutput as { status?: string; exitCode?: number; output?: string }
  const ticks = [...(p.output ?? '').matchAll(/gc-\d+/gu)].map(m => m[0])
  console.log('poll:', p.status, 'exit', p.exitCode, '| 增量 tick:', JSON.stringify(ticks), '| 增量原文:', JSON.stringify((p.output ?? '').slice(0, 300)))
}

await run('A. powershell 直出 tick（C-2 已验证能流）', TICKER)
await run('B. 经 cmd /c 包一层（模拟 npm.cmd shim 链）', `cmd /c ${TICKER}`)
await run('C. 经 npm run 代理（repo 里借 doc:check 不行，用 npm exec）', `npm exec --userconfig=nul -- call ${TICKER}`)
disposeShellSessions()
