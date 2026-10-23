export interface FrustrationFixture {
  scrollEvents?: number
  handledClicks?: number
  session: () => string | undefined
  setRoute: (value: string) => void
}

declare global {
  interface Window {
    frustrationFixture: FrustrationFixture
  }
}
