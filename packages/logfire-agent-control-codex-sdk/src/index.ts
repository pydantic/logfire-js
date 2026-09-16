/**
 * Logfire Agent Control for the OpenAI Codex SDK.
 *
 * Wrap the options you already pass to `new Codex(...)` and `startThread(...)`, give the agent a
 * name, and its developer instructions, its base prompt, its model, and its reasoning effort become
 * editable in Logfire without a deploy:
 *
 * ```ts
 * const managed = agentControl({ name: 'ci_fixer', thread: { model: 'gpt-5.6-sol' } });
 * const answer = await managed.run(async (thread) => (await thread.run('Fix the failing job.')).finalResponse);
 * ```
 *
 * What is *not* here is as much of the point. Codex assembles its prompt and defines its tools
 * inside the `codex` binary, so nothing published can rename a tool, reword one, or set a
 * temperature; every such value is reported through the core's `onUnmatched` policy instead of being
 * dropped where nobody would see it. See the README for the full table.
 */

export { BASE_INSTRUCTIONS_ID, CODEX_OWNED_BLOCK_IDS, DEVELOPER_INSTRUCTIONS_ID } from './instructions'

export { agentControl, ManagedCodex } from './managed'
export type { CodexAgentControlOptions, ManagedCodexConfiguration } from './managed'
