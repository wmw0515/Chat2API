/**
 * Proxy Service Module - Proxy Server Core
 * Implements proxy server based on Koa
 */

import Koa, { type Context, type Next } from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { Server as HttpServer } from 'http'
import routes from './routes'
import managementRoutes from './routes/management'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { sessionManager } from './sessionManager'
import ProviderManager from '../store/providers'
import AccountManager from '../store/accounts'
import ConfigManager from '../store/config'
import { ProviderChecker } from '../providers/checker'
import { validateCredentials } from '../store/validator'
import fs from 'node:fs'
import path from 'node:path'
import mime from 'mime-types'

/**
 * Proxy Server Class
 */
export class ProxyServer {
  private app: Koa
  private router: Router
  private server: HttpServer | null = null
  private port: number = 8080
  private host: string = '127.0.0.1'

  constructor() {
    this.app = new Koa()
    this.router = new Router()

    this.setupMiddleware()
    this.setupRoutes()
    this.setupErrorHandler()
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    this.app.use(async (ctx, next) => {
      ctx.set('Access-Control-Allow-Origin', '*')
      ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Dashboard-Token')
      ctx.set('Access-Control-Max-Age', '86400')

      if (ctx.method === 'OPTIONS') {
        ctx.status = 204
        return
      }

      await next()
    })

    this.app.use(bodyParser({
      jsonLimit: '50mb',
      formLimit: '50mb',
      textLimit: '50mb',
    }))


    this.app.use(async (ctx, next) => {
      const dashboardToken = process.env.CHAT2API_DASHBOARD_TOKEN
      if (!dashboardToken || !ctx.path.startsWith('/dashboard-api/')) {
        await next()
        return
      }

      const authHeader = ctx.get('Authorization') || ''
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
      const headerToken = ctx.get('X-Dashboard-Token') || ''
      const providedToken = bearerToken || headerToken

      if (providedToken !== dashboardToken) {
        ctx.status = 401
        ctx.body = {
          success: false,
          error: {
            code: 'dashboard_auth_required',
            message: 'Dashboard token is required',
          },
        }
        return
      }

      await next()
    })

    // API Key validation middleware
    this.app.use(async (ctx, next) => {
      // Skip paths that don't require authentication
      const publicPaths = ['/', '/health', '/stats']
      if (publicPaths.includes(ctx.path)) {
        await next()
        return
      }

      // Skip management API paths - they have their own authentication
      if (ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      const config = storeManager.getConfig()
      
      if (config.enableApiKey && config.apiKeys && config.apiKeys.length > 0) {
        const authHeader = ctx.get('Authorization') || ''
        const providedKey = authHeader.startsWith('Bearer ') 
          ? authHeader.slice(7) 
          : (ctx.query.api_key as string) || ctx.get('X-API-Key')
        
        if (!providedKey) {
          ctx.status = 401
          ctx.body = {
            error: {
              message: 'API key is required',
              type: 'invalid_request_error',
              code: 'missing_api_key',
            },
          }
          return
        }
        
        const validKey = config.apiKeys.find(
          k => k.key === providedKey && k.enabled
        )
        
        if (!validKey) {
          ctx.status = 401
          ctx.body = {
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }
          return
        }
        
        // Update usage statistics
        const updatedKeys = config.apiKeys.map(k => 
          k.id === validKey.id 
            ? { 
                ...k, 
                lastUsedAt: Date.now(), 
                usageCount: k.usageCount + 1 
              }
            : k
        )
        storeManager.updateConfig({ apiKeys: updatedKeys })
      }
      
      await next()
    })

    this.app.use(async (ctx, next) => {
      const startTime = Date.now()

      await next()

      const latency = Date.now() - startTime
      const logLevel = ctx.status >= 400 ? 'warn' : 'info'

      if (!ctx.path.startsWith('/v1/models')) {
        storeManager.addLog(logLevel, `${ctx.method} ${ctx.path} ${ctx.status} ${latency}ms`, {
          data: {
            method: ctx.method,
            path: ctx.path,
            status: ctx.status,
            latency,
            clientIP: ctx.ip,
          },
        })
      }
    })
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    const rootInfoResponse = {
      name: 'Chat2API Proxy',
      version: '1.1.2',
      description: 'OpenAI API compatible proxy service',
      endpoints: [
        'POST /v1/chat/completions',
        'GET /v1/models',
        'GET /v1/models/:model',
        'POST /v1/completions',
      ],
    }

    const getSanitizedProviderUpdatePayload = (body: unknown): Record<string, unknown> => {
      const payload = (body || {}) as Record<string, unknown>
      const allowedFields = [
        'name',
        'authType',
        'apiEndpoint',
        'chatPath',
        'headers',
        'enabled',
        'description',
        'icon',
        'supportedModels',
        'modelMappings',
        'credentialFields',
      ]
      return Object.fromEntries(
        Object.entries(payload).filter(([key]) => allowedFields.includes(key)),
      )
    }

    const getSanitizedAccountUpdatePayload = (body: unknown): Record<string, unknown> => {
      const payload = (body || {}) as Record<string, unknown>
      const allowedFields = [
        'name',
        'email',
        'credentials',
        'dailyLimit',
        'weight',
        'status',
        'errorMessage',
      ]
      return Object.fromEntries(
        Object.entries(payload).filter(([key]) => allowedFields.includes(key)),
      )
    }
    const parseDashboardError = (error: unknown): { message: string; code: string } => {
      if (error instanceof Error) {
        return { message: error.message, code: 'dashboard_request_failed' }
      }
      return { message: 'Unknown error', code: 'dashboard_request_failed' }
    }

    const withDashboardErrorHandling = (handler: (ctx: Context) => Promise<void> | void) => {
      return async (ctx: Context): Promise<void> => {
        try {
          await handler(ctx)
        } catch (error) {
          const normalized = parseDashboardError(error)
          ctx.status = ctx.status && ctx.status >= 400 ? ctx.status : 400
          ctx.body = {
            success: false,
            error: {
              code: normalized.code,
              message: normalized.message,
            },
          }
        }
      }
    }

    // Register OpenAI API routes
    for (const route of routes) {
      this.router.use(route.routes())
      this.router.use(route.allowedMethods())
    }

    this.router.get('/', async (ctx) => {
      const acceptHeader = (ctx.get('accept') || '').toLowerCase()
      const explicitlyRequestsJson = acceptHeader.includes('application/json')
      const acceptsHtml = Boolean(ctx.accepts('html'))

      if (!explicitlyRequestsJson && acceptsHtml) {
        const rendererRoot = this.resolveRendererRoot()
        const indexFilePath = rendererRoot ? path.join(rendererRoot, 'index.html') : ''
        if (indexFilePath && fs.existsSync(indexFilePath)) {
          ctx.type = mime.lookup(indexFilePath) || 'text/html'
          ctx.body = fs.createReadStream(indexFilePath)
          return
        }
      }

      ctx.body = rootInfoResponse
    })

    this.router.get('/health', async (ctx) => {
      const status = proxyStatusManager.getRunningStatus()
      const statistics = proxyStatusManager.getStatistics()

      ctx.body = {
        status: status.isRunning ? 'running' : 'stopped',
        uptime: status.uptime,
        statistics: {
          totalRequests: statistics.totalRequests,
          successRequests: statistics.successRequests,
          failedRequests: statistics.failedRequests,
          activeConnections: statistics.activeConnections,
        },
      }
    })

    this.router.get('/stats', async (ctx) => {
      const statistics = proxyStatusManager.getStatistics()
      ctx.body = statistics
    })

    this.router.get('/dashboard-api/health', async (ctx) => {
      const status = proxyStatusManager.getRunningStatus()
      const statistics = proxyStatusManager.getStatistics()

      ctx.body = {
        status: status.isRunning ? 'running' : 'stopped',
        uptime: status.uptime,
        statistics,
      }
    })

    this.router.get('/dashboard-api/config', withDashboardErrorHandling(async (ctx) => {
      ctx.body = ConfigManager.get()
    }))

    this.router.put('/dashboard-api/config', withDashboardErrorHandling(async (ctx) => {
      const updates = (ctx.request.body || {}) as Record<string, unknown>
      const validation = ConfigManager.validate(updates)

      if (!validation.valid) {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: validation.errors.join('; '),
        }
        return
      }

      ctx.body = {
        success: true,
        data: ConfigManager.update(updates),
      }
    }))

    this.router.get('/dashboard-api/providers', withDashboardErrorHandling(async (ctx) => {
      ctx.body = ProviderManager.getAll()
    }))

    this.router.get('/dashboard-api/providers/builtin', withDashboardErrorHandling(async (ctx) => {
      ctx.body = ProviderManager.getBuiltin()
    }))

    this.router.post('/dashboard-api/providers', withDashboardErrorHandling(async (ctx) => {
      const body = (ctx.request.body || {}) as any
      if (!body?.name || !body?.authType || !body?.apiEndpoint) {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'invalid_provider_payload', message: 'name, authType and apiEndpoint are required' } }
        return
      }
      ctx.body = ProviderManager.create(body)
    }))

    this.router.put('/dashboard-api/providers/:id', withDashboardErrorHandling(async (ctx) => {
      const updates = getSanitizedProviderUpdatePayload(ctx.request.body)
      const updated = ProviderManager.update(ctx.params.id, updates as any)
      if (!updated) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = updated
    }))

    this.router.delete('/dashboard-api/providers/:id', withDashboardErrorHandling(async (ctx) => {
      const success = ProviderManager.delete(ctx.params.id)
      if (!success) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = { success: true }
    }))

    this.router.post('/dashboard-api/providers/:id/check-status', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = await ProviderChecker.checkProviderStatus(provider)
    }))

    this.router.post('/dashboard-api/providers/check-all-status', withDashboardErrorHandling(async (ctx) => {
      const providers = ProviderManager.getAll()
      const entries = await Promise.all(
        providers.map(async (provider) => [provider.id, await ProviderChecker.checkProviderStatus(provider)] as const),
      )
      ctx.body = Object.fromEntries(entries)
    }))

    this.router.get('/dashboard-api/accounts', withDashboardErrorHandling(async (ctx) => {
      const providerId = typeof ctx.query.providerId === 'string' ? ctx.query.providerId : undefined
      if (providerId) {
        ctx.body = AccountManager.getByProviderId(providerId, false)
        return
      }
      ctx.body = AccountManager.getAll(false)
    }))

    this.router.get('/dashboard-api/accounts/:id', withDashboardErrorHandling(async (ctx) => {
      const includeCredentials = String(ctx.query.includeCredentials || '0') === '1'
      const account = AccountManager.getById(ctx.params.id, includeCredentials)
      if (!account) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'account_not_found', message: `Account not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = account
    }))

    this.router.post('/dashboard-api/accounts', withDashboardErrorHandling(async (ctx) => {
      const body = (ctx.request.body || {}) as any
      if (!body?.providerId || !body?.name || !body?.credentials || typeof body.credentials !== 'object') {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'invalid_account_payload', message: 'providerId, name and credentials are required' } }
        return
      }
      ctx.body = AccountManager.create(body)
    }))

    this.router.put('/dashboard-api/accounts/:id', withDashboardErrorHandling(async (ctx) => {
      const updates = getSanitizedAccountUpdatePayload(ctx.request.body)
      const updated = AccountManager.update(ctx.params.id, updates as any)
      if (!updated) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'account_not_found', message: `Account not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = updated
    }))

    this.router.delete('/dashboard-api/accounts/:id', withDashboardErrorHandling(async (ctx) => {
      const success = AccountManager.delete(ctx.params.id)
      if (!success) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'account_not_found', message: `Account not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = { success: true }
    }))

    this.router.post('/dashboard-api/accounts/:id/validate', withDashboardErrorHandling(async (ctx) => {
      const result = await AccountManager.validate(ctx.params.id)
      if (!result.valid) {
        ctx.status = 400
      }
      ctx.body = result
    }))

    this.router.post('/dashboard-api/accounts/validate-token', withDashboardErrorHandling(async (ctx) => {
      const body = (ctx.request.body || {}) as { providerId?: string; credentials?: Record<string, string> }
      if (!body.providerId || !body.credentials) {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'invalid_validation_payload', message: 'providerId and credentials are required' } }
        return
      }
      const provider = ProviderManager.getById(body.providerId)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${body.providerId}` } }
        return
      }
      ctx.body = await validateCredentials(provider, body.credentials)
    }))

    this.router.get('/dashboard-api/statistics', async (ctx) => {
      ctx.body = storeManager.getStatistics()
    })

    this.router.get('/dashboard-api/logs', async (ctx) => {
      const limit = Number.parseInt(String(ctx.query.limit || '50'), 10)
      ctx.body = storeManager.getLogs(Number.isFinite(limit) ? limit : 50)
    })

    this.router.get('/dashboard-api/logs/trend', async (ctx) => {
      const days = Number.parseInt(String(ctx.query.days || '7'), 10)
      ctx.body = storeManager.getLogTrend(Number.isFinite(days) ? days : 7)
    })

    this.router.get('/dashboard-api/request-logs', async (ctx) => {
      const limit = Number.parseInt(String(ctx.query.limit || '100'), 10)
      ctx.body = storeManager.getRequestLogs(Number.isFinite(limit) ? limit : 100)
    })

    this.router.get('/dashboard-api/request-logs/trend', async (ctx) => {
      const days = Number.parseInt(String(ctx.query.days || '7'), 10)
      ctx.body = storeManager.getRequestLogTrend(Number.isFinite(days) ? days : 7)
    })

    // Management API enable check middleware
    // This must be registered before management routes
    const managementEnableCheck = async (ctx: Context, next: Next) => {
      if (!ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      try {
        const config = storeManager.getConfig()
        if (!config.managementApi?.enableManagementApi) {
          ctx.status = 404
          ctx.body = {
            success: false,
            error: {
              code: 'management_api_disabled',
              message: 'Management API is not enabled',
            },
          }
          return
        }
        await next()
      } catch {
        ctx.status = 503
        ctx.body = {
          success: false,
          error: {
            code: 'service_unavailable',
            message: 'Service is initializing',
          },
        }
      }
    }

    this.app.use(managementEnableCheck)

    // Register all management routes (they already have /v0/management prefix)
    for (const route of managementRoutes) {
      this.app.use(route.routes())
      this.app.use(route.allowedMethods())
    }

    this.app.use(this.router.routes())
    this.app.use(this.router.allowedMethods())

    this.app.use(async (ctx, next) => {
      if (ctx.method !== 'GET') {
        await next()
        return
      }

      const rendererRoot = this.resolveRendererRoot()
      if (!rendererRoot || ctx.path.startsWith('/v0/') || ctx.path.startsWith('/v1/') || ctx.path.startsWith('/dashboard-api/')) {
        await next()
        return
      }

      const requestPath = ctx.path === '/' ? '/index.html' : ctx.path
      const filePath = path.join(rendererRoot, requestPath)
      const normalizedPath = path.normalize(filePath)
      if (!normalizedPath.startsWith(rendererRoot)) {
        ctx.status = 403
        return
      }

      const hasExtension = path.extname(requestPath).length > 0
      const targetFile = fs.existsSync(normalizedPath)
        ? normalizedPath
        : hasExtension
          ? ''
          : path.join(rendererRoot, 'index.html')

      if (!targetFile || !fs.existsSync(targetFile)) {
        await next()
        return
      }

      const contentType = mime.lookup(targetFile) || 'application/octet-stream'
      ctx.type = contentType
      ctx.body = fs.createReadStream(targetFile)
    })

    this.app.use(async (ctx) => {
      ctx.status = 404
      ctx.body = {
        error: {
          message: `Route not found: ${ctx.method} ${ctx.path}`,
          type: 'not_found_error',
        },
      }
    })
  }

  private resolveRendererRoot(): string | null {
    const candidates = [
      path.resolve(__dirname, '../renderer'),
      path.resolve(process.cwd(), 'out/renderer'),
      path.resolve(process.cwd(), 'src/renderer/dist'),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'index.html'))) {
        return candidate
      }
    }

    return null
  }

  /**
   * Setup error handler
   */
  private setupErrorHandler(): void {
    this.app.on('error', (err, ctx) => {
      const status = err.status || 500
      const message = err.message || 'Internal Server Error'

      storeManager.addLog('error', `Server error: ${message}`, {
        data: {
          status,
          path: ctx.path,
          method: ctx.method,
          stack: err.stack,
        },
      })
    })
  }

  /**
   * Start server
   */
  async start(port?: number, host?: string): Promise<boolean> {
    if (this.server) {
      return false
    }

    this.port = port || proxyStatusManager.getPort()
    this.host = host || proxyStatusManager.getHost()
    
    sessionManager.initialize()

    return new Promise((resolve) => {
      try {
        this.server = this.app.listen(this.port, this.host, () => {
          proxyStatusManager.start()
          proxyStatusManager.setPort(this.port)
          proxyStatusManager.setHost(this.host)

          storeManager.addLog('info', `Proxy server started successfully, listening on ${this.host}:${this.port}`)

          resolve(true)
        })

        this.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            storeManager.addLog('error', `Port ${this.port} is already in use`)
          } else {
            storeManager.addLog('error', `Server error: ${err.message}`)
          }
          this.server = null
          resolve(false)
        })

        this.server.on('close', () => {
          this.server = null
        })
      } catch (error) {
        storeManager.addLog('error', `Failed to start server: ${error instanceof Error ? error.message : 'Unknown error'}`)
        resolve(false)
      }
    })
  }

  /**
   * Stop server
   */
  async stop(): Promise<boolean> {
    if (!this.server) {
      return false
    }
    
    sessionManager.destroy()

    return new Promise((resolve) => {
      this.server!.close((err) => {
        if (err) {
          storeManager.addLog('error', `Failed to stop server: ${err.message}`)
          resolve(false)
          return
        }

        this.server = null
        proxyStatusManager.stop()

        storeManager.addLog('info', 'Proxy server stopped')

        resolve(true)
      })
    })
  }

  /**
   * Restart server
   */
  async restart(port?: number, host?: string): Promise<boolean> {
    await this.stop()
    return this.start(port, host)
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null && proxyStatusManager.getRunningStatus().isRunning
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return proxyStatusManager.getStatistics()
  }

  /**
   * Get running status
   */
  getStatus() {
    return proxyStatusManager.getRunningStatus()
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    proxyStatusManager.resetStatistics()
  }
}

export const proxyServer = new ProxyServer()
export default proxyServer
