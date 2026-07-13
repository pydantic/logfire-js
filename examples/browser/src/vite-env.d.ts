interface ImportMetaEnv {
  readonly VITE_LOGFIRE_PROXY_ORIGIN?: string
  readonly VITE_LOGFIRE_REPLAY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __r7Unhandled?: string[]
}

declare module 'lf-browser-recorder' {
  export * from '@pydantic/logfire-session-replay'
}
