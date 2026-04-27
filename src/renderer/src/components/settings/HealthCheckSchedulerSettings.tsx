import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { Activity, AlertTriangle } from 'lucide-react'

interface SchedulerConfigState {
  enabled: boolean
  minIntervalHours: string
  maxIntervalHours: string
}

export function HealthCheckSchedulerSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [form, setForm] = useState<SchedulerConfigState>({
    enabled: false,
    minIntervalHours: '12',
    maxIntervalHours: '24',
  })

  useEffect(() => {
    void loadConfig()
  }, [])

  const validationError = useMemo(() => {
    const min = Number(form.minIntervalHours)
    const max = Number(form.maxIntervalHours)

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return t('settings.healthCheckScheduler.validation.invalidNumber')
    }
    if (min < 1 || max < 1) {
      return t('settings.healthCheckScheduler.validation.minTooSmall')
    }
    if (max < min) {
      return t('settings.healthCheckScheduler.validation.maxTooSmall')
    }
    return ''
  }, [form.maxIntervalHours, form.minIntervalHours, t])

  const showAggressiveWarning = useMemo(() => {
    const min = Number(form.minIntervalHours)
    return Number.isFinite(min) && min < 12
  }, [form.minIntervalHours])

  const loadConfig = async () => {
    try {
      const config = await window.electronAPI.providers.getHealthSchedulerConfig()
      setForm({
        enabled: config.enabled,
        minIntervalHours: String(config.minIntervalHours),
        maxIntervalHours: String(config.maxIntervalHours),
      })
      setRunning(config.running)
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('common.error'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    if (validationError) {
      return
    }

    setIsSaving(true)
    try {
      const minIntervalHours = Math.floor(Number(form.minIntervalHours))
      const maxIntervalHours = Math.floor(Number(form.maxIntervalHours))
      const updated = await window.electronAPI.providers.updateHealthSchedulerConfig({
        enabled: form.enabled,
        minIntervalHours,
        maxIntervalHours,
      })
      setRunning(updated.running)
      setForm({
        enabled: updated.enabled,
        minIntervalHours: String(updated.minIntervalHours),
        maxIntervalHours: String(updated.maxIntervalHours),
      })
      toast({
        title: t('common.success'),
        description: t('settings.healthCheckScheduler.saveSuccess'),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('common.error'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-center text-muted-foreground">{t('common.loading')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          {t('settings.healthCheckScheduler.title')}
        </CardTitle>
        <CardDescription>{t('settings.healthCheckScheduler.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="health-check-enabled">{t('settings.healthCheckScheduler.enabled')}</Label>
            <p className="text-sm text-muted-foreground">{running ? t('settings.healthCheckScheduler.running') : t('settings.healthCheckScheduler.stopped')}</p>
          </div>
          <Switch
            id="health-check-enabled"
            checked={form.enabled}
            onCheckedChange={(enabled) => setForm(prev => ({ ...prev, enabled }))}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="scheduler-min-interval">{t('settings.healthCheckScheduler.minIntervalHours')}</Label>
            <Input
              id="scheduler-min-interval"
              type="number"
              min={1}
              step={1}
              value={form.minIntervalHours}
              onChange={(event) => setForm(prev => ({ ...prev, minIntervalHours: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="scheduler-max-interval">{t('settings.healthCheckScheduler.maxIntervalHours')}</Label>
            <Input
              id="scheduler-max-interval"
              type="number"
              min={1}
              step={1}
              value={form.maxIntervalHours}
              onChange={(event) => setForm(prev => ({ ...prev, maxIntervalHours: event.target.value }))}
            />
          </div>
        </div>

        <p className="text-sm text-muted-foreground">{t('settings.healthCheckScheduler.helper')}</p>

        {showAggressiveWarning && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{t('settings.healthCheckScheduler.aggressiveWarning')}</AlertDescription>
          </Alert>
        )}

        {validationError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={Boolean(validationError) || isSaving}>
            {isSaving ? t('common.loading') : t('settings.healthCheckScheduler.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
