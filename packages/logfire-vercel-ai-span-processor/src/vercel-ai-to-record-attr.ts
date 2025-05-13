import { CoreMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai'

import { MessageEvent, MessageEventType, ToolCall } from './schema/record.schema'
import { ImageContent, VercelAIAttribute } from './schema/vercel-ai-attribute.schema'

export const vercelAIToRecordAttribute = (attributes: VercelAIAttribute): MessageEvent[] => {
  const messageEvents: MessageEvent[] = []
  const messages = attributes['ai.prompt']?.messages ?? attributes['ai.prompt.messages']
  if (messages) {
    for (const message of messages) {
      const eventType = message.role satisfies MessageEventType
      if (typeof message.content === 'object') {
        const events = getObjectMessageEvent(message, eventType)
        messageEvents.push(...events)
      } else if (typeof message.content === 'string') {
        messageEvents.push({
          ...message,
          content: message.content,
          'event.name': `gen_ai.${eventType}.message`,
          role: eventType,
        })
      }
    }
  }

  if (attributes['ai.prompt']?.system) {
    messageEvents.push({
      content: attributes['ai.prompt'].system,
      'event.name': `gen_ai.system.message`,
      role: 'system',
    })
  }

  if (attributes['ai.prompt']?.prompt) {
    messageEvents.push({
      content: attributes['ai.prompt'].prompt,
      'event.name': `gen_ai.user.message`,
      role: 'user',
    })
  }

  // handle object generation output
  if (attributes['ai.response.object'] && attributes['ai.operationId']?.includes('ai.generateObject')) {
    try {
      let content: object | string = attributes['ai.response.object']
      if (typeof attributes['ai.response.object'] === 'string') {
        content = JSON.parse(attributes['ai.response.object']) as unknown as object
      }
      messageEvents.push({
        content,
        'event.name': `gen_ai.assistant.message`,
        role: 'assistant',
      })
    } catch (_) {
      messageEvents.push({
        content: attributes['ai.response.object'],
        'event.name': `gen_ai.assistant.message`,
        role: 'assistant',
      })
    }
  }

  if (attributes['ai.response.text']) {
    messageEvents.push({
      content: attributes['ai.response.text'],
      'event.name': `gen_ai.assistant.message`,
      role: 'assistant',
    })
  }
  return messageEvents
}

const getImageContent = (imageContent: ImageContent) => {
  if (typeof imageContent.image === 'string') {
    return {
      kind: 'image-url',
      url: imageContent.image,
    }
  } else if (imageContent.type === 'Buffer') {
    const dataStringBase64 = Buffer.from(imageContent.image.data).toString('base64')
    return {
      data: dataStringBase64,
      is_image: true,
      kind: 'binary',
      media_type: imageContent.image.mimeType,
    }
  } else {
    return {
      kind: 'image-url',
      url: imageContent.image,
    }
  }
}

const getObjectMessageEvent = (message: CoreMessage, eventType: MessageEventType) => {
  const messageEvents: MessageEvent[] = []
  const contents = getContent(message)
  if (message.role === 'assistant') {
    messageEvents.push({
      content: null,
      'event.name': `gen_ai.assistant.message`,
      role: eventType,
      tool_calls: getTools(message.content as ToolCallPart[]),
    })
  } else if (message.role === 'tool') {
    ;(contents as ToolResultPart[]).forEach((content) => {
      const messageEvent: MessageEvent = {
        ...message,
        ...content,
        content: content.result,
        'event.name': `gen_ai.${eventType}.message`,
        functionName: content.toolName,
        id: content.toolCallId,
        role: eventType,
      }
      messageEvents.push(messageEvent)
    })
  } else {
    messageEvents.push({
      ...message,
      content: contents.map((part) => getMessageObjectContent(part)),
      'event.name': `gen_ai.${eventType}.message`,
      role: eventType,
    })
  }
  return messageEvents
}

const getMessageObjectContent = (contentPart: unknown) => {
  // needs to be updated to handle all types
  if (typeof contentPart === 'string') {
    return contentPart
  }
  if (typeof contentPart === 'object' && contentPart !== null && 'type' in contentPart) {
    switch (contentPart.type) {
      case 'file':
        return contentPart
      case 'image':
        return getImageContent(contentPart as ImageContent)
      case 'text':
        return (contentPart as TextPart).text
      case 'tool-call':
        return contentPart
    }
  }
  return contentPart
}
function getTools(toolsStringArray: ToolCallPart[] | undefined): ToolCall[] | undefined {
  if (!toolsStringArray) {
    return
  }
  const tools = toolsStringArray.map((tool) => {
    return {
      function: {
        arguments: tool.args,
        name: tool.toolName,
      },
      id: tool.toolCallId,
      type: tool.type as string,
    } as ToolCall
  })
  return tools
}

function getContent(message: CoreMessage) {
  if (Array.isArray(message.content)) {
    return message.content
  } else {
    return [message.content]
  }
}
