import { Case, Dataset } from './dataset'

export interface GenerateDatasetOptions<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  extraInstructions?: string
  generator: (params: {
    extraInstructions?: string
    nExamples: number
  }) => Promise<{ cases: { expectedOutput?: null | OutputT; inputs: InputsT; metadata?: MetadataT | null; name?: null | string }[] }>
  name?: null | string
  nExamples?: number
}

export async function generateDataset<InputsT = unknown, OutputT = unknown, MetadataT = unknown>(
  options: GenerateDatasetOptions<InputsT, OutputT, MetadataT>
): Promise<Dataset<InputsT, OutputT, MetadataT>> {
  const n = options.nExamples ?? 3
  const generated = await options.generator({ extraInstructions: options.extraInstructions, nExamples: n })
  const cases = generated.cases.map(
    (c) =>
      new Case<InputsT, OutputT, MetadataT>({
        expectedOutput: c.expectedOutput ?? null,
        inputs: c.inputs,
        metadata: c.metadata ?? null,
        name: c.name ?? null,
      })
  )
  return new Dataset<InputsT, OutputT, MetadataT>({ cases, name: options.name ?? 'generated' })
}
