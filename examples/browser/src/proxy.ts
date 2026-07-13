import { pathToFileURL } from 'node:url'

import {
  createDevelopmentProxyApp,
  listenDevelopmentProxy,
  loadDevelopmentProxyConfig,
  type DevelopmentProxyConfig,
} from './proxySupport.ts'

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): DevelopmentProxyConfig {
  return loadDevelopmentProxyConfig({
    defaultAllowedOrigins: ['http://127.0.0.1:5173', 'http://127.0.0.1:4173'],
    defaultPort: 8989,
    env,
  })
}

export function createProxyApp(config: DevelopmentProxyConfig) {
  const app = createDevelopmentProxyApp(config)
  app.get('/api/post', (_request, response) => {
    response.json({ id: 1, title: 'Browser proxy response' })
  })
  return app
}

export async function startProxy(config: DevelopmentProxyConfig = loadProxyConfig()) {
  const server = await listenDevelopmentProxy(createProxyApp(config), config)
  console.log(`Browser development proxy listening on http://${config.host}:${String(config.port)}`)
  return server
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startProxy()
}
