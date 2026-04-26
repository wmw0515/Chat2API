type RequestOptions = {
  method?: string
  body?: unknown
}

const apiBase = '/dashboard-api'

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed: ${response.status}`)
  }

  return response.json()
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
      checkAllStatus: async () => ({}),
    },
    accounts: {
      getAll: () => request('/accounts'),
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
