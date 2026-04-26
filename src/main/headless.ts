import { storeManager } from './store/store'
import { proxyServer } from './proxy/server'

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function startHeadlessServer(): Promise<void> {
  await storeManager.initialize()

  const config = storeManager.getConfig()
  const host = process.env.CHAT2API_HOST || config.proxyHost
  const port = parsePort(process.env.CHAT2API_PORT, config.proxyPort)

  const started = await proxyServer.start(port, host)
  if (!started) {
    throw new Error(`Failed to start Chat2API headless server on ${host}:${port}`)
  }

  console.log(`[Headless] Chat2API proxy running on http://${host}:${port}`)

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`[Headless] Received ${signal}, shutting down...`)
    await proxyServer.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

startHeadlessServer().catch((error) => {
  console.error('[Headless] Fatal error:', error)
  process.exit(1)
})
