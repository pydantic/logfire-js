import type { JsonSchema } from './signature'

import { pyIsIdentifier, pyIsKeyword } from './python'
import { pathToTypename, toPascalCase } from './signature'

export type SchemaKind = 'parameters' | 'return'

/**
 * Rewrite a tool's JSON Schema into the form the signature generator reads, which is pydantic's: local refs
 * into `$defs`, definition names that are Python class names, and property names that are Python names.
 */
export function normalizeSchema(schema: JsonSchema, toolName: string, kind: SchemaKind): JsonSchema {
  const root = structuredClone(schema)
  const defs = takeDefinitions(root, toolName)
  delete root['$schema']
  if (kind === 'parameters' && typeof root['$ref'] === 'string') {
    // The generator reads parameters from the root's properties, so a referenced root would lose them all.
    throw new Error(`Tool "${toolName}" has a parameters schema that is only a reference, which code mode cannot read`)
  }

  const names = new Map<string, string>()
  const used = new Set<string>()
  const claim = (key: string, name: string): void => {
    if (used.has(name)) {
      throw new Error(`Tool "${toolName}" has two schema definitions that both become the Python type "${name}"`)
    }
    used.add(name)
    names.set(key, name)
  }

  // The generator builds parameters from the root's own properties and does not follow a root `$ref`
  // (pydantic-ai `function_signature.py:552`), so the root stays in place and a copy of it becomes the
  // definition that `#` refers to.
  let rootName: string | undefined
  if (containsRef([root, ...Object.values(defs)], '#')) {
    rootName = pythonTypeName(root['title'], undefined, () => pathToTypename(toolName, kind === 'return' ? 'Return' : ''))
    used.add(rootName)
  }

  const firstPaths = firstReferencePaths(root, defs, kind)
  for (const [key, definition] of Object.entries(defs)) {
    const title = isRecord(definition) ? definition['title'] : undefined
    claim(
      key,
      pythonTypeName(title, key, () => pathToTypename(toolName, firstPaths.get(key) ?? key))
    )
  }

  const rewrite = (node: unknown): unknown => rewriteRefs(node, toolName, names, rootName)
  const normalized = rewrite(root) as JsonSchema
  const normalizedDefs: Record<string, unknown> = {}
  for (const [key, name] of names) {
    normalizedDefs[name] = rewrite(defs[key])
  }
  if (rootName !== undefined) {
    const copy = { ...normalized }
    delete copy['$defs']
    normalizedDefs[rootName] = copy
  }
  if (Object.keys(normalizedDefs).length > 0) {
    normalized['$defs'] = normalizedDefs
  }

  checkPropertyNames(normalized, toolName, '')
  return normalized
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function takeDefinitions(root: JsonSchema, toolName: string): Record<string, unknown> {
  const defs: Record<string, unknown> = {}
  const groups = [root['definitions'], root['$defs']]
  delete root['definitions']
  delete root['$defs']
  for (const group of groups) {
    if (!isRecord(group)) {
      continue
    }
    for (const [name, definition] of Object.entries(group)) {
      if (Object.hasOwn(defs, name)) {
        throw new Error(`Tool "${toolName}" defines "${name}" in both "definitions" and "$defs"`)
      }
      defs[name] = definition
    }
  }
  return defs
}

function containsRef(node: unknown, ref: string): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => containsRef(item, ref))
  }
  if (!isRecord(node)) {
    return false
  }
  return node['$ref'] === ref || Object.values(node).some((value) => containsRef(value, ref))
}

// zod names the definitions it creates for recursion `__schema0`, `__schema1`, and so on.
const SYNTHETIC_DEFINITION = /^__schema\d+$/u

function isPythonName(name: string): boolean {
  return pyIsIdentifier(name) && !pyIsKeyword(name)
}

// A TypedDict with one of these names would shadow the stub's imports or a builtin used in annotations, so that
// `class str(TypedDict)` silently changes what every later `str` means.
const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  'asyncio',
  'Any',
  'TypedDict',
  'NotRequired',
  'Literal',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'tuple',
])

function isTypeName(name: string): boolean {
  return isPythonName(name) && !RESERVED_TYPE_NAMES.has(name)
}

function pythonTypeName(title: unknown, key: string | undefined, fallback: () => string): string {
  if (key !== undefined && isTypeName(key) && !SYNTHETIC_DEFINITION.test(key)) {
    return key
  }
  if (typeof title === 'string' && isTypeName(title)) {
    return title
  }
  if (key !== undefined && !SYNTHETIC_DEFINITION.test(key)) {
    const pascal = toPascalCase(key)
    if (isTypeName(pascal)) {
      return pascal
    }
  }
  return fallback()
}

// Values of these keywords are data, not schemas, so nothing inside them is rewritten or checked.
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['default', 'const', 'enum', 'examples'])

// The keys of these keywords are names, such as a property called `default`, and every value is a schema.
const SCHEMA_MAPS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'definitions'])

/**
 * The path where each definition is first referenced, using the generator's path conventions, so that a
 * definition named by path gets the name an inline object at the same place would get.
 */
function firstReferencePaths(root: JsonSchema, defs: Record<string, unknown>, kind: SchemaKind): Map<string, string> {
  const paths = new Map<string, string>()
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, path)
      }
      return
    }
    if (!isRecord(node)) {
      return
    }
    const ref = node['$ref']
    if (typeof ref === 'string') {
      const key = localDefinitionKey(ref)
      if (key !== undefined && Object.hasOwn(defs, key) && !paths.has(key)) {
        paths.set(key, path)
        visit(defs[key], path)
      }
    }
    const properties = node['properties']
    if (isRecord(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        visit(child, path ? `${path}.${name}` : name)
      }
    }
    const items = node['items']
    if (Array.isArray(items)) {
      items.forEach((item, i) => {
        visit(item, `${path}.${String(i)}`)
      })
    } else {
      visit(items, `${path}Item`)
    }
    visit(node['additionalProperties'], `${path}Value`)
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      visit(node[key], path)
    }
  }
  visit(root, kind === 'return' ? 'Return' : '')
  return paths
}

function localDefinitionKey(ref: string): string | undefined {
  const match = /^#\/(?:definitions|\$defs)\/([^/]+)$/u.exec(ref)
  return match?.[1]?.replace(/~1/gu, '/').replace(/~0/gu, '~')
}

function rewriteRefs(node: unknown, toolName: string, names: ReadonlyMap<string, string>, rootName: string | undefined): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => rewriteRefs(item, toolName, names, rootName))
  }
  if (!isRecord(node)) {
    return node
  }
  const result: JsonSchema = {}
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, rewriteRefs(schema, toolName, names, rootName)])
      )
    } else if (DATA_KEYWORDS.has(key)) {
      result[key] = value
    } else if (key === '$ref' && typeof value === 'string') {
      result[key] = rewriteRef(value, toolName, names, rootName)
    } else if (key === 'title' && typeof value === 'string' && !isTypeName(value)) {
      // The generator names an object after a valid identifier title. Without it, the object is named by path.
      continue
    } else {
      result[key] = rewriteRefs(value, toolName, names, rootName)
    }
  }
  return result
}

function rewriteRef(ref: string, toolName: string, names: ReadonlyMap<string, string>, rootName: string | undefined): string {
  if (ref === '#' && rootName !== undefined) {
    return `#/$defs/${rootName}`
  }
  const key = localDefinitionKey(ref)
  const name = key === undefined ? undefined : names.get(key)
  if (name === undefined) {
    throw new Error(`Tool "${toolName}" has a schema reference "${ref}" that code mode cannot resolve`)
  }
  return `#/$defs/${name}`
}

// Property names become keyword-only parameters and TypedDict fields, which pydantic-ai copies unchanged.
function checkPropertyNames(node: unknown, toolName: string, path: string): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      checkPropertyNames(item, toolName, path)
    }
    return
  }
  if (!isRecord(node)) {
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${name}` : name
        if (!isPythonName(name)) {
          throw new Error(`Tool "${toolName}" has a property "${childPath}" that is not a valid Python name`)
        }
        checkPropertyNames(child, toolName, childPath)
      }
    } else if (key === '$defs' && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        checkPropertyNames(child, toolName, name)
      }
    } else if (!DATA_KEYWORDS.has(key)) {
      checkPropertyNames(value, toolName, path)
    }
  }
}
