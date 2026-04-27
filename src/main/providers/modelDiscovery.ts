import axios from 'axios'
import type { Account, Provider } from '../store/types'
import { normalizeMimoCredentials } from './mimoCredentials'

export type DynamicModelSource = 'discovered'

export interface DiscoveredProviderModel {
  displayName: string
  actualModelId: string
  source: DynamicModelSource
}

export interface ModelDiscoveryResult {
  models: DiscoveredProviderModel[]
}

interface ProviderModelDiscoverer {
  discoverModels(account: Account, provider: Provider): Promise<ModelDiscoveryResult>
}

const MIMO_MODEL_ENDPOINTS = [
  '/open-apis/bot/models',
  '/open-apis/chat/models',
  '/open-apis/models',
]

function parseModelList(payload: unknown): Array<{ displayName: string; actualModelId: string }> {
  const roots: unknown[] = []
  if (Array.isArray(payload)) {
    roots.push(payload)
  } else if (payload && typeof payload === 'object') {
    const data = (payload as any).data
    if (Array.isArray(data)) roots.push(data)
    if (Array.isArray((payload as any).models)) roots.push((payload as any).models)
    if (Array.isArray((payload as any).list)) roots.push((payload as any).list)
  }

  const models = new Map<string, { displayName: string; actualModelId: string }>()

  for (const root of roots) {
    for (const item of root as any[]) {
      if (typeof item === 'string') {
        const value = item.trim()
        if (value) models.set(value, { displayName: value, actualModelId: value })
        continue
      }
      if (!item || typeof item !== 'object') continue

      const actualModelId = String(item.modelId || item.id || item.model || item.value || item.name || '').trim()
      const displayName = String(item.displayName || item.modelName || item.name || actualModelId).trim()
      if (!displayName || !actualModelId) continue

      models.set(displayName, { displayName, actualModelId })
    }
  }

  return [...models.values()]
}

class MimoModelDiscoverer implements ProviderModelDiscoverer {
  async discoverModels(account: Account, provider: Provider): Promise<ModelDiscoveryResult> {
    const { serviceToken, userId, phToken } = normalizeMimoCredentials(account.credentials)
    if (!serviceToken || !userId || !phToken) {
      throw new Error('Missing required Mimo credentials: service_token, user_id, ph_token')
    }

    const cookie = `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`
    const baseURL = provider.apiEndpoint || 'https://aistudio.xiaomimimo.com'
    let lastErrorMessage = 'Unknown error'

    for (const path of MIMO_MODEL_ENDPOINTS) {
      const url = `${baseURL}${path}?xiaomichatbot_ph=${encodeURIComponent(phToken)}`
      try {
        const response = await axios.get(url, {
          timeout: 15000,
          validateStatus: () => true,
          headers: {
            'Content-Type': 'application/json',
            Accept: '*/*',
            Origin: 'https://aistudio.xiaomimimo.com',
            Referer: 'https://aistudio.xiaomimimo.com/',
            'X-Timezone': 'Asia/Shanghai',
            Cookie: cookie,
          },
        })

        if (response.status < 200 || response.status >= 300) {
          lastErrorMessage = `HTTP ${response.status}`
          continue
        }

        const parsed = parseModelList(response.data)
        if (parsed.length === 0) {
          lastErrorMessage = 'Model list is empty or unsupported response format'
          continue
        }

        return {
          models: parsed.map(model => ({ ...model, source: 'discovered' })),
        }
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : 'Request failed'
      }
    }

    throw new Error(`Failed to discover Mimo models: ${lastErrorMessage}`)
  }
}

const discoverers: Partial<Record<string, ProviderModelDiscoverer>> = {
  mimo: new MimoModelDiscoverer(),
}

export function providerSupportsModelDiscovery(providerId: string): boolean {
  return Boolean(discoverers[providerId])
}

export async function discoverProviderModels(provider: Provider, account: Account): Promise<ModelDiscoveryResult> {
  const discoverer = discoverers[provider.id]
  if (!discoverer) {
    throw new Error(`Provider ${provider.id} does not support dynamic model discovery`)
  }
  return discoverer.discoverModels(account, provider)
}
