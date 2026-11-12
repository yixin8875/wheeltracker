import { useCallback, useEffect, useState } from 'react'
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
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="备份与同步"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <span className="sheet-grip" aria-hidden="true" />
          <h2>备份与同步</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="sheet-body">
          {error && (
            <div className="alert" role="alert">
              <strong>操作失败</strong>
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <p className="notice-inline" role="status">
              {notice}
            </p>
          )}
          {pending && (
            <div className="alert warn" role="status">
              <strong>已安排恢复</strong>
              <span>
                {pending.backupFile} · 完全退出并重新打开应用后生效，此前不能记新账。
              </span>
            </div>
          )}
          {!pending && lastResult && (
            <p className="muted small">上次恢复：{lastResult.message}</p>
          )}

          {!config && !error && <p className="empty">正在读取设置…</p>}

          {config && (
            <>
              <div className="field-grid">
                <label className="field wide">
                  <span>服务器地址</span>
                  <input
                    value={config.url}
                    onChange={(event) => update({ url: event.target.value })}
                    placeholder="https://dav.jianguoyun.com/dav/"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <label className="field">
                  <span>账号</span>
                  <input
                    value={config.username}
                    onChange={(event) => update({ username: event.target.value })}
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <label className="field">
                  <span>应用密码</span>
                  <input
                    type="password"
                    value={serverPassword}
                    onChange={(event) => setServerPassword(event.target.value)}
                    placeholder={settings?.hasPassword ? settings.passwordHint : '仅本次运行保存'}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <label className="field">
                  <span>远程目录</span>
                  <input
                    value={config.remoteDir}
                    onChange={(event) => update({ remoteDir: event.target.value })}
                    placeholder="/wheel/"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </label>
                <label className="field">
                  <span>保留份数</span>
                  <input
                    value={String(config.keep)}
                    onChange={(event) =>
                      update({ keep: Math.max(1, Math.trunc(Number(event.target.value) || 1)) })
                    }
                    inputMode="numeric"
                  />
                </label>
              </div>

              <div className="toggle-list">
                <button
                  className={`toggle ${config.encrypt ? 'on' : ''}`}
                  onClick={() => update({ encrypt: !config.encrypt })}
                  aria-pressed={config.encrypt}
                >
                  <span>加密上传</span>
                  <span className="switch" aria-hidden="true" />
                </button>
                <button
                  className={`toggle ${config.allowInsecureHttp ? 'on' : ''}`}
                  onClick={() => update({ allowInsecureHttp: !config.allowInsecureHttp })}
                  aria-pressed={config.allowInsecureHttp}
                >
                  <span>允许局域网 HTTP</span>
                  <span className="switch" aria-hidden="true" />
                </button>
              </div>

              <div className="sheet-actions">
                <button className="ghost" onClick={() => void onTest()} disabled={Boolean(busy)}>
                  {busy === '测试连接' ? '连接中…' : '测试连接'}
                </button>
                <button className="primary" onClick={() => void onSave()} disabled={Boolean(busy)}>
                  {busy === '保存' ? '保存中…' : '保存'}
                </button>
              </div>

              {settings?.lastError && <p className="muted small">上次错误：{settings.lastError}</p>}
              {settings?.lastUploadAt && (
                <p className="muted small">
                  上次上传：{when(settings.lastUploadAt)} · {settings.lastUploadFile ?? '—'}
                </p>
              )}

              {known && (
                <>
                  <div className="section-title spaced">
                    <h2>云端快照</h2>
                    <button className="link" onClick={() => void onList()} disabled={Boolean(busy)}>
                      {busy === '刷新云端' ? '刷新中…' : '刷新'}
                    </button>
                  </div>

                  {config.encrypt && (
                    <label className="field wide">
                      <span>备份密码（加密上传 / 恢复加密快照）</span>
                      <input
                        type="password"
                        value={backupPassword}
                        onChange={(event) => setBackupPassword(event.target.value)}
                        placeholder="至少 8 位，不保存"
                        autoCapitalize="none"
                        autoCorrect="off"
                      />
                    </label>
                  )}

                  <button
                    className="primary wide"
                    onClick={() => void onBackup()}
                    disabled={Boolean(busy)}
                  >
                    {busy === '备份' ? '上传中…' : '立即备份到 WebDAV'}
                  </button>

                  {snapshots && snapshots.length === 0 && (
                    <p className="empty">云端还没有本应用上传的快照。</p>
                  )}
                  {snapshots?.map((entry) => (
                    <article className="card snapshot" key={entry.fileName}>
                      <div className="card-head">
                        <div>
                          <strong className="mono small">{entry.fileName}</strong>
                          <span className="muted small">
                            {size(entry.sizeBytes)} · {when(entry.modifiedAt)}
                            {entry.encrypted ? ' · 加密' : ''}
                          </span>
                        </div>
                      </div>
                      <div className="position-actions">
                        <button onClick={() => void onDownload(entry)} disabled={Boolean(busy)}>
                          恢复…
                        </button>
                        <button
                          className="danger"
                          onClick={() => void onDelete(entry)}
                          disabled={Boolean(busy)}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  ))}

                  {candidate && (
                    <div className="card confirm">
                      <p>
                        将 {candidate.fileName} 换入本机账本。当前账本会留一份安全副本，恢复在下次启动时执行。
                      </p>
                      <div className="position-actions">
                        <button onClick={() => setCandidate(null)}>取消</button>
                        <button className="primary" onClick={() => void onStage()}>
                          安排恢复
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              <p className="muted small">
                密码只保存在本次运行的内存中，不写入账本；重启应用后需要重新输入。因此启动时自动上传暂不开放。
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
