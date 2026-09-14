/**
 * Logfire Agent Control for Mastra.
 *
 * One processor on a Mastra agent makes its instructions, model, model settings and tool definitions
 * editable from the Logfire UI, without a deploy. Everything the contract itself owns -- the
 * `AgentConfig` shape, the variable, the pure helpers that apply a published value -- lives in
 * `@pydantic/logfire-node/agent-control`; this package is the Mastra half: where the hook is, which ids
 * address which blocks, and how a canonical model string and settings become Mastra's own.
 */

export { AGENT_BLOCK_ID, PROVIDER_OPTIONS_NAMESPACE } from './instructions'

export { agentControl, PROCESSOR_ID } from './processor'
export type { MastraAgentControlOptions } from './processor'
