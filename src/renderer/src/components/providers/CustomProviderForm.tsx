import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AuthType, BuiltinProviderConfig, CredentialField, ProviderPreset } from '@/types/electron'

interface CustomProviderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CustomProviderFormData) => void
  initialData?: Partial<CustomProviderFormData>
  builtinProviders?: BuiltinProviderConfig[]
  customPresets?: ProviderPreset[]
  onResetBuiltinOverride?: (providerId: string) => Promise<void>
  onSaveAsPreset?: (data: CustomProviderFormData) => Promise<void>
}

export interface CustomProviderFormData {
  name: string
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers: Record<string, string>
  description: string
  supportedModels: string[]
  credentialFields: CredentialField[]
}

const authTypeOptions: AuthType[] = ['token', 'userToken', 'refresh_token', 'jwt', 'realUserID_token', 'tongyi_sso_ticket', 'cookie', 'oauth']
const authLabelKey: Record<AuthType, string> = {
  token: 'providers.authToken',
  userToken: 'providers.authUserToken',
  refresh_token: 'providers.authRefreshToken',
  jwt: 'providers.authJwt',
  realUserID_token: 'providers.authUserIdToken',
  tongyi_sso_ticket: 'providers.authSso',
  cookie: 'providers.authCookie',
  oauth: 'providers.authOAuth',
}

export function CustomProviderForm({ open, onOpenChange, onSubmit, initialData, builtinProviders = [], customPresets = [], onResetBuiltinOverride, onSaveAsPreset }: CustomProviderFormProps) {
  const { t } = useTranslation()
  const [selectedPresetId, setSelectedPresetId] = useState('custom')
  const [modelsText, setModelsText] = useState('')
  const [headersText, setHeadersText] = useState('{"Content-Type":"application/json"}')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formData, setFormData] = useState<CustomProviderFormData>({
    name: '', authType: 'token', apiEndpoint: '', chatPath: '', headers: { 'Content-Type': 'application/json' }, description: '', supportedModels: [], credentialFields: [],
  })

  useEffect(() => {
    const next = {
      name: initialData?.name || '',
      authType: initialData?.authType || 'token',
      apiEndpoint: initialData?.apiEndpoint || '',
      chatPath: initialData?.chatPath || '',
      headers: initialData?.headers || { 'Content-Type': 'application/json' },
      description: initialData?.description || '',
      supportedModels: initialData?.supportedModels || [],
      credentialFields: initialData?.credentialFields || [],
    }
    setFormData(next)
    setModelsText(next.supportedModels.join('\n'))
    setHeadersText(JSON.stringify(next.headers, null, 2))
  }, [initialData])

  const presetOptions = useMemo(() => ([
    ...builtinProviders.map((p) => ({ id: `builtin:${p.id}`, name: p.name, payload: p })),
    ...customPresets.map((p) => ({ id: p.presetId, name: p.name, payload: p })),
  ]), [builtinProviders, customPresets])

  const isBuiltinPreset = selectedPresetId.startsWith('builtin:')
  const selectedBuiltinProviderId = isBuiltinPreset ? selectedPresetId.replace('builtin:', '') : ''

  const applyPreset = (presetId: string) => {
    setSelectedPresetId(presetId)
    if (presetId === 'custom') return
    const payload: any = presetOptions.find((p) => p.id === presetId)?.payload
    if (!payload) return
    const next: CustomProviderFormData = {
      name: payload.name || '',
      authType: payload.authType || 'token',
      apiEndpoint: payload.apiEndpoint || '',
      chatPath: payload.chatPath || '',
      headers: payload.headers || {},
      description: payload.description || '',
      supportedModels: payload.supportedModels || [],
      credentialFields: payload.credentialFields || [],
    }
    setFormData(next)
    setModelsText(next.supportedModels.join('\n'))
    setHeadersText(JSON.stringify(next.headers, null, 2))
  }

  const validate = () => {
    const nextErrors: Record<string, string> = {}
    if (!formData.name.trim() && !isBuiltinPreset) nextErrors.name = t('providers.providerNameRequired')
    try { new URL(formData.apiEndpoint) } catch { nextErrors.apiEndpoint = t('providers.apiEndpointInvalid') }
    try {
      const parsed = JSON.parse(headersText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) nextErrors.headers = t('providers.headersInvalid')
      else formData.headers = parsed
    } catch {
      nextErrors.headers = t('providers.headersInvalid')
    }
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const submit = () => {
    const normalized: CustomProviderFormData = {
      ...formData,
      supportedModels: modelsText.split('\n').map((m) => m.trim()).filter(Boolean),
      headers: JSON.parse(headersText || '{}'),
    }
    if (!validate()) return
    onSubmit(normalized)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>{initialData ? t('providers.editProvider') : t('providers.createCustomProvider')}</DialogTitle>
          <DialogDescription>{t('providers.createCustomProviderDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2 max-h-[500px] overflow-auto">
          <div>
            <Label>{t('providers.providerPreset')}</Label>
            <Select value={selectedPresetId} onValueChange={applyPreset}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">{t('providers.customPreset')}</SelectItem>
                {presetOptions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {isBuiltinPreset && <Alert><AlertDescription>{t('providers.builtinPresetWarning')}</AlertDescription></Alert>}
          <div><Label>{t('providers.providerName')}</Label><Input value={formData.name} disabled={isBuiltinPreset} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />{errors.name && <p className="text-destructive text-xs">{errors.name}</p>}</div>
          <div><Label>{t('providers.authType')}</Label><Select value={formData.authType} disabled={isBuiltinPreset} onValueChange={(v: AuthType) => setFormData({ ...formData, authType: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{authTypeOptions.map((a) => <SelectItem key={a} value={a}>{t(authLabelKey[a])}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>{t('providers.apiEndpoint')}</Label><Input value={formData.apiEndpoint} onChange={(e) => setFormData({ ...formData, apiEndpoint: e.target.value })} />{errors.apiEndpoint && <p className="text-destructive text-xs">{errors.apiEndpoint}</p>}</div>
          <div><Label>{t('providers.chatPath')}</Label><Input value={formData.chatPath || ''} onChange={(e) => setFormData({ ...formData, chatPath: e.target.value })} /></div>
          <div><Label>{t('providers.headers')}</Label><Textarea rows={5} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />{errors.headers && <p className="text-destructive text-xs">{errors.headers}</p>}</div>
          <div><Label>{t('providers.supportedModels')}</Label><Textarea rows={4} value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="one model per line" /></div>
          <div><Label>{t('providers.description')}</Label><Textarea rows={3} value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} /></div>
        </div>
        <DialogFooter>
          {isBuiltinPreset && selectedBuiltinProviderId && onResetBuiltinOverride && <Button variant="outline" onClick={() => onResetBuiltinOverride(selectedBuiltinProviderId)}>{t('providers.resetBuiltinDefaults')}</Button>}
          {!isBuiltinPreset && onSaveAsPreset && <Button variant="outline" onClick={async () => { if (validate()) await onSaveAsPreset({ ...formData, supportedModels: modelsText.split('\n').map((m) => m.trim()).filter(Boolean), headers: JSON.parse(headersText || '{}') }) }}>{t('providers.saveAsPreset')}</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
