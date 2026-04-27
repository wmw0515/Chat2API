type RequestOptions = {
  method?: string
  body?: unknown
}

const apiBase = '/dashboard-api'
const dashboardTokenStorageKey = 'chat2api.dashboardToken'


function getDashboardToken(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(dashboardTokenStorageKey)?.trim() || ''
  } catch {
    return ''
  }
}

function extractErrorMessage(payload: any, fallback: string): string {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload
  if (typeof payload?.message === 'string') return payload.message
  if (typeof payload?.error === 'string') return payload.error
  if (typeof payload?.error?.message === 'string') return payload.error.message
  return fallback
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const dashboardToken = getDashboardToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (dashboardToken) {
    headers['X-Dashboard-Token'] = dashboardToken
  }

  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  const text = await response.text()
  const payload = text ? (() => {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })() : null

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Dashboard token is missing or invalid. Set localStorage key "chat2api.dashboardToken" and refresh the page.')
    }
    throw new Error(extractErrorMessage(payload, `Request failed: ${response.status}`))
  }

  if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false) {
    throw new Error(extractErrorMessage(payload, 'Request failed'))
  }

  return payload as T
}

export function installBrowserApiShim() {
  if (typeof window === 'undefined' || window.electronAPI) {
    return
  }

  ;(window as any).__CHAT2API_BROWSER_MODE = true

  window.electronAPI = {
    proxy: {
      getStatus: () => request('/health').then((data: any) => ({
        isRunning: data.status === 'running',
        port: data.statistics?.port,
        host: data.statistics?.host,
        uptime: data.uptime,
      })),
      onStatusChanged: () => () => {},
      start: async () => false,
      stop: async () => false,
    },
    statistics: {
      get: () => request('/statistics'),
    },
    providers: {
      getAll: () => request('/providers'),
      getBuiltin: () => request('/providers/builtin'),
      getPresets: () => request('/provider-presets'),
      createPreset: (preset: any) => request('/provider-presets', { method: 'POST', body: preset }),
      updatePreset: (presetId: string, updates: any) => request(`/provider-presets/${presetId}`, { method: 'PUT', body: updates }),
      deletePreset: (presetId: string) => request(`/provider-presets/${presetId}`, { method: 'DELETE' }).then(() => true),
      getOverride: (providerId: string) => request(`/providers/${providerId}/override`),
      updateOverride: (providerId: string, override: any) => request(`/providers/${providerId}/override`, { method: 'PUT', body: override }),
      deleteOverride: (providerId: string) => request(`/providers/${providerId}/override`, { method: 'DELETE' }).then(() => true),
      add: (data: any) => request('/providers', { method: 'POST', body: data }),
      update: (id: string, updates: any) => request(`/providers/${id}`, { method: 'PUT', body: updates }),
      delete: (id: string) => request(`/providers/${id}`, { method: 'DELETE' }).then(() => true),
      checkStatus: (providerId: string) => request(`/providers/${providerId}/check-status`, { method: 'POST' }),
      checkAllStatus: () => request('/providers/check-all-status', { method: 'POST' }),
      getEffectiveModels: (providerId: string) => request(`/providers/${providerId}/effective-models`),
      syncModels: (providerId: string) => request(`/providers/${providerId}/models/sync`, { method: 'POST' }),
      getModelSyncStatus: (providerId: string) => request(`/providers/${providerId}/models/sync-status`),
      addCustomModel: (providerId: string, model: { displayName: string; actualModelId: string }) =>
        request(`/providers/${providerId}/models`, { method: 'POST', body: model }),
      removeModel: (providerId: string, modelName: string) =>
        request(`/providers/${providerId}/models/${encodeURIComponent(modelName)}`, { method: 'DELETE' }),
      resetModels: (providerId: string) =>
        request(`/providers/${providerId}/models/reset`, { method: 'POST' }),
      checkModel: (providerId: string, modelId: string) =>
        request(`/providers/${providerId}/models/${encodeURIComponent(modelId)}/check`, { method: 'POST' }),
      checkAllModels: (providerId: string) =>
        request(`/providers/${providerId}/models/check-all`, { method: 'POST' }),
      duplicate: async () => {
        throw new Error('Duplicate provider is not supported in browser headless mode')
      },
    },
    accounts: {
      getAll: () => request('/accounts'),
      getById: (id: string, includeCredentials?: boolean) =>
        request(`/accounts/${id}?includeCredentials=${includeCredentials ? '1' : '0'}`),
      getByProvider: (providerId: string) => request(`/accounts?providerId=${encodeURIComponent(providerId)}`),
      add: (data: any) => request('/accounts', { method: 'POST', body: data }),
      update: (id: string, updates: any) => request(`/accounts/${id}`, { method: 'PUT', body: updates }),
      delete: (id: string) => request(`/accounts/${id}`, { method: 'DELETE' }).then(() => true),
      validate: (accountId: string) =>
        request(`/accounts/${accountId}/validate`, { method: 'POST' }),
      check: (accountId: string) =>
        request(`/accounts/${accountId}/check`, { method: 'POST' }),
      validateToken: (providerId: string, credentials: Record<string, string>) =>
        request('/accounts/validate-token', { method: 'POST', body: { providerId, credentials } }),
    },
    logs: {
      get: (options?: { limit?: number }) => request(`/logs?limit=${options?.limit || 50}`),
      getTrend: (days: number) => request(`/logs/trend?days=${days}`),
    },
    requestLogs: {
      get: (options?: { limit?: number }) => request(`/request-logs?limit=${options?.limit || 100}`),
      getTrend: (days: number) => request(`/request-logs/trend?days=${days}`),
    },
    config: {
      get: () => request('/config'),
      update: (updates: Record<string, unknown>) => request('/config', { method: 'PUT', body: updates }),
    },
    dashboard: {
      exportData: (options?: { includeCredentials?: boolean }) =>
        request(`/export?includeCredentials=${options?.includeCredentials ? '1' : '0'}`),
      importData: (
        payload: unknown,
        options?: { dryRun?: boolean },
      ) => request('/import', {
        method: 'POST',
        body: {
          dryRun: Boolean(options?.dryRun),
          ...((payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>),
        },
      }),
    },
    invoke: (channel: string, payload?: any) => {
      if (channel === 'proxy:getStatistics') {
        return request('/health').then((data: any) => data.statistics)
      }
      if (channel === 'managementApi:getConfig') {
        return request('/config').then((config: any) => config.managementApi)
      }
      if (channel === 'managementApi:updateConfig') {
        return request('/config', {
          method: 'PUT',
          body: { managementApi: payload },
        })
      }
      if (channel === 'managementApi:generateSecret') {
        return Promise.resolve('Not supported in headless web mode yet')
      }
      return Promise.reject(new Error(`Unsupported channel in browser mode: ${channel}`))
    },
  } as any
}
