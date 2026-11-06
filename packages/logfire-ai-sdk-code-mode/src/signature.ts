// A port of pydantic-ai's `pydantic_ai_slim/pydantic_ai/function_signature.py`. Names and structure follow the
// Python module so that a change upstream maps to a change here; `fixtures/signatures/expected.json` records the
// pydantic-ai commit it matches. The one deliberate difference is marked `Parity exception` below.
//
// Parity exception: pydantic-ai resolves conflicting types by name, prefixed with whatever is being rendered,
// the function or the definition (pydantic/pydantic-ai#8816). So a type shared with an earlier tool is
// annotated with a name that is never defined; a definition that is not itself conflicting renders
// conflicting field types with no prefix; and one tool that defines two different types with the same name
// emits two classes under one name, the second replacing the first. Here each conflicting type object gets its
// own name, prefixed with its owner (the first signature that references it) and numbered when that is taken.
// This matches pydantic-ai whenever its output is valid.
//
// Three more differences, each marked where it applies, fix output that is valid Python but has the wrong
// types: structural equality, return types that duplicate a parameter type, and unions of inline objects.

import { pyIsIdentifier, pyRepr } from './python'

export type JsonSchema = Record<string, unknown>

type SimpleTypeName = 'Any' | 'bool' | 'float' | 'int' | 'None' | 'str'

interface RenderContext {
  conflicting: ReadonlySet<string>
  /** The rendered name of each conflicting type, from `FunctionSignature.prefixedTypeNames()`. */
  typeNames: ReadonlyMap<TypeSignature, string>
  /** Prefix for a conflicting type with no recorded name, as pydantic-ai uses for every conflicting type. */
  fallbackOwner: string | undefined
}

// Set during rendering so that conflicting types resolve to prefixed names, e.g. `tool_a_User`. Python uses a
// ContextVar; rendering is synchronous here.
let renderContext: RenderContext | undefined

// Names of the non-object defs currently being resolved inline. A self-referential one would otherwise
// recurse forever.
let resolvingRefs: ReadonlySet<string> = new Set()

export class SimpleTypeExpr {
  readonly kind = 'simple'
  readonly name: SimpleTypeName

  constructor(name: SimpleTypeName) {
    this.name = name
  }

  toString(): string {
    return this.name
  }
}

export class LiteralTypeExpr {
  readonly kind = 'literal'
  readonly values: unknown[]

  constructor(values: unknown[]) {
    this.values = values
  }

  toString(): string {
    return `Literal[${this.values.map(pyRepr).join(', ')}]`
  }
}

export class GenericTypeExpr {
  readonly kind = 'generic'
  readonly base: string
  args: TypeExpr[]

  constructor(base: string, args: TypeExpr[]) {
    this.base = base
    this.args = args
  }

  toString(): string {
    return `${this.base}[${this.args.map(String).join(', ')}]`
  }
}

export class UnionTypeExpr {
  readonly kind = 'union'
  members: TypeExpr[]

  constructor(members: TypeExpr[]) {
    this.members = members
  }

  toString(): string {
    return this.members.map(String).join(' | ')
  }
}

export type TypeExpr = GenericTypeExpr | LiteralTypeExpr | SimpleTypeExpr | TypeSignature | UnionTypeExpr

// One level of nesting inside a rendered docstring (Google style: four spaces).
const DOC_INDENT = '    '

// Keeps arbitrary description text from breaking the generated `"""..."""` literal: backslashes would start
// escape sequences, null bytes are rejected by compile(), and quotes could terminate the delimiter.
function escapeDescription(text: string): string {
  return text.replace(/[\\\0"]/gu, (char) => (char === '\\' ? '\\\\' : char === '\0' ? '\\x00' : '\\"'))
}

// Python's str.strip() and str.splitlines() treat more characters as whitespace and line breaks than JS.
const PY_WHITESPACE = '\\s\\x1c-\\x1f\\x85'
const PY_STRIP = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, 'gu')
// eslint-disable-next-line no-control-regex -- these are the separators str.splitlines() splits on
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u

function pyStrip(text: string): string {
  return text.replace(PY_STRIP, '')
}

function pySplitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const lines = text.split(PY_LINE_BREAK)
  // splitlines() drops the empty string after a trailing line break.
  if (lines.at(-1) === '' && PY_LINE_BREAK.test(text.at(-1) ?? '')) {
    lines.pop()
  }
  return lines
}

// Python truthiness for an optional string.
function nonEmpty(text: string | undefined): text is string {
  return text !== undefined && text !== ''
}

function renderDescription(text: string, indent = ''): string[] {
  const escaped = escapeDescription(pyStrip(text))
  const descriptionLines = pySplitLines(escaped)
  if (descriptionLines.length > 1) {
    return [`${indent}"""`, ...descriptionLines.map((line) => (pyStrip(line) ? `${indent}${line}` : '')), `${indent}"""`]
  }
  return [`${indent}"""${escaped}"""`]
}

export class TypeFieldSignature {
  readonly kind = 'field'
  readonly name: string
  type: TypeExpr
  readonly required: boolean
  readonly description: string | undefined

  constructor(name: string, type: TypeExpr, required = false, description?: string) {
    this.name = name
    this.type = type
    this.required = required
    this.description = description
  }

  toString(): string {
    let typeStr = String(this.type)
    if (!this.required) {
      typeStr = `NotRequired[${typeStr}]`
    }
    const lines = [`    ${this.name}: ${typeStr}`]
    if (nonEmpty(this.description)) {
      lines.push(...renderDescription(this.description, '    '))
    }
    return lines.join('\n')
  }
}

export class TypeSignature {
  readonly kind = 'type'
  readonly name: string
  description: string | undefined
  fields: Map<string, TypeFieldSignature>

  constructor(name: string, description?: string, fields: Map<string, TypeFieldSignature> = new Map<string, TypeFieldSignature>()) {
    this.name = name
    this.description = description
    this.fields = fields
  }

  get displayName(): string {
    if (renderContext === undefined || !renderContext.conflicting.has(this.name)) {
      return this.name
    }
    const name = renderContext.typeNames.get(this)
    if (name !== undefined) {
      return name
    }
    const owner = renderContext.fallbackOwner
    return nonEmpty(owner) ? `${owner}_${this.name}` : this.name
  }

  toString(): string {
    return this.displayName
  }

  renderDefinition(
    ownerName?: string,
    conflictingTypeNames: ReadonlySet<string> = new Set(),
    typeNames: ReadonlyMap<TypeSignature, string> = new Map()
  ): string {
    return withRenderContext({ conflicting: conflictingTypeNames, typeNames, fallbackOwner: ownerName }, () => this.renderDefinitionBody())
  }

  private renderDefinitionBody(): string {
    const lines = [`class ${this.displayName}(TypedDict):`]
    if (nonEmpty(this.description)) {
      lines.push(...renderDescription(this.description, '    '))
    }
    if (this.fields.size === 0) {
      if (!nonEmpty(this.description)) {
        lines.push('    pass')
      }
    } else {
      for (const f of this.fields.values()) {
        lines.push(String(f))
      }
    }
    return lines.join('\n')
  }

  structurallyEqual(other: TypeSignature): boolean {
    return fieldsEqual(this, other, new Map())
  }
}

// Parity exception: pydantic-ai compares field types by their rendered names, so two `User`s whose `address`
// fields point at different `Address` shapes count as equal, and one tool's `User` replaces the other's. Field
// types are compared by structure here. `assumed` holds pairs already being compared, so recursion stops.
type AssumedEqual = Map<TypeSignature, Set<TypeSignature>>

function fieldsEqual(a: TypeSignature, b: TypeSignature, assumed: AssumedEqual): boolean {
  if (a === b || assumed.get(a)?.has(b) === true) {
    return true
  }
  assumed.set(a, new Set([...(assumed.get(a) ?? []), b]))
  if (a.fields.size !== b.fields.size) {
    return false
  }
  for (const [name, f] of a.fields) {
    const other = b.fields.get(name)
    if (other === undefined || f.required !== other.required || !typeExprsEqual(f.type, other.type, assumed)) {
      return false
    }
  }
  return true
}

function typeExprsEqual(a: TypeExpr, b: TypeExpr, assumed: AssumedEqual): boolean {
  if (a instanceof TypeSignature && b instanceof TypeSignature) {
    return a.name === b.name && fieldsEqual(a, b, assumed)
  }
  if (a instanceof GenericTypeExpr && b instanceof GenericTypeExpr) {
    return a.base === b.base && listsEqual(a.args, b.args, assumed)
  }
  if (a instanceof UnionTypeExpr && b instanceof UnionTypeExpr) {
    return listsEqual(a.members, b.members, assumed)
  }
  return a.kind === b.kind && String(a) === String(b)
}

function listsEqual(a: TypeExpr[], b: TypeExpr[], assumed: AssumedEqual): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const other = b[i]
      return other !== undefined && typeExprsEqual(item, other, assumed)
    })
  )
}

export class FunctionParam {
  readonly kind = 'param'
  readonly name: string
  type: TypeExpr
  readonly defaultValue: string | undefined
  readonly description: string | undefined

  constructor(name: string, type: TypeExpr, defaultValue?: string, description?: string) {
    this.name = name
    this.type = type
    this.defaultValue = defaultValue
    this.description = description
  }

  toString(): string {
    const typeStr = String(this.type)
    return this.defaultValue === undefined ? `${this.name}: ${typeStr}` : `${this.name}: ${typeStr} = ${this.defaultValue}`
  }
}

export interface RenderOptions {
  name?: string
  description?: string | undefined
  isAsync?: boolean
  conflictingTypeNames?: ReadonlySet<string>
  /** The rendered name of each conflicting type, from `FunctionSignature.prefixedTypeNames()`. */
  typeNames?: ReadonlyMap<TypeSignature, string>
}

export class FunctionSignature {
  readonly kind = 'function'
  readonly name: string
  params: Map<string, FunctionParam>
  returnType: TypeExpr
  referencedTypes: TypeSignature[]
  readonly description: string | undefined
  readonly isAsync: boolean

  constructor(
    name: string,
    params: Map<string, FunctionParam>,
    returnType: TypeExpr,
    referencedTypes: TypeSignature[],
    description?: string,
    isAsync = false
  ) {
    this.name = name
    this.params = params
    this.returnType = returnType
    this.referencedTypes = referencedTypes
    this.description = description
    this.isAsync = isAsync
  }

  render(body: string, options: RenderOptions = {}): string {
    const renderName = options.name !== undefined && options.name !== '' ? options.name : this.name
    const description = options.description ?? this.description
    const context = {
      conflicting: options.conflictingTypeNames ?? new Set<string>(),
      typeNames: options.typeNames ?? new Map<TypeSignature, string>(),
      fallbackOwner: renderName,
    }
    return withRenderContext(context, () => this.renderBody(body, renderName, description, options.isAsync))
  }

  private renderBody(body: string, name: string, description: string | undefined, isAsync: boolean | undefined): string {
    const prefix = (isAsync ?? this.isAsync) ? 'async def' : 'def'
    const paramsStr = [...this.params.values()].map(String).join(', ')
    const returnStr = String(this.returnType)
    // Force keyword-only params so LLMs always use named arguments.
    const parts = [paramsStr ? `${prefix} ${name}(*, ${paramsStr}) -> ${returnStr}:` : `${prefix} ${name}() -> ${returnStr}:`]

    const descriptionSections = nonEmpty(description) ? [description] : []
    const argsLines: string[] = []
    for (const param of this.params.values()) {
      const descriptionLines = pySplitLines(pyStrip(param.description ?? ''))
      const [firstLine, ...continuation] = descriptionLines
      if (firstLine === undefined) {
        continue
      }
      argsLines.push(`${DOC_INDENT}${param.name}: ${firstLine}`)
      // Continuation lines nest one level past the parameter name.
      argsLines.push(...continuation.map((line) => `${DOC_INDENT}${DOC_INDENT}${line}`))
    }
    if (argsLines.length > 0) {
      descriptionSections.push(['Args:', ...argsLines].join('\n'))
    }
    const fullDescription = descriptionSections.join('\n\n')
    if (fullDescription !== '') {
      parts.push(...renderDescription(fullDescription, '    '))
    }
    parts.push(`    ${body}`)
    return parts.join('\n')
  }

  /**
   * Build a FunctionSignature from JSON schemas. Parameter and return schemas are processed independently;
   * each resolves `$ref`s against its own `$defs`.
   */
  static fromSchema(name: string, parametersSchema: JsonSchema, returnSchema?: JsonSchema): FunctionSignature {
    const paramDefs = schemaDefs(parametersSchema)
    const paramReferenced = new Map<string, TypeSignature>()
    processSchemaDefs(paramDefs, paramReferenced, name)
    const params = buildParamsFromSchema(parametersSchema, paramDefs, paramReferenced, name)

    let resolvedReturnType: TypeExpr = ANY
    const returnReferenced = new Map<string, TypeSignature>()
    if (returnSchema !== undefined) {
      const returnDefs = schemaDefs(returnSchema)
      processSchemaDefs(returnDefs, returnReferenced, name)
      resolvedReturnType = schemaToTypeExpr(returnSchema, returnDefs, returnReferenced, name, 'Return')
    }

    // Merge referenced types, deduplicating structurally identical types within this signature.
    const allReferenced = [...paramReferenced.values()]
    const duplicates = new Map<TypeSignature, TypeSignature>()
    for (const retType of returnReferenced.values()) {
      const existing = paramReferenced.get(retType.name)
      if (existing?.structurallyEqual(retType) === true) {
        duplicates.set(retType, existing)
        continue
      }
      allReferenced.push(retType)
    }
    // Parity exception: pydantic-ai drops the duplicate but keeps references to it, so a return annotation names
    // a type that gets no definition of its own and no prefix of its own when the name conflicts.
    resolvedReturnType = replaceInExpr(resolvedReturnType, duplicates)
    for (const typeSig of allReferenced) {
      for (const f of typeSig.fields.values()) {
        f.type = replaceInExpr(f.type, duplicates)
      }
    }
    return new FunctionSignature(name, params, resolvedReturnType, allReferenced)
  }

  /**
   * Identify TypedDict name conflicts across signatures, unifying identical types (same name and structure)
   * to one object. Returns the names that need tool-name prefixes at render time.
   */
  static getConflictingTypeNames(signatures: FunctionSignature[]): ReadonlySet<string> {
    const seen = new Map<string, TypeSignature>()
    const prefixed = new Set<string>()
    for (const sig of signatures) {
      const deduped: TypeSignature[] = []
      for (const typeSig of sig.referencedTypes) {
        const canonical = seen.get(typeSig.name)
        if (canonical === undefined) {
          seen.set(typeSig.name, typeSig)
          deduped.push(typeSig)
        } else if (canonical.structurallyEqual(typeSig)) {
          replaceTypeRefs(sig, typeSig, canonical)
          deduped.push(canonical)
        } else {
          prefixed.add(typeSig.name)
          deduped.push(typeSig)
        }
      }
      sig.referencedTypes = deduped
    }
    return prefixed
  }

  static collectUniqueReferencedTypes(signatures: FunctionSignature[]): TypeSignature[] {
    const seen = new Set<TypeSignature>()
    const result: TypeSignature[] = []
    for (const sig of signatures) {
      for (const typeSig of sig.referencedTypes) {
        if (!seen.has(typeSig)) {
          seen.add(typeSig)
          result.push(typeSig)
        }
      }
    }
    return result
  }

  /**
   * A unique name for each conflicting type object: its owner's name, the first signature that references it,
   * as prefix, and a number when one owner has several types with the same name.
   */
  static prefixedTypeNames(signatures: FunctionSignature[], conflictingTypeNames: ReadonlySet<string>): Map<TypeSignature, string> {
    const used = new Set<string>()
    for (const tsig of FunctionSignature.collectUniqueReferencedTypes(signatures)) {
      if (!conflictingTypeNames.has(tsig.name)) {
        used.add(tsig.name)
      }
    }
    const names = new Map<TypeSignature, string>()
    for (const sig of signatures) {
      for (const tsig of sig.referencedTypes) {
        if (!conflictingTypeNames.has(tsig.name) || names.has(tsig)) {
          continue
        }
        const base = `${sig.name}_${tsig.name}`
        let name = base
        for (let n = 2; used.has(name); n++) {
          name = `${base}_${String(n)}`
        }
        used.add(name)
        names.set(tsig, name)
      }
    }
    return names
  }

  static renderTypeDefinitions(signatures: FunctionSignature[], conflictingTypeNames: ReadonlySet<string>): string[] {
    const uniqueTypes = FunctionSignature.collectUniqueReferencedTypes(signatures)
    const typeNames = FunctionSignature.prefixedTypeNames(signatures, conflictingTypeNames)
    return uniqueTypes.map((tsig) => tsig.renderDefinition(undefined, conflictingTypeNames, typeNames))
  }
}

function withRenderContext<T>(context: RenderContext, render: () => T): T {
  const previous = renderContext
  renderContext = context
  try {
    return render()
  } finally {
    renderContext = previous
  }
}

const ANY = new SimpleTypeExpr('Any')
const NONE = new SimpleTypeExpr('None')

const JSON_SIMPLE_TYPE_TO_PYTHON: ReadonlyMap<unknown, SimpleTypeName> = new Map([
  ['string', 'str'],
  ['integer', 'int'],
  ['number', 'float'],
  ['boolean', 'bool'],
  ['null', 'None'],
])

function jsonTypeToPython(jsonType: string): SimpleTypeExpr {
  return new SimpleTypeExpr(JSON_SIMPLE_TYPE_TO_PYTHON.get(jsonType) ?? 'Any')
}

// Mirrors str.capitalize(): the first character upper case, the rest lower case.
function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
}

export function toPascalCase(s: string): string {
  const result = s
    .replace(/[^a-zA-Z0-9]/gu, '_')
    .split('_')
    .filter(Boolean)
    .map(capitalize)
    .join('')
  return /^[0-9]/u.test(result) ? `_${result}` : result
}

export function pathToTypename(toolName: string, path: string): string {
  return [toolName, ...path.split('.').filter(Boolean)].map(toPascalCase).join('')
}

// Python's `schema.get('description') or None`.
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `true` and `false` are valid schemas anywhere; both collapse to an empty schema, which renders as `Any`.
function normalizeSchemaNode(node: unknown): JsonSchema {
  return isRecord(node) ? node : {}
}

function schemaDefs(schema: JsonSchema): Record<string, unknown> {
  const defs = schema['$defs']
  return isRecord(defs) ? defs : {}
}

function schemaProperties(schema: JsonSchema): Record<string, unknown> {
  const properties = schema['properties']
  return isRecord(properties) ? properties : {}
}

function schemaRequired(schema: JsonSchema): Set<unknown> {
  const required = schema['required']
  return new Set(Array.isArray(required) ? required : [])
}

function isObjectWithProperties(schema: JsonSchema): boolean {
  return schema['type'] === 'object' && 'properties' in schema
}

function processSchemaDefs(defs: Record<string, unknown>, referencedTypes: Map<string, TypeSignature>, toolName: string): void {
  for (const [defName, defSchemaRaw] of Object.entries(defs)) {
    const defSchema = normalizeSchemaNode(defSchemaRaw)
    if (isObjectWithProperties(defSchema) && !referencedTypes.has(defName)) {
      buildAndRegisterType(defName, defSchema, defs, referencedTypes, toolName, defName)
    }
  }
}

function buildParamsFromSchema(
  schema: JsonSchema,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string
): Map<string, FunctionParam> {
  const required = schemaRequired(schema)
  const requiredParams = new Map<string, FunctionParam>()
  const optionalParams = new Map<string, FunctionParam>()

  for (const [propName, propSchemaRaw] of Object.entries(schemaProperties(schema))) {
    const propSchema = normalizeSchemaNode(propSchemaRaw)
    const typeExpr = schemaToTypeExpr(propSchema, defs, referencedTypes, toolName, propName)
    const description = optionalText(propSchema['description'])

    if ('default' in propSchema) {
      optionalParams.set(propName, new FunctionParam(propName, typeExpr, pyRepr(propSchema['default']), description))
    } else if (required.has(propName)) {
      requiredParams.set(propName, new FunctionParam(propName, typeExpr, undefined, description))
    } else if (schemaAllowsNull(propSchema)) {
      optionalParams.set(propName, new FunctionParam(propName, typeExpr, 'None', description))
    } else {
      optionalParams.set(propName, new FunctionParam(propName, new UnionTypeExpr([typeExpr, NONE]), 'None', description))
    }
  }
  return new Map([...requiredParams, ...optionalParams])
}

function schemaAllowsNull(schema: JsonSchema): boolean {
  const schemaType = schema['type']
  if (Array.isArray(schemaType) && schemaType.includes('null')) {
    return true
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (key in schema) {
      const members = schema[key]
      return Array.isArray(members) && members.some((s) => normalizeSchemaNode(s)['type'] === 'null')
    }
  }
  return false
}

function schemaToTypeExpr(
  schemaRaw: unknown,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeExpr {
  const schema = normalizeSchemaNode(schemaRaw)

  if ('$ref' in schema) {
    const refName = String(schema['$ref']).split('/').at(-1) ?? ''
    if (Object.hasOwn(defs, refName) && !referencedTypes.has(refName)) {
      const refSchema = normalizeSchemaNode(defs[refName])
      if (isObjectWithProperties(refSchema)) {
        buildAndRegisterType(refName, refSchema, defs, referencedTypes, toolName, path)
      } else {
        // Only object defs become TypedDicts; enums, aliases and unions resolve inline.
        // Parity exception: pydantic-ai leaves a def that is itself a `$ref` unresolved, so the annotation names
        // an alias that is never defined. Here the reference chain is followed, with the same recursion guard.
        if (resolvingRefs.has(refName)) {
          return ANY
        }
        const previous = resolvingRefs
        resolvingRefs = new Set([...previous, refName])
        try {
          return schemaToTypeExpr(refSchema, defs, referencedTypes, toolName, path)
        } finally {
          resolvingRefs = previous
        }
      }
    }
    return referencedTypes.get(refName) ?? new TypeSignature(refName)
  }

  if ('anyOf' in schema) {
    return handleUnionSchema(schema['anyOf'], defs, referencedTypes, toolName, path)
  }
  if ('oneOf' in schema) {
    return handleUnionSchema(schema['oneOf'], defs, referencedTypes, toolName, path)
  }
  if ('allOf' in schema) {
    const allOf = schema['allOf'] as unknown[]
    return allOf.length === 1 ? schemaToTypeExpr(allOf[0], defs, referencedTypes, toolName, path) : ANY
  }
  if ('const' in schema) {
    return new LiteralTypeExpr([schema['const']])
  }
  if ('enum' in schema) {
    return new LiteralTypeExpr(schema['enum'] as unknown[])
  }
  return typeToExpr(schema['type'], schema, defs, referencedTypes, toolName, path)
}

function typeToExpr(
  schemaType: unknown,
  schema: JsonSchema,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeExpr {
  const simple = JSON_SIMPLE_TYPE_TO_PYTHON.get(schemaType)
  if (simple !== undefined) {
    return new SimpleTypeExpr(simple)
  }

  if (schemaType === 'array') {
    const items = schema['items'] ?? {}
    if (isTruthyPy(items)) {
      if (Array.isArray(items)) {
        return new GenericTypeExpr(
          'tuple',
          items.map((item, i) => schemaToTypeExpr(item, defs, referencedTypes, toolName, `${path}.${String(i)}`))
        )
      }
      return new GenericTypeExpr('list', [schemaToTypeExpr(items, defs, referencedTypes, toolName, `${path}Item`)])
    }
    return new GenericTypeExpr('list', [ANY])
  }

  if (schemaType === 'object') {
    if ('properties' in schema) {
      // A `title` that is a valid identifier keeps real class names like `User`; otherwise name it by path.
      const title = schema['title']
      const tdName = typeof title === 'string' && title !== '' && pyIsIdentifier(title) ? title : pathToTypename(toolName, path)
      // Parity exception: definitions are built in order, so an inline object inside an earlier definition could
      // claim a later definition's name, and every `$ref` to that definition would get the inline object's fields.
      // The definition is built first, so the inline object is named against it.
      const definition = Object.hasOwn(defs, tdName) ? normalizeSchemaNode(defs[tdName]) : undefined
      if (definition !== undefined && isObjectWithProperties(definition) && !referencedTypes.has(tdName)) {
        buildAndRegisterType(tdName, definition, defs, referencedTypes, toolName, tdName)
      }
      if (!referencedTypes.has(tdName)) {
        return buildAndRegisterType(tdName, schema, defs, referencedTypes, toolName, path)
      }
      return inlineObjectWithTakenName(tdName, schema, defs, referencedTypes, toolName, path)
    }
    if ('additionalProperties' in schema) {
      const additional = schema['additionalProperties']
      if (additional === true) {
        return new GenericTypeExpr('dict', [new SimpleTypeExpr('str'), ANY])
      }
      if (isRecord(additional)) {
        const valueExpr = schemaToTypeExpr(additional, defs, referencedTypes, toolName, `${path}Value`)
        return new GenericTypeExpr('dict', [new SimpleTypeExpr('str'), valueExpr])
      }
    }
    return new GenericTypeExpr('dict', [new SimpleTypeExpr('str'), ANY])
  }

  if (Array.isArray(schemaType)) {
    return typeListToExpr(schemaType as string[], schema, defs, referencedTypes, toolName, path)
  }
  return ANY
}

// Python truthiness for a schema's `items`: an empty dict or list is falsy.
function isTruthyPy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0
  }
  return Boolean(value)
}

function typeListToExpr(
  schemaType: string[],
  schema: JsonSchema,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeExpr {
  if (schemaType.includes('object') && 'properties' in schema) {
    const baseExpr = typeToExpr('object', schema, defs, referencedTypes, toolName, path)
    return schemaType.includes('null') ? new UnionTypeExpr([baseExpr, NONE]) : baseExpr
  }
  const typeExprs: TypeExpr[] = schemaType.map(jsonTypeToPython)
  const nonNone = typeExprs.find((t) => String(t) !== 'None')
  if (typeExprs.length === 2 && nonNone !== undefined && typeExprs.some((t) => String(t) === 'None')) {
    return new UnionTypeExpr([nonNone, NONE])
  }
  const [first, ...rest] = typeExprs
  if (first === undefined) {
    return ANY
  }
  return rest.length > 0 ? new UnionTypeExpr(typeExprs) : first
}

function handleUnionSchema(
  schemas: unknown,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeExpr {
  const members = (schemas as unknown[]).map(normalizeSchemaNode)
  const branchPaths = inlineObjectBranchPaths(members, path)
  const typeExprs: TypeExpr[] = []
  let hasNull = false
  for (const s of members) {
    if (s['type'] === 'null') {
      hasNull = true
    } else {
      typeExprs.push(schemaToTypeExpr(s, defs, referencedTypes, toolName, branchPaths.get(s) ?? path))
    }
  }

  const seen = new Set<string>()
  const uniqueExprs: TypeExpr[] = []
  for (const expr of typeExprs) {
    const rendered = String(expr)
    if (!seen.has(rendered)) {
      seen.add(rendered)
      uniqueExprs.push(expr)
    }
  }
  if (hasNull) {
    uniqueExprs.push(NONE)
  }
  const [only, ...rest] = uniqueExprs
  return only !== undefined && rest.length === 0 ? only : new UnionTypeExpr(uniqueExprs)
}

// Parity exception: inline objects are named by path, and every branch of a union shares the union's path, so
// pydantic-ai renders the first branch for all of them and drops the rest, such as the `write` variant of a
// discriminated union. When two or more branches are inline objects without a usable title, each gets its own
// path: the value of a string `const` property that tells it apart, such as `kind: 'read'`, or its position.
function inlineObjectBranchPaths(members: JsonSchema[], path: string): Map<JsonSchema, string> {
  const inline = members.filter((s) => s['type'] === 'object' && 'properties' in s && !hasUsableTitle(s))
  const paths = new Map<JsonSchema, string>()
  if (inline.length < 2) {
    return paths
  }
  const labels = inline.map(constLabel)
  // Labels such as `read-file` and `read_file` become the same class name, so distinctness is checked on that.
  const distinct =
    labels.every((label) => label !== undefined) && new Set(labels.map((label) => toPascalCase(label))).size === labels.length
  inline.forEach((s, i) => {
    paths.set(s, `${path}.${distinct ? (labels[i] ?? '') : String(i + 1)}`)
  })
  return paths
}

function hasUsableTitle(schema: JsonSchema): boolean {
  const title = schema['title']
  return typeof title === 'string' && title !== '' && pyIsIdentifier(title)
}

function constLabel(schema: JsonSchema): string | undefined {
  for (const property of Object.values(schemaProperties(schema))) {
    const value = normalizeSchemaNode(property)['const']
    if (typeof value === 'string' && toPascalCase(value) !== '') {
      return value
    }
  }
  return undefined
}

// Parity exception: pydantic-ai reuses whatever type already has an inline object's name, so a second object
// titled `User`, or one whose path name matches a definition, is described with the first one's fields. Here the
// object is reused only when its structure matches, and otherwise gets the next free name: `User_2`, `User_3`.
// An inline object cannot refer to itself, so it can be built in full before it is compared.
function inlineObjectWithTakenName(
  tdName: string,
  schema: JsonSchema,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeSignature {
  const candidate = buildTypeSignature(tdName, schema, defs, referencedTypes, toolName, path)
  for (let n = 1; ; n++) {
    const name = n === 1 ? tdName : `${tdName}_${String(n)}`
    const existing = referencedTypes.get(name)
    if (existing === undefined) {
      const named = new TypeSignature(name, candidate.description, candidate.fields)
      referencedTypes.set(name, named)
      return named
    }
    if (existing.structurallyEqual(candidate)) {
      return existing
    }
  }
}

// Registers a placeholder first, so that a recursive schema resolves to the same TypeSignature.
function buildAndRegisterType(
  name: string,
  schema: JsonSchema,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeSignature {
  const placeholder = new TypeSignature(name)
  referencedTypes.set(name, placeholder)
  const built = buildTypeSignature(name, schema, defs, referencedTypes, toolName, path)
  placeholder.fields = built.fields
  placeholder.description = built.description
  return placeholder
}

function buildTypeSignature(
  name: string,
  schema: JsonSchema,
  defs: Record<string, unknown>,
  referencedTypes: Map<string, TypeSignature>,
  toolName: string,
  path: string
): TypeSignature {
  const required = schemaRequired(schema)
  const fields = new Map<string, TypeFieldSignature>()
  for (const [propName, propSchemaRaw] of Object.entries(schemaProperties(schema))) {
    const propSchema = normalizeSchemaNode(propSchemaRaw)
    const propPath = path ? `${path}.${propName}` : propName
    const typeExpr = schemaToTypeExpr(propSchema, defs, referencedTypes, toolName, propPath)
    const desc = optionalText(propSchema['description'])
    fields.set(propName, new TypeFieldSignature(propName, typeExpr, required.has(propName), desc))
  }
  return new TypeSignature(name, optionalText(schema['description']), fields)
}

function replaceInExpr(expr: TypeExpr, replacements: ReadonlyMap<TypeSignature, TypeSignature>): TypeExpr {
  if (expr instanceof TypeSignature) {
    return replacements.get(expr) ?? expr
  }
  if (expr instanceof GenericTypeExpr) {
    const newArgs = expr.args.map((arg) => replaceInExpr(arg, replacements))
    if (newArgs.some((arg, i) => arg !== expr.args[i])) {
      expr.args = newArgs
    }
  } else if (expr instanceof UnionTypeExpr) {
    const newMembers = expr.members.map((member) => replaceInExpr(member, replacements))
    if (newMembers.some((member, i) => member !== expr.members[i])) {
      expr.members = newMembers
    }
  }
  return expr
}

function replaceTypeRefs(sig: FunctionSignature, oldRef: TypeSignature, canonical: TypeSignature): void {
  const replacements = new Map([[oldRef, canonical]])
  for (const param of sig.params.values()) {
    param.type = replaceInExpr(param.type, replacements)
  }
  sig.returnType = replaceInExpr(sig.returnType, replacements)
  for (const typeSig of sig.referencedTypes) {
    for (const f of typeSig.fields.values()) {
      f.type = replaceInExpr(f.type, replacements)
    }
  }
}
