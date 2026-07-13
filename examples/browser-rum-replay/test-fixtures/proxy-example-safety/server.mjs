import { createServer } from 'node:http'

const host = '127.0.0.1'
const port = 8991
const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://127.0.0.1:5174'])
const actionRoutes = new Map([
  ['basic', { method: 'GET', path: '/api/post' }],
  ['catalog', { method: 'GET', path: '/api/catalog' }],
  ['inventory', { method: 'GET', path: '/api/inventory' }],
  ['checkout', { method: 'POST', path: '/api/checkout' }],
])

let prepared
let pending
let completed = []

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`)

  if (url.pathname.startsWith('/__r7/')) {
    await handleControl(request, response, url)
    return
  }

  if (!allowBrowserOrigin(request, response)) {
    return
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end()
    return
  }

  if (isTelemetryRequest(request, url)) {
    await drain(request)
    response.writeHead(202).end()
    return
  }

  const action = matchingAction(request, url)
  if (action === undefined) {
    await drain(request)
    json(response, 404, { error: 'not found' })
    return
  }
  if (prepared === undefined || prepared.action !== action || pending !== undefined) {
    await drain(request)
    json(response, 409, { error: 'action not prepared' })
    return
  }

  await drain(request)
  pending = {
    action,
    method: request.method,
    mode: prepared.mode,
    path: `${url.pathname}${url.search}`,
    response,
  }
  prepared = undefined
})

async function handleControl(request, response, url) {
  if (request.method === 'POST' && url.pathname.startsWith('/__r7/prepare/')) {
    const [, , , mode, action] = url.pathname.split('/')
    if (!['success', 'http', 'network'].includes(mode) || !actionRoutes.has(action)) {
      json(response, 400, { error: 'invalid mode or action' })
      return
    }
    if (pending !== undefined) {
      json(response, 409, { error: 'request already pending' })
      return
    }
    prepared = { action, mode }
    json(response, 200, { action, mode, prepared: true })
    return
  }

  if (request.method === 'POST' && url.pathname === '/__r7/release') {
    if (pending === undefined) {
      json(response, 409, { error: 'no request pending' })
      return
    }
    const held = pending
    pending = undefined
    completed.push({
      action: held.action,
      method: held.method,
      mode: held.mode,
      path: held.path,
    })
    if (held.mode === 'network') {
      held.response.socket?.destroy()
    } else if (held.mode === 'http') {
      json(held.response, 503, { error: 'fixture rejection' })
    } else {
      releaseSuccess(held.action, held.response)
    }
    json(response, 200, { action: held.action, mode: held.mode, released: true })
    return
  }

  if (request.method === 'GET' && url.pathname === '/__r7/status') {
    json(response, 200, {
      completed,
      pending:
        pending === undefined
          ? null
          : {
              action: pending.action,
              method: pending.method,
              mode: pending.mode,
              path: pending.path,
            },
      prepared: prepared ?? null,
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/__r7/reset') {
    if (pending !== undefined) {
      pending.response.socket?.destroy()
    }
    prepared = undefined
    pending = undefined
    completed = []
    json(response, 200, { reset: true })
    return
  }

  json(response, 404, { error: 'not found' })
}

function allowBrowserOrigin(request, response) {
  const origin = request.headers.origin
  if (origin === undefined) {
    return true
  }
  if (!allowedOrigins.has(origin)) {
    json(response, 403, { error: 'origin not allowed' })
    return false
  }
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Headers', 'content-type, content-encoding')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Vary', 'Origin')
  return true
}

function isTelemetryRequest(request, url) {
  return (
    request.method === 'POST' &&
    (url.pathname === '/client-traces' || url.pathname === '/client-metrics' || url.pathname.startsWith('/client-replay/'))
  )
}

function matchingAction(request, url) {
  for (const [action, route] of actionRoutes) {
    if (request.method === route.method && url.pathname === route.path) {
      return action
    }
  }
  return undefined
}

function releaseSuccess(action, response) {
  if (action === 'basic') {
    json(response, 200, { id: 1, title: 'Browser proxy response' })
  } else if (action === 'catalog') {
    json(response, 200, {
      products: [
        { name: 'Travel mug', sku: 'MUG-001', stock: 8 },
        { name: 'Notebook', sku: 'NOTE-002', stock: 3 },
      ],
      region: 'us',
    })
  } else if (action === 'inventory') {
    json(response, 200, {
      available: 42,
      checkedAt: '2026-01-01T00:00:00.000Z',
      warehouse: 'north-1',
    })
  } else {
    json(response, 202, {
      accepted: true,
      orderId: 'order-r7-fixture',
      userId: 'demo-user-42',
    })
  }
}

function json(response, status, value) {
  if (response.destroyed) {
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function drain(request) {
  for await (const _chunk of request) {
    // Consume request bytes before holding or responding.
  }
}

server.listen(port, host, () => {
  console.log(`R7 browser fixture listening on http://${host}:${String(port)}`)
})
