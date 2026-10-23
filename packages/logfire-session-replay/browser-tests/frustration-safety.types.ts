export interface FrustrationSafety {
  documentId: string
  shows: boolean[]
  signals: string[]
  session(): string | undefined
  recording(): string | undefined
  stats(): { ticks: number; handled: number; uploadErrors: number }
  start(): Promise<void>
  flush(): Promise<void>
  stop(): Promise<void>
  workload(enabled: boolean): void
}

declare global {
  interface Window {
    frustrationSafety: FrustrationSafety
  }
}
