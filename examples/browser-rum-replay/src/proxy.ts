import { pathToFileURL } from 'node:url'

import {
  createDevelopmentProxyApp,
  listenDevelopmentProxy,
  loadDevelopmentProxyConfig,
  type DevelopmentProxyConfig,
} from '../../browser/src/proxySupport.ts'

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): DevelopmentProxyConfig {
  return loadDevelopmentProxyConfig({
    defaultAllowedOrigins: ['http://127.0.0.1:5174', 'http://127.0.0.1:4174'],
    defaultPort: 8990,
    env,
  })
}

export function createProxyApp(config: DevelopmentProxyConfig) {
  const app = createDevelopmentProxyApp(config)

  app.get('/api/catalog', async (request, response) => {
    await sleep(180)
    response.json({
      region: request.query['region'] ?? 'unknown',
      products: [
        { sku: 'LF-101', name: 'Replay capture', stock: 12 },
        { sku: 'LF-204', name: 'Browser traces', stock: 7 },
        { sku: 'LF-330', name: 'Vitals metrics', stock: 18 },
      ],
    })
  })

  app.get('/api/inventory', async (_request, response) => {
    await sleep(120)
    response.json({
      warehouse: 'north-1',
      available: Math.floor(40 + Math.random() * 20),
      checkedAt: new Date().toISOString(),
    })
  })

  app.post('/api/checkout', async (request, response) => {
    await sleep(240)
    response.status(202).json({
      accepted: true,
      orderId: `ord_${Date.now().toString(36)}`,
      userId: request.body?.userId ?? 'anonymous',
    })
  })

  return app
}

export async function startProxy(config: DevelopmentProxyConfig = loadProxyConfig()) {
  const server = await listenDevelopmentProxy(createProxyApp(config), config)
  console.log(`RUM replay development proxy listening on http://${config.host}:${String(config.port)}`)
  return server
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startProxy()
}
