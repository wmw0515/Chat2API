/**
 * Model Editor Component
 * Manages model catalog for a provider
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { useProvidersStore } from '@/stores/providersStore'
import type { EffectiveModel } from '@/types/electron'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, RotateCcw, AlertTriangle, Loader2 } from 'lucide-react'

interface ModelEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerName: string
}

export function ModelEditor({
  open,
  onOpenChange,
  providerId,
  providerName,
}: ModelEditorProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const setModelsLastUpdated = useProvidersStore((state) => state.setModelsLastUpdated)

  const [models, setModels] = useState<EffectiveModel[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newActualModelId, setNewActualModelId] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [checkingModel, setCheckingModel] = useState<string | null>(null)
  const [isCheckingAllModels, setIsCheckingAllModels] = useState(false)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<{
    supported: boolean
    discoveryEnabled?: boolean
    lastSyncedAt?: number
    lastSyncStatus?: string
    lastSyncError?: string
  } | null>(null)

  const [schedulerStatus, setSchedulerStatus] = useState<{
    enabled: boolean
    minIntervalHours: number
    maxIntervalHours: number
    running: boolean
    lastScheduledRunAt?: number
    nextScheduledRunAt?: number
  } | null>(null)

  useEffect(() => {
    if (open) {
      loadModels()
      loadSyncStatus()
      loadSchedulerStatus()
    }
  }, [open, providerId])

  const loadModels = async () => {
    setIsLoading(true)
    try {
      const effectiveModels = await window.electronAPI.providers.getEffectiveModels(providerId)
      setModels(effectiveModels || [])
    } catch (error) {
      console.error('Failed to load models:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Failed to load models',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const sortedModels = [...models].sort((a, b) => {
    const sourcePriority: Record<NonNullable<EffectiveModel['source']>, number> = {
      manual: 0,
      static: 1,
      discovered: 2,
    }
    const sourceA = a.source ?? 'static'
    const sourceB = b.source ?? 'static'
    const sourceDiff = sourcePriority[sourceA] - sourcePriority[sourceB]
    if (sourceDiff !== 0) return sourceDiff
    return a.displayName.localeCompare(b.displayName)
  })
  const isDiscoveryEnabled = syncStatus?.discoveryEnabled === true

  const loadSyncStatus = async () => {
    try {
      const status = await window.electronAPI.providers.getModelSyncStatus(providerId)
      setSyncStatus(status)
    } catch {
      setSyncStatus(null)
    }
  }


  const loadSchedulerStatus = async () => {
    try {
      const status = await window.electronAPI.providers.getHealthSchedulerStatus()
      setSchedulerStatus(status)
    } catch {
      setSchedulerStatus(null)
    }
  }
  const handleSyncModels = async () => {
    setIsSyncing(true)
    try {
      const result = await window.electronAPI.providers.syncModels(providerId)
      await loadSyncStatus()
      if (result.success) {
        await loadModels()
        setModelsLastUpdated(Date.now())
        toast({ title: t('common.success'), description: t('modelEditor.syncSuccess') })
      } else {
        throw new Error(result.error || t('modelEditor.syncError'))
      }
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.syncError'),
        variant: 'destructive',
      })
    } finally {
      setIsSyncing(false)
    }
  }

  const handleAddModel = async () => {
    if (!newDisplayName.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameRequired'),
        variant: 'destructive',
      })
      return
    }

    if (!newActualModelId.trim()) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.idRequired'),
        variant: 'destructive',
      })
      return
    }

    if (models.some(m => m.displayName === newDisplayName.trim())) {
      toast({
        title: t('common.error'),
        description: t('modelEditor.nameExists'),
        variant: 'destructive',
      })
      return
    }

    setIsAdding(true)
    try {
      const result = await window.electronAPI.providers.addCustomModel(providerId, {
        displayName: newDisplayName.trim(),
        actualModelId: newActualModelId.trim(),
      })

      if (result.success) {
        setModels(result.models)
        setNewDisplayName('')
        setNewActualModelId('')
        setIsAddDialogOpen(false)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.addSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to add model')
      }
    } catch (error) {
      console.error('Failed to add model:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.addError'),
        variant: 'destructive',
      })
    } finally {
      setIsAdding(false)
    }
  }

  const handleRemoveModel = async (modelName: string) => {
    setDeletingModel(modelName)
    try {
      const result = await window.electronAPI.providers.removeModel(providerId, modelName)

      if (result.success) {
        setModels(result.models)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.removeSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to remove model')
      }
    } catch (error) {
      console.error('Failed to remove model:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.removeError'),
        variant: 'destructive',
      })
    } finally {
      setDeletingModel(null)
    }
  }

  const handleResetModels = async () => {
    if (!window.confirm(t('modelEditor.confirmReset'))) {
      return
    }

    setIsResetting(true)
    try {
      const result = await window.electronAPI.providers.resetModels(providerId)

      if (result.success) {
        setModels(result.models)
        setModelsLastUpdated(Date.now())
        toast({
          title: t('common.success'),
          description: t('modelEditor.resetSuccess'),
        })
      } else {
        throw new Error(result.error || 'Failed to reset models')
      }
    } catch (error) {
      console.error('Failed to reset models:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('modelEditor.resetError'),
        variant: 'destructive',
      })
    } finally {
      setIsResetting(false)
    }
  }

  const getCheckToastMessage = (status: string) => {
    switch (status) {
      case 'available':
        return '模型可用'
      case 'credential_error':
        return '凭证失效'
      case 'model_invalid':
        return '模型无效'
      case 'connection_error':
        return '连接异常'
      default:
        return '未知错误'
    }
  }

  const handleCheckModel = async (modelName: string) => {
    setCheckingModel(modelName)
    try {
      const result = await window.electronAPI.providers.checkModel(providerId, modelName)
      await loadModels()
      setModelsLastUpdated(Date.now())
      toast({
        title: result.success ? t('common.success') : t('common.error'),
        description: getCheckToastMessage(result.status),
        variant: result.success ? 'default' : 'destructive',
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Check failed',
        variant: 'destructive',
      })
    } finally {
      setCheckingModel(null)
    }
  }

  const handleCheckAllModels = async () => {
    setIsCheckingAllModels(true)
    try {
      const result = await window.electronAPI.providers.checkAllModels(providerId)
      await loadModels()
      setModelsLastUpdated(Date.now())
      toast({
        title: t('common.success'),
        description: `已检测 ${result.checked} 个模型，可用 ${result.available} 个`,
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Check failed',
        variant: 'destructive',
      })
    } finally {
      setIsCheckingAllModels(false)
    }
  }

  const renderModelTable = (modelList: EffectiveModel[]) => {
    if (modelList.length === 0) {
      return (
        <div className="text-center py-8 text-muted-foreground border rounded-lg">
          <p className="text-sm">{t('modelEditor.noModels')}</p>
        </div>
      )
    }

    const formatHealthStatus = (status?: string) => {
      switch (status) {
        case 'available':
          return '有效'
        case 'credential_error':
          return '凭证失效'
        case 'model_invalid':
          return '模型无效'
        case 'connection_error':
          return '连接异常'
        case 'unknown_error':
          return '未知错误'
        default:
          return '未知'
      }
    }

    const formatTimestamp = (value?: number) => {
      if (!value) return '-'
      return new Date(value).toLocaleString()
    }

    return (
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('modelEditor.displayName')}</TableHead>
              <TableHead>{t('modelEditor.actualModelId')}</TableHead>
              <TableHead>{t('modelEditor.healthStatus')}</TableHead>
              <TableHead>{t('modelEditor.lastCheckedAt')}</TableHead>
              <TableHead>{t('modelEditor.lastErrorMessage')}</TableHead>
              <TableHead>{t('modelEditor.source')}</TableHead>
              <TableHead className="w-[180px]">{t('modelEditor.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modelList.map((model) => {
              const isDeleting = deletingModel === model.displayName
              const showBoth = model.displayName !== model.actualModelId

              return (
                <TableRow key={model.displayName}>
                  <TableCell>
                    <code className="text-sm">{model.displayName}</code>
                  </TableCell>
                  <TableCell>
                    <code className="text-sm">
                      {showBoth ? model.actualModelId : model.displayName}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {formatHealthStatus(model.runtimeHealth?.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(model.runtimeHealth?.lastCheckedAt)}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={model.runtimeHealth?.lastErrorMessage || ''}>
                    {model.runtimeHealth?.lastErrorMessage || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {model.source ? t(`modelEditor.source.${model.source}`) : t('modelEditor.source.static')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCheckModel(model.displayName)}
                        disabled={Boolean(checkingModel) || isCheckingAllModels}
                      >
                        {checkingModel === model.displayName ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                        Check
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (window.confirm(t('modelEditor.confirmDelete'))) {
                            handleRemoveModel(model.displayName)
                          }
                        }}
                        disabled={isDeleting || Boolean(checkingModel) || isCheckingAllModels}
                        className="h-8 w-8 text-destructive hover:text-destructive"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('modelEditor.title', { name: providerName })}
            </DialogTitle>
            <DialogDescription>
              {t('modelEditor.manualWorkflowHint')}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6 mt-4">
              {renderModelTable(sortedModels)}


              <div className="rounded-md border p-3 text-xs text-muted-foreground space-y-1">
                <div className="font-medium text-foreground">Scheduled health checks</div>
                <div>Status: {schedulerStatus?.enabled ? (schedulerStatus.running ? 'enabled' : 'enabled (idle)') : 'disabled'}</div>
                <div>Interval: {schedulerStatus?.minIntervalHours ?? 12}-{schedulerStatus?.maxIntervalHours ?? 24} hours</div>
                <div>Last scheduled run: {schedulerStatus?.lastScheduledRunAt ? new Date(schedulerStatus.lastScheduledRunAt).toLocaleString() : '-'}</div>
                <div>Next scheduled run: {schedulerStatus?.nextScheduledRunAt ? new Date(schedulerStatus.nextScheduledRunAt).toLocaleString() : '-'}</div>
              </div>

              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t('modelEditor.warningMessage')}
                </AlertDescription>
              </Alert>

              {!isDiscoveryEnabled ? (
                <p className="text-xs text-muted-foreground">{t('modelEditor.discoveryDisabledNote')}</p>
              ) : null}
            </div>
          )}

          <DialogFooter className="mt-6">
            <div className="flex gap-2 w-full justify-between">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsAddDialogOpen(true)}
                  disabled={isLoading}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {t('modelEditor.addModel')}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleResetModels}
                  disabled={isLoading || isResetting || Boolean(checkingModel) || isCheckingAllModels}
                >
                  {isResetting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4 mr-2" />
                  )}
                  {t('modelEditor.resetDefault')}
                </Button>
                {isDiscoveryEnabled ? (
                  <Button
                    variant="outline"
                    onClick={handleSyncModels}
                    disabled={isLoading || isSyncing || (syncStatus ? !syncStatus.supported : false)}
                  >
                    {isSyncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {t('modelEditor.syncModels')}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={handleCheckAllModels}
                  disabled={isLoading || isCheckingAllModels || Boolean(checkingModel)}
                >
                  {isCheckingAllModels ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Check all models
                </Button>
              </div>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('modelEditor.cancel')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('modelEditor.addDialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('modelEditor.displayNameLabel')}</Label>
              <Input
                id="displayName"
                placeholder={t('modelEditor.displayNamePlaceholder')}
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.displayNameHelp')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="actualModelId">{t('modelEditor.actualIdLabel')}</Label>
              <Input
                id="actualModelId"
                placeholder={t('modelEditor.actualIdPlaceholder')}
                value={newActualModelId}
                onChange={(e) => setNewActualModelId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('modelEditor.actualIdHelp')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddDialogOpen(false)
                setNewDisplayName('')
                setNewActualModelId('')
              }}
              disabled={isAdding}
            >
              {t('modelEditor.cancel')}
            </Button>
            <Button onClick={handleAddModel} disabled={isAdding}>
              {isAdding ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('common.loading')}
                </>
              ) : (
                t('modelEditor.add')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default ModelEditor
