import type { Hono } from 'hono'
import { z } from 'zod'
import type { DecisionInbox } from './runtime/decision-inbox.ts'
import { RuntimeError } from './runtime-errors.ts'

const id = z.string().trim().min(1).max(160)
const mailUpdate = z.discriminatedUnion('action', [
  z.object({ action: z.literal('archive') }).strict(),
  z.object({ action: z.literal('restore') }).strict(),
  z.object({ action: z.literal('snooze'), until: z.number().int().positive() }).strict(),
])
const resultVerdict = z.object({
  action: z.enum(['accept', 'revise']),
  feedback: z.string().trim().min(1).max(2_000).optional(),
}).strict()
const attempt = z.number().int().positive()
const inConversationVerdict = resultVerdict.extend({ attempt })
const presence = z.object({
  viewId: z.uuid(),
  sequence: z.number().int().positive(),
  active: z.boolean(),
  observed: z.array(z.union([
    z.object({ kind: z.literal('interaction'), id }).strict(),
    z.object({ kind: z.enum(['result', 'failure']), itemId: id, attempt }).strict(),
  ])).max(2),
}).strict()

function identifier(value: string): string {
  const parsed = id.safeParse(value)
  if (!parsed.success) throw new RuntimeError('INVALID_INPUT', '收件箱标识无效')
  return parsed.data
}

export function mountDecisionInboxRoutes(
  app: Hono,
  inbox: DecisionInbox,
  readJson: <T>(request: Request, schema: z.ZodType<T>) => Promise<T>,
): void {
  app.get('/api/workbench/:workspaceId/inbox', async c => c.json(await inbox.list(identifier(c.req.param('workspaceId')))))
  app.post('/api/workbench/:workspaceId/inbox/presence/:conversationId', async c => {
    const input = await readJson(c.req.raw, presence)
    await inbox.presence(identifier(c.req.param('workspaceId')), identifier(c.req.param('conversationId')), input)
    return c.json({ ok: true })
  })
  app.patch('/api/workbench/:workspaceId/inbox', async c => {
    const { ids, update } = await readJson(c.req.raw, z.object({ ids: z.array(id).min(1), update: mailUpdate }).strict())
    await inbox.updateMany(identifier(c.req.param('workspaceId')), ids, update)
    return c.json({ ok: true })
  })
  app.get('/api/workbench/:workspaceId/inbox/:mailId', async c => c.json(await inbox.detail(
    identifier(c.req.param('workspaceId')), identifier(c.req.param('mailId')),
  )))
  app.post('/api/workbench/:workspaceId/inbox/:mailId/opened', async c => {
    await inbox.opened(identifier(c.req.param('workspaceId')), identifier(c.req.param('mailId')))
    return c.json({ ok: true })
  })
  app.patch('/api/workbench/:workspaceId/inbox/:mailId', async c => c.json(await inbox.update(
    identifier(c.req.param('workspaceId')), identifier(c.req.param('mailId')), await readJson(c.req.raw, mailUpdate),
  )))
  app.post('/api/workbench/:workspaceId/inbox/:mailId/verdict', async c => {
    const { action, feedback } = await readJson(c.req.raw, resultVerdict)
    return c.json(await inbox.verdict(identifier(c.req.param('workspaceId')), identifier(c.req.param('mailId')), {
      action, ...(feedback === undefined ? {} : { feedback }),
    }))
  })
  app.post('/api/workbench/:workspaceId/items/:itemId/verdict', async c => {
    await inbox.verdictWorkItem(identifier(c.req.param('workspaceId')), identifier(c.req.param('itemId')),
      await readJson(c.req.raw, inConversationVerdict))
    return c.json({ ok: true })
  })
}
