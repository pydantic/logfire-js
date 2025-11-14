/* eslint-disable @typescript-eslint/no-empty-function */
import { PushMetricExporter } from '@opentelemetry/sdk-metrics'

export class VoidMetricExporter implements PushMetricExporter {
  export(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
