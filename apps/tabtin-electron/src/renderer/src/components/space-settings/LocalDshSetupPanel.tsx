import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@muse/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { LocalDshStatus } from '@shared/types/local-dsh'

export interface LocalDshSetupPanelProps {
  onReadyChange?: (ready: boolean) => void
  disabled?: boolean
  /** Ready/checking state sits next to the harness options; setup still expands. */
  compact?: boolean
}

/** Detect first; the user's Install click is the only path that downloads DSH. */
export function LocalDshSetupPanel({ onReadyChange, disabled = false, compact = false }: LocalDshSetupPanelProps) {
  const { t } = useTranslation('space')
  const [status, setStatus] = useState<LocalDshStatus | null>(null)
  const [action, setAction] = useState<'check' | 'install' | null>('check')
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)

  const perform = useCallback(async (kind: 'check' | 'install') => {
    if (inFlight.current) return
    inFlight.current = true
    const requestGeneration = generation.current
    setAction(kind)
    setError(null)
    try {
      const result = kind === 'install'
        ? await window.muse.localDsh.install()
        : await window.muse.localDsh.getStatus()
      if (generation.current !== requestGeneration) return
      setStatus(result)
      setError(result.error)
      onReadyChange?.(result.installed && !result.installing)
    } catch (cause) {
      if (generation.current !== requestGeneration) return
      if (kind === 'check') setStatus(null)
      setError(cause instanceof Error ? cause.message : '')
      onReadyChange?.(false)
    } finally {
      if (generation.current === requestGeneration) {
        inFlight.current = false
        setAction(null)
      }
    }
  }, [onReadyChange])

  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    onReadyChange?.(false)
    void perform('check')
    return () => { generation.current += 1; inFlight.current = false }
  }, [perform, onReadyChange])

  // A reopened panel can observe an install still running in the main process.
  useEffect(() => {
    if (!status?.installing) return
    const timer = setInterval(() => { void perform('check') }, 2000)
    return () => clearInterval(timer)
  }, [status?.installing, perform])

  const installing = action === 'install' || status?.installing === true
  const busy = action !== null || installing
  const installed = status?.installed === true
  const incompatible = Boolean(!installed && status?.version && status.supportedVersion && status.version !== status.supportedVersion)
  const versionNotice = status?.errorCode === 'DSH_VERSION_INCOMPATIBLE' && error === status.error

  if (compact && error === null && !installing && (installed || action === 'check')) {
    return (
      <div className="inline-flex min-w-0 items-center gap-2 text-caption text-muted-foreground" aria-busy={busy}>
        <span role="status" className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {action === 'check' && !installed
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{t('harness.local.checking')}</>
            : <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />{t('harness.local.readyShort')}</>}
        </span>
        {status?.version && <span className="whitespace-nowrap tabular-nums">v{status.version}</span>}
        <button
          type="button"
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring${disabled ? ' opacity-40' : ''}`}
          disabled={disabled || busy}
          onClick={() => void perform('check')}
          aria-label={t('harness.local.refresh')}
          title={t('harness.local.refresh')}
        >
          <RefreshCw className={`h-3.5 w-3.5${action === 'check' ? ' animate-spin' : ''}`} aria-hidden />
        </button>
      </div>
    )
  }

  return (
    <section className="w-full rounded-lg border border-border bg-muted/20 p-3 space-y-3" aria-busy={busy}>
      <div className="flex items-start gap-2">
        {installed
          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          : <Download className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0 space-y-1">
          <p className="text-body font-medium text-foreground">
            {installed ? t('harness.local.ready') : t('harness.local.title')}
          </p>
          <p className="text-caption text-muted-foreground" role="status">
            {installing ? t('harness.local.installing')
              : action === 'check' ? t('harness.local.checking')
                : installed ? t('harness.local.version', { version: status.version })
                  : incompatible ? t('harness.local.incompatibleVersion', { version: status?.version, supportedVersion: status?.supportedVersion })
                    : t('harness.local.description')}
          </p>
        </div>
      </div>
      {status?.detail && !installed && (
        <p className="text-caption text-muted-foreground">{t('harness.local.nodeRequired')}</p>
      )}
      {error !== null && !versionNotice && (
        <p role="alert" className="text-caption text-destructive break-words">
          {error || t('harness.local.failed')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!installed && status?.canInstall && (
          <Button type="button" size="sm" disabled={disabled || busy} onClick={() => void perform('install')}>
            {installing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
            {installing ? t('harness.local.installingButton') : error !== null && !versionNotice ? t('harness.local.retry') : t('harness.local.install')}
          </Button>
        )}
        {status?.detail && !installed && (
          <Button type="button" variant="outline" size="sm" disabled={disabled || busy}
            onClick={() => { void window.muse.openExternal('https://nodejs.org/en/download') }}>
            {t('harness.local.getNode')}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => void perform('check')}>
          {action === 'check'
            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {t('harness.local.refresh')}
        </Button>
      </div>
    </section>
  )
}
