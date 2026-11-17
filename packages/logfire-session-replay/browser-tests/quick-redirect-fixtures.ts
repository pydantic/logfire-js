export const quickRedirectServers = [
  {
    command: 'python3 examples/browser/quick-redirect/collector.py',
    url: 'http://127.0.0.1:4195/receipts/health',
  },
  {
    command: 'pnpm exec vp dev --config examples/browser/quick-redirect/vite.config.ts',
    url: 'http://127.0.0.1:4194/',
  },
]
