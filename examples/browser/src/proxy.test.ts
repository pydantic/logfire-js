import { expect } from 'vite-plus/test'

import { defineProxyContract } from './proxyTestContract.ts'
import { createProxyApp, loadProxyConfig, startProxy } from './proxy.ts'

defineProxyContract({
  createProxyApp,
  defaultOrigin: 'http://127.0.0.1:5173',
  defaultOrigins: ['http://127.0.0.1:5173', 'http://127.0.0.1:4173'],
  defaultPort: 8989,
  label: 'basic browser',
  loadProxyConfig,
  startProxy,
  verifyExampleApi: async (origin) => {
    const response = await fetch(`${origin}/api/post`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 1, title: 'Browser proxy response' })
  },
})
