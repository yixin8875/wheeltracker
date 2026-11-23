import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCwIcon, XIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  restoreStatus,
  webdavBackup,
  webdavDelete,
  webdavDownload,
  webdavList,
  webdavSave,
  webdavSettings,
  webdavStageRestore,
  webdavTest,
  type PendingRestore,
  type RemoteBackup,
  type RestoreResult,
  type WebDavConfig,
  type WebDavSettings,
} from './api'

interface Props {
  onClose: () => void
  onChanged: (message: string) => void
}

const FIELD_INPUT = 'h-10 [&_input]:h-full [&_input]:leading-10'

function size(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function when(value: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(
    parsed.getHours(),
  )}:${pad(parsed.getMinutes())}`
}

function toConfig(settings: WebDavSettings): WebDavConfig {
  return {
    url: settings.url,
    username: settings.username,
    remoteDir: settings.remoteDir,
    autoUpload: settings.autoUpload,
    keep: settings.keep,
    encrypt: settings.encrypt,
    allowInsecureHttp: settings.allowInsecureHttp,
  }
}

function Field({
  label,
  wide,
  children,
}: {
  label: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground',
        wide && 'col-span-2',
      )}
    >
      <span>{label}</span>
      {children}
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      onClick={onChange}
      aria-pressed={checked}
      className="h-12 w-full justify-between rounded-none px-3.5 text-sm font-normal"
    >
      <span>{children}</span>
      <span
        aria-hidden="true"
        className={cn(
          'relative h-6 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-input',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-background shadow-sm transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </span>
    </Button>
  )
}

export default function WebDavSheet({ onClose, onChanged }: Props) {
  const [settings, setSettings] = useState<WebDavSettings | null>(null)
  const [config, setConfig] = useState<WebDavConfig | null>(null)
  const [serverPassword, setServerPassword] = useState('')
  const [backupPassword, setBackupPassword] = useState('')
  const [snapshots, setSnapshots] = useState<RemoteBackup[] | null>(null)
  const [pending, setPending] = useState<PendingRestore | null>(null)
  const [lastResult, setLastResult] = useState<RestoreResult | null>(null)
  const [candidate, setCandidate] = useState<{ fileName: string; localFile: string } | null>(
    null,
  )
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const applySettings = useCallback((fresh: WebDavSettings) => {
    setSettings(fresh)
    setConfig(toConfig(fresh))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [fresh, restore] = await Promise.all([webdavSettings(), restoreStatus()])
        if (cancelled) return
        applySettings(fresh)
        setPending(restore.pending)
        setLastResult(restore.lastResult)
      } catch (failure) {
        if (!cancelled) setError(String(failure))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applySettings])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = (patch: Partial<WebDavConfig>) => {
    setConfig((current) => (current ? { ...current, ...patch } : current))
  }

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await task()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy('')
    }
  }

  const onTest = () =>
    run('测试连接', async () => {
      if (!config) return
      const info = await webdavTest(config, serverPassword || null)
      setNotice(
        `连接成功${info.writable ? '' : '（目录只读）'} · 云端 ${info.snapshotCount} 份快照${
          info.server ? ` · ${info.server}` : ''
        }`,
      )
    })

  const onSave = () =>
    run('保存', async () => {
      if (!config) return
      const fresh = await webdavSave(
        config,
        serverPassword || (settings?.hasPassword ? null : ''),
      )
      applySettings(fresh)
      setServerPassword('')
      setNotice('已保存 WebDAV 设置。')
      onChanged('WebDAV 设置已保存')
    })

  const known = Boolean(settings?.configured)

  const onList = () =>
    run('刷新云端', async () => {
      const list = await webdavList(serverPassword || null)
      setSnapshots(list)
      setNotice(list.length === 0 ? '云端还没有本应用上传的快照。' : `云端 ${list.length} 份快照。`)
    })

  const onBackup = () =>
    run('备份', async () => {
      const secret = config?.encrypt ? backupPassword || null : null
      const outcome = await webdavBackup(serverPassword || null, secret)
      setBackupPassword('')
      setNotice(`已上传 ${outcome.remote.fileName}（${size(outcome.remote.sizeBytes)}）。`)
      onChanged('已备份到 WebDAV')
      const list = await webdavList(serverPassword || null)
      setSnapshots(list)
    })

  const onDownload = (entry: RemoteBackup) =>
    run('下载', async () => {
      const secret = entry.encrypted ? backupPassword || null : null
      const downloaded = await webdavDownload(
        entry.fileName,
        serverPassword || null,
        secret,
      )
      if (!downloaded.validation.valid) {
        throw new Error(
          `快照校验失败：${downloaded.validation.issues.join('；') || '文件不完整'}`,
        )
      }
      setCandidate({ fileName: entry.fileName, localFile: downloaded.localFile })
      setNotice(
        `已下载并校验：${downloaded.validation.events} 条事件 · ${downloaded.validation.accounts} 个账户。`,
      )
    })

  const onStage = () =>
    run('安排恢复', async () => {
      if (!candidate) return
      const staged = await webdavStageRestore(candidate.localFile, backupPassword || null)
      setPending(staged)
      setCandidate(null)
      setNotice('已安排恢复：请完全退出并重新打开应用以完成。')
    })

  const onDelete = (entry: RemoteBackup) =>
    run('删除', async () => {
      await webdavDelete(entry.fileName, serverPassword || null)
      setSnapshots((current) =>
        current ? current.filter((item) => item.fileName !== entry.fileName) : current,
      )
      setNotice(`已删除云端快照 ${entry.fileName}。`)
    })

  return (
    <div
      className="fixed inset-0 z-40 flex animate-in items-end justify-center bg-black/40 backdrop-blur-sm duration-150 fade-in-0"
      onClick={onClose}
      role="presentation"
    >
      <section
        className="max-h-[92dvh] w-full max-w-[30rem] animate-in overflow-y-auto rounded-t-2xl border bg-background p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-xl duration-300 fade-in-0 slide-in-from-bottom-6"
        role="dialog"
        aria-modal="true"
        aria-label="备份与同步"
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden="true"
          className="mx-auto mb-1 block h-1 w-9 rounded-full bg-border"
        />
        <header className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 border-b bg-background px-4 py-2.5">
          <h2 className="font-heading text-base font-semibold">备份与同步</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
            <XIcon />
          </Button>
        </header>

        <div className="mt-4 flex flex-col gap-4">
          {error && (
            <Alert variant="error" role="alert">
              <AlertTitle>操作失败</AlertTitle>
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <p
              role="status"
              className="rounded-lg border border-info/32 bg-info/4 px-3.5 py-2.5 text-xs leading-relaxed text-foreground"
            >
              {notice}
            </p>
          )}
          {pending && (
            <Alert variant="warning" role="status">
              <AlertTitle>已安排恢复</AlertTitle>
              <AlertDescription className="text-xs">
                {pending.backupFile} · 完全退出并重新打开应用后生效，此前不能记新账。
              </AlertDescription>
            </Alert>
          )}
          {!pending && lastResult && (
            <p className="text-xs text-muted-foreground">上次恢复：{lastResult.message}</p>
          )}

          {!config && !error && (
            <p className="py-8 text-center text-sm text-muted-foreground">正在读取设置…</p>
          )}

          {config && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="服务器地址" wide>
                  <Input
                    className={FIELD_INPUT}
                    value={config.url}
                    onChange={(event) => update({ url: event.target.value })}
                    placeholder="https://dav.example.com/dav/"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
                <Field label="账号">
                  <Input
                    className={FIELD_INPUT}
                    value={config.username}
                    onChange={(event) => update({ username: event.target.value })}
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
                <Field label="应用密码">
                  <Input
                    className={FIELD_INPUT}
                    type="password"
                    value={serverPassword}
                    onChange={(event) => setServerPassword(event.target.value)}
                    placeholder={settings?.hasPassword ? settings.passwordHint : '加密保存在本机'}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
                <Field label="远程目录">
                  <Input
                    className={FIELD_INPUT}
                    value={config.remoteDir}
                    onChange={(event) => update({ remoteDir: event.target.value })}
                    placeholder="/wheel/"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
                <Field label="保留份数">
                  <Input
                    className={FIELD_INPUT}
                    value={String(config.keep)}
                    onChange={(event) =>
                      update({ keep: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })
                    }
                    inputMode="numeric"
                  />
                </Field>
              </div>

              <div className="divide-y overflow-hidden rounded-xl border">
                <Toggle
                  checked={config.encrypt}
                  onChange={() => update({ encrypt: !config.encrypt })}
                >
                  加密上传
                </Toggle>
                <Toggle
                  checked={config.allowInsecureHttp}
                  onChange={() => update({ allowInsecureHttp: !config.allowInsecureHttp })}
                >
                  允许局域网 HTTP
                </Toggle>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => void onTest()}
                  disabled={Boolean(busy)}
                >
                  {busy === '测试连接' ? '连接中…' : '测试连接'}
                </Button>
                <Button size="lg" onClick={() => void onSave()} disabled={Boolean(busy)}>
                  {busy === '保存' ? '保存中…' : '保存'}
                </Button>
              </div>

              {settings?.lastError && (
                <p className="text-xs text-destructive-foreground">上次错误：{settings.lastError}</p>
              )}
              {settings?.lastUploadAt && (
                <p className="text-xs text-muted-foreground">
                  上次上传：{when(settings.lastUploadAt)} · {settings.lastUploadFile ?? '—'}
                </p>
              )}

              {known && (
                <>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <h3 className="font-heading text-sm font-semibold">云端快照</h3>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void onList()}
                      disabled={Boolean(busy)}
                    >
                      <RefreshCwIcon className={busy === '刷新云端' ? 'animate-spin' : undefined} />
                      {busy === '刷新云端' ? '刷新中…' : '刷新'}
                    </Button>
                  </div>

                  {config.encrypt && (
                    <Field label="备份密码（加密上传 / 恢复加密快照）" wide>
                      <Input
                        className={FIELD_INPUT}
                        type="password"
                        value={backupPassword}
                        onChange={(event) => setBackupPassword(event.target.value)}
                        placeholder="至少 8 位，不保存"
                        autoCapitalize="none"
                        autoCorrect="off"
                      />
                    </Field>
                  )}

                  <Button
                    size="lg"
                    className="w-full"
                    onClick={() => void onBackup()}
                    disabled={Boolean(busy)}
                  >
                    {busy === '备份' ? '上传中…' : '立即备份到 WebDAV'}
                  </Button>

                  {snapshots && snapshots.length === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                      云端还没有本应用上传的快照。
                    </p>
                  )}
                  {snapshots?.map((entry) => (
                    <Card key={entry.fileName}>
                      <CardHeader className="gap-1 p-3.5 pb-2">
                        <CardTitle className="num truncate text-xs font-medium">
                          {entry.fileName}
                        </CardTitle>
                        <CardDescription className="text-[11px]">
                          {size(entry.sizeBytes)} · {when(entry.modifiedAt)}
                          {entry.encrypted ? ' · 加密' : ''}
                        </CardDescription>
                      </CardHeader>
                      <CardPanel className="grid grid-cols-2 gap-2 p-3.5 pt-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9"
                          onClick={() => void onDownload(entry)}
                          disabled={Boolean(busy)}
                        >
                          恢复…
                        </Button>
                        <Button
                          variant="destructive-outline"
                          size="sm"
                          className="h-9"
                          onClick={() => void onDelete(entry)}
                          disabled={Boolean(busy)}
                        >
                          删除
                        </Button>
                      </CardPanel>
                    </Card>
                  ))}

                  {candidate && (
                    <Card className="border-warning/40 bg-warning/4">
                      <CardPanel className="flex flex-col gap-3 p-3.5">
                        <p className="text-xs leading-relaxed">
                          将 {candidate.fileName} 换入本机账本。当前账本会留一份安全副本，恢复在下次启动时执行。
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9"
                            onClick={() => setCandidate(null)}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            className="h-9"
                            onClick={() => void onStage()}
                            disabled={Boolean(busy)}
                          >
                            安排恢复
                          </Button>
                        </div>
                      </CardPanel>
                    </Card>
                  )}
                </>
              )}

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                密码使用 Android Keystore 加密保存在本机，不写入账本；重启应用后继续沿用。自动上传仍未开放。
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
