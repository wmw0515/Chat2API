import { storeManager } from '../store/store'
import { ProviderManager } from '../store/providers'
import { AccountManager } from '../store/accounts'
import { requestForwarder } from '../proxy/forwarder'
import { classifyProviderError, sanitizeRuntimeErrorMessage } from '../proxy/utils/runtimeError'
import { runGlmBigModelSseProbe } from '../providers/glmProbe'
import type { Account, Provider } from '../store/types'
import type { HealthCheckSchedulerConfig } from '../../shared/types'
import type { ChatCompletionRequest, ProxyContext } from '../proxy/types'
import type { RuntimeErrorCode } from '../../shared/types'

export type RuntimeStatus = 'available' | 'credential_error' | 'model_invalid' | 'connection_error' | 'unknown_error'

export type HealthCheckResult = {
  success: boolean
  providerId: string
  accountId: string
  model: string
  actualModel: string
  status: RuntimeStatus
  errorCode?: string
  errorMessage?: string
  checkedAt: number
}

type SchedulerProviderState = {
  lastScheduledHealthCheckAt?: number
  nextScheduledHealthCheckAt?: number
}

export type ScheduledHealthCheckStatus = {
  enabled: boolean
  minIntervalHours: number
  maxIntervalHours: number
  running: boolean
  lastScheduledRunAt?: number
  nextScheduledRunAt?: number
  providerStates: Record<string, SchedulerProviderState>
}

const HEALTH_CHECK_TIMEOUT_MS = 30_000
const GLM_HEALTH_CHECK_TIMEOUT_MS = 90_000
const HEALTH_CHECK_PROMPT = 'Please reply only: ok'
const MODEL_CHECK_DELAY_MS = 1_000
const NO_ACCOUNT_HEALTH_CHECK_ERROR = '没有可用于健康检测的有效账户凭证。请先添加或验证该厂商账户。'

const SENSITIVE_FIELD_PATTERN = /(service_token|ph_token|apikey|api_key|cookie|authorization|refresh_token|ticket|sessiontoken)/ig

const parsePositiveIntEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

const normalizeSchedulerConfig = (config: Partial<HealthCheckSchedulerConfig>): HealthCheckSchedulerConfig => {
  const enabled = Boolean(config.enabled)
  const minIntervalHours = Number.isFinite(config.minIntervalHours) && Number(config.minIntervalHours) >= 1
    ? Math.floor(Number(config.minIntervalHours))
    : 12
  const maxCandidate = Number.isFinite(config.maxIntervalHours) && Number(config.maxIntervalHours) >= 1
    ? Math.floor(Number(config.maxIntervalHours))
    : 24
  return {
    enabled,
    minIntervalHours,
    maxIntervalHours: Math.max(minIntervalHours, maxCandidate),
  }
}

const sanitizeHealthErrorMessage = (message: string): string => {
  return message.replace(SENSITIVE_FIELD_PATTERN, '[REDACTED]')
}

const extractAssistantContent = (body: any): string => {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (!item || typeof item !== 'object') return ''
        if (item.type === 'text' && typeof item.text === 'string') {
          return item.text
        }
        return ''
      })
      .join('')
      .trim()
  }
  return ''
}

export class HealthCheckService {
  private static instance: HealthCheckService | null = null

  private enabled = false

  private minIntervalHours = 12

  private maxIntervalHours = 24

  private hasLoadedStoreSchedulerConfig = false

  private hasLoggedStoreNotReadyWarning = false

  private readonly providerState = new Map<string, SchedulerProviderState>()

  private timer: NodeJS.Timeout | null = null

  private running = false

  private isProcessing = false

  private lastScheduledRunAt?: number

  private nextScheduledRunAt?: number

  private constructor() {
    this.applySchedulerConfig(this.getEnvSchedulerConfig())
  }

  static getInstance(): HealthCheckService {
    if (!this.instance) {
      this.instance = new HealthCheckService()
    }
    return this.instance
  }

  getSchedulerStatus(): ScheduledHealthCheckStatus {
    return {
      enabled: this.enabled,
      minIntervalHours: this.minIntervalHours,
      maxIntervalHours: this.maxIntervalHours,
      running: this.running,
      lastScheduledRunAt: this.lastScheduledRunAt,
      nextScheduledRunAt: this.nextScheduledRunAt,
      providerStates: Object.fromEntries(this.providerState.entries()),
    }
  }

  getSchedulerConfig(): HealthCheckSchedulerConfig {
    this.loadSchedulerConfig()
    return {
      enabled: this.enabled,
      minIntervalHours: this.minIntervalHours,
      maxIntervalHours: this.maxIntervalHours,
    }
  }

  updateSchedulerConfig(config: Partial<HealthCheckSchedulerConfig>): ScheduledHealthCheckStatus {
    this.loadSchedulerConfig()
    const normalized = normalizeSchedulerConfig({
      ...this.getSchedulerConfig(),
      ...config,
    })
    this.applySchedulerConfig(normalized)
    this.safeUpdateStoreConfig(normalized)
    this.restartScheduler()
    this.safeAddLog('info', '[HealthCheckScheduler] Config updated', { data: normalized })
    return this.getSchedulerStatus()
  }

  restartScheduler(): void {
    this.stopScheduler()
    this.startScheduler()
  }

  startScheduler(): void {
    if (!this.loadSchedulerConfig()) {
      return
    }
    if (this.running) {
      return
    }
    if (!this.enabled) {
      return
    }
    this.running = true
    this.scheduleNextRun(10_000)
    this.safeAddLog('info', '[HealthCheckScheduler] Started', {
      data: {
        minIntervalHours: this.minIntervalHours,
        maxIntervalHours: this.maxIntervalHours,
      },
    })
  }

  stopScheduler(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.running) {
      return
    }
    this.running = false
    this.nextScheduledRunAt = undefined
    this.safeAddLog('info', '[HealthCheckScheduler] Stopped')
  }

  private getEnvSchedulerConfig(): HealthCheckSchedulerConfig {
    return normalizeSchedulerConfig({
      enabled: process.env.CHAT2API_HEALTH_CHECK_ENABLED === '1',
      minIntervalHours: parsePositiveIntEnv('CHAT2API_HEALTH_CHECK_MIN_INTERVAL_HOURS', 12),
      maxIntervalHours: parsePositiveIntEnv('CHAT2API_HEALTH_CHECK_MAX_INTERVAL_HOURS', 24),
    })
  }

  private applySchedulerConfig(config: HealthCheckSchedulerConfig): void {
    this.enabled = config.enabled
    this.minIntervalHours = config.minIntervalHours
    this.maxIntervalHours = config.maxIntervalHours
  }

  private safeUpdateStoreConfig(config: HealthCheckSchedulerConfig): void {
    try {
      if (!storeManager.getStore()) {
        return
      }
      storeManager.updateConfig({ healthCheckScheduler: config })
    } catch {
      // ignore non-critical store update failures during startup
    }
  }

  private safeAddLog(level: 'info' | 'warn' | 'error', message: string, payload?: { data?: unknown }): void {
    try {
      if (storeManager.getStore()) {
        storeManager.addLog(level, message, payload)
        return
      }
    } catch {
      // ignore and fallback to console
    }

    if (level === 'error') {
      console.error(message, payload?.data ?? '')
      return
    }
    if (level === 'warn') {
      console.warn(message, payload?.data ?? '')
      return
    }
    console.log(message, payload?.data ?? '')
  }

  private loadSchedulerConfig(): boolean {
    if (this.hasLoadedStoreSchedulerConfig) {
      return true
    }

    if (!storeManager.getStore()) {
      if (!this.hasLoggedStoreNotReadyWarning) {
        this.hasLoggedStoreNotReadyWarning = true
        this.safeAddLog('warn', '[HealthCheckScheduler] Store not initialized yet, scheduler start delayed')
      }
      return false
    }

    try {
      const config = storeManager.getConfig()
      const hasStoredConfig = config.healthCheckScheduler && typeof config.healthCheckScheduler === 'object'
      const envConfig = this.getEnvSchedulerConfig()
      const runtimeConfig = hasStoredConfig
        ? normalizeSchedulerConfig(config.healthCheckScheduler)
        : envConfig

      this.applySchedulerConfig(runtimeConfig)
      this.hasLoadedStoreSchedulerConfig = true
      this.hasLoggedStoreNotReadyWarning = false

      if (!hasStoredConfig) {
        this.safeUpdateStoreConfig(runtimeConfig)
      }

      return true
    } catch {
      if (!this.hasLoggedStoreNotReadyWarning) {
        this.hasLoggedStoreNotReadyWarning = true
        this.safeAddLog('warn', '[HealthCheckScheduler] Store not initialized yet, scheduler start delayed')
      }
      return false
    }
  }

  async checkModel(providerId: string, modelId: string): Promise<HealthCheckResult> {
    const provider = ProviderManager.getById(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const account = await this.pickActiveAccount(providerId)
    const effectiveModels = storeManager.getEffectiveModels(providerId)
    const mapped = effectiveModels.find(item => item.displayName === modelId)
    const actualModel = mapped?.actualModelId || modelId
    if (!account) {
      const checkedAt = Date.now()
      storeManager.markModelRuntimeFailure(
        providerId,
        modelId,
        actualModel,
        'unknown_error',
        NO_ACCOUNT_HEALTH_CHECK_ERROR,
      )
      return {
        success: false,
        providerId,
        accountId: '',
        model: modelId,
        actualModel,
        status: 'unknown_error',
        errorCode: 'no_available_account',
        errorMessage: NO_ACCOUNT_HEALTH_CHECK_ERROR,
        checkedAt,
      }
    }
    return this.runMinimalProbe(provider, account, modelId, actualModel)
  }

  async checkAllModels(providerId: string): Promise<{
    providerId: string
    checked: number
    available: number
    failed: number
    results: HealthCheckResult[]
  }> {
    const provider = ProviderManager.getById(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const account = await this.pickActiveAccount(providerId)
    const effectiveModels = storeManager.getEffectiveModels(providerId)
    if (effectiveModels.length === 0) {
      return {
        providerId,
        checked: 0,
        available: 0,
        failed: 0,
        results: [],
      }
    }

    if (!account) {
      const checkedAt = Date.now()
      const errorMessage = NO_ACCOUNT_HEALTH_CHECK_ERROR
      const results: HealthCheckResult[] = effectiveModels.map((model) => {
        storeManager.markModelRuntimeFailure(providerId, model.displayName, model.actualModelId, 'unknown_error', errorMessage)
        return {
          success: false,
          providerId,
          accountId: '',
          model: model.displayName,
          actualModel: model.actualModelId,
          status: 'unknown_error',
          errorCode: 'no_available_account',
          errorMessage,
          checkedAt,
        }
      })

      return {
        providerId,
        checked: results.length,
        available: 0,
        failed: results.length,
        results,
      }
    }

    const results: HealthCheckResult[] = []

    for (let index = 0; index < effectiveModels.length; index += 1) {
      const model = effectiveModels[index]
      const result = await this.runMinimalProbe(provider, account, model.displayName, model.actualModelId)
      results.push(result)
      if (index < effectiveModels.length - 1) {
        await this.delay(700)
      }
    }

    const available = results.filter(item => item.status === 'available').length
    return {
      providerId,
      checked: results.length,
      available,
      failed: results.length - available,
      results,
    }
  }

  async checkAccount(accountId: string): Promise<HealthCheckResult> {
    const account = AccountManager.getById(accountId, true)
    if (!account) {
      throw new Error(`Account not found: ${accountId}`)
    }

    const provider = ProviderManager.getById(account.providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${account.providerId}`)
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
      return {
        success: false,
        providerId: provider.id,
        accountId: account.id,
        model: '',
        actualModel: '',
        status: 'unknown_error',
        errorCode: 'no_model_available',
        errorMessage: 'No effective model available for health check',
        checkedAt: Date.now(),
      }
    }

    return this.runMinimalProbe(provider, account, selectedModel.displayName, selectedModel.actualModelId)
  }

  async runMinimalProbe(provider: Provider, account: Account, model: string, actualModel: string): Promise<HealthCheckResult> {
    const checkedAt = Date.now()
    const credentialCheck = this.hasRequiredCredentials(provider.id, account)
    if (!credentialCheck.ok) {
      this.applyFailureState(provider.id, model, actualModel, account, 'credential_error', credentialCheck.message || 'Missing required credentials.', checkedAt)
      return {
        success: false,
        providerId: provider.id,
        accountId: account.id,
        model,
        actualModel,
        status: 'credential_error',
        errorCode: 'credential_error',
        errorMessage: credentialCheck.message || 'Missing required credentials.',
        checkedAt,
      }
    }

    if (provider.id === 'glm') {
      return this.runGlmSseProbe(provider, account, model, actualModel)
    }

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
      clientIP: 'health-check',
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
        const assistantContent = extractAssistantContent(result.body)
        if (!assistantContent) {
          const emptyContentError = 'Health check returned empty content'
          this.applyFailureState(provider.id, model, actualModel, account, 'unknown_error', emptyContentError, checkedAt)
          return {
            success: false,
            providerId: provider.id,
            accountId: account.id,
            model,
            actualModel,
            status: 'unknown_error',
            errorCode: 'unknown_error',
            errorMessage: emptyContentError,
            checkedAt,
          }
        }

        if (!assistantContent.toLowerCase().includes('ok')) {
          const unexpectedContentError = 'Health check response missing expected "ok" marker'
          this.applyFailureState(provider.id, model, actualModel, account, 'unknown_error', unexpectedContentError, checkedAt)
          return {
            success: false,
            providerId: provider.id,
            accountId: account.id,
            model,
            actualModel,
            status: 'unknown_error',
            errorCode: 'unknown_error',
            errorMessage: unexpectedContentError,
            checkedAt,
          }
        }

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

      const sanitizedError = sanitizeHealthErrorMessage(sanitizeRuntimeErrorMessage(result.error || 'Health check failed'))
      const category = classifyProviderError(provider.id, {
        status: result.status,
        message: sanitizedError,
      })
      this.applyFailureState(provider.id, model, actualModel, account, category, sanitizedError, checkedAt)
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
      const sanitizedError = sanitizeHealthErrorMessage(
        sanitizeRuntimeErrorMessage(error instanceof Error ? error.message : 'Health check failed'),
      )
      const category = classifyProviderError(provider.id, { message: sanitizedError }) || 'unknown_error'
      this.applyFailureState(provider.id, model, actualModel, account, category, sanitizedError, checkedAt)
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

  private async runGlmSseProbe(provider: Provider, account: Account, model: string, actualModel: string): Promise<HealthCheckResult> {
    const checkedAt = Date.now()
    const probe = await runGlmBigModelSseProbe(account.credentials || {}, GLM_HEALTH_CHECK_TIMEOUT_MS)

    if (!probe.credentialValid) {
      const errorMessage = probe.errorMessage || 'GLM requires Authorization, Bigmodel Organization, and Bigmodel Project.'
      this.applyFailureState(provider.id, model, actualModel, account, 'credential_error', errorMessage, checkedAt)
      return { success: false, providerId: provider.id, accountId: account.id, model, actualModel, status: 'credential_error', errorCode: 'credential_error', errorMessage, checkedAt }
    }

    if (!probe.sseChunkReceived) {
      const warningMessage = probe.warning || 'GLM 健康检测超时：未在检测窗口内收到 SSE 响应。账号凭证未被判定为无效。'
      this.applyFailureState(provider.id, model, actualModel, account, 'connection_error', warningMessage, checkedAt)
      return { success: false, providerId: provider.id, accountId: account.id, model, actualModel, status: 'connection_error', errorCode: probe.errorCode || 'connection_error', errorMessage: warningMessage, checkedAt }
    }

    if (probe.warning) {
      this.safeAddLog('warn', probe.warning, {
        providerId: provider.id,
        accountId: account.id,
        data: { model, actualModel },
      })
    }

    storeManager.markModelRuntimeSuccess(provider.id, model, actualModel)
    storeManager.updateAccount(account.id, {
      status: 'active',
      healthStatus: 'active',
      errorMessage: undefined,
      lastValidationError: undefined,
      lastRuntimeSuccessAt: Date.now(),
      lastRuntimeErrorCode: undefined,
      lastRuntimeErrorMessage: undefined,
    })
    return { success: true, providerId: provider.id, accountId: account.id, model, actualModel, status: 'available', checkedAt: Date.now() }
  }

  private hasUsableCredentials(account: Account): boolean {
    const credentials = account.credentials
    return Boolean(credentials && Object.keys(credentials).length > 0)
  }

  private hasRequiredCredentials(providerId: string, account: Account): { ok: boolean, message?: string } {
    if (!this.hasUsableCredentials(account)) {
      return { ok: false, message: 'No credentials configured for account.' }
    }

    if (providerId === 'glm') {
      const credentials = account.credentials || {}
      if (!credentials.authorization || !credentials.bigmodelOrganization || !credentials.bigmodelProject) {
        return { ok: false, message: 'GLM requires Authorization, Bigmodel Organization, and Bigmodel Project.' }
      }
    }

    return { ok: true }
  }

  private isAccountEligibleForHealthCheck(providerId: string, account: Account): boolean {
    if (account.providerId !== providerId) return false
    if ((account as any).enabled === false) return false
    if (account.status !== 'active' || account.status === 'disabled' || account.status === 'deleted') return false
    if (!this.hasUsableCredentials(account)) return false
    if (account.lastRuntimeErrorCode === 'credential_error') return false
    if (account.healthStatus === 'invalid' && account.lastRuntimeErrorCode === 'credential_error') return false
    return true
  }

  private applyFailureState(
    providerId: string,
    model: string,
    actualModel: string,
    account: Account,
    category: RuntimeErrorCode,
    sanitizedError: string,
    checkedAt: number,
  ): void {
    storeManager.markModelRuntimeFailure(providerId, model, actualModel, category, sanitizedError)
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
      return
    }
    storeManager.updateAccount(account.id, runtimeFailureUpdates)
  }

  private async pickActiveAccount(providerId: string): Promise<Account | null> {
    const candidates = AccountManager.getByProviderId(providerId, true).filter(account => this.isAccountEligibleForHealthCheck(providerId, account))
    if (providerId !== 'glm') return candidates[0] || null

    for (const account of candidates) {
      const probe = await runGlmBigModelSseProbe(account.credentials || {}, GLM_HEALTH_CHECK_TIMEOUT_MS)
      if (probe.credentialValid && probe.sseChunkReceived) {
        return account
      }
    }

    return null
  }

  private scheduleNextRun(delayMs: number): void {
    if (!this.running) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.nextScheduledRunAt = Date.now() + delayMs
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runScheduledPass()
    }, delayMs)
  }

  private async runScheduledPass(): Promise<void> {
    if (!this.running || this.isProcessing) {
      this.scheduleNextRun(this.hoursToMs(this.minIntervalHours))
      return
    }

    this.isProcessing = true
    this.lastScheduledRunAt = Date.now()

    try {
      const providers = ProviderManager.getEnabled()
      for (const provider of providers) {
        if (!this.running) break

        const providerMeta = this.providerState.get(provider.id) || {}
        const now = Date.now()
        if (providerMeta.nextScheduledHealthCheckAt && providerMeta.nextScheduledHealthCheckAt > now) {
          continue
        }

        const account = this.pickScheduledAccount(provider.id)
        if (!account) {
          this.providerState.set(provider.id, {
            ...providerMeta,
            nextScheduledHealthCheckAt: this.nextIntervalTimestamp(),
          })
          continue
        }

        const effectiveModels = storeManager.getEffectiveModels(provider.id)
        for (const model of effectiveModels) {
          const alreadyCheckedAt = Math.max(
            model.runtimeHealth?.lastCheckedAt || 0,
            account.lastRuntimeSuccessAt || 0,
            account.lastRuntimeFailureAt || 0,
          )
          if (alreadyCheckedAt && (Date.now() - alreadyCheckedAt) < this.hoursToMs(this.minIntervalHours)) {
            continue
          }

          await this.runMinimalProbe(provider, account, model.displayName, model.actualModelId)
          await this.delay(MODEL_CHECK_DELAY_MS)
        }

        this.providerState.set(provider.id, {
          lastScheduledHealthCheckAt: Date.now(),
          nextScheduledHealthCheckAt: this.nextIntervalTimestamp(),
        })
      }
    } catch (error) {
      storeManager.addLog('warn', '[HealthCheckScheduler] Scheduled pass failed', {
        data: {
          error: error instanceof Error ? sanitizeHealthErrorMessage(error.message) : 'unknown_error',
        },
      })
    } finally {
      this.isProcessing = false
      this.scheduleNextRun(this.hoursToMs(this.minIntervalHours))
    }
  }

  private pickScheduledAccount(providerId: string): Account | null {
    const candidates = AccountManager.getByProviderId(providerId, true).filter(account => this.isAccountEligibleForHealthCheck(providerId, account))
    return candidates[0] || null
  }

  private nextIntervalTimestamp(): number {
    const now = Date.now()
    const minMs = this.hoursToMs(this.minIntervalHours)
    const maxMs = this.hoursToMs(this.maxIntervalHours)
    if (maxMs <= minMs) {
      return now + minMs
    }
    const jitter = Math.floor(Math.random() * (maxMs - minMs + 1))
    return now + minMs + jitter
  }

  private hoursToMs(hours: number): number {
    return Math.floor(hours * 60 * 60 * 1000)
  }

  private async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}
