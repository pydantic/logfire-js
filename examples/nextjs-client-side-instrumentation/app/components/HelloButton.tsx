'use client'
import { useState } from 'react'

export default function HelloButton() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchHello = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/hello')
      const data = await response.json()
      setMessage(data.message)
    } catch {
      setMessage('Error fetching data')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button onClick={fetchHello} disabled={loading}>
        {loading ? 'Loading...' : 'Fetch Hello World'}
      </button>
      {message && <p>{message}</p>}
    </div>
  )
}
