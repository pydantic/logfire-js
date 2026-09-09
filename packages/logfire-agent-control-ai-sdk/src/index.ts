/**
 * Logfire Agent Control for the Vercel AI SDK.
 *
 * An agent's instructions, model, generation settings, and the names and descriptions its tools are
 * advertised under, edited in the Logfire UI and applied to every model request -- without a deploy,
 * and without the agent's code knowing anything about it. Pass `agentControl` a `ToolLoopAgent`'s
 * settings, or any model:
 *
 * ```ts
 * import { ToolLoopAgent } from 'ai';
 * import { anthropic } from '@ai-sdk/anthropic';
 * import { agentControl } from '@pydantic/logfire-agent-control-ai-sdk';
 *
 * export const agent = new ToolLoopAgent(
 *   agentControl({
 *     settings: {
 *       id: 'checkout_assistant',
 *       model: anthropic('claude-fable-5-1'),
 *       instructions: 'You are a concise checkout assistant.',
 *       tools: { get_weather },
 *     },
 *   }),
 * );
 * ```
 *
 * If Logfire is unreachable, if nothing has been published, or if a published value cannot be
 * understood, the agent runs on its code. See the README for what becomes editable and what does not.
 */

export { agentControl } from './agent'
export type { AgentControlModelOptions, AgentControlSettingsOptions, ManagedSettings } from './agent'

export { PROVIDER_OPTIONS_NAMESPACE } from './instructions'

export { agentControlMiddleware } from './middleware'
export type { AgentControlOptions } from './middleware'

export type { ModelResolutionOptions, SpecificationVersion, WrappableModel } from './model'

export type { CallSettings } from './settings'

// The core's own surface, so an application installing this adapter does not also have to depend on
// the core to name the policy it wants or catch the error `'error'` raises.
export { UnmatchedConfigError } from '@pydantic/logfire-node/agent-control'
export type { AgentConfig, OnUnmatched } from '@pydantic/logfire-node/agent-control'
