'use client'

import * as logfire from '@pydantic/logfire-browser'
import { useState } from 'react'

export default function HelloButton() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function fetchHello() {
    return logfire.span('Click call API route button', {
      callback: async () => {
        setLoading(true)
        setMessage('')

        try {
          const response = await fetch('/api/hello')
          if (!response.ok) {
            throw new Error(`Request failed with ${response.status}`)
          }

          const data = (await response.json()) as { message: string }
          setMessage(data.message)
        } catch (error) {
          setMessage(error instanceof Error ? error.message : 'Request failed')
        } finally {
          setLoading(false)
        }
      },
    })
  }

  return (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
      <button disabled={loading} onClick={fetchHello} type="button">
        {loading ? 'Loading...' : 'Call API route'}
      </button>
      {message ? <p>{message}</p> : null}
    </div>
  )
}
