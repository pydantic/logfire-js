import type { Exception, SpanOptions } from '@opentelemetry/api'
import { context as api_context, SpanKind, trace } from '@opentelemetry/api'
import type { Initialiser } from '../config'
import { setConfig } from '../config'
import { ATTR_FAAS_TRIGGER, ATTR_MESSAGING_DESTINATION_NAME, ATTR_RPC_MESSAGE_ID } from '../semconv.js'
import { wrap } from '../wrap'
import { exportSpans, proxyExecutionContext } from './common'
import { instrumentEnv } from './env'
import { versionAttributes } from './version'

type EmailHandler = EmailExportedHandler
export type EmailHandlerArgs = Parameters<EmailHandler>

export function createEmailHandler(emailFn: EmailHandler, initialiser: Initialiser): EmailHandler {
  const emailHandler: ProxyHandler<EmailHandler> = {
    async apply(target, _thisArg, argArray: Parameters<EmailHandler>): Promise<void> {
      const [message, orig_env, orig_ctx] = argArray
      const config = initialiser(orig_env as Record<string, unknown>, message)
      const env = instrumentEnv(orig_env as Record<string, unknown>)
      const { ctx, tracker } = proxyExecutionContext(orig_ctx)
      const context = setConfig(config)

      try {
        const args: EmailHandlerArgs = [message, env, ctx]
        await api_context.with(context, executeEmailHandler, undefined, target, args)
      } finally {
        orig_ctx.waitUntil(exportSpans(tracker))
      }
    },
  }
  return wrap(emailFn, emailHandler)
}

/**
 * Converts the message headers into a record ready to be injected
 * as OpenTelemetry attributes
 *
 * @example
 * ```ts
 * const headers = new Headers({ "Subject": "Hello!", From: "hello@example.com" })
 * headerAttributes({ headers })
 * // => {"email.header.Subject": "Hello!", "email.header.From": "hello@example.com"}
 * ```
 */
function headerAttributes(message: { headers: Headers }): Record<string, unknown> {
  return Object.fromEntries([...message.headers].map(([key, value]) => [`email.header.${key}`, value] as const))
}

async function executeEmailHandler(emailFn: EmailHandler, [message, env, ctx]: EmailHandlerArgs): Promise<void> {
  const tracer = trace.getTracer('emailHandler')
  const messageId = message.headers.get('Message-Id')
  const options = {
    attributes: {
      [ATTR_FAAS_TRIGGER]: 'other',
      [ATTR_MESSAGING_DESTINATION_NAME]: message.to,
      ...(messageId !== null ? { [ATTR_RPC_MESSAGE_ID]: messageId } : {}),
    },
    kind: SpanKind.CONSUMER,
  } satisfies SpanOptions
  Object.assign(options.attributes, headerAttributes(message), versionAttributes(env))
  const promise = tracer.startActiveSpan(`emailHandler ${message.to}`, options, async (span) => {
    try {
      await emailFn(message, env, ctx)
      span.end()
    } catch (error) {
      span.recordException(error as Exception)
      span.end()
      throw error
    }
  })
  return promise
}
