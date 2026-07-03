import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'

const EXPORT_SUCCESS = { code: 0 }

function makeExporter(): LogRecordExporter {
  return {
    export: (_logs, resultCallback) => {
      resultCallback(EXPORT_SUCCESS)
    },
    forceFlush: async () => Promise.resolve(),
    shutdown: async () => Promise.resolve(),
  }
}

async function importWithBatchLogRecordProcessor(BatchLogRecordProcessor: unknown) {
  vi.resetModules()
  vi.doMock('@opentelemetry/sdk-logs', () => ({
    BatchLogRecordProcessor,
  }))
  return import('../logsExporter')
}

describe('logsExporter', () => {
  afterEach(() => {
    vi.doUnmock('@opentelemetry/sdk-logs')
    vi.resetModules()
  })

  it('constructs BatchLogRecordProcessor with the options-object shape when supported', async () => {
    const constructorArgs: unknown[] = []

    const OptionsBatchLogRecordProcessorBase = (_options: { exporter?: unknown }) => undefined

    function OptionsBatchLogRecordProcessor(this: object, options: { exporter?: unknown }) {
      constructorArgs.push(options)
    }
    Object.setPrototypeOf(OptionsBatchLogRecordProcessor, OptionsBatchLogRecordProcessorBase)

    const { makeBatchLogRecordProcessor } = await importWithBatchLogRecordProcessor(OptionsBatchLogRecordProcessor)
    const exporter = makeExporter()

    const processor = makeBatchLogRecordProcessor(exporter)

    expect(processor).toBeInstanceOf(OptionsBatchLogRecordProcessor)
    expect(constructorArgs).toEqual([{ exporter }])
  })

  it('falls back to the legacy exporter-argument shape when options are not supported', async () => {
    const constructorArgs: unknown[] = []

    const LegacyBatchLogRecordProcessorBase = (_exporter: unknown, _config?: unknown) => undefined

    function LegacyBatchLogRecordProcessor(this: object, exporter: unknown) {
      constructorArgs.push(exporter)
    }
    Object.setPrototypeOf(LegacyBatchLogRecordProcessor, LegacyBatchLogRecordProcessorBase)

    const { makeBatchLogRecordProcessor } = await importWithBatchLogRecordProcessor(LegacyBatchLogRecordProcessor)
    const exporter = makeExporter()

    const processor = makeBatchLogRecordProcessor(exporter)

    expect(processor).toBeInstanceOf(LegacyBatchLogRecordProcessor)
    expect(constructorArgs).toEqual([exporter])
  })
})
