import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai'

export const DEMO_SKILL = [
  '---', 'name: demo-verifier',
  'description: Verify the explicitly requested Pi Web skill demonstration.',
  '---', '', 'Return the exact marker PI_WEB_SKILL_READY when asked to run this demonstration.', '',
].join('\n')

/** Deterministic integration fixture, used only by the explicitly selected demo model. */
export function skillsDemoResponse(context: Parameters<FauxResponseFactory>[0]) {
  const start = context.messages.findLastIndex(message => message.role === 'user')
  const user = context.messages[start]
  const text = user?.role === 'user'
    ? typeof user.content === 'string' ? user.content : user.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    : ''
  if (!/\[skills-(create|use|nested-save|delegate)\]/.test(text)) return undefined
  const results = context.messages.slice(start + 1).filter(message => message.role === 'toolResult')
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(
    fauxToolCall(name, args, { id: `demo-skills-${context.messages.length}` }), { stopReason: 'toolUse' },
  )
  const latest = results.at(-1)
  if (latest?.isError) return fauxAssistantMessage(fauxText('Skill 演示遇到工具错误；请检查上方实际工具结果。'))
  if (text.includes('[skills-nested-save]')) {
    if (!results.length) return call('codemode', {
      code: `return await tools.skill_save(${JSON.stringify({ name: 'demo-verifier', content: DEMO_SKILL })})`,
    })
  } else if (text.includes('[skills-delegate]')) {
    if (!results.length) return call('subagent', { task: '[skills-use] Load and use the project demo-verifier skill.', label: 'Skill verifier' })
  } else if (text.includes('[skills-use]')) {
    if (!results.length) return call('skill_load', { skill: 'agents:demo-verifier' })
  } else {
    switch (results.length) {
      case 0: return call('skill_load', { skill: 'builtin:skill-creator' })
      case 1: return call('skill_save', { name: 'demo-verifier', content: DEMO_SKILL })
      case 2: return call('skill_list', {})
      case 3: return call('skill_validate', { skill: 'agents:demo-verifier' })
      case 4: return call('skill_load', { skill: 'agents:demo-verifier' })
    }
  }
  const output = latest?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
  return fauxAssistantMessage(fauxText(`Skill 演示工具结果：\n${output}`))
}
