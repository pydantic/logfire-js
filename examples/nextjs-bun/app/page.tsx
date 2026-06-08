import HelloButton from './components/HelloButton'

export default function Home() {
  return (
    <main style={{ display: 'grid', gap: 16, margin: '80px auto', maxWidth: 640, padding: 24 }}>
      <h1>Next.js 16 with Bun</h1>
      <p>This page renders with the App Router. The button calls a server route handler.</p>
      <HelloButton />
    </main>
  )
}
