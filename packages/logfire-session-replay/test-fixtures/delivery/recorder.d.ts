// Vite replaces this module with the built recorder after rewriting its browser dependencies.
declare module 'lf-replay-delivery' {
  export { startSessionReplay } from '@pydantic/logfire-session-replay'
}
