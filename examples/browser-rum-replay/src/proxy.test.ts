import { expect } from 'vite-plus/test'

import { defineProxyContract } from '../../browser/src/proxyTestContract.ts'
import { createProxyApp, loadProxyConfig, startProxy } from './proxy.ts'

defineProxyContract({
  createProxyApp,
  defaultOrigin: 'http://127.0.0.1:5174',
  defaultOrigins: ['http://127.0.0.1:5174', 'http://127.0.0.1:4174'],
  defaultPort: 8990,
  label: 'browser RUM replay',
  loadProxyConfig,
  startProxy,
  verifyExampleApi: async (origin) => {
    const catalog = await fetch(`${origin}/api/catalog?region=us`)
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({
      products: [
        { name: 'Replay capture', sku: 'LF-101', stock: 12 },
        { name: 'Browser traces', sku: 'LF-204', stock: 7 },
        { name: 'Vitals metrics', sku: 'LF-330', stock: 18 },
      ],
      region: 'us',
    })
    const inventory = await fetch(`${origin}/api/inventory`)
    expect(inventory.status).toBe(200)
    const inventoryBody = (await inventory.json()) as { available: number; warehouse: string }
    expect(inventoryBody.warehouse).toBe('north-1')
    expect(inventoryBody.available).toBeGreaterThanOrEqual(40)
    expect(inventoryBody.available).toBeLessThan(60)
    const checkout = await fetch(`${origin}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'demo-user' }),
    })
    expect(checkout.status).toBe(202)
    expect(await checkout.json()).toMatchObject({ accepted: true, userId: 'demo-user' })
  },
})
