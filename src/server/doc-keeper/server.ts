/**
 * The doc-keeper A2A server surface: an Express app exposing the Agent Card (public discovery) and
 * the JSON-RPC endpoint (API-key gated). The maintenance capability is injected as runMaintenance,
 * so this layer is independent of how the pi-web runtime assembles the doc-keeper service.
 */
import express, { type Express } from 'express'
import { AGENT_CARD_PATH } from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import { buildDocKeeperAgentCard } from './agent-card.ts'
import { DocKeeperExecutor, type RunMaintenance } from './executor.ts'

export interface DocKeeperServerOptions {
  runMaintenance: RunMaintenance
  /** Public base URL advertised in the Agent Card, e.g. http://127.0.0.1:41250/. */
  url: string
  /** When set, the JSON-RPC endpoint requires `Authorization: Bearer <apiKey>`. */
  apiKey?: string
}

export function createDocKeeperApp(options: DocKeeperServerOptions): Express {
  const card = buildDocKeeperAgentCard(options.url)
  const executor = new DocKeeperExecutor(options.runMaintenance)
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
  const app = express()

  // API-key gate on the RPC endpoint; the Agent Card stays public so clients can discover the skill.
  if (options.apiKey !== undefined && options.apiKey !== '') {
    const expected = options.apiKey
    app.use((req, res, next) => {
      if (req.path.includes('agent-card.json')) return next()
      const header = req.headers.authorization ?? ''
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
      if (token !== expected) {
        res.status(401).json({ error: 'unauthorized', message: '需要 Authorization: Bearer <API key>' })
        return
      }
      next()
    })
  }

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }))
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }))
  return app
}