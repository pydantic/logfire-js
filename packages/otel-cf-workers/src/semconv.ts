// Own unstable and compatibility-only semantic convention keys locally so
// runtime code does not depend on the incubating semconv entrypoint.
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name' as const
export const ATTR_FAAS_COLDSTART = 'faas.coldstart' as const
export const ATTR_FAAS_CRON = 'faas.cron' as const
export const ATTR_FAAS_INVOCATION_ID = 'faas.invocation_id' as const
export const ATTR_FAAS_MAX_MEMORY = 'faas.max_memory' as const
export const ATTR_FAAS_TIME = 'faas.time' as const
export const ATTR_FAAS_TRIGGER = 'faas.trigger' as const
export const ATTR_MESSAGING_DESTINATION_NAME = 'messaging.destination.name' as const
export const ATTR_RPC_MESSAGE_ID = 'rpc.message.id' as const
