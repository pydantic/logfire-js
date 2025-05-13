import { coreMessageSchema, FilePart, TextPart, ToolCallPart } from 'ai'
import { z } from 'zod'
export { coreMessageSchema }

// Helper for JSON stringified values
const jsonString = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val)
      } catch {
        return val
      }
    }
    return val
  }, schema)

export const TextContentSchema = z.object({
  text: z.string(),
  type: z.literal('text'),
})

export const ImageContentSchema = z.union([
  z.object({
    image: z.string(),
    mimeType: z.string(),
    type: z.literal('image'),
  }),
  z.object({
    image: z.object({
      data: z.array(z.number()),
      mimeType: z.string(),
    }),
    type: z.literal('Buffer'),
  }),
])
export type ImageContent = z.infer<typeof ImageContentSchema>

export const ResourceBaseSchema = z.object({
  mimeType: z.string().optional(),
  uri: z.string(),
})

export const TextResourceSchema = ResourceBaseSchema.extend({
  text: z.string(),
})

export const BlobResourceSchema = ResourceBaseSchema.extend({
  blob: z.string(),
})

export const ResourceContentSchema = z.object({
  resource: z.union([TextResourceSchema, BlobResourceSchema]),
  type: z.literal('resource'),
})

export const ContentSchema = z.union([TextContentSchema, ImageContentSchema, ResourceContentSchema])
export type Content = z.infer<typeof ContentSchema>

export type ContentPart = FilePart | ImageContent | TextPart | ToolCallPart

export const ResultWithContentSchema = z.object({
  _meta: z.object({}).optional(),
  content: z.array(ContentSchema),
  isError: z.boolean().default(false).optional(),
})

export const ResultWithToolResultSchema = z.object({
  _meta: z.object({}).optional(),
  toolResult: z.unknown(),
})

export const CallToolResultSchema = z.union([ResultWithContentSchema, ResultWithToolResultSchema])

export const messageSchema = z.array(coreMessageSchema)

export const vercelAIAttributeSchema = z.object({
  'ai.model.id': z.string(),
  'ai.model.provider': z.string(),
  'ai.operationId': z.string().optional(),
  'ai.prompt': jsonString(
    z.object({
      messages: jsonString(messageSchema).optional(),
      prompt: z.string().optional(),
      system: z.string().optional(),
    })
  ).optional(),
  'ai.prompt.format': z.union([z.literal('prompt'), z.literal('messages')]).optional(),
  'ai.prompt.messages': jsonString(messageSchema).optional(),
  'ai.prompt.toolChoice': jsonString(z.object({ type: z.string() })).optional(),
  'ai.prompt.tools': jsonString(
    z.array(
      jsonString(
        z.object({
          description: z.string(),
          name: z.string(),
          parameters: z.object({
            $schema: z.string().optional(),
            additionalProperties: z.boolean(),
            properties: z.record(z.any()),
            required: z.array(z.string()),
            type: z.literal('object'),
          }),
          type: z.string(),
        })
      )
    )
  ).optional(),
  'ai.response.finishReason': z.string().optional(),
  'ai.response.id': z.string().optional(),
  'ai.response.model': z.string().optional(),
  'ai.response.object': z.unknown().optional(),
  'ai.response.text': z.string().optional(),
  'ai.response.timestamp': z.string().optional(), // Optionally: z.coerce.date()
  'ai.response.toolCalls': jsonString(z.array(CallToolResultSchema)).optional(),
  'ai.settings.maxRetries': z.number().optional(),
  'ai.telemetry.functionId': z.string().optional(),
  'ai.usage.completionTokens': z.number().optional(),
  'ai.usage.promptTokens': z.number().optional(),
  final_result: z.string().optional(),
  'gen_ai.request.model': z.string().optional(),
  'gen_ai.response.finish_reasons': z.union([z.array(z.string()), z.string()]).optional(),
  'gen_ai.response.id': z.string().optional(),
  'gen_ai.response.model': z.string().optional(),
  'gen_ai.system': z.string().optional(),
  'gen_ai.usage.input_tokens': z.number().optional(),
  'gen_ai.usage.output_tokens': z.number().optional(),
  'operation.name': z.string().optional(),
  'resource.name': z.string().optional(),
})

export type VercelAIAttribute = z.infer<typeof vercelAIAttributeSchema>
