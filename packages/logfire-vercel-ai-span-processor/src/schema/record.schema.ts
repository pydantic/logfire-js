type MessageContentItem =
  | { image_url: { url: string }; type: 'image_url' }
  | {
      source: {
        data: string
        media_type: string
        type: string
      }
      type: 'image'
    }
  | {
      text: string
      type: 'text'
    }

export type StandaloneAIMessageContent = MessageContentItem[] | null | string | undefined

// TODO: make this with Zod to have some shape safety
export type MessageEventType = 'assistant' | 'system' | 'tool' | 'unknown' | 'user'

export interface BaseMessageEvent<Role extends MessageEventType> {
  'event.name': `gen_ai.${Role}.message`
  id?: string
  role: Role
}

export interface ToolCall {
  function: {
    arguments: unknown
    name: string
  }
  id: string
  type: string
}

interface ToolCallMessageEvent extends BaseMessageEvent<'assistant'> {
  tool_calls: ToolCall[]
}

interface ToolResponseMessageEvent extends BaseMessageEvent<'tool'> {
  functionName?: string
  id: string
}

interface ContentMessageEvent<Role extends MessageEventType> extends BaseMessageEvent<Role> {
  content: unknown
}

interface TextualMessageEvent<Role extends MessageEventType> extends ContentMessageEvent<Role> {
  content: string
}

interface JsonMessageEvent<Role extends MessageEventType> extends ContentMessageEvent<Role> {
  content: object
}

interface StandaloneAIMessageEvent<Role extends MessageEventType> {
  content: globalThis.Record<string, unknown> | StandaloneAIMessageContent
  direction: 'request' | 'response'
  functionName?: string
  name?: string
  role: Role
  standalone: true
  tool_calls?: ToolCall[]
}

type InnerMessageEvent<Type extends MessageEventType> = JsonMessageEvent<Type> | TextualMessageEvent<Type> | ToolCallMessageEvent

interface ChoiceEvent<Type extends MessageEventType> {
  'event.name': 'gen_ai.choice'
  index: number
  message: Omit<InnerMessageEvent<Type>, 'event.name'>
}

export type MessageEvent =
  | ChoiceEvent<MessageEventType>
  | ContentMessageEvent<MessageEventType>
  | JsonMessageEvent<MessageEventType>
  | StandaloneAIMessageEvent<MessageEventType>
  | ToolCallMessageEvent
  | ToolResponseMessageEvent
