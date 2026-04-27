import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useSettingsStore, LogLevel } from '@/stores/settingsStore'
import { useToast } from '@/hooks/use-toast'
import { Database, Download, Upload, Trash2, RotateCcw, AlertTriangle } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export function DataManagement() {
  const { t } = useTranslation()
  const { logLevel, setLogLevel, logRetentionDays, setLogRetentionDays, maxLogs, setMaxLogs } = useSettingsStore()
  const { toast } = useToast()
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [importPayload, setImportPayload] = useState('')
  const [isImportingProviders, setIsImportingProviders] = useState(false)

  const handleImportProviderAccountFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      JSON.parse(text)
      setImportPayload(text)
      toast({
        title: t('common.success'),
        description: 'Loaded JSON file into import textarea.',
      })
    } catch {
      toast({
        title: t('common.error'),
        description: 'Invalid JSON file. Please choose a valid export file.',
        variant: 'destructive',
      })
    } finally {
      event.target.value = ''
    }
  }

  const handleExportConfig = async () => {
    setIsExporting(true)
    try {
      const config = {
        version: '1.1.2',
        exportedAt: new Date().toISOString(),
        settings: localStorage.getItem('chat2api-settings'),
      }
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `chat2api-config-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({
        title: t('common.success'),
        description: t('settings.exportSuccess'),
      })
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.exportFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    try {
      const text = await file.text()
      const config = JSON.parse(text)
      if (config.settings) {
        localStorage.setItem('chat2api-settings', config.settings)
        toast({
          title: t('common.success'),
          description: t('settings.importSuccess'),
        })
        setTimeout(() => {
          window.location.reload()
        }, 1500)
      }
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.importFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      event.target.value = ''
    }
  }

  const handleClearCache = async () => {
    setIsClearing(true)
    try {
      sessionStorage.clear()
      toast({
        title: t('common.success'),
        description: t('settings.cacheCleared'),
      })
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.cacheClearFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsClearing(false)
    }
  }

  const handleResetApp = async () => {
    setIsResetting(true)
    try {
      localStorage.clear()
      sessionStorage.clear()
      
      if (window.electronAPI?.store?.clearAll) {
        await window.electronAPI.store.clearAll()
      }
      
      toast({
        title: t('common.success'),
        description: t('settings.resetSuccess'),
      })
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.resetFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsResetting(false)
    }
  }

  const handleExportProviderAccountConfig = async () => {
    if (!window.electronAPI?.dashboard?.exportData) {
      toast({
        title: t('common.error'),
        description: 'Dashboard export is not available in this runtime.',
        variant: 'destructive',
      })
      return
    }

    setIsExporting(true)
    try {
      const payload = await window.electronAPI.dashboard.exportData({ includeCredentials })
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `chat2api-provider-account-backup-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({
        title: t('common.success'),
        description: includeCredentials
          ? 'Exported provider/account backup with credentials.'
          : 'Exported provider/account backup without credentials.',
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Failed to export provider/account backup.',
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportProviderAccountConfig = async (dryRun: boolean) => {
    if (!window.electronAPI?.dashboard?.importData) {
      toast({
        title: t('common.error'),
        description: 'Dashboard import is not available in this runtime.',
        variant: 'destructive',
      })
      return
    }

    setIsImportingProviders(true)
    try {
      const parsed = JSON.parse(importPayload)
      const result = await window.electronAPI.dashboard.importData(parsed, { dryRun })
      const summary = result.summary
      toast({
        title: dryRun ? 'Dry run completed' : t('common.success'),
        description: [
          `Providers: +${summary.providers.created.length} / ~${summary.providers.updated.length} / skip ${summary.providers.skipped.length}`,
          `Accounts: +${summary.accounts.created.length} / ~${summary.accounts.updated.length} / skip ${summary.accounts.skipped.length}`,
        ].join(' | '),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : 'Failed to import provider/account backup.',
        variant: 'destructive',
      })
    } finally {
      setIsImportingProviders(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Database className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.logSettings')}
          </CardTitle>
          <CardDescription>{t('settings.logRetentionDays')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2 p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <Label htmlFor="log-level">{t('settings.logLevel')}</Label>
              <Select value={logLevel} onValueChange={(value) => setLogLevel(value as LogLevel)}>
                <SelectTrigger id="log-level">
                  <SelectValue placeholder={t('settings.selectLogLevel')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debug">Debug</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warn">Warn</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('settings.logLevelHelp')}</p>
            </div>
            <div className="space-y-2 p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <Label htmlFor="log-retention">{t('settings.logRetentionDays')}</Label>
              <Input
                id="log-retention"
                type="number"
                min={1}
                max={365}
                value={logRetentionDays}
                onChange={(e) => setLogRetentionDays(parseInt(e.target.value) || 30)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.logRetentionHelp')}</p>
            </div>
            <div className="space-y-2 p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <Label htmlFor="max-logs">{t('settings.maxLogs')}</Label>
              <Input
                id="max-logs"
                type="number"
                min={100}
                max={100000}
                value={maxLogs}
                onChange={(e) => setMaxLogs(parseInt(e.target.value) || 10000)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.maxLogsHelp')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Upload className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            Provider/Account Backup
          </CardTitle>
          <CardDescription>
            Export and import providers/accounts for migration or backup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant={includeCredentials ? 'destructive' : 'default'}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Credential export warning</AlertTitle>
            <AlertDescription>
              If you enable credential export, the backup file contains active tokens and should be treated like a password vault.
            </AlertDescription>
          </Alert>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeCredentials}
              onChange={(event) => setIncludeCredentials(event.target.checked)}
            />
            Include account credentials in export (sensitive)
          </label>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={includeCredentials ? 'destructive' : 'outline'}
              onClick={handleExportProviderAccountConfig}
              disabled={isExporting}
            >
              <Download className="mr-2 h-4 w-4" />
              {isExporting ? 'Exporting backup...' : 'Export provider/account backup'}
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-account-import-json">Import JSON payload</Label>
            <div className="relative inline-flex">
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleImportProviderAccountFile}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <Button variant="outline" type="button">
                <Upload className="mr-2 h-4 w-4" />
                Import from JSON file
              </Button>
            </div>
            <Textarea
              id="provider-account-import-json"
              value={importPayload}
              onChange={(event) => setImportPayload(event.target.value)}
              placeholder="Paste exported JSON payload here"
              rows={10}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={isImportingProviders || !importPayload.trim()}
              onClick={() => handleImportProviderAccountConfig(true)}
            >
              {isImportingProviders ? 'Running dry run...' : 'Dry run import'}
            </Button>
            <Button
              disabled={isImportingProviders || !importPayload.trim()}
              onClick={() => handleImportProviderAccountConfig(false)}
            >
              {isImportingProviders ? 'Importing...' : 'Import now'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Download className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.dataManagement')}
          </CardTitle>
          <CardDescription>{t('settings.dataManagementDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleExportConfig}
              disabled={isExporting}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              {isExporting ? t('settings.exporting') : t('settings.exportConfig')}
            </Button>
            <div className="relative">
              <input
                type="file"
                accept=".json"
                onChange={handleImportConfig}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isImporting}
              />
              <Button
                variant="outline"
                disabled={isImporting}
                className="flex items-center gap-2"
              >
                <Upload className="h-4 w-4" />
                {isImporting ? t('settings.importing') : t('settings.importConfig')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {t('settings.dangerZone')}
          </CardTitle>
          <CardDescription>{t('settings.dangerZoneDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleClearCache}
              disabled={isClearing}
              className="flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {isClearing ? t('settings.clearing') : t('settings.clearCache')}
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" className="flex items-center gap-2">
                  <RotateCcw className="h-4 w-4" />
                  {t('settings.resetApp')}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('settings.confirmReset')}</DialogTitle>
                  <DialogDescription>
                    {t('settings.confirmResetDesc')}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => {}}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleResetApp}
                    disabled={isResetting}
                  >
                    {isResetting ? t('settings.resetting') : t('settings.confirmReset')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
