interface ImportMetaEnv {
  readonly VITE_LOGFIRE_PROXY_ORIGIN?: string
  readonly VITE_LOGFIRE_DIAG?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'lf-browser-recorder' {
  export * from '@pydantic/logfire-session-replay'
}
