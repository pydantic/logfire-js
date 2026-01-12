'use client'
import dynamic from 'next/dynamic'
import HelloButton from './components/HelloButton'

const ClientInstrumentationProvider = dynamic(() => import('./components/ClientInstrumentationProvider'), { ssr: false })
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-2xl font-bold mb-4">Next.js API Example</h1>
      <ClientInstrumentationProvider>
        <HelloButton />
      </ClientInstrumentationProvider>
    </main>
  )
}
