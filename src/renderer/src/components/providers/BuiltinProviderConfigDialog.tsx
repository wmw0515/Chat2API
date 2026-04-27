import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Provider, ProviderConfigOverride } from '@/types/electron'

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
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formState, setFormState] = useState<FormState>({
    apiEndpoint: '',
    chatPath: '',
    headersText: '{"Content-Type":"application/json"}',
    description: '',
    supportedModelsText: '',
  })

  const canEditSupportedModels = Boolean(provider?.supportedModels?.length)

  const initialData = useMemo(() => ({
    apiEndpoint: provider?.apiEndpoint || '',
    chatPath: provider?.chatPath || '',
    headersText: JSON.stringify(provider?.headers || { 'Content-Type': 'application/json' }, null, 2),
    description: provider?.description || '',
    supportedModelsText: provider?.supportedModels?.join('\n') || '',
  }), [provider])

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

    onSubmit(payload)
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
