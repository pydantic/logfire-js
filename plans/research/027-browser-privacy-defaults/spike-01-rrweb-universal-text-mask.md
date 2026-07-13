# Spike 01: rrweb universal text masking

## Question

Can the installed `rrweb@2.1.0` implementation support a public
`maskAllText` privacy default even though its recorder options do not expose a
property with that name?

## Why this is load-bearing

R5's settled D2 contract masks all rendered DOM text by default. If the
installed recorder cannot implement that contract reliably, the public option,
roadmap scope, or package dependency would need to change before generating an
implementation-ready PRP.

## Evidence

- `node_modules/.pnpm/rrweb@2.1.0/node_modules/rrweb/dist/rrweb.d.ts:217-238`
  exposes `maskTextSelector`, `maskAllInputs`, and `maskTextFn`, but no
  `maskAllText` option.
- `node_modules/.pnpm/rrweb-snapshot@2.1.0/node_modules/rrweb-snapshot/dist/rrweb-snapshot.cjs:757-787`
  applies `maskTextSelector` with `Element.matches()`/`closest()` when serializing
  text nodes, including ancestor checks.
- The installed-version jsdom probe invoked `rrweb-snapshot.snapshot()` with
  `maskTextSelector: '*'` and `maskAllInputs: true` against visible heading,
  paragraph, and input values. It returned only masked values:

  ```json
  ["******* ***** *****", "******** *****", "value=******"]
  ```

## Command

Run from `packages/logfire-session-replay`:

```bash
node --input-type=module -e "import { JSDOM } from 'jsdom'; const dom = new JSDOM('<!doctype html><html><body><h1>Welcome Alice Smith</h1><p>Balance: 84213</p><input value=secret></body></html>'); for (const key of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','SVGElement','ShadowRoot','CSSStyleSheet']) if (key in dom.window) globalThis[key]=dom.window[key]; const mod = await import('../../node_modules/.pnpm/rrweb-snapshot@2.1.0/node_modules/rrweb-snapshot/dist/rrweb-snapshot.js'); const node = mod.snapshot(dom.window.document, { maskTextSelector: '*', maskAllInputs: true }); const values=[]; const walk=(n)=>{ if(n && typeof n==='object'){ if(typeof n.textContent==='string') values.push(n.textContent); if(n.attributes?.value) values.push('value='+n.attributes.value); for(const c of n.childNodes??[]) walk(c); }}; walk(node); console.log(JSON.stringify(values));"
```

## Decision

Add a public `maskAllText?: boolean` option with a default of `true`. Keep the
rrweb mapping internal:

- `maskAllText: true` passes `maskTextSelector: '*'` to rrweb.
- `maskAllText: false` passes the caller's optional `maskTextSelector` for
  selective masking.
- When `maskAllText` is true, a narrower `maskTextSelector` cannot unmask text;
  callers must explicitly set `maskAllText: false` before selecting narrower
  regions.

This gives consumers a semantic, recorder-independent API while preserving the
existing selective-mask escape hatch.

## Limits and execution gate

The probe establishes installed full-snapshot serialization behavior in jsdom.
It does not prove mutation-event behavior or the final gzip envelope. Execution
must therefore include a built-package real-browser fixture that inspects the
decoded initial snapshot and a later visible-text mutation. If either contains
the original marker under defaults, R5 must pause rather than claim the privacy
contract.
