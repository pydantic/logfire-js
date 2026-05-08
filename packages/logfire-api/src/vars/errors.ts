export class VariableCompositionError extends Error {
  override name: string = 'VariableCompositionError'
}

export class VariableCompositionCycleError extends VariableCompositionError {
  override name: string = 'VariableCompositionCycleError'
}

export class VariableCompositionDepthError extends VariableCompositionError {
  override name: string = 'VariableCompositionDepthError'
}

export class VariableRenderError extends Error {
  override name: string = 'VariableRenderError'
}
