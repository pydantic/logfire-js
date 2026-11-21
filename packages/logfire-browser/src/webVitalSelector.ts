/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Modified by Pydantic. `buildSelector` is adapted from `src/lib/getSelector.ts`
 * of web-vitals 6.2.2, which does not export it. The change: the walk can treat
 * an element with a generated id as an element with no id, and it reports
 * whether it did so.
 */

const MAX_LENGTH = 100

/**
 * Ids that a framework or component library generates at render time. Each
 * pattern is narrow on purpose: a hand-written id that matches one is skipped,
 * and the selector then continues to the next ancestor id.
 */
const GENERATED_ID_PATTERNS = [
  // React 18 and 19.0 `useId`: `:r1:`, and `:R1mcq:` or `:R1mcqH1:` from server rendering.
  // Not anchored to the whole id, because libraries build ids on it, such as `radix-:r1:`.
  // The counter is base 32, and the left boundary keeps ids such as `form:results:0`.
  /(?:^|[^0-9A-Za-z]):[rR][0-9a-vH]+:/u,
  // React 19.1 `useId`: `«r1»`, `«R1mcq»`.
  /«[rR][0-9a-vH]+»/u,
  // React 19.2 `useId`: `_r_1_`, `_R_1mcq_`. The boundaries keep ids such as `user_r_and_d_team`.
  /(?:^|[^0-9A-Za-z])_[rR]_[0-9a-vH]+_(?:$|[^0-9A-Za-z])/u,
  // Counter ids from library versions that do not use `useId`: `radix-1`,
  // `headlessui-menu-button-1`, `react-aria-1`, `react-aria123-1`.
  /^(?:radix|headlessui|react-aria)[0-9A-Za-z-]*-\d+$/u,
]

export function isGeneratedId(id: unknown): boolean {
  return typeof id === 'string' && GENERATED_ID_PATTERNS.some((pattern) => pattern.test(id))
}

function getName(node: Node): string {
  const name = node.nodeName
  return node.nodeType === 1 ? name.toLowerCase() : name.toUpperCase().replace(/^#/u, '')
}

interface BuiltSelector {
  selector: string
  skippedGeneratedId: boolean
}

function buildSelector(start: Node | null, skipGeneratedIds: boolean): BuiltSelector {
  let node = start
  let selector = ''
  let skippedGeneratedId = false

  try {
    while (node?.nodeType !== 9) {
      const element = node as Element
      let id = element.id
      if (skipGeneratedIds && isGeneratedId(id)) {
        skippedGeneratedId = true
        id = ''
      }
      // A text node has no classList.
      const classNames = (element.classList as DOMTokenList | undefined) ?? []
      const part = id ? `#${id}` : [getName(element), ...Array.from(classNames).sort()].join('.')
      if (selector.length + part.length > MAX_LENGTH - 1) {
        return { selector: selector || part, skippedGeneratedId }
      }
      selector = selector ? `${part}>${selector}` : part
      if (id) {
        break
      }
      node = element.parentNode
    }
  } catch {
    // The walk ends here for a node outside a document, as it does in web-vitals.
  }
  return { selector, skippedGeneratedId }
}

/**
 * The selector that web-vitals generates for a node. With `skipGeneratedIds`,
 * a generated id does not end the walk.
 */
export function getSelector(node: Node | null, skipGeneratedIds = false): string {
  return buildSelector(node, skipGeneratedIds).selector
}

/**
 * A selector with no generated id in it. It returns `undefined` when the walk
 * meets no generated id, so web-vitals builds the selector and the value stays
 * the same as without this function.
 */
export function generateStableSelector(node: Node | null): string | undefined {
  const { selector, skippedGeneratedId } = buildSelector(node, true)
  return skippedGeneratedId && selector !== '' ? selector : undefined
}
