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

interface MimoWebModelConfigItem {
  name?: string
  displayName?: string
  model?: string
  pageType?: string
  isDefault?: boolean
  isNew?: boolean
}

function normalizeBaseUrl(input?: string): string {
  const fallback = 'https://aistudio.xiaomimimo.com'
  const candidate = (input || fallback).trim()
  return candidate.replace(/\/+$/, '') || fallback
}

function extractScriptUrls(html: string, baseUrl: string): string[] {
  const scriptUrlSet = new Set<string>()
  const srcRegex = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

  let match: RegExpExecArray | null = null
  while ((match = srcRegex.exec(html)) !== null) {
    const rawSrc = match[1]?.trim()
    if (!rawSrc) continue
    try {
      const url = new URL(rawSrc, `${baseUrl}/`).toString()
      if (/\.js(\?|$)/i.test(url)) {
        scriptUrlSet.add(url)
      }
    } catch {
      continue
    }
  }

  return [...scriptUrlSet]
}

function extractBracketedArray(text: string, anchor: string): string | null {
  const anchorIndex = text.indexOf(anchor)
  if (anchorIndex < 0) return null

  const arrayStart = text.indexOf('[', anchorIndex)
  if (arrayStart < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = arrayStart; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '[') {
      depth++
      continue
    }

    if (char === ']') {
      depth--
      if (depth === 0) {
        return text.slice(arrayStart, i + 1)
      }
    }
  }

  return null
}

function tryParseModelConfigArray(raw: string): MimoWebModelConfigItem[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter(item => item && typeof item === 'object') as MimoWebModelConfigItem[]
    }
  } catch {
    // fallback to regex parse
  }

  const fallbackMatches: MimoWebModelConfigItem[] = []
  const entryRegex = /\{[^{}]*"model"\s*:\s*"([^"]+)"[^{}]*\}/g

  let entry: RegExpExecArray | null = null
  while ((entry = entryRegex.exec(raw)) !== null) {
    const objectText = entry[0]
    const model = objectText.match(/"model"\s*:\s*"([^"]+)"/)?.[1]
    const pageType = objectText.match(/"pageType"\s*:\s*"([^"]+)"/)?.[1]
    const name = objectText.match(/"name"\s*:\s*"([^"]+)"/)?.[1]
    const displayName = objectText.match(/"displayName"\s*:\s*"([^"]+)"/)?.[1]
    const isDefault = /"isDefault"\s*:\s*true/.test(objectText)
    const isNew = /"isNew"\s*:\s*true/.test(objectText)

    if (model) {
      fallbackMatches.push({ model, pageType, name, displayName, isDefault, isNew })
    }
  }

  return fallbackMatches
}

function scoreMimoEntry(item: MimoWebModelConfigItem): number {
  const model = String(item.model || '').toLowerCase()
  const hasV25 = model.includes('v2.5')
  const hasV21 = model.includes('v2.1')
  const hasV2 = model.includes('v2')

  return (item.isDefault ? 100 : 0)
    + (item.isNew ? 80 : 0)
    + (hasV25 ? 30 : hasV21 ? 20 : hasV2 ? 10 : 0)
}

function selectMimoChatModels(items: MimoWebModelConfigItem[]): Array<{ displayName: string; actualModelId: string }> {
  const byDisplayName = new Map<string, { score: number; model: { displayName: string; actualModelId: string } }>()

  for (const item of items) {
    const modelId = String(item.model || '').trim()
    if (!modelId) continue

    const pageType = String(item.pageType || '').trim().toLowerCase()
    if (pageType !== 'chat') continue

    const displayName = String(item.name || item.displayName || modelId).trim()
    if (!displayName) continue

    const score = scoreMimoEntry(item)
    const previous = byDisplayName.get(displayName)
    if (!previous || score > previous.score) {
      byDisplayName.set(displayName, {
        score,
        model: {
          displayName,
          actualModelId: modelId,
        },
      })
    }
  }

  const uniqueByModelId = new Set<string>()
  const selected: Array<{ displayName: string; actualModelId: string }> = []
  for (const entry of byDisplayName.values()) {
    if (uniqueByModelId.has(entry.model.actualModelId)) continue
    uniqueByModelId.add(entry.model.actualModelId)
    selected.push(entry.model)
  }

  return selected
}

function extractModelsFromWebAsset(content: string): Array<{ displayName: string; actualModelId: string }> {
  const anchors = ['"modelConfigListNg"', 'modelConfigListNg']
  for (const anchor of anchors) {
    const arrayText = extractBracketedArray(content, anchor)
    if (!arrayText) continue

    const parsedItems = tryParseModelConfigArray(arrayText)
    const models = selectMimoChatModels(parsedItems)
    if (models.length > 0) {
      return models
    }
  }
  return []
}

class MimoModelDiscoverer implements ProviderModelDiscoverer {
  async discoverModels(account: Account, provider: Provider): Promise<ModelDiscoveryResult> {
    const { serviceToken, userId, phToken } = normalizeMimoCredentials(account.credentials)
    const baseUrlCandidates = [normalizeBaseUrl(provider.apiEndpoint), 'https://aistudio.xiaomimimo.com']

    const defaultHeaders: Record<string, string> = {
      Accept: 'text/html,application/javascript,*/*',
      Referer: 'https://aistudio.xiaomimimo.com/',
    }

    if (serviceToken && userId && phToken) {
      defaultHeaders.Cookie = `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`
    }

    let lastErrorMessage = 'unable to locate modelConfigListNg in web app assets'

    for (const baseURL of [...new Set(baseUrlCandidates)]) {
      try {
        const htmlResponse = await axios.get(baseURL, {
          timeout: 15000,
          validateStatus: () => true,
          headers: defaultHeaders,
        })

        if (htmlResponse.status < 200 || htmlResponse.status >= 300 || typeof htmlResponse.data !== 'string') {
          lastErrorMessage = `HTML request failed with HTTP ${htmlResponse.status}`
          continue
        }

        const htmlText = htmlResponse.data
        const inlineModels = extractModelsFromWebAsset(htmlText)
        if (inlineModels.length > 0) {
          return {
            models: inlineModels.map(model => ({ ...model, source: 'discovered' })),
          }
        }

        const scriptUrls = extractScriptUrls(htmlText, baseURL)
        if (scriptUrls.length === 0) {
          lastErrorMessage = 'No JavaScript assets found on Mimo web app page'
          continue
        }

        const likelyScripts = scriptUrls
          .filter(url => /chunk|index|app|main/i.test(url) || /\.js(\?|$)/i.test(url))
          .slice(0, 30)

        for (const scriptUrl of likelyScripts) {
          try {
            const jsResponse = await axios.get(scriptUrl, {
              timeout: 15000,
              validateStatus: () => true,
              headers: {
                ...defaultHeaders,
                Accept: 'application/javascript,text/javascript,*/*',
              },
            })

            if (jsResponse.status < 200 || jsResponse.status >= 300 || typeof jsResponse.data !== 'string') {
              continue
            }

            const discovered = extractModelsFromWebAsset(jsResponse.data)
            if (discovered.length > 0) {
              return {
                models: discovered.map(model => ({ ...model, source: 'discovered' })),
              }
            }
          } catch {
            continue
          }
        }

        lastErrorMessage = 'modelConfigListNg not found in fetched web assets'
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : 'web asset request failed'
      }
    }

    const fallbackModels = parseModelList(provider.supportedModels || []).map(model => ({
      ...model,
      source: 'discovered' as const,
    }))

    if (fallbackModels.length > 0) {
      return { models: fallbackModels }
    }

    throw new Error(`Failed to discover Mimo models safely (${lastErrorMessage}). Existing/static models remain unchanged.`)
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
