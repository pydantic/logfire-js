// Constants used by the formatter and scrubber

/** Maximum length for formatted values in messages */
export const MESSAGE_FORMATTED_VALUE_LENGTH_LIMIT = 2000
const LOGFIRE_ATTRIBUTES_NAMESPACE = 'logfire'
export const ATTRIBUTES_LEVEL_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.level_num`
export const ATTRIBUTES_SPAN_TYPE_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.span_type`
export const ATTRIBUTES_TAGS_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.tags`
export const ATTRIBUTES_MESSAGE_TEMPLATE_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.msg_template`
export const ATTRIBUTES_MESSAGE_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.msg`

/** Key for storing scrubbed attributes information */
export const ATTRIBUTES_SCRUBBED_KEY = `${LOGFIRE_ATTRIBUTES_NAMESPACE}.scrubbed`
export const DEFAULT_OTEL_SCOPE = 'logfire'
export const JSON_SCHEMA_KEY = 'logfire.json_schema'
export const JSON_NULL_FIELDS_KEY = 'logfire.null_args'
