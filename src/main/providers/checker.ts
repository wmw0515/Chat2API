import axios, { AxiosError } from 'axios'
import { getBuiltinProvider } from './builtin'
import type { Provider, ProviderCheckResult, Account } from '../../shared/types'
import type { BuiltinProviderConfig } from '../store/types'
import { normalizeMimoCredentials } from './mimoCredentials'

const CHECK_TIMEOUT = 15000

export interface TokenCheckResult {
  valid: boolean
  error?: string
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
}

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const builtinConfig = provider.type === 'builtin' 
        ? getBuiltinProvider(provider.id) 
        : null
      
      if (builtinConfig) {
        return await this.checkBuiltinProvider(builtinConfig)
      }
      
      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(config: BuiltinProviderConfig): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`
      
      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  static async checkAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' 
      ? getBuiltinProvider(provider.id) 
      : null
    
    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }
    
    switch (provider.id) {
      case 'deepseek':
        return this.checkDeepSeekToken(account.credentials.token)
      case 'glm':
        return this.checkGLMToken(account.credentials)
      case 'kimi':
        return this.checkKimiToken(account.credentials.token)
      case 'minimax':
        return this.checkMiniMaxToken(
          provider,
          account
        )
      case 'qwen':
        return this.checkQwenToken(account.credentials.ticket)
      case 'qwen-ai':
        return this.checkQwenAiToken(account.credentials.token)
      case 'perplexity':
        return this.checkPerplexityToken(account.credentials.sessionToken || account.credentials.token)
      case 'mimo':
        return this.checkMimoToken(
          account.credentials.service_token,
          account.credentials.user_id,
          account.credentials.ph_token
        )
      default:
        if (!builtinConfig.tokenCheckEndpoint) {
          return { valid: true }
        }
        return this.checkGenericToken(builtinConfig, account)
    }
  }

  private static async checkMimoToken(
    serviceToken: string,
    userId: string,
    phToken: string
  ): Promise<TokenCheckResult> {
    const normalized = normalizeMimoCredentials({
      service_token: serviceToken,
      user_id: userId,
      ph_token: phToken,
    })

    if (!normalized.serviceToken || !normalized.userId || !normalized.phToken) {
      return { valid: false, error: 'Missing required credentials: service_token, user_id, ph_token' }
    }

    try {
      const response = await axios({
        method: 'POST',
        url: `https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=${encodeURIComponent(normalized.phToken)}`,
        data: {
          msgId: `validate_${Date.now()}`,
          conversationId: `validate_${Date.now()}`,
          query: 'ping',
          isEditedQuery: false,
          modelConfig: {
            enableThinking: false,
            webSearchStatus: 'disabled',
            model: 'mimo-v2-flash-studio',
            temperature: 0.1,
            topP: 0.95,
          },
          multiMedias: [],
        },
        headers: {
          'Content-Type': 'application/json',
          Cookie: `serviceToken=${normalized.serviceToken}; userId=${normalized.userId}; xiaomichatbot_ph=${normalized.phToken}`,
          Origin: 'https://aistudio.xiaomimimo.com',
          Referer: 'https://aistudio.xiaomimimo.com/',
          'X-Timezone': 'Asia/Shanghai',
          Accept: '*/*',
        },
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: `Validation failed: HTTP ${response.status}` }
      }
      if (response.status >= 200 && response.status < 300) {
        return {
          valid: true,
          userInfo: {
            name: 'Mimo User',
          },
        }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkDeepSeekToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[DeepSeek] Validating token for DeepSeek account')
      
      const response = await axios.get(
        'https://chat.deepseek.com/api/v0/users/current',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[DeepSeek] Response status:', response.status)
      console.log('[DeepSeek] Response data:', JSON.stringify(response.data, null, 2))
      
      // Response format: { code: 0, data: { biz_data: { ... } } }
      if (response.status === 200 && response.data?.code === 0 && response.data?.data?.biz_data) {
        const bizData = response.data.data.biz_data
        return {
          valid: true,
          userInfo: {
            name: bizData.id_profile?.name,
            email: bizData.email,
          },
        }
      }
      
      if (response.status === 401 || response.data?.code === 40003 || response.data?.data?.biz_code === 40003) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.msg || response.data?.message || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[DeepSeek] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkGLMToken(credentials: Record<string, any>): Promise<TokenCheckResult> {
    const authorization = credentials.authorization
    const bigmodelOrganization = credentials.bigmodelOrganization
    const bigmodelProject = credentials.bigmodelProject

    if (!authorization || !bigmodelOrganization || !bigmodelProject) {
      return { valid: false, error: 'GLM provider now requires BigModel Authorization, Bigmodel Organization, and Bigmodel Project fields.' }
    }

    try {
      const response = await axios.post(
        'https://bigmodel.cn/api/biz/trial/response/v4/sse/11989',
        {
          model: 'glm-5.1',
          modelId: 11989,
          stream: true,
          thinking: { type: 'enabled' },
          max_tokens: 65536,
          temperature: 1,
          top_p: 0.95,
          prompt: [{ role: 'user', content: '只回复 glm-ok', fileContentList: [] }],
        },
        {
          headers: {
            Authorization: authorization,
            'Bigmodel-Organization': bigmodelOrganization,
            'Bigmodel-Project': bigmodelProject,
            Origin: 'https://bigmodel.cn',
            Referer: 'https://bigmodel.cn/trialcenter/modeltrial/text?modelCode=glm-5.1',
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            'Set-Language': 'zh',
          },
          timeout: CHECK_TIMEOUT,
          responseType: 'stream',
          validateStatus: () => true,
        }
      )
      const contentType = String(response.headers['content-type'] || '')
      if (response.status === 401 || response.status === 403) return { valid: false, error: `Validation failed: HTTP ${response.status}` }
      if (response.status === 500) return { valid: false, error: 'Validation failed: missing Bigmodel-Organization or Bigmodel-Project' }
      if (response.status !== 200 || !contentType.includes('text/event-stream')) return { valid: false, error: `Validation failed: HTTP ${response.status}` }
      return { valid: true, userInfo: { name: 'GLM User' } }
    } catch (error) {
      return { valid: false, error: error instanceof AxiosError ? error.message : 'Connection failed' }
    }
  }

  private static async generateGLMSignV2(): Promise<{ timestamp: string; nonce: string; sign: string }> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    
    // GLM timestamp algorithm
    const now = Date.now()
    const timestampStr = now.toString()
    const len = timestampStr.length
    const digits = timestampStr.split('').map(d => parseInt(d))
    const sum = digits.reduce((a, b) => a + b, 0) - digits[len - 2]
    const checkDigit = sum % 10
    const timestamp = timestampStr.substring(0, len - 2) + checkDigit + timestampStr.substring(len - 1)
    
    // Random UUID (no separators)
    const nonce = this.generateUUID().replace(/-/g, '')
    
    // Signature
    const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
    
    return { timestamp, nonce, sign }
  }

  private static async checkKimiToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[Kimi] Validating Token:', token.substring(0, 20) + '...')
      
      const response = await axios.post(
        'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'Accept': '*/*',
            'Origin': 'https://www.kimi.com',
            'Referer': 'https://www.kimi.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[Kimi] Response status:', response.status)
      console.log('[Kimi] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.subscription) {
        return {
          valid: true,
          userInfo: {
            name: response.data.subscription.userName,
          },
        }
      }
      
      return { valid: false, error: 'Token expired or invalid' }
    } catch (error) {
      console.error('[Kimi] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkMiniMaxToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const { MiniMaxAdapter } = await import('../proxy/adapters/minimax')
      const adapter = new MiniMaxAdapter(provider, account)
      const result = await adapter.validateCredentialFlow()
      return result.valid
        ? { valid: true }
        : { valid: false, error: result.error || 'MiniMax validation failed' }
    } catch (error) {
      console.error('[MiniMax] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenToken(ticket: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.post(
        'https://chat2-api.qianwen.com/api/v2/session/page/list',
        {},
        {
          headers: {
            Cookie: `tongyi_sso_ticket=${ticket}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.qianwen.com',
            'Referer': 'https://www.qianwen.com/',
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      if (response.status === 200 && response.data?.success) {
        return {
          valid: true,
        }
      }
      
      if (!response.data?.success) {
        return { valid: false, error: 'SSO ticket expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.errorMsg || 'Unknown error'}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenAiToken(token: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.get(
        'https://chat.qwen.ai/api/v2/user',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            source: 'web',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )

      if (response.status === 200 && response.data?.data) {
        return {
          valid: true,
          userInfo: {
            name: response.data.data.name || response.data.data.email,
            email: response.data.data.email,
          },
        }
      }

      if (response.status === 401) {
        return { valid: false, error: 'Token expired or invalid' }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError
          ? error.message
          : 'Connection failed',
      }
    }
  }

  private static checkPerplexityToken(sessionToken: string): TokenCheckResult {
    if (!sessionToken) {
      return { valid: false, error: 'Session token is required' }
    }

    if (sessionToken.length < 100) {
      return { valid: false, error: 'Session token appears to be invalid (too short)' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Perplexity User',
      },
    }
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  private static async generateGLMSign(timestamp: string, nonce: string): Promise<string> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    return crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
  }

  static async fetchProviderModels(
    providerId: string
  ): Promise<{
    supportedModels: string[]
    modelMappings: Record<string, string>
  }> {
    const builtinConfig = getBuiltinProvider(providerId)
    
    if (!builtinConfig) {
      throw new Error(`Provider ${providerId} not found`)
    }

    if (!builtinConfig.modelsApiEndpoint) {
      throw new Error(`Provider ${providerId} does not support dynamic model fetching`)
    }

    try {
      const headers: Record<string, string> = {
        ...(builtinConfig.modelsApiHeaders || builtinConfig.headers),
      }

      const response = await axios.get(builtinConfig.modelsApiEndpoint, {
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }

      const models = response.data.data || []
      const supportedModels: string[] = []
      const modelMappings: Record<string, string> = {}

      for (const model of models) {
        if (model.name && model.id) {
          supportedModels.push(model.name)
          modelMappings[model.name] = model.id
        }
      }

      return { supportedModels, modelMappings }
    } catch (error) {
      console.error(`[ProviderChecker] Failed to fetch models for ${providerId}:`, error)
      throw error
    }
  }
}

export default ProviderChecker
