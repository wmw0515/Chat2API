import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CredentialField, Provider, ProviderConfigOverride } from '@/types/electron'
import { normalizeCredentialFields, sortCredentialFields } from '../../../../shared/credentialFields'

interface BuiltinProviderConfigDialogProps {
  open: boolean
  provider: Provider | null
  hasOverride: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (override: ProviderConfigOverride) => void
  onReset: () => void
}

interface FormState {
  apiEndpoint: string
  chatPath: string
  headersText: string
  description: string
  supportedModelsText: string
  credentialFields: CredentialField[]
}

export function BuiltinProviderConfigDialog({
  open,
  provider,
  hasOverride,
  onOpenChange,
  onSubmit,
  onReset,
}: BuiltinProviderConfigDialogProps) {
  const { t, i18n } = useTranslation()
  const isMiniMaxProvider = provider?.id === 'minimax'
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formState, setFormState] = useState<FormState>({
    apiEndpoint: '',
    chatPath: '',
    headersText: '{"Content-Type":"application/json"}',
    description: '',
    supportedModelsText: '',
    credentialFields: [],
  })

  const canEditSupportedModels = Boolean(provider?.supportedModels?.length)

  const initialData = useMemo(() => ({
    apiEndpoint: provider?.apiEndpoint || '',
    chatPath: provider?.chatPath || '',
    headersText: JSON.stringify(provider?.headers || { 'Content-Type': 'application/json' }, null, 2),
    description: provider?.description || '',
    supportedModelsText: provider?.supportedModels?.join('\n') || '',
    credentialFields: sortCredentialFields(normalizeCredentialFields(provider?.credentialFields || [])).map((field) => {
      if (!isMiniMaxProvider || !i18n.language.startsWith('zh')) {
        return field
      }

      const minimaxFieldLocales: Partial<Record<string, Pick<CredentialField, 'label' | 'helpText'>>> = {
        token: {
          label: 'JWT Token',
          helpText: '支持直接填写完整 JWT Token；也支持 realUserID+JWTToken 格式。若填写了 Real User ID，则优先使用 Real User ID 字段。',
        },
        realUserID: {
          label: 'Real User ID（可选）',
          helpText: '可选：填写成功 send_msg 请求 URL 中的 user_id 参数。若不填写，将尝试从 JWT 中解析。',
        },
        webUuid: {
          label: 'Web UUID（可选）',
          helpText: '可选：填写成功 send_msg 请求 URL 中的 uuid 参数。若不填写，将使用自动生成的 uuid。',
        },
        cookies: {
          label: 'Cookies（可选）',
          helpText: '当前 MiniMax send_msg 默认不发送 Cookie。仅在后续调试确认为必需时填写。',
        },
        chatId: {
          label: 'Chat ID（可选）',
          helpText: '当前 MiniMax send_msg 默认不需要 Chat ID。仅在后续调试确认为必需时填写。',
        },
      }

      const localized = minimaxFieldLocales[field.name]
      if (!localized) {
        return field
      }

      return {
        ...field,
        label: localized.label ?? field.label,
        helpText: localized.helpText ?? field.helpText,
      }
    }),
  }), [i18n.language, isMiniMaxProvider, provider])

  useEffect(() => {
    setFormState(initialData)
    setErrors({})
  }, [open, initialData])

  const validate = () => {
    const nextErrors: Record<string, string> = {}

    try {
      new URL(formState.apiEndpoint)
    } catch {
      nextErrors.apiEndpoint = t('providers.apiEndpointInvalid')
    }

    try {
      const parsed = JSON.parse(formState.headersText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        nextErrors.headers = t('providers.headersInvalid')
      }
    } catch {
      nextErrors.headers = t('providers.headersInvalid')
    }

    setErrors(nextErrors)
    if (formState.credentialFields.some((field) => !field.name.trim())) {
      nextErrors.credentialFields = t('providers.credentialFieldNameRequired')
    }
    const names = formState.credentialFields.map((field) => field.name.trim())
    if (new Set(names).size !== names.length) {
      nextErrors.credentialFields = t('providers.credentialFieldNameDuplicate')
    }
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const submit = () => {
    if (!provider) return
    if (!validate()) return

    const payload: ProviderConfigOverride = {
      apiEndpoint: formState.apiEndpoint,
      chatPath: formState.chatPath || undefined,
      headers: JSON.parse(formState.headersText || '{}'),
      description: formState.description || undefined,
    }

    if (canEditSupportedModels) {
      payload.supportedModels = formState.supportedModelsText
        .split('\n')
        .map((m) => m.trim())
        .filter(Boolean)
    }
    payload.credentialFields = sortCredentialFields(normalizeCredentialFields(formState.credentialFields))

    onSubmit(payload)
  }

  const updateCredentialField = (index: number, updates: Partial<CredentialField>) => {
    setFormState((prev) => {
      const next = [...prev.credentialFields]
      next[index] = { ...next[index], ...updates }
      return { ...prev, credentialFields: next }
    })
  }

  const addCredentialField = () => {
    setFormState((prev) => ({
      ...prev,
      credentialFields: [
        ...prev.credentialFields,
        {
          name: '',
          label: '',
          type: 'text',
          required: false,
          secret: false,
          order: 10000,
          sanitize: 'none',
          enabled: true,
        },
      ],
    }))
  }

  const warningText = i18n.language.startsWith('zh')
    ? '这是内置供应商的高级配置。填写错误可能导致该供应商全部模型调用失败，可随时恢复默认。'
    : 'This is advanced configuration for a built-in provider. Incorrect values may break all model calls for this provider. You can restore defaults.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>{t('providers.editConfig')}</DialogTitle>
          <DialogDescription>
            {provider?.name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2 max-h-[520px] overflow-auto">
          <Alert>
            <AlertDescription>{warningText}</AlertDescription>
          </Alert>

          <div>
            <Label>{t('providers.apiEndpoint')}</Label>
            <Input
              value={formState.apiEndpoint}
              onChange={(e) => setFormState((prev) => ({ ...prev, apiEndpoint: e.target.value }))}
            />
            {errors.apiEndpoint && <p className="text-destructive text-xs">{errors.apiEndpoint}</p>}
          </div>

          <div>
            <Label>{t('providers.chatPath')}</Label>
            <Input
              value={formState.chatPath}
              onChange={(e) => setFormState((prev) => ({ ...prev, chatPath: e.target.value }))}
            />
          </div>

          <div>
            <Label>{t('providers.headers')}</Label>
            <Textarea
              rows={5}
              value={formState.headersText}
              onChange={(e) => setFormState((prev) => ({ ...prev, headersText: e.target.value }))}
            />
            {errors.headers && <p className="text-destructive text-xs">{errors.headers}</p>}
          </div>

          <div>
            <Label>{t('providers.description')}</Label>
            <Textarea
              rows={3}
              value={formState.description}
              onChange={(e) => setFormState((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>

          {canEditSupportedModels && (
            <div>
              <Label>{t('providers.supportedModels')}</Label>
              <Textarea
                rows={4}
                value={formState.supportedModelsText}
                onChange={(e) => setFormState((prev) => ({ ...prev, supportedModelsText: e.target.value }))}
              />
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t('providers.dynamicCredentialEditorTitle')}</Label>
              <Button type="button" variant="outline" size="sm" onClick={addCredentialField}>{t('providers.dynamicCredentialAddField')}</Button>
            </div>
            <div className="space-y-3">
              {formState.credentialFields.map((field, index) => (
                <div key={`${field.name || 'new'}-${index}`} className="rounded border p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Input placeholder={t('providers.dynamicCredentialFieldName')} value={field.name} onChange={(e) => updateCredentialField(index, { name: e.target.value })} />
                    <Input placeholder={t('providers.dynamicCredentialFieldLabel')} value={field.label} onChange={(e) => updateCredentialField(index, { label: e.target.value })} />
                    <Select value={field.type} onValueChange={(value: CredentialField['type']) => updateCredentialField(index, { type: value })}>
                      <SelectTrigger><SelectValue placeholder={t('providers.dynamicCredentialFieldType')} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text">{t('providers.dynamicCredentialType.text')}</SelectItem>
                        <SelectItem value="password">{t('providers.dynamicCredentialType.password')}</SelectItem>
                        <SelectItem value="textarea">{t('providers.dynamicCredentialType.textarea')}</SelectItem>
                        <SelectItem value="number">{t('providers.dynamicCredentialType.number')}</SelectItem>
                        <SelectItem value="select">{t('providers.dynamicCredentialType.select')}</SelectItem>
                        <SelectItem value="json">{t('providers.dynamicCredentialType.json')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input type="number" placeholder={t('providers.dynamicCredentialFieldOrder')} value={field.order ?? 10000} onChange={(e) => updateCredentialField(index, { order: Number(e.target.value) || 10000 })} />
                    <Input className="col-span-2" placeholder={t('providers.dynamicCredentialFieldHelpText')} value={field.helpText || ''} onChange={(e) => updateCredentialField(index, { helpText: e.target.value })} />
                    <p className="col-span-2 text-xs text-muted-foreground">{t('providers.dynamicCredentialFieldOrderHint')}</p>
                    <Select value={field.sanitize || 'none'} onValueChange={(value: CredentialField['sanitize']) => updateCredentialField(index, { sanitize: value })}>
                      <SelectTrigger><SelectValue placeholder={t('providers.dynamicCredentialFieldSanitize')} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('providers.dynamicCredentialSanitize.none')}</SelectItem>
                        <SelectItem value="singleLine">{t('providers.dynamicCredentialSanitize.singleLine')}</SelectItem>
                        <SelectItem value="cookie">{t('providers.dynamicCredentialSanitize.cookie')}</SelectItem>
                        <SelectItem value="numeric">{t('providers.dynamicCredentialSanitize.numeric')}</SelectItem>
                        <SelectItem value="jwt">{t('providers.dynamicCredentialSanitize.jwt')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input placeholder={t('providers.dynamicCredentialFieldPlaceholder')} value={field.placeholder || ''} onChange={(e) => updateCredentialField(index, { placeholder: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <label className="flex items-center gap-2"><Switch checked={field.required} onCheckedChange={(checked) => updateCredentialField(index, { required: Boolean(checked) })} />{t('providers.dynamicCredentialFieldRequired')}</label>
                    <label className="flex items-center gap-2"><Switch checked={field.secret ?? false} onCheckedChange={(checked) => updateCredentialField(index, { secret: Boolean(checked) })} />{t('providers.dynamicCredentialFieldSecret')}</label>
                    <label className="flex items-center gap-2"><Switch checked={field.enabled !== false} onCheckedChange={(checked) => updateCredentialField(index, { enabled: Boolean(checked) })} />{t('providers.dynamicCredentialFieldEnabled')}</label>
                    <Button type="button" variant="destructive" size="sm" onClick={() => {
                      const isBuiltin = Boolean(provider?.credentialFields?.some((builtinField) => builtinField.name === field.name))
                      if (isBuiltin) {
                        updateCredentialField(index, { enabled: false })
                        return
                      }
                      setFormState((prev) => ({ ...prev, credentialFields: prev.credentialFields.filter((_, i) => i !== index) }))
                    }}>{t('providers.dynamicCredentialDeleteOrDisable')}</Button>
                  </div>
                </div>
              ))}
            </div>
            {errors.credentialFields && <p className="text-destructive text-xs">{errors.credentialFields}</p>}
          </div>
        </div>

        <DialogFooter>
          {hasOverride && (
            <Button variant="outline" onClick={onReset}>
              {t('providers.resetDefaults')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BuiltinProviderConfigDialog
