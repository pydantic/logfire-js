#!/usr/bin/env node
// A stand-in for the `codex` binary: records the argv and the prompt it was given, then emits the
// minimal JSONL turn the SDK needs to consider the run finished.
//
// This is the whole reason the option mapping can be proven offline. Everything this adapter does
// ends up as `--config key=value` and `--model` flags on a child process, so a binary that writes
// its argv to a file is a complete, honest assertion target -- with no API key, no network, and no
// model involved.
//
// TypeScript rather than JavaScript, and run through the shebang above: Node strips the types on its
// own, and being a `.ts` file inside the package's `tsconfig.json` is what puts this file under the
// same typecheck and type-aware lint as everything else here.
import { writeFileSync } from 'node:fs'

writeFileSync(process.env['FAKE_CODEX_ARGV'] ?? '', JSON.stringify(process.argv.slice(2)), 'utf8')

let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  prompt += String(chunk)
})
process.stdin.on('end', () => {
  const promptFile = process.env['FAKE_CODEX_PROMPT']
  if (promptFile !== undefined) {
    writeFileSync(promptFile, prompt, 'utf8')
  }
  for (const event of [
    { type: 'thread.started', thread_id: 't_fake' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ]) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
})
