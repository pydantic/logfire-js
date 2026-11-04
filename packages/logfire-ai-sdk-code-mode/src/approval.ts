import type { ModelMessage, ToolApprovalConfiguration, ToolApprovalStatus, ToolSet } from 'ai'

export interface ApprovalRequest {
  toolName: string
  toolCallId: string
  input: unknown
  messages: ModelMessage[]
  toolContext: unknown
  /** The tool's own fields that the AI SDK copies onto a direct call, so a policy that reads them sees the same. */
  tool: { type?: string | undefined; title?: string | undefined; metadata?: unknown }
}

export type ApprovalDecision = { approved: true } | { approved: false; reason: string | undefined; needsUser: boolean }

/**
 * Evaluates an approval configuration for one nested call, the way generateText evaluates `toolApproval` for a
 * direct one: the generic function for every call, or the tool's own entry in the map.
 */
export async function decideApproval<TOOLS extends ToolSet, RUNTIME_CONTEXT>(
  approval: ToolApprovalConfiguration<TOOLS, RUNTIME_CONTEXT> | undefined,
  { tools, toolsContext, runtimeContext }: { tools: TOOLS; toolsContext: unknown; runtimeContext: RUNTIME_CONTEXT },
  request: ApprovalRequest
): Promise<ApprovalDecision> {
  if (approval === undefined) {
    return { approved: true }
  }
  let status: ToolApprovalStatus
  if (typeof approval === 'function') {
    // Built as the AI SDK's `parseToolCall` builds a direct call, so a policy that reads `toolMetadata` or `dynamic`
    // gates nested calls the same way.
    const { tool } = request
    const toolCall = {
      type: 'tool-call',
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      input: request.input,
      ...(tool.metadata === undefined || tool.metadata === null ? {} : { toolMetadata: tool.metadata }),
      ...(tool.type === 'dynamic' ? { dynamic: true } : {}),
      title: tool.title,
    }
    status = await approval({
      toolCall: toolCall as Parameters<typeof approval>[0]['toolCall'],
      tools,
      toolsContext: toolsContext as Parameters<typeof approval>[0]['toolsContext'],
      runtimeContext,
      messages: request.messages,
    })
  } else {
    // Own properties only, as the AI SDK's `resolveToolApproval` reads them.
    const entry: unknown = Object.hasOwn(approval, request.toolName) ? approval[request.toolName as keyof TOOLS] : undefined
    status =
      typeof entry === 'function'
        ? await (entry as (input: unknown, options: unknown) => PromiseLike<ToolApprovalStatus> | ToolApprovalStatus)(request.input, {
            toolCallId: request.toolCallId,
            messages: request.messages,
            toolContext: request.toolContext,
            runtimeContext,
          })
        : (entry as ToolApprovalStatus)
  }
  const type = typeof status === 'object' ? status.type : status
  const reason = typeof status === 'object' ? status.reason : undefined
  if (type === undefined || type === 'not-applicable' || type === 'approved') {
    return { approved: true }
  }
  return { approved: false, reason, needsUser: type === 'user-approval' }
}
