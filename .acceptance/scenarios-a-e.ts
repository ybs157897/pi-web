/**
 * Windows 实机验收 harness：直接驱动 pwsh / shell_session 工具，验证会话化改造的 A–E 场景。
 * 运行：npm run check 之外单独执行 → npx tsx .acceptance/scenarios-a-e.ts
 */
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable'
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

function brief(result: ToolExecutionResult): Record<string, unknown> {
  return {
    structuredOutput: result.structuredOutput,
    isError: result.isError,
    diagnostics: result.diagnostics,
  }
}

async function timed<P>(run: () => Promise<P>): Promise<{ ms: number; value: P }> {
  const start = Date.now()
  const value = await run()
  return { ms: Date.now() - start, value }
}

function check(name: string, pass: boolean, detail: unknown = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  :: ${String(detail)}`}`)
}

const pwsh = createWindowsPowerShellTool()
const shellSession = createShellSessionTool()

async function main(): Promise<void> {
  // ---------- 场景 A：yield 触发 ----------
  console.log('\n===== 场景 A：yield 触发（默认 10s）=====')
  const a = await timed(() => pwsh.execute({
    command: 'Start-Sleep -Seconds 20; Write-Output done-after-sleep',
    description: '验收场景A：20秒命令跨过yield点',
  }, apiFor(), CONTEXT))
  const aOut = a.value.structuredOutput as {
    status?: string; sessionId?: string; exitCode?: number; fullOutputPath?: string; output?: string; truncated?: boolean
  }
  console.log(`A 耗时 ${a.ms}ms`)
  console.log('A 结果:', JSON.stringify(brief(a.value), null, 1))
  check('A1 耗时约 10s（9–13s 窗口）', a.ms >= 9_000 && a.ms <= 13_000, `${a.ms}ms`)
  check('A2 status=running', aOut.status === 'running', aOut.status)
  check('A3 sessionId 形如 sh_xxxxxxxx', /^sh_[0-9a-f]{8}$/u.test(aOut.sessionId ?? ''), aOut.sessionId)
  check('A4 fullOutputPath 存在', typeof aOut.fullOutputPath === 'string' && aOut.fullOutputPath.length > 0, aOut.fullOutputPath)
  check('A5 无旧「转后台」文案', !/(转入后台|后台运行|background)/iu.test(aOut.output ?? ''), JSON.stringify(aOut.output?.slice(-200)))
  check('A6 诊断含 session_started', a.value.diagnostics?.some(d => d.code === 'session_started') === true, JSON.stringify(a.value.diagnostics))

  // ---------- 场景 B：增量轮询 + 终态 + 回收 ----------
  console.log('\n===== 场景 B：shell_session 轮询场景A会话（yieldTimeMs=20000）=====')
  const sessionId = aOut.sessionId as string
  const b = await timed(() => shellSession.execute({ sessionId, yieldTimeMs: 20_000 }, apiFor(), CONTEXT))
  const bOut = b.value.structuredOutput as { status?: string; exitCode?: number; output?: string }
  console.log(`B 耗时 ${b.ms}ms`)
  console.log('B 结果:', JSON.stringify(brief(b.value), null, 1))
  check('B1 status=exited', bOut.status === 'exited', bOut.status)
  check('B2 exitCode=0', bOut.exitCode === 0, bOut.exitCode)
  check('B3 增量含 done-after-sleep', (bOut.output ?? '').includes('done-after-sleep'), JSON.stringify(bOut.output?.slice(-200)))
  const second = await timed(() => shellSession.execute({ sessionId }, apiFor(), CONTEXT)
    .then(v => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })))
  const nfMessage = second.value.ok ? '' : second.value.e instanceof Error ? second.value.e.message : String(second.value.e)
  check('B4 二次轮询 NOT_FOUND（会话已回收）', !second.value.ok && /does not exist|NOT_FOUND/iu.test(nfMessage), nfMessage)

  // ---------- 场景 C：消费游标 ----------
  console.log('\n===== 场景 C-1：文档原命令（1..3，tick 全在 promote 前）=====')
  const c1 = await timed(() => pwsh.execute({
    command: '1..3 | ForEach-Object { Write-Output "tick-$_"; Start-Sleep -Seconds 4 }',
    description: '验收场景C：3个tick跨yield点',
  }, apiFor(), CONTEXT))
  const c1Out = c1.value.structuredOutput as { status?: string; sessionId?: string; output?: string }
  console.log(`C-1 promote 耗时 ${c1.ms}ms`)
  console.log('C-1 promote 结果:', JSON.stringify(brief(c1.value), null, 1))
  const c1Id = c1Out.sessionId as string
  const c1Poll = await timed(() => shellSession.execute({ sessionId: c1Id, yieldTimeMs: 5_000 }, apiFor(), CONTEXT))
  const c1PollOut = c1Poll.value.structuredOutput as { status?: string; exitCode?: number; output?: string }
  console.log(`C-1 轮询耗时 ${c1Poll.ms}ms`)
  console.log('C-1 轮询结果:', JSON.stringify(brief(c1Poll.value), null, 1))
  check('C1.1 增量不含已消费 tick（无重复）', !/tick-\d/u.test(c1PollOut.output ?? ''), JSON.stringify(c1PollOut.output))
  check('C1.2 会话终态 exited/0', c1PollOut.status === 'exited' && c1PollOut.exitCode === 0, `${c1PollOut.status}/${c1PollOut.exitCode}`)

  console.log('\n===== 场景 C-2：扩展命令（1..5，tick 跨 promote 前后）=====')
  const c2 = await timed(() => pwsh.execute({
    command: '1..5 | ForEach-Object { Write-Output "tick-$_"; Start-Sleep -Seconds 4 }',
    description: '验收场景C：5个tick跨yield点前后',
  }, apiFor(), CONTEXT))
  const c2Out = c2.value.structuredOutput as { status?: string; sessionId?: string; output?: string }
  console.log(`C-2 promote 耗时 ${c2.ms}ms`)
  console.log('C-2 promote 输出含:', JSON.stringify(c2Out.output))
  const c2Id = c2Out.sessionId as string
  const c2P1 = await timed(() => shellSession.execute({ sessionId: c2Id, yieldTimeMs: 4_000 }, apiFor(), CONTEXT))
  const c2P1Out = c2P1.value.structuredOutput as { status?: string; output?: string }
  console.log(`C-2 轮询1 耗时 ${c2P1.ms}ms →`, JSON.stringify(brief(c2P1.value), null, 1))
  const c2P2 = await timed(() => shellSession.execute({ sessionId: c2Id, yieldTimeMs: 20_000 }, apiFor(), CONTEXT))
  const c2P2Out = c2P2.value.structuredOutput as { status?: string; exitCode?: number; output?: string }
  console.log(`C-2 轮询2 耗时 ${c2P2.ms}ms →`, JSON.stringify(brief(c2P2.value), null, 1))
  const promotedTicks = [...(c2Out.output ?? '').matchAll(/tick-\d/gu)].map(m => m[0])
  const p1Ticks = [...(c2P1Out.output ?? '').matchAll(/tick-\d/gu)].map(m => m[0])
  const p2Ticks = [...(c2P2Out.output ?? '').matchAll(/tick-\d/gu)].map(m => m[0])
  console.log(`C-2 tick 分布: promote=[${promotedTicks.join(',')}] poll1=[${p1Ticks.join(',')}] poll2=[${p2Ticks.join(',')}]`)
  check('C2.1 轮询1 只含 promote 后的新 tick', p1Ticks.length > 0 && p1Ticks.every(t => !promotedTicks.includes(t)), `poll1=[${p1Ticks.join(',')}]`)
  check('C2.2 轮询2 只含更新一轮 tick（无重复）', p2Ticks.every(t => !promotedTicks.includes(t) && !p1Ticks.includes(t)), `poll2=[${p2Ticks.join(',')}]`)
  check('C2.3 终态 exited/0', c2P2Out.status === 'exited' && c2P2Out.exitCode === 0, `${c2P2Out.status}/${c2P2Out.exitCode}`)
  const c2Reclaim = await shellSession.execute({ sessionId: c2Id }, apiFor(), CONTEXT)
    .then(() => false, (e: unknown) => /does not exist|NOT_FOUND/iu.test(e instanceof Error ? e.message : String(e)))
  check('C2.4 终态读取后会话回收 NOT_FOUND', c2Reclaim)

  // ---------- 场景 D：stdin 写入 ----------
  console.log('\n===== 场景 D：stdin 写入（-NonInteractive 风险点）=====')
  const d = await timed(() => pwsh.execute({
    command: '$line = [Console]::In.ReadLine(); Write-Output "got:$line"',
    description: '验收场景D：stdin读取回显',
  }, apiFor(), CONTEXT))
  const dOut = d.value.structuredOutput as { status?: string; sessionId?: string; exitCode?: number; output?: string }
  console.log(`D 调用耗时 ${d.ms}ms`)
  console.log('D 结果:', JSON.stringify(brief(d.value), null, 1))
  if (dOut.status === 'running') {
    const dPoll = await timed(() => shellSession.execute({ sessionId: dOut.sessionId as string, stdin: 'hello-stdin\n', yieldTimeMs: 20_000 }, apiFor(), CONTEXT))
    const dPollOut = dPoll.value.structuredOutput as { status?: string; exitCode?: number; output?: string }
    console.log(`D 轮询耗时 ${dPoll.ms}ms`)
    console.log('D 轮询结果:', JSON.stringify(brief(dPoll.value), null, 1))
    check('D1 终态 exited', dPollOut.status === 'exited', dPollOut.status)
    check('D2 增量含 got:hello-stdin', (dPollOut.output ?? '').includes('got:hello-stdin'), JSON.stringify(dPollOut.output))
  } else {
    // -NonInteractive 拦截 ReadLine：进程立即 EOF/报错退出，promote 不会发生 —— 按文档要求如实记录。
    check('D1 promote 发生（status=running）', false, `实际 status=${dOut.status} exitCode=${dOut.exitCode}`)
    check('D2 增量含 got:hello-stdin', false, `-NonInteractive 拦截现象: ${JSON.stringify(dOut.output)} isError=${String(d.value.isError)} diagnostics=${JSON.stringify(d.value.diagnostics)}`)
  }

  // ---------- 场景 E：timeout 硬上限 ----------
  console.log('\n===== 场景 E-1：文档原样（timeout=5s < 默认 yield 10s）=====')
  const e1 = await timed(() => pwsh.execute({
    command: 'Start-Sleep -Seconds 120',
    timeout: 5,
    description: '验收场景E：timeout硬上限',
  }, apiFor(), CONTEXT))
  const e1Out = e1.value.structuredOutput as { status?: string; sessionId?: string; exitCode?: number }
  console.log(`E-1 耗时 ${e1.ms}ms`)
  console.log('E-1 结果:', JSON.stringify(brief(e1.value), null, 1))
  check('E1.1 exitCode=-1', e1Out.exitCode === -1, e1Out.exitCode)
  check('E1.2 isError=true', e1.value.isError === true, String(e1.value.isError))
  check('E1.3 诊断含 timeout', e1.value.diagnostics?.some(d => d.code === 'timeout') === true, JSON.stringify(e1.value.diagnostics))

  console.log('\n===== 场景 E-2：变体（timeout=20s > yieldTimeMs=3s，走 promote 后 timeout 杀进程）=====')
  const e2 = await timed(() => pwsh.execute({
    command: 'Start-Sleep -Seconds 120',
    timeout: 20,
    yieldTimeMs: 3_000,
    description: '验收场景E：promote后timeout杀进程',
  }, apiFor(), CONTEXT))
  const e2Out = e2.value.structuredOutput as { status?: string; sessionId?: string; exitCode?: number }
  console.log(`E-2 promote 耗时 ${e2.ms}ms`)
  console.log('E-2 promote 结果:', JSON.stringify(brief(e2.value), null, 1))
  if (e2Out.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 18_000)) // promote 后等到 timeout(20s) 过点
    const e2Poll = await timed(() => shellSession.execute({ sessionId: e2Out.sessionId as string, yieldTimeMs: 10_000 }, apiFor(), CONTEXT))
    const e2PollOut = e2Poll.value.structuredOutput as { status?: string; exitCode?: number; output?: string }
    console.log(`E-2 轮询耗时 ${e2Poll.ms}ms`)
    console.log('E-2 轮询结果:', JSON.stringify(brief(e2Poll.value), null, 1))
    check('E2.1 status=exited', e2PollOut.status === 'exited', e2PollOut.status)
    check('E2.2 exitCode=-1', e2PollOut.exitCode === -1, e2PollOut.exitCode)
    check('E2.3 isError=true', e2Poll.value.isError === true, String(e2Poll.value.isError))
    check('E2.4 诊断含 timeout', e2Poll.value.diagnostics?.some(d => d.code === 'timeout') === true, JSON.stringify(e2Poll.value.diagnostics))
    check('E2.5 输出含 [timed out after 20s]', (e2PollOut.output ?? '').includes('[timed out after 20s]'), JSON.stringify(e2PollOut.output?.slice(-200)))
    const e2Reclaim = await shellSession.execute({ sessionId: e2Out.sessionId as string }, apiFor(), CONTEXT)
      .then(() => false, (e: unknown) => /does not exist|NOT_FOUND/iu.test(e instanceof Error ? e.message : String(e)))
    check('E2.6 超时会话同样回收 NOT_FOUND', e2Reclaim)
  } else {
    check('E2 promote 发生', false, `实际 status=${e2Out.status}`)
  }
}

main()
  .catch(error => { console.error('HARNESS ERROR:', error); process.exitCode = 1 })
  .finally(() => disposeShellSessions())
