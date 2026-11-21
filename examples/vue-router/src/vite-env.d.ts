interface ImportMetaEnv {
  readonly VITE_LOGFIRE_BASE_URL?: string
  readonly VITE_LOGFIRE_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
