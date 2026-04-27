import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AuthType, CredentialField } from '@/types/electron'

interface CustomProviderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CustomProviderFormData) => void
  initialData?: Partial<CustomProviderFormData>
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

export function CustomProviderForm({ open, onOpenChange, onSubmit, initialData }: CustomProviderFormProps) {
  const { t } = useTranslation()
  const [modelsText, setModelsText] = useState('')
  const [headersText, setHeadersText] = useState('{"Content-Type":"application/json"}')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formData, setFormData] = useState<CustomProviderFormData>({
    name: '', authType: 'token', apiEndpoint: '', chatPath: '', headers: { 'Content-Type': 'application/json' }, description: '', supportedModels: [], credentialFields: [],
  })

  const resolvedInitialData = useMemo(() => ({
    name: initialData?.name || '',
    authType: initialData?.authType || 'token',
    apiEndpoint: initialData?.apiEndpoint || '',
    chatPath: initialData?.chatPath || '',
    headers: initialData?.headers || { 'Content-Type': 'application/json' },
    description: initialData?.description || '',
    supportedModels: initialData?.supportedModels || [],
    credentialFields: initialData?.credentialFields || [],
  }), [initialData])

  useEffect(() => {
    const next = {
      ...resolvedInitialData,
    }
    setFormData(next)
    setModelsText(next.supportedModels.join('\n'))
    setHeadersText(JSON.stringify(next.headers, null, 2))
    setErrors({})
  }, [open, resolvedInitialData])

  const validate = () => {
    const nextErrors: Record<string, string> = {}
    if (!formData.name.trim()) nextErrors.name = t('providers.providerNameRequired')
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
          <Alert><AlertDescription>{t('providers.customProviderFormNotice')}</AlertDescription></Alert>
          <div><Label>{t('providers.providerName')}</Label><Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />{errors.name && <p className="text-destructive text-xs">{errors.name}</p>}</div>
          <div><Label>{t('providers.authType')}</Label><Select value={formData.authType} onValueChange={(v: AuthType) => setFormData({ ...formData, authType: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{authTypeOptions.map((a) => <SelectItem key={a} value={a}>{t(authLabelKey[a])}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>{t('providers.apiEndpoint')}</Label><Input value={formData.apiEndpoint} onChange={(e) => setFormData({ ...formData, apiEndpoint: e.target.value })} />{errors.apiEndpoint && <p className="text-destructive text-xs">{errors.apiEndpoint}</p>}</div>
          <div><Label>{t('providers.chatPath')}</Label><Input value={formData.chatPath || ''} onChange={(e) => setFormData({ ...formData, chatPath: e.target.value })} /></div>
          <div><Label>{t('providers.headers')}</Label><Textarea rows={5} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />{errors.headers && <p className="text-destructive text-xs">{errors.headers}</p>}</div>
          <div><Label>{t('providers.supportedModels')}</Label><Textarea rows={4} value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="one model per line" /></div>
          <div><Label>{t('providers.description')}</Label><Textarea rows={3} value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
