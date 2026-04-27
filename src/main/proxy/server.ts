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
import { discoverProviderModels, providerSupportsModelDiscovery } from '../providers/modelDiscovery'
import { validateCredentials } from '../store/validator'
import { requestForwarder } from './forwarder'
import { classifyProviderError, sanitizeRuntimeErrorMessage } from './utils/runtimeError'
import type { ChatCompletionRequest, ProxyContext } from './types'
import fs from 'node:fs'
import path from 'node:path'
import mime from 'mime-types'
import type { Account, Provider } from '../store/types'
import type { ProviderPreset, ProviderConfigOverride } from '../../shared/types'

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

    const HEALTH_CHECK_TIMEOUT_MS = 30_000
    const HEALTH_CHECK_PROMPT = 'Please reply only: ok'

    const delay = async (ms: number): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, ms))
    }

    type ManualCheckResult = {
      success: boolean
      providerId: string
      accountId: string
      model: string
      actualModel: string
      status: 'available' | 'credential_error' | 'model_invalid' | 'connection_error' | 'unknown_error'
      errorCode?: string
      errorMessage?: string
      checkedAt: number
    }

    const runMinimalProbe = async (
      provider: Provider,
      account: Account,
      model: string,
      actualModel: string,
    ): Promise<ManualCheckResult> => {
      const startedAt = Date.now()
      const request: ChatCompletionRequest = {
        model,
        messages: [{ role: 'user', content: HEALTH_CHECK_PROMPT }],
        stream: false,
        max_tokens: 8,
        temperature: 0,
      }
      const context: ProxyContext = {
        requestId: `healthchk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        providerId: provider.id,
        accountId: account.id,
        model,
        actualModel,
        startTime: startedAt,
        isStream: false,
        clientIP: 'dashboard',
      }

      try {
        const result = await Promise.race([
          requestForwarder.forwardChatCompletion(request, account, provider, actualModel, context),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Health check timeout')), HEALTH_CHECK_TIMEOUT_MS)
          }),
        ])

        const checkedAt = Date.now()
        if (result.success) {
          storeManager.markModelRuntimeSuccess(provider.id, model, actualModel)
          storeManager.updateAccount(account.id, {
            healthStatus: 'active',
            lastRuntimeSuccessAt: checkedAt,
            lastRuntimeErrorCode: undefined,
            lastRuntimeErrorMessage: undefined,
          })
          return {
            success: true,
            providerId: provider.id,
            accountId: account.id,
            model,
            actualModel,
            status: 'available',
            checkedAt,
          }
        }

        const sanitizedError = sanitizeRuntimeErrorMessage(result.error || 'Health check failed')
        const category = classifyProviderError(provider.id, {
          status: result.status,
          message: sanitizedError,
        })
        storeManager.markModelRuntimeFailure(provider.id, model, actualModel, category, sanitizedError)
        const runtimeFailureUpdates = {
          lastRuntimeFailureAt: checkedAt,
          lastRuntimeErrorCode: category,
          lastRuntimeErrorMessage: sanitizedError,
          runtimeFailureCount: (account.runtimeFailureCount || 0) + 1,
        }
        if (category === 'credential_error') {
          storeManager.updateAccount(account.id, {
            ...runtimeFailureUpdates,
            healthStatus: 'invalid',
          })
        } else {
          storeManager.updateAccount(account.id, runtimeFailureUpdates)
        }

        return {
          success: false,
          providerId: provider.id,
          accountId: account.id,
          model,
          actualModel,
          status: category,
          errorCode: category,
          errorMessage: sanitizedError,
          checkedAt,
        }
      } catch (error) {
        const checkedAt = Date.now()
        const sanitizedError = sanitizeRuntimeErrorMessage(error instanceof Error ? error.message : 'Health check failed')
        const category: ManualCheckResult['status'] = 'connection_error'
        storeManager.markModelRuntimeFailure(provider.id, model, actualModel, category, sanitizedError)
        storeManager.updateAccount(account.id, {
          lastRuntimeFailureAt: checkedAt,
          lastRuntimeErrorCode: category,
          lastRuntimeErrorMessage: sanitizedError,
          runtimeFailureCount: (account.runtimeFailureCount || 0) + 1,
        })
        return {
          success: false,
          providerId: provider.id,
          accountId: account.id,
          model,
          actualModel,
          status: category,
          errorCode: category,
          errorMessage: sanitizedError,
          checkedAt,
        }
      }
    }

    type DashboardExportAccount = Omit<Account, 'credentials'> & { credentials?: Record<string, string> }
    type DashboardExportPayload = {
      version: string
      exportedAt: string
      includeCredentials: boolean
      providers: Provider[]
      accounts: DashboardExportAccount[]
      providerConfigOverrides: Record<string, ProviderConfigOverride>
      providerPresets: ProviderPreset[]
    }

    const toDashboardExport = (includeCredentials: boolean): DashboardExportPayload => {
      const providers = ProviderManager.getAll()
      const accounts = AccountManager.getAll(includeCredentials)

      return {
        version: rootInfoResponse.version,
        exportedAt: new Date().toISOString(),
        includeCredentials,
        providers,
        accounts: accounts.map((account) => {
          if (includeCredentials) {
            return account
          }
          const { credentials: _credentials, ...safeAccount } = account
          return safeAccount
        }),
        providerConfigOverrides: storeManager.getProviderConfigOverrides(),
        providerPresets: storeManager.getProviderPresets(),
      }
    }

    const getSanitizedProviderImportPayload = (provider: Partial<Provider>): Record<string, unknown> => {
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
        Object.entries(provider).filter(([key]) => allowedFields.includes(key)),
      )
    }

    const getSanitizedAccountImportPayload = (account: Partial<Account>): Record<string, unknown> => {
      const allowedFields = [
        'name',
        'email',
        'dailyLimit',
        'status',
        'errorMessage',
        'healthStatus',
        'lastValidatedAt',
        'lastValidationError',
        'lastValidationLatency',
      ]

      return Object.fromEntries(
        Object.entries(account).filter(([key]) => allowedFields.includes(key)),
      )
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
    this.router.get('/dashboard-api/provider-presets', withDashboardErrorHandling(async (ctx) => {
      const builtinPresets: ProviderPreset[] = ProviderManager.getBuiltin().map((provider: any) => ({
        presetId: `builtin:${provider.id}`,
        name: provider.name,
        type: 'builtin',
        providerId: provider.id,
        authType: provider.authType,
        apiEndpoint: provider.apiEndpoint,
        chatPath: provider.chatPath,
        headers: provider.headers,
        description: provider.description,
        supportedModels: provider.supportedModels,
        credentialFields: provider.credentialFields,
      }))
      ctx.body = [...builtinPresets, ...ProviderManager.getProviderPresets()]
    }))
    this.router.post('/dashboard-api/provider-presets', withDashboardErrorHandling(async (ctx) => {
      const body = (ctx.request.body || {}) as ProviderPreset
      ctx.body = ProviderManager.createProviderPreset({
        ...body,
        type: 'custom',
        presetId: body.presetId || `preset_${Date.now()}`,
      })
    }))
    this.router.put('/dashboard-api/provider-presets/:id', withDashboardErrorHandling(async (ctx) => {
      const updated = ProviderManager.updateProviderPreset(ctx.params.id, (ctx.request.body || {}) as Partial<ProviderPreset>)
      if (!updated) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'preset_not_found', message: `Preset not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = updated
    }))
    this.router.delete('/dashboard-api/provider-presets/:id', withDashboardErrorHandling(async (ctx) => {
      ctx.body = { success: ProviderManager.deleteProviderPreset(ctx.params.id) }
    }))
    this.router.get('/dashboard-api/providers/:id/override', withDashboardErrorHandling(async (ctx) => {
      ctx.body = ProviderManager.getBuiltinOverride(ctx.params.id) || {}
    }))
    this.router.put('/dashboard-api/providers/:id/override', withDashboardErrorHandling(async (ctx) => {
      ctx.body = ProviderManager.updateBuiltinOverride(ctx.params.id, (ctx.request.body || {}) as ProviderConfigOverride)
    }))
    this.router.delete('/dashboard-api/providers/:id/override', withDashboardErrorHandling(async (ctx) => {
      ProviderManager.resetBuiltinOverride(ctx.params.id)
      ctx.body = { success: true }
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

    this.router.get('/dashboard-api/providers/:id/effective-models', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = storeManager.getEffectiveModels(ctx.params.id)
    }))

    this.router.post('/dashboard-api/providers/:id/models/sync', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }

      if (!providerSupportsModelDiscovery(provider.id)) {
        storeManager.markModelSyncUnsupported(provider.id, 'This provider does not support dynamic model discovery')
        ctx.body = {
          success: false,
          supported: false,
          ...storeManager.getModelSyncStatus(provider.id),
        }
        return
      }

      const account = AccountManager.getByProviderId(provider.id, true).find(item => item.status === 'active')
      if (!account) {
        const message = 'No active account with credentials found for model sync'
        storeManager.markModelSyncFailure(provider.id, message)
        ctx.status = 400
        ctx.body = {
          success: false,
          supported: true,
          error: message,
          ...storeManager.getModelSyncStatus(provider.id),
          models: storeManager.getEffectiveModels(provider.id),
        }
        return
      }

      try {
        const result = await discoverProviderModels(provider, account)
        storeManager.updateDiscoveredModels(provider.id, result.models)
        ctx.body = {
          success: true,
          supported: true,
          ...storeManager.getModelSyncStatus(provider.id),
          models: storeManager.getEffectiveModels(provider.id),
        }
      } catch (error) {
        const safeMessage = error instanceof Error ? error.message : 'Failed to sync models'
        storeManager.markModelSyncFailure(provider.id, safeMessage)
        ctx.status = 502
        ctx.body = {
          success: false,
          supported: true,
          error: safeMessage,
          ...storeManager.getModelSyncStatus(provider.id),
          models: storeManager.getEffectiveModels(provider.id),
        }
      }
    }))

    this.router.get('/dashboard-api/providers/:id/models/sync-status', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = {
        providerId: provider.id,
        supported: providerSupportsModelDiscovery(provider.id),
        ...storeManager.getModelSyncStatus(provider.id),
      }
    }))

    this.router.post('/dashboard-api/providers/:id/models', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      const body = (ctx.request.body || {}) as { displayName?: string; actualModelId?: string }
      if (!body.displayName || !body.actualModelId) {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'invalid_model_payload', message: 'displayName and actualModelId are required' } }
        return
      }
      ctx.body = {
        success: true,
        models: storeManager.addCustomModel(ctx.params.id, {
          displayName: body.displayName,
          actualModelId: body.actualModelId,
        }),
      }
    }))

    this.router.delete('/dashboard-api/providers/:id/models/:modelName', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      const modelName = decodeURIComponent(ctx.params.modelName || '')
      if (!modelName) {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'invalid_model_name', message: 'modelName is required' } }
        return
      }
      ctx.body = {
        success: true,
        models: storeManager.removeModel(ctx.params.id, modelName),
      }
    }))

    this.router.post('/dashboard-api/providers/:id/models/reset', withDashboardErrorHandling(async (ctx) => {
      const provider = ProviderManager.getById(ctx.params.id)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${ctx.params.id}` } }
        return
      }
      ctx.body = {
        success: true,
        models: storeManager.resetModels(ctx.params.id),
      }
    }))

    this.router.post('/dashboard-api/providers/:providerId/models/:modelId/check', withDashboardErrorHandling(async (ctx) => {
      const providerId = ctx.params.providerId
      const modelId = decodeURIComponent(ctx.params.modelId || '')
      const provider = ProviderManager.getById(providerId)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${providerId}` } }
        return
      }
      if (!modelId) {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'invalid_model_id', message: 'modelId is required' } }
        return
      }

      const account = AccountManager.getAvailable(providerId).find(item => item.status === 'active')
      if (!account) {
        ctx.status = 400
        ctx.body = {
          success: false,
          providerId,
          model: modelId,
          actualModel: modelId,
          status: 'unknown_error',
          errorCode: 'no_available_account',
          errorMessage: 'No active account with credentials available for health check',
          checkedAt: Date.now(),
        }
        return
      }

      const effectiveModels = storeManager.getEffectiveModels(providerId)
      const mapped = effectiveModels.find(item => item.displayName === modelId)
      const actualModel = mapped?.actualModelId || modelId
      const result = await runMinimalProbe(provider, account, modelId, actualModel)
      ctx.body = result
    }))

    this.router.post('/dashboard-api/accounts/:accountId/check', withDashboardErrorHandling(async (ctx) => {
      const accountId = ctx.params.accountId
      const account = AccountManager.getById(accountId, true)
      if (!account) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'account_not_found', message: `Account not found: ${accountId}` } }
        return
      }
      const provider = ProviderManager.getById(account.providerId)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${account.providerId}` } }
        return
      }

      const effectiveModels = storeManager.getEffectiveModels(provider.id)
      const sourcePriority: Record<'manual' | 'static' | 'discovered', number> = {
        manual: 0,
        static: 1,
        discovered: 2,
      }
      const selectedModel = [...effectiveModels].sort((a, b) => {
        const sourceA = a.source || 'static'
        const sourceB = b.source || 'static'
        return sourcePriority[sourceA] - sourcePriority[sourceB]
      })[0]

      if (!selectedModel) {
        ctx.status = 400
        ctx.body = {
          success: false,
          providerId: provider.id,
          accountId: account.id,
          status: 'unknown_error',
          errorCode: 'no_model_available',
          errorMessage: 'No effective model available for health check',
          checkedAt: Date.now(),
        }
        return
      }

      const result = await runMinimalProbe(provider, account, selectedModel.displayName, selectedModel.actualModelId)
      ctx.body = result
    }))

    this.router.post('/dashboard-api/providers/:providerId/models/check-all', withDashboardErrorHandling(async (ctx) => {
      const providerId = ctx.params.providerId
      const provider = ProviderManager.getById(providerId)
      if (!provider) {
        ctx.status = 404
        ctx.body = { success: false, error: { code: 'provider_not_found', message: `Provider not found: ${providerId}` } }
        return
      }
      const account = AccountManager.getAvailable(providerId).find(item => item.status === 'active')
      if (!account) {
        ctx.status = 400
        ctx.body = { success: false, error: { code: 'account_not_found', message: `No active account for provider: ${providerId}` } }
        return
      }
      const effectiveModels = storeManager.getEffectiveModels(providerId)
      const results: ManualCheckResult[] = []
      for (let index = 0; index < effectiveModels.length; index += 1) {
        const model = effectiveModels[index]
        const result = await runMinimalProbe(provider, account, model.displayName, model.actualModelId)
        results.push(result)
        if (index < effectiveModels.length - 1) {
          await delay(700)
        }
      }
      const available = results.filter(item => item.status === 'available').length
      ctx.body = {
        providerId,
        checked: results.length,
        available,
        failed: results.length - available,
        results,
      }
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

    this.router.get('/dashboard-api/export', withDashboardErrorHandling(async (ctx) => {
      const includeCredentials = String(ctx.query.includeCredentials || '0') === '1'
      ctx.body = toDashboardExport(includeCredentials)
    }))

    this.router.post('/dashboard-api/import', withDashboardErrorHandling(async (ctx) => {
      const body = (ctx.request.body || {}) as any
      const dryRun = Boolean(body?.dryRun)
      const payload = body?.data && typeof body.data === 'object' ? body.data : body

      if (!payload || !Array.isArray(payload.providers) || !Array.isArray(payload.accounts)) {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: { code: 'invalid_import_payload', message: 'providers and accounts arrays are required' },
        }
        return
      }

      if (!dryRun && payload.providerConfigOverrides && typeof payload.providerConfigOverrides === 'object') {
        for (const [providerId, override] of Object.entries(payload.providerConfigOverrides as Record<string, ProviderConfigOverride>)) {
          try {
            ProviderManager.updateBuiltinOverride(providerId, override)
          } catch {
            // skip invalid overrides
          }
        }
      }
      if (!dryRun && Array.isArray(payload.providerPresets)) {
        for (const preset of payload.providerPresets as ProviderPreset[]) {
          if (!preset?.presetId) continue
          ProviderManager.updateProviderPreset(preset.presetId, preset) || ProviderManager.createProviderPreset(preset)
        }
      }

      const providerSummary = { created: [] as string[], updated: [] as string[], skipped: [] as string[] }
      const accountSummary = { created: [] as string[], updated: [] as string[], skipped: [] as string[] }

      for (const importedProviderRaw of payload.providers as Partial<Provider>[]) {
        if (!importedProviderRaw?.id) {
          providerSummary.skipped.push('missing-provider-id')
          continue
        }

        const existing = ProviderManager.getById(importedProviderRaw.id)
        const importedType = importedProviderRaw.type || 'custom'

        if (!existing && importedType === 'builtin') {
          if (!dryRun) {
            storeManager.ensureProviderExists(importedProviderRaw.id)
          }
          providerSummary.skipped.push(importedProviderRaw.id)
          continue
        }

        if (!existing && importedType !== 'custom') {
          providerSummary.skipped.push(importedProviderRaw.id)
          continue
        }

        if (!existing) {
          const createPayload = getSanitizedProviderImportPayload(importedProviderRaw) as any
          if (!createPayload.name || !createPayload.authType || !createPayload.apiEndpoint) {
            providerSummary.skipped.push(importedProviderRaw.id)
            continue
          }

          if (!dryRun) {
            ProviderManager.create({
              ...createPayload,
              id: importedProviderRaw.id,
              type: 'custom',
            })
          }
          providerSummary.created.push(importedProviderRaw.id)
          continue
        }

        if (existing.type === 'builtin' && importedType === 'builtin') {
          providerSummary.skipped.push(importedProviderRaw.id)
          continue
        }

        const updates = getSanitizedProviderImportPayload(importedProviderRaw)
        if (!dryRun) {
          ProviderManager.update(importedProviderRaw.id, updates as any)
        }
        providerSummary.updated.push(importedProviderRaw.id)
      }

      for (const importedAccountRaw of payload.accounts as Partial<Account>[]) {
        if (!importedAccountRaw?.id || !importedAccountRaw.providerId) {
          accountSummary.skipped.push(importedAccountRaw?.id || 'missing-account-id')
          continue
        }

        const provider = ProviderManager.getById(importedAccountRaw.providerId)
        if (!provider) {
          accountSummary.skipped.push(importedAccountRaw.id)
          continue
        }

        const existing = AccountManager.getById(importedAccountRaw.id, true)
        const hasCredentials = importedAccountRaw.credentials && typeof importedAccountRaw.credentials === 'object'
        const baseUpdates = getSanitizedAccountImportPayload(importedAccountRaw)
        const accountUpdates = hasCredentials
          ? { ...baseUpdates, credentials: importedAccountRaw.credentials }
          : baseUpdates

        if (existing) {
          if (existing.providerId !== importedAccountRaw.providerId) {
            accountSummary.skipped.push(importedAccountRaw.id)
            continue
          }

          if (!dryRun) {
            AccountManager.update(importedAccountRaw.id, accountUpdates as any)
          }
          accountSummary.updated.push(importedAccountRaw.id)
          continue
        }

        if (!dryRun) {
          const now = Date.now()
          storeManager.addAccount({
            id: importedAccountRaw.id,
            providerId: importedAccountRaw.providerId,
            name: importedAccountRaw.name || importedAccountRaw.id,
            email: importedAccountRaw.email,
            credentials: hasCredentials ? importedAccountRaw.credentials! : {},
            status: importedAccountRaw.status || 'inactive',
            createdAt: now,
            updatedAt: now,
            errorMessage: importedAccountRaw.errorMessage,
            dailyLimit: importedAccountRaw.dailyLimit,
            requestCount: importedAccountRaw.requestCount,
            todayUsed: importedAccountRaw.todayUsed,
            healthStatus: importedAccountRaw.healthStatus || 'unknown',
            lastValidatedAt: importedAccountRaw.lastValidatedAt,
            lastValidationError: importedAccountRaw.lastValidationError,
            lastValidationLatency: importedAccountRaw.lastValidationLatency,
            lastUsed: importedAccountRaw.lastUsed,
          })
        }
        accountSummary.created.push(importedAccountRaw.id)
      }

      ctx.body = {
        success: true,
        dryRun,
        summary: {
          providers: providerSummary,
          accounts: accountSummary,
        },
      }
    }))

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
