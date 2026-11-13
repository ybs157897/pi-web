/**
 * The doc-keeper A2A Agent Card: the discoverable capability description of this built-in agent.
 * In-process callers read it from the DocKeeperAgent (no HTTP endpoint); one skill — knowledge-doc
 * maintenance.
 */
import { A2A_PROTOCOL_VERSION, type AgentCard } from '@a2a-js/sdk'

export const DOC_KEEPER_SKILL_ID = 'knowledge_doc_maintenance'

export function buildDocKeeperAgentCard(url: string): AgentCard {
  return {
    name: 'doc-keeper',
    description: '内置模块知识文档维护智能体：检测代码变更并增量刷新知识文档。check 只体检，refresh 增量回写。经进程内 A2A 协议（SendMessage）委派，不独立监听端口。',
    version: '1.0.0',
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: { organization: 'pi-web', url: 'https://github.com/' },
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json', 'text'],
    defaultOutputModes: ['application/json', 'text'],
    skills: [
      {
        id: DOC_KEEPER_SKILL_ID,
        name: 'Knowledge doc maintenance',
        description: '给定 repo/globs/knowledgePath/mode，检测 git 变更并增量刷新知识文档。data part: {repo?, globs[], knowledgePath, mode:"check"|"refresh", model?}。',
        tags: ['documentation', 'knowledge', 'maintenance'],
        examples: ['维护 src/server 模块的知识文档', 'check docs/bots/Atlas.md'],
        inputModes: ['application/json', 'text'],
        outputModes: ['application/json', 'text'],
        securityRequirements: [],
      },
    ],
    documentationUrl: '',
    signatures: [],
  }
}