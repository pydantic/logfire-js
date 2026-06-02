## Goal

Add a hosted datasets API client to the Logfire JavaScript SDK for `PYD-3528`.

The end state is a Promise-based TypeScript client that can manage hosted datasets and cases from a trusted server runtime using Logfire API keys. It should mirror the Python dataset client behavior where the JS runtime model makes sense, while keeping high-level local-evals integration (`pushDataset`, JS evaluator instance serialization, and fetching into `Dataset.evaluate()`) for `PYD-3896`.

## Why

- JS now has local eval primitives under `logfire/evals`, but it cannot create, list, update, delete, or import hosted datasets through the platform API.
- Python already has an experimental hosted dataset client in `../logfire/logfire/experimental/api_client.py`; JS users need equivalent hosted dataset management for parity.
- `PYD-3319` needs stronger TypeScript support across the Pydantic AI stack.
- This PRP creates the lower-level hosted datasets foundation so `PYD-3896` can focus on the local `Dataset`/`Case` workflow rather than platform transport and CRUD.

## Success Criteria

- [ ] JS users can instantiate a hosted datasets client with an explicit API key.
- [ ] `logfire/datasets` exposes a runtime-neutral core client that requires an explicit API key.
- [ ] `@pydantic/logfire-node/datasets` exposes a Node-owned convenience helper/export that can read `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL`.
- [ ] API-key base URL inference supports current Python token syntax, including optional organization IDs and staging regions in API keys.
- [ ] Users can override the platform base URL.
- [ ] Users can list, create, update, delete, and fetch hosted dataset metadata.
- [ ] `getDataset(idOrName, { includeCases: false })` uses the metadata endpoint.
- [ ] Default/full `getDataset(idOrName)` uses the export endpoint and returns the backend's full dataset payload.
- [ ] Users can list, get, import/add, update, and delete cases for a hosted dataset.
- [ ] Dataset lookup accepts dataset ID or dataset name; direct case get/update/delete accepts backend case ID, matching Python.
- [ ] Case import supports backend `on_conflict` behavior.
- [ ] Dataset and case request types include stable hosted fields: names, descriptions, JSON schemas, inputs, expected outputs, metadata, evaluator specs, report evaluator specs, tags where supported by backend.
- [ ] Error handling exposes predictable typed errors for dataset not found, case not found, API failures, timeouts, and transport failures.
- [ ] Successful JSON responses are returned as raw backend payloads without strict shape validation, matching Python client behavior.
- [ ] Unit tests use injected/mocked `fetch`; no tests depend on live Logfire services.
- [ ] Docs explain API key scopes and distinguish hosted dataset management from local `logfire/evals` execution.
- [ ] A minor changeset is added for both `logfire` and `@pydantic/logfire-node`.
- [ ] The implementation does not include `pushDataset` or local JS `Dataset` bridging; those remain for `PYD-3896`.

## Context

### Linear Source

- `PYD-3528` - Add hosted datasets API client support to logfire-js.
- Parent: `PYD-3525` - Bring logfire-js closer to Python SDK feature parity.
- Blocks: `PYD-3896` - Integrate hosted datasets with logfire-js evals.
- Related: `PYD-3319`, `PYD-2417`.

### Python Reference

- `../logfire/logfire/experimental/api_client.py`
  - `LogfireAPIClient` and `AsyncLogfireAPIClient` manage hosted datasets and cases.
  - Endpoints:
    - `GET /v1/datasets/`
    - `POST /v1/datasets/`
    - `GET /v1/datasets/{id_or_name}/`
    - `PATCH /v1/datasets/{id_or_name}/`
    - `DELETE /v1/datasets/{id_or_name}/`
    - `GET /v1/datasets/{id_or_name}/export/`
    - `GET /v1/datasets/{dataset_id_or_name}/cases/`
    - `GET /v1/datasets/{dataset_id_or_name}/cases/{case_id}/`
    - `POST /v1/datasets/{dataset_id_or_name}/import/?on_conflict=...`
    - `PATCH /v1/datasets/{dataset_id_or_name}/cases/{case_id}/`
    - `DELETE /v1/datasets/{dataset_id_or_name}/cases/{case_id}/`
  - Errors:
    - `DatasetNotFoundError`
    - `CaseNotFoundError`
    - `DatasetApiError`
  - `get_dataset(..., include_cases=False)` uses `/v1/datasets/{id_or_name}/`.
  - `get_dataset(..., include_cases=True)` uses `/v1/datasets/{id_or_name}/export/`.
  - `add_cases(..., on_conflict='update')` posts to `/import/`.
  - Dataset operations accept `id_or_name`; direct case operations accept `case_id`.
  - `push_dataset(...)` is intentionally excluded from this PRP.

- `../logfire/tests/test_datasets_client.py`
  - Best source for behavior expectations and mocked endpoint coverage.
  - Includes tests for metadata vs export fetch, CRUD operations, import `on_conflict`, 404 mapping, and evaluator spec payloads.

- `../logfire/logfire/_internal/auth.py`
  - Current token regex supports optional organization ID:

    ```text
    pylf_v{version}_{region}_{organization_uuid?}_{token}
    ```

- `../logfire/logfire/_internal/config.py`
  - `get_base_url_from_token()` defaults legacy/unknown tokens to US.
  - Supports `stagingus` and `stagingeu` regions in Python tests.

### Current JS Reference

- `packages/logfire-api/src/vars/index.ts`
  - Existing platform API HTTP pattern:
    - injected `fetch`,
    - trimmed `baseUrl`,
    - API-key auth via `Authorization: bearer ${apiKey}`,
    - timeout via `AbortController`,
    - JSON request/response handling,
    - domain-specific public errors.
  - `LogfireRemoteVariableProvider` is the closest local pattern.
  - This PRP should extract the reusable HTTP transport shape into an internal helper, but should not refactor variables to use it yet.

- `packages/logfire-api/src/vars.test.ts`
  - Existing mocked-`fetch` tests for API-key auth, URL construction, write body normalization, and error bodies.

- `packages/logfire-api/src/logfireApiConfig.ts`
  - Owns `resolveBaseUrl()`.
  - Current token regex does not yet support optional organization IDs in API keys.

- `packages/logfire-api/src/logfireApiConfig.test.ts`
  - Existing base URL inference tests for US/EU tokens.

- `packages/logfire-node/src/logfireConfig.ts`
  - Node runtime config already reads `LOGFIRE_API_KEY`.
  - Current `variablesBaseUrl` uses `logfireApi.resolveBaseUrl(process.env, advanced.baseUrl, apiKey)`.

- `packages/logfire-node/src/__test__/logfireConfig.test.ts`
  - Existing env/API key coverage for remote variables.

- `packages/logfire-api/src/evals/types.ts`
  - Defines the local evals `EvaluatorSpec` as `{ name, arguments }`.

- `packages/logfire-api/src/evals/serialization/dataset.ts`
  - Local JS dataset serialization uses pydantic-evals-compatible file/YAML shape, not necessarily the hosted API shape.
  - Do not wire this into hosted datasets in this PRP except by reusing compatible raw types where safe.

- `docs/evals.md`
  - Current JS evals documentation.
  - Add a hosted datasets management section or link from here, but keep local eval execution distinct from hosted management.

### Gotchas

- JavaScript should expose one Promise-based client, not separate sync and async clients.
- `packages/logfire-api` currently does not read `process.env`. Preserve that boundary: env handling belongs in `@pydantic/logfire-node`.
- `LOGFIRE_TOKEN` and `LOGFIRE_API_KEY` are different credentials. Hosted datasets must use API keys, not write tokens.
- `logfire/evals` has a short-form YAML evaluator encoding helper, but the hosted API uses explicit evaluator specs shaped like `{ name, arguments }`. Do not confuse these two wire shapes.
- TypeScript generic parameters are erased at runtime. JSON schema inference from `Dataset<I, O, M>` generics belongs to `PYD-3896`, and may need explicit schema options in JS.
- Backend response shape may include fields not captured in this PRP. Types should preserve stable known fields and allow unknown extra fields instead of strict-forbidding forward-compatible responses.
- Match Python behavior for successful responses: parse JSON and return it as-is, without checking that `listDatasets()` returned an array or `getDataset()` returned an object.
- API keys are sensitive. Docs must frame this client as trusted-server-runtime usage.

## Non-Goals

- No `pushDataset(...)` helper.
- No local JS `Dataset`/`Case` to hosted dataset bridge.
- No hosted dataset to local `Dataset.evaluate()` bridge.
- No evaluator instance serialization from JS evaluator classes.
- No production-trace/query-client dataset construction from `PYD-2417`.
- No GenAI/provider instrumentation.
- No live Logfire integration tests unless a separate test fixture/token strategy is explicitly added later.
- No managed variables refactor. `PYD-3897` tracks moving `LogfireRemoteVariableProvider` onto the shared internal platform transport after `PYD-3528` lands.
- No browser-safe API key story beyond documenting that API-key clients belong in trusted runtimes.

## Recommended Public API Shape

Decision: use a runtime-neutral core client in `logfire/datasets` and a Node-owned convenience helper/export in `@pydantic/logfire-node/datasets`.

```ts
import { LogfireAPIClient } from 'logfire/datasets'

const client = new LogfireAPIClient({
  apiKey: process.env.LOGFIRE_API_KEY,
})

const dataset = await client.createDataset({
  description: 'Golden QA cases',
  inputSchema: {
    properties: { question: { type: 'string' } },
    required: ['question'],
    type: 'object',
  },
  name: 'qa-golden-set',
})

await client.addCases(
  dataset.name,
  [
    {
      expectedOutput: { answer: '4' },
      inputs: { question: 'What is 2+2?' },
      name: 'arithmetic-1',
    },
  ],
  { onConflict: 'update' }
)

const metadata = await client.getDataset('qa-golden-set', { includeCases: false })
const full = await client.getDataset('qa-golden-set')
```

Node convenience path:

```ts
import { createLogfireAPIClient } from '@pydantic/logfire-node/datasets'

const client = createLogfireAPIClient()
```

`createLogfireAPIClient()` should read `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL`, and should also respect the same explicit options as the core client:

```ts
const client = createLogfireAPIClient({
  apiKey: 'pylf_v1_us_...',
  baseUrl: 'https://logfire-us.pydantic.dev',
})
```

The core `logfire/datasets` constructor should not read `process.env` directly.

## Implementation Blueprint

### Data Models

Create dataset client types in `packages/logfire-api/src/datasets/index.ts` or split into `types.ts` if the file grows.

Recommended core types:

```ts
export type JsonObject = Record<string, unknown>
export type JsonSchema = Record<string, unknown>

export interface HostedEvaluatorSpec {
  arguments: null | JsonObject | unknown[]
  name: string
}

export interface HostedDataset {
  case_count?: number
  created_at?: string
  description?: null | string
  evaluators?: HostedEvaluatorSpec[]
  id: string
  input_schema?: JsonSchema | null
  metadata_schema?: JsonSchema | null
  name: string
  output_schema?: JsonSchema | null
  report_evaluators?: HostedEvaluatorSpec[]
  updated_at?: string
  [key: string]: unknown
}

export interface HostedCase {
  created_at?: string
  evaluators?: HostedEvaluatorSpec[]
  expected_output?: unknown
  id: string
  inputs: unknown
  metadata?: unknown
  name?: null | string
  tags?: string[]
  updated_at?: string
  [key: string]: unknown
}

export interface CreateDatasetOptions {
  description?: null | string
  evaluators?: HostedEvaluatorSpec[]
  inputSchema?: JsonSchema | null
  metadataSchema?: JsonSchema | null
  name: string
  outputSchema?: JsonSchema | null
  reportEvaluators?: HostedEvaluatorSpec[]
}

export interface UpdateDatasetOptions {
  description?: null | string
  evaluators?: HostedEvaluatorSpec[] | null
  inputSchema?: JsonSchema | null
  metadataSchema?: JsonSchema | null
  name?: string
  outputSchema?: JsonSchema | null
  reportEvaluators?: HostedEvaluatorSpec[] | null
}

export interface CreateCaseOptions {
  evaluators?: HostedEvaluatorSpec[]
  expectedOutput?: unknown
  inputs: unknown
  metadata?: unknown
  name?: null | string
  tags?: string[]
}

export interface UpdateCaseOptions {
  evaluators?: HostedEvaluatorSpec[] | null
  expectedOutput?: unknown
  inputs?: unknown
  metadata?: unknown
  name?: null | string
  tags?: string[] | null
}

export type CaseConflictBehavior = 'error' | 'update'
```

Notes:

- Public write options use camelCase.
- Wire payload conversion maps camelCase to backend snake_case.
- Raw response DTOs preserve backend snake_case to avoid inventing lossy response normalization.
- Do not normalize hosted dataset/case responses to camelCase. Full dataset export payloads are backend/pydantic-evals-compatible DTOs and should remain raw.

### Tasks

```yaml
Task 1: Update API-key base URL inference
  MODIFY packages/logfire-api/src/logfireApiConfig.ts:
    - Update PYDANTIC_LOGFIRE_TOKEN_PATTERN to accept optional organization UUID between region and token.
    - Preserve legacy behavior for old tokens.
    - Preserve trailing slash trimming in resolveBaseUrl().
    - Match Python staging region behavior for `stagingus` and `stagingeu` tokens.
  MODIFY packages/logfire-api/src/logfireApiConfig.test.ts:
    - Add org-ID API key inference tests.
    - Add stagingus/stagingeu token inference tests.
    - Add trailing slash override test if not already covered.
  PATTERN:
    - ../logfire/logfire/_internal/auth.py
    - ../logfire/logfire/_internal/config.py:get_base_url_from_token

Task 2: Add an internal platform API transport helper
  CREATE packages/logfire-api/src/platform/http.ts:
    - Implement an internal low-level PlatformAPIClient or equivalent.
    - Implement fetch injection.
    - Implement API-key bearer auth.
    - Implement base URL trimming.
    - Implement JSON Accept/Content-Type handling.
    - Implement timeout with AbortController.
    - For error responses, parse JSON error details and fall back to text when JSON parsing fails.
    - For successful non-204 responses, parse JSON and return it as-is without schema/shape validation.
    - Convert malformed JSON success responses into a predictable dataset API/transport error.
    - Implement path segment encoding helper.
    - Avoid Node-only APIs.
    - Keep this internal; do not export a generic "call any Logfire endpoint" public API.
  CREATE packages/logfire-api/src/platform/errors.ts:
    - Export a generic PlatformAPIError only if useful outside datasets.
    - Keep dataset domain errors in datasets if generic errors would be premature.
  PATTERN:
    - packages/logfire-api/src/vars/index.ts:LogfireRemoteVariableProvider.fetchJson
  NON-GOAL:
    - Do not migrate LogfireRemoteVariableProvider to this helper in this PRP.

Task 3: Add hosted datasets client
  CREATE packages/logfire-api/src/datasets/index.ts:
    - Export LogfireAPIClient, options types, DTO types, and error classes.
    - Constructor accepts { apiKey, baseUrl, fetch, timeoutMs }.
    - Use the internal platform API transport helper from Task 2.
    - Resolve base URL using explicit baseUrl first, then API key region inference.
    - Do not read process.env in this package.
    - Throw a clear configuration error when no API key is available.
    - Implement listDatasets().
    - Implement createDataset(options).
    - Implement updateDataset(idOrName, options).
    - Implement deleteDataset(idOrName).
    - Implement getDataset(idOrName, options?) with includeCases defaulting to true.
    - Implement listCases(datasetIdOrName).
    - Implement getCase(datasetIdOrName, caseId), where caseId is the backend case ID.
    - Implement addCases(datasetIdOrName, cases, options?) using /import/?on_conflict=...
    - Implement updateCase(datasetIdOrName, caseId, options), where caseId is the backend case ID.
    - Implement deleteCase(datasetIdOrName, caseId), where caseId is the backend case ID.
  PATTERN:
    - ../logfire/logfire/experimental/api_client.py methods
    - ../logfire/tests/test_datasets_client.py endpoint expectations

Task 4: Map errors predictably
  MODIFY packages/logfire-api/src/datasets/index.ts:
    - Add DatasetNotFoundError.
    - Add CaseNotFoundError.
    - Add DatasetApiError with status and detail fields.
    - Add DatasetTransportError or equivalent for fetch failures.
    - Add DatasetTimeoutError or make timeout distinguishable via DatasetTransportError.cause.
    - Map 404 on dataset endpoints to DatasetNotFoundError.
    - Map 404 on case endpoints to CaseNotFoundError when the backend detail indicates a case miss; otherwise preserve DatasetNotFoundError.
    - Map non-404 >=400 responses to DatasetApiError.
    - Return undefined/void for 204 responses.
  PATTERN:
    - ../logfire/logfire/experimental/api_client.py:_handle_response

Task 5: Add package exports and build entries
  MODIFY packages/logfire-api/package.json:
    - Add ./datasets export.
  MODIFY packages/logfire-api/vite.config.ts:
    - Add datasets entry.
    - Copy CJS declarations for datasets.
  MODIFY packages/logfire-node/package.json:
    - Add ./datasets export for the Node convenience entrypoint.
  MODIFY packages/logfire-node/vite.config.ts:
    - Add datasets entry.
    - Copy CJS declarations for datasets.
  CREATE packages/logfire-node/src/datasets.ts:
    - Re-export core dataset client types and errors from logfire/datasets.
    - Export createLogfireAPIClient(options?) that reads LOGFIRE_API_KEY and LOGFIRE_BASE_URL.
    - Explicit options override env values.
    - Do not call configure() as a side effect.

Task 6: Add focused tests
  CREATE packages/logfire-api/src/datasets.test.ts:
    - Test Authorization header uses "bearer <apiKey>".
    - Test base URL trimming and URL construction.
    - Test list/create/update/delete dataset endpoints and payload mapping.
    - Test public camelCase write options map to backend snake_case request bodies.
    - Test response objects preserve backend snake_case fields.
    - Test getDataset includeCases false uses /v1/datasets/{id}/.
    - Test getDataset default uses /v1/datasets/{id}/export/.
    - Test list/get/import/update/delete case endpoints and payload mapping.
    - Test addCases onConflict query param defaults to "update" and supports "error".
    - Test 204 handling for deletes.
    - Test DatasetNotFoundError, CaseNotFoundError, DatasetApiError.
    - Test response body detail is included in API errors.
    - Test success responses are returned raw without array/object shape validation.
    - Test malformed JSON success responses produce a predictable error.
    - Test timeout abort path with fake timers or a controllable fetch promise.
    - Test injected fetch is required when global fetch is missing.
  CREATE packages/logfire-api/src/platform/http.test.ts if useful:
    - Test internal transport behavior directly only if datasets tests become too broad.
  MODIFY packages/logfire-node/src/__test__/logfireConfig.test.ts:
    - Add coverage only if createLogfireAPIClient reads from shared logfireConfig instead of process.env directly.
  CREATE packages/logfire-node/src/__test__/datasets.test.ts:
    - Test createLogfireAPIClient reads LOGFIRE_API_KEY.
    - Test createLogfireAPIClient reads LOGFIRE_BASE_URL.
    - Test explicit options override env values.
    - Test missing API key throws a clear error.

Task 7: Add docs
  MODIFY docs/evals.md:
    - Add "Hosted Dataset Management" section.
    - Show API-key client creation.
    - Document required API key scopes: project:read_datasets and project:write_datasets.
    - Show create/list/get metadata/import cases/update/delete examples.
    - Explicitly distinguish hosted dataset management from local Dataset.evaluate().
    - Point out that push/local eval integration is covered by a separate upcoming helper.
  OPTIONAL MODIFY README.md:
    - Add only a brief package-level mention if README currently tracks subpath APIs.

Task 8: Add changeset
  CREATE .changeset/*.md:
    - Add a minor changeset for logfire.
    - Add a minor changeset for @pydantic/logfire-node.
    - Summarize the new hosted datasets client and Node env-aware helper.
    - Mention that high-level local Dataset push/fetch integration is separate follow-up work if useful for reader expectations.
```

### Integration Points

```yaml
PACKAGE_EXPORTS:
  - packages/logfire-api/package.json
  - packages/logfire-api/vite.config.ts

NODE_RUNTIME:
  - packages/logfire-node/src/logfireConfig.ts
  - packages/logfire-node/src/vars.ts
  - packages/logfire-node/package.json
  - packages/logfire-node/vite.config.ts

PLATFORM_HTTP:
  - packages/logfire-api/src/vars/index.ts
  - packages/logfire-api/src/platform/http.ts
  - packages/logfire-api/src/platform/errors.ts

EVALS_TYPES:
  - packages/logfire-api/src/evals/types.ts
  - packages/logfire-api/src/evals/serialization/dataset.ts

DOCS:
  - docs/evals.md
```

## Validation

Run focused validation during implementation:

```bash
vp run logfire#test -- -t "datasets|base url"
vp run logfire#typecheck
vp run @pydantic/logfire-node#test -- -t "api key|datasets|variables"
vp run @pydantic/logfire-node#typecheck
```

Run broader validation before PR:

```bash
pnpm run build
pnpm run test
pnpm run check
```

If the implementation only touches `packages/logfire-api` and docs, `vp run logfire#test` plus `vp run logfire#typecheck` is the minimum useful gate. Add the Node package gates if env/config integration or `@pydantic/logfire-node/datasets` is added.
Because this PRP includes `@pydantic/logfire-node/datasets`, run the Node package gates too.

### Required Test Coverage

- [ ] Explicit API key auth and base URL override.
- [ ] API key base URL inference for plain region token and org-ID token.
- [ ] API key base URL inference for `stagingus` and `stagingeu` tokens.
- [ ] Missing API key configuration error in both core and Node helper paths.
- [ ] Node helper reads `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL`.
- [ ] Node helper explicit options override env values.
- [ ] Public write options are camelCase and wire request bodies are snake_case.
- [ ] Responses preserve backend snake_case fields without broad normalization.
- [ ] Dataset CRUD happy paths.
- [ ] `getDataset(..., { includeCases: false })` metadata path.
- [ ] `getDataset(...)` export path.
- [ ] Case list/get/import/update/delete happy paths.
- [ ] Direct case get/update/delete methods document and use backend case IDs, not case names.
- [ ] Import `onConflict` default and explicit error mode.
- [ ] 204 delete responses.
- [ ] 404 dataset mapping.
- [ ] 404 case mapping.
- [ ] Non-404 API error mapping with parsed JSON detail and text fallback.
- [ ] Successful JSON responses are returned raw without shape validation.
- [ ] Malformed JSON success responses produce a predictable error.
- [ ] Timeout/abort behavior.
- [ ] Forward-compatible response types do not reject unknown backend fields.
- [ ] Minor changeset covers both public package exports.

## Resolved Decisions

- 2026-06-02: Public entrypoint and env behavior
  - Core client lives in `logfire/datasets`.
  - `@pydantic/logfire-node/datasets` provides the Node-owned convenience helper/export.
  - `LOGFIRE_API_KEY` and `LOGFIRE_BASE_URL` are read by the Node helper, not by `packages/logfire-api`.
- 2026-06-02: Request/response casing
  - Public write options use camelCase.
  - Request bodies map to backend snake_case.
  - Response DTOs preserve backend snake_case fields without broad normalization.
- 2026-06-02: Success response validation
  - Match Python client behavior: parse successful JSON responses and return them as-is.
  - Do not use strict Zod schemas or array/object shape validation for successful responses in this PRP.
  - Keep typed errors for HTTP failures, timeouts, transport failures, and malformed JSON responses.
- 2026-06-02: HTTP helper scope
  - Create an internal low-level platform API transport helper for shared fetch/auth/base URL/timeout/JSON handling.
  - Use it for the new hosted datasets client.
  - Do not expose the low-level transport as a public generic Logfire API client.
  - Do not refactor managed variables in this PRP; track that as follow-up `PYD-3897` after `PYD-3528`.
- 2026-06-02: Case identifiers
  - Follow Python behavior.
  - Dataset operations accept dataset ID or dataset name.
  - Direct case get/update/delete methods accept backend case ID, not case name.
- 2026-06-02: Staging token support
  - Match Python `get_base_url_from_token()` behavior for `stagingus` and `stagingeu`.
  - Add staging token inference tests while updating the token regex for optional organization IDs.
- 2026-06-02: Changeset
  - Add a minor changeset for both `logfire` and `@pydantic/logfire-node`.
  - The new subpath exports and hosted datasets client are feature-level public API additions.

## Unknowns & Risks

- Backend response fields are not documented as a stable OpenAPI contract in this repo. The implementation should stay forward-compatible.
- The API key org-ID token pattern must be updated carefully so old write tokens and current API keys still infer base URLs as before.
- `LOGFIRE_API_KEY` support can pull Node-specific assumptions into `packages/logfire-api` if future changes bypass the Node helper boundary.
- Hosted evaluator specs use `{ name, arguments }`, while local eval file serialization has additional short forms. Mixing these would create hard-to-debug hosted payloads.
- Case tags appeared in an old Python branch; confirm backend support before making tags part of acceptance beyond pass-through typing.
- Live API validation is intentionally out of scope, so mocked tests must be precise about endpoint paths and payloads.
- The internal platform transport helper will initially have two similar implementations in the repo because managed variables keep their existing HTTP path until the follow-up refactor.

**Confidence: 9/10** for one-pass implementation.
