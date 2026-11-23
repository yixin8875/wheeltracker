import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CloudIcon, CloudDownloadIcon, CloudUploadIcon, LockIcon, RefreshCwIcon, ServerIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { api, desktop } from './lib';
import type { RemoteBackup, RestoreStatus, WebDavConfig, WebDavDownload, WebDavServerInfo, WebDavSettings as WebDavSettingsData, WebDavUpload } from './types';

const EMPTY: WebDavConfig = {
  url: '',
  username: '',
  remoteDir: '/wheel/',
  autoUpload: true,
  keep: 10,
  encrypt: true,
  allowInsecureHttp: false
};

function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function hostOf(url: string) {
  try { return new URL(url).host; } catch { return url; }
}

function timeLabel(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function formOf(settings: WebDavSettingsData): WebDavConfig {
  return {
    url: settings.url,
    username: settings.username,
    remoteDir: settings.remoteDir,
    autoUpload: settings.autoUpload,
    keep: settings.keep,
    encrypt: settings.encrypt,
    allowInsecureHttp: settings.allowInsecureHttp
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal leading-relaxed">{hint}</span> : null}
    </label>
  );
}

/**
 * WebDAV snapshot backup. Uploads reuse the local snapshot format; restore is
 * download → validate → stage, with the actual swap happening on next launch.
 */
export function WebDavSettings({ onNotice, onError, onRestoreStatus }: {
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onRestoreStatus: (status: RestoreStatus) => void;
}) {
  const [settings, setSettings] = useState<WebDavSettingsData | null>(null);
  const [form, setForm] = useState<WebDavConfig>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState('');
  const [password, setPassword] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [remote, setRemote] = useState<RemoteBackup[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [download, setDownload] = useState<WebDavDownload | null>(null);
  const [confirm, setConfirm] = useState<RemoteBackup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemoteBackup | null>(null);
  const [testResult, setTestResult] = useState<WebDavServerInfo | null>(null);

  const reloadSettings = useCallback(async () => {
    if (!desktop) return;
    const value = await api<WebDavSettingsData>('webdav_get_settings');
    setSettings(value);
    return value;
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    api<WebDavSettingsData>('webdav_get_settings')
      .then(value => {
        if (cancelled) return;
        setSettings(value);
        setForm(formOf(value));
        setEditing(!value.configured);
      })
      .catch(failure => { if (!cancelled) onError(String(failure)); });
    return () => { cancelled = true; };
  }, [onError]);

  async function saveConfig() {
    if (working) return;
    const keep = Number(form.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
      onError('远端保留份数必须是 1 到 100 之间的整数。');
      return;
    }
    setWorking('save');
    try {
      const result = await api<WebDavSettingsData>('webdav_save_settings', {
        config: {
          ...form,
          url: form.url.trim(),
          username: form.username.trim(),
          remoteDir: form.remoteDir.trim(),
          keep
        },
        password: password.trim() ? password : null,
        backupPassword: backupPassword.trim() ? backupPassword : null
      });
      setSettings(result);
      setForm(formOf(result));
      setEditing(false);
      setTestResult(null);
      setRemote(null);
      setSelected(null);
      setDownload(null);
      const messages: string[] = [];
      if (password.trim()) {
        messages.push(result.passwordSource === 'keychain'
          ? '应用密码已写入系统凭据库。'
          : '当前系统凭据库不可用，应用密码只保留在本次运行内存中，重启后需重新输入。');
      } else if (result.hasPassword) {
        messages.push('继续使用已保存的应用密码。');
      } else {
        messages.push('尚未保存应用密码，连接前请填写。');
      }
      if (backupPassword.trim()) messages.push('备份密码仅用于本次运行的自动上传，不会保存。');
      setPassword('');
      onNotice(`WebDAV 设置已保存。${messages.join('')}`);
    } catch (failure) {
      onError(String(failure));
    } finally {
      setWorking('');
    }
  }

  async function testConnection() {
    if (working) return;
    setWorking('test');
    setTestResult(null);
    try {
      setTestResult(await api<WebDavServerInfo>('webdav_test', {
        config: form,
        password: password.trim() || null
      }));
    } catch (failure) {
      onError(String(failure));
    } finally {
      setWorking('');
    }
  }

  async function backupNow() {
    if (!settings?.configured || working) return;
    if (settings.encrypt && backupPassword.length < 8) {
      onError('加密上传已开启：请填写至少 8 位的备份密码（不会保存，遗失将无法恢复）。');
      return;
    }
    setWorking('upload');
    try {
      const result = await api<WebDavUpload>('webdav_backup_now', {
        serverPassword: password.trim() || null,
        backupPassword: settings.encrypt ? backupPassword : null
      });
      onNotice(`已上传 ${result.remote.fileName}（${sizeLabel(result.remote.sizeBytes)}）到 WebDAV。`);
      setBackupPassword('');
      await reloadSettings();
      setRemote(await api<RemoteBackup[]>('webdav_list', { serverPassword: password.trim() || null }));
    } catch (failure) {
      onError(String(failure));
      try { await reloadSettings(); } catch { /* keep the previous view */ }
    } finally {
      setWorking('');
    }
  }

  async function refreshRemote() {
    if (!settings?.configured || working) return;
    setWorking('list');
    try {
      setRemote(await api<RemoteBackup[]>('webdav_list', { serverPassword: password.trim() || null }));
      await reloadSettings();
    } catch (failure) {
      onError(String(failure));
    } finally {
      setWorking('');
    }
  }

  async function inspectRemote(item: RemoteBackup) {
    if (working) return;
    if (item.encrypted && restorePassword.length < 8) {
      setSelected(item.fileName);
      setDownload(null);
      return;
    }
    setSelected(item.fileName);
    setWorking('download');
    try {
      const result = await api<WebDavDownload>('webdav_restore', {
        fileName: item.fileName,
        backupPassword: item.encrypted ? restorePassword : null,
        serverPassword: password.trim() || null
      });
      setDownload(result);
      if (result.validation.valid) {
        onNotice(`云端快照已下载并通过校验：${result.validation.events} 笔事件、${result.validation.accounts} 个账户。`);
      } else {
        onError(`云端快照未通过校验：${result.validation.issues.join('；')}`);
      }
    } catch (failure) {
      onError(String(failure));
    } finally {
      setWorking('');
    }
  }

  async function stageRemote() {
    if (!download || !confirm || working) return;
    setWorking('stage');
    try {
      await api<unknown>('webdav_stage_restore', {
        fileName: download.localFile,
        password: confirm.encrypted ? restorePassword : null
      });
      setConfirm(null);
      setDownload(null);
      setSelected(null);
      setRestorePassword('');
      onNotice('恢复已安排。请完全退出并重新启动应用，重启后才会替换当前账本。');
      try { onRestoreStatus(await api<RestoreStatus>('restore_status')); } catch { /* the banner also refreshes with the ledger */ }
    } catch (failure) {
      onError(String(failure));
    } finally {
      setWorking('');
    }
  }

  async function removeRemote(item: RemoteBackup) {
    if (working) return;
    setWorking('delete');
    try {
      await api<boolean>('webdav_delete', {
        fileName: item.fileName,
        serverPassword: password.trim() || null
      });
      setRemote(current => current?.filter(entry => entry.fileName !== item.fileName) ?? null);
      setDeleteTarget(null);
      if (selected === item.fileName) { setSelected(null); setDownload(null); }
      onNotice(`已删除云端快照 ${item.fileName}。本机账本未受影响。`);
    } catch (failure) {
      onError(String(failure));
    } finally {
      setWorking('');
    }
  }

  const selectedItem = remote?.find(item => item.fileName === selected) ?? null;
  const busy = Boolean(working);

  return (
    <Card className="webdav-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><CloudIcon className="size-4 text-muted-foreground" />WebDAV 备份</CardTitle>
        <CardDescription>{settings?.configured ? hostOf(settings.url) : '未配置'}</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        {!desktop && <p className="text-xs text-muted-foreground">当前是浏览器预览。WebDAV 备份仅在桌面应用中可用。</p>}

        {settings?.lastError && <Alert variant="error" role="alert" className="alert error"><strong>上次云端操作失败：</strong>{settings.lastError}</Alert>}

        {settings ? (
          <p className="webdav-status text-xs leading-relaxed text-muted-foreground">
            上次上传：{timeLabel(settings.lastUploadAt)}{settings.lastUploadFile ? ` · ${settings.lastUploadFile}` : ''}
            {' · '}密码：{settings.hasPassword
              ? (settings.passwordSource === 'keychain' ? `系统凭据库 ${settings.passwordHint}` : `本次运行内存 ${settings.passwordHint}`)
              : '未保存'}
            {' · '}自动上传：{settings.autoUploadReady ? '已就绪' : settings.autoUpload ? '未就绪' : '已关闭'}
          </p>
        ) : <p className="text-xs text-muted-foreground">尚未读取 WebDAV 设置。</p>}

        {settings?.autoUpload && settings.encrypt && !settings.autoUploadReady && (
          <Alert variant="warning" className="alert warning">
            自动上传已开启但尚未就绪：加密上传需要在本次运行中提供备份密码。请填写下方备份密码并执行一次「立即上传备份」。
          </Alert>
        )}

        <div className="toolbar flex flex-wrap gap-2">
          <Button size="sm" disabled={!desktop || !settings?.configured || busy || editing} onClick={() => void backupNow()}>
            <CloudUploadIcon />{working === 'upload' ? '上传中…' : '立即上传备份'}
          </Button>
          <Button variant="outline" size="sm" disabled={!desktop || !settings?.configured || busy || editing} onClick={() => void refreshRemote()}>
            <RefreshCwIcon />{working === 'list' ? '读取中…' : '刷新云端快照'}
          </Button>
          <Button variant="ghost" size="sm" disabled={!desktop || busy} onClick={() => {
            setEditing(value => !value);
            if (settings) setForm(formOf(settings));
            setTestResult(null);
          }}><ServerIcon />{editing ? '收起设置' : '编辑设置'}</Button>
        </div>

        {!editing && settings?.configured && (
          <div className="backup-password-row grid gap-3 rounded-xl border bg-muted/30 p-3 sm:grid-cols-2">
            <Field label="WebDAV 应用密码（留空使用已保存密码）">
              <Input
                type="password"
                aria-label="WebDAV 应用密码"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={event => setPassword(event.target.value)}
                placeholder={settings.hasPassword ? `已保存 ${settings.passwordHint}` : '未保存密码'}
              />
            </Field>
            {settings.encrypt ? (
              <Field label="备份加密密码（本次运行，不保存）">
                <Input
                  type="password"
                  aria-label="备份加密密码"
                  autoComplete="new-password"
                  value={backupPassword}
                  disabled={busy}
                  onChange={event => setBackupPassword(event.target.value)}
                  placeholder="至少 8 位；遗失不可恢复"
                />
              </Field>
            ) : <span className="self-end text-xs leading-relaxed text-muted-foreground">未加密上传：WebDAV 服务商可读取快照内容（包括 SQLite 中的 AI API Key）。</span>}
          </div>
        )}

        {editing && (
          <div className="accounting-preferences grid gap-3 rounded-xl border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="服务器地址">
                <Input
                  type="url"
                  value={form.url}
                  disabled={busy}
                  onChange={event => setForm(current => ({ ...current, url: event.target.value }))}
                  placeholder="https://dav.jianguoyun.com/dav/"
                />
              </Field>
              <Field label="账号">
                <Input
                  type="text"
                  autoComplete="username"
                  value={form.username}
                  disabled={busy}
                  onChange={event => setForm(current => ({ ...current, username: event.target.value }))}
                  placeholder="坚果云 / Nextcloud 账号"
                />
              </Field>
              <Field label="应用密码">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  disabled={busy}
                  onChange={event => setPassword(event.target.value)}
                  placeholder={settings?.hasPassword ? `已保存 ${settings.passwordHint}；留空不修改` : '服务器生成的应用密码'}
                />
              </Field>
              <Field label="远程目录">
                <Input
                  type="text"
                  value={form.remoteDir}
                  disabled={busy}
                  onChange={event => setForm(current => ({ ...current, remoteDir: event.target.value }))}
                  placeholder="/wheel/"
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>远端保留</span>
              <Input
                type="number"
                className="w-24"
                min={1}
                max={100}
                step={1}
                value={form.keep}
                disabled={busy}
                onChange={event => setForm(current => ({ ...current, keep: Number(event.target.value) }))}
              />
              <span>份自动上传快照（手动快照不会被自动删除）</span>
            </div>
            <label className="check flex items-center gap-2 text-sm"><input
              type="checkbox"
              className="size-3.5 rounded border-input accent-primary"
              checked={form.autoUpload}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, autoUpload: event.target.checked }))}
            />每日自动备份后自动上传</label>
            <label className="check flex items-center gap-2 text-sm"><input
              type="checkbox"
              className="size-3.5 rounded border-input accent-primary"
              checked={form.encrypt}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, encrypt: event.target.checked }))}
            />加密上传（每次运行需提供备份密码）</label>
            <label className="check flex items-center gap-2 text-sm"><input
              type="checkbox"
              className="size-3.5 rounded border-input accent-primary"
              checked={form.allowInsecureHttp}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, allowInsecureHttp: event.target.checked }))}
            />允许不安全 HTTP（仅限 localhost / 局域网）</label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              应用密码保存在 Windows 凭据管理器；凭据库不可用时只保留在本次运行内存中，绝不写入 SQLite。
              恢复是整库替换而非同步：同一时间请只在一台设备上记账。手动快照与 pre-restore 安全快照不会被远端保留策略清理。
            </p>
            <div className="toolbar flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void saveConfig()}>{working === 'save' ? '保存中…' : '保存设置'}</Button>
              <Button variant="outline" size="sm" disabled={busy || !form.url.trim()} onClick={() => void testConnection()}>{working === 'test' ? '测试中…' : '测试连接'}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(false); if (settings) setForm(formOf(settings)); setTestResult(null); }}>取消</Button>
            </div>
            {testResult && (
              <Alert variant={testResult.writable ? 'success' : 'warning'} role="status" className={testResult.writable ? 'success' : 'warning'}>
                连接成功 · {testResult.writable ? '目录可写' : '目录只读（无法上传）'} · {testResult.snapshotCount} 份快照{testResult.server ? ` · ${testResult.server}` : ''}
              </Alert>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-4">
          <h3 className="font-heading text-sm font-semibold">云端快照</h3>
          <span className="text-xs text-muted-foreground">{remote ? `${remote.length} 份 · 时间为本地时区` : '点击「刷新云端快照」读取'}</span>
        </div>

        {remote && (remote.length ? (
          <div className="backup-list grid gap-2" role="list">
            {remote.map(item => (
              <div key={item.fileName} className={`backup-row flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${selected === item.fileName ? 'selected bg-accent/60' : ''}`} role="listitem">
                <div className="backup-meta min-w-0">
                  <strong className="block truncate text-sm font-medium">{item.fileName}</strong>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant={item.fileName.startsWith('auto-') ? 'secondary' : 'info'} size="sm">{item.fileName.startsWith('auto-') ? '自动备份' : '手动备份'}</Badge>
                    {item.encrypted && <span className="backup-lock inline-flex items-center gap-1"><LockIcon className="size-3" />已加密</span>}
                    · {sizeLabel(item.sizeBytes)} · {timeLabel(item.modifiedAt)}
                  </span>
                </div>
                <div className="toolbar flex gap-1">
                  <Button variant="outline" size="xs" disabled={busy} onClick={() => void inspectRemote(item)}>
                    <CloudDownloadIcon />{working === 'download' && selected === item.fileName ? '下载校验中…' : '恢复'}
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={() => setDeleteTarget(item)}><Trash2Icon />删除</Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有云端快照</EmptyTitle>
              <EmptyDescription>云端目录中没有本应用的快照。上传后会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ))}

        {selectedItem && !download && selectedItem.encrypted && (
          <div className="restore-validation space-y-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-heading flex items-center gap-2 text-sm font-semibold"><LockIcon className="size-4" /> {selectedItem.fileName}</h3>
              <Badge variant="outline" size="sm">已加密</Badge>
            </div>
            <Field label="备份密码">
              <Input
                type="password"
                aria-label="云端备份密码"
                autoComplete="current-password"
                value={restorePassword}
                disabled={busy}
                onChange={event => setRestorePassword(event.target.value)}
              />
            </Field>
            <p className="text-xs leading-relaxed text-muted-foreground">下载后先在本机校验完整性与 schema；密码只用于校验和暂存，不会保存。</p>
            <div className="toolbar flex gap-2">
              <Button variant="outline" size="sm" disabled={busy || restorePassword.length < 8} onClick={() => void inspectRemote(selectedItem)}>
                {working === 'download' ? '下载校验中…' : '下载并校验'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setSelected(null); setRestorePassword(''); }}>取消</Button>
            </div>
          </div>
        )}

        {download && selectedItem && (
          <div className="restore-validation space-y-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-heading flex items-center gap-2 text-sm font-semibold"><ShieldCheckIcon className="size-4" /> {selectedItem.fileName}</h3>
              <Badge variant={download.validation.valid ? 'success' : 'destructive'} size="sm">{download.validation.valid ? '校验通过' : '不可恢复'}</Badge>
            </div>
            <div className="validation-values grid grid-cols-2 gap-3 sm:grid-cols-4">
              <span className="grid gap-0.5 text-xs text-muted-foreground">完整性<strong className="num text-sm font-medium text-foreground">{download.validation.integrity || '未知'}</strong></span>
              <span className="grid gap-0.5 text-xs text-muted-foreground">事件<strong className="num text-sm font-medium text-foreground">{download.validation.events}</strong></span>
              <span className="grid gap-0.5 text-xs text-muted-foreground">账户<strong className="num text-sm font-medium text-foreground">{download.validation.accounts}</strong></span>
              <span className="grid gap-0.5 text-xs text-muted-foreground">报价<strong className="num text-sm font-medium text-foreground">{download.validation.prices}</strong></span>
            </div>
            {!!download.validation.issues.length && <ul className="negative validation-issues list-disc space-y-1 ps-5 text-xs text-destructive-foreground">{download.validation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
            <p className="text-xs leading-relaxed text-muted-foreground">
              已下载到本机：{download.localFile}。恢复会在下次启动、打开数据库之前执行：先为当前账本创建 pre-restore 安全快照，再整库替换；
              暂存期间账本只读。云端快照不是同步协议，恢复会覆盖本机自该快照之后的修改。
            </p>
            <div className="toolbar flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={!download.validation.valid || busy}
                onClick={() => setConfirm(selectedItem)}
              >恢复此快照…</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDownload(null); setSelected(null); setRestorePassword(''); }}>关闭</Button>
            </div>
          </div>
        )}

        {confirm && (
          <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
            <section role="dialog" aria-modal="true" aria-labelledby="webdav-restore-title" className="modal w-full max-w-lg space-y-3 rounded-2xl border bg-card p-5 shadow-xl">
              <h2 id="webdav-restore-title" className="font-heading text-base font-semibold">确认从云端恢复账本？</h2>
              <p className="text-sm text-muted-foreground">将从 <strong className="text-foreground">{confirm.fileName}</strong> 恢复。系统会先为当前账本创建 pre-restore 安全快照，并归档当前数据库及其 WAL/SHM 文件。</p>
              <p className="text-sm text-muted-foreground">恢复会在下次启动时生效。请完全退出应用并重新启动；暂存期间所有写入会被拒绝。</p>
              <p className="text-xs leading-relaxed text-muted-foreground">这是整库替换，不是合并。若另一台设备在此快照之后写入，那些修改不会出现在恢复后的账本中。</p>
              <div className="toolbar flex justify-end gap-2">
                <Button variant="outline" size="sm" autoFocus disabled={busy} onClick={() => setConfirm(null)}>取消</Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void stageRemote()}>{working === 'stage' ? '正在安排…' : '确认安排恢复'}</Button>
              </div>
            </section>
          </div>
        )}

        {deleteTarget && (
          <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
            <section role="dialog" aria-modal="true" aria-labelledby="webdav-delete-title" className="modal w-full max-w-md space-y-3 rounded-2xl border bg-card p-5 shadow-xl">
              <h2 id="webdav-delete-title" className="font-heading text-base font-semibold">删除云端快照？</h2>
              <p className="text-sm text-muted-foreground">将从 WebDAV 目录删除 <strong className="text-foreground">{deleteTarget.fileName}</strong>。此操作不会影响本机账本与本地备份。</p>
              <div className="toolbar flex justify-end gap-2">
                <Button variant="outline" size="sm" autoFocus disabled={busy} onClick={() => setDeleteTarget(null)}>取消</Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void removeRemote(deleteTarget)}>{working === 'delete' ? '删除中…' : '确认删除'}</Button>
              </div>
            </section>
          </div>
        )}
      </CardPanel>
    </Card>
  );
}
