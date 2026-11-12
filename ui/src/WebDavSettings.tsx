import { useCallback, useEffect, useState } from 'react';
import { Cloud, CloudDownload, CloudUpload, Lock, RefreshCw, Server, ShieldCheck, Trash2 } from 'lucide-react';
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
    <section className="panel">
      <div className="section-heading">
        <h2><Cloud size={18}/> WebDAV 备份</h2>
        <span className="muted">{settings?.configured ? hostOf(settings.url) : '未配置'}</span>
      </div>

      {!desktop && <p className="muted">当前是浏览器预览。WebDAV 备份仅在桌面应用中可用。</p>}

      {settings?.lastError && <div className="alert error" role="alert"><strong>上次云端操作失败：</strong>{settings.lastError}</div>}

      {settings ? <p className="muted">
        上次上传：{timeLabel(settings.lastUploadAt)}{settings.lastUploadFile ? ` · ${settings.lastUploadFile}` : ''}
        {' · '}密码：{settings.hasPassword
          ? (settings.passwordSource === 'keychain' ? `系统凭据库 ${settings.passwordHint}` : `本次运行内存 ${settings.passwordHint}`)
          : '未保存'}
        {' · '}自动上传：{settings.autoUploadReady ? '已就绪' : settings.autoUpload ? '未就绪' : '已关闭'}
      </p> : <p className="muted">尚未读取 WebDAV 设置。</p>}

      {settings?.autoUpload && settings.encrypt && !settings.autoUploadReady && (
        <div className="alert warning">
          自动上传已开启但尚未就绪：加密上传需要在本次运行中提供备份密码。请填写下方备份密码并执行一次「立即上传备份」。
        </div>
      )}

      <div className="toolbar">
        <button className="primary" disabled={!desktop || !settings?.configured || busy || editing} onClick={() => void backupNow()}>
          <CloudUpload size={15}/>{working === 'upload' ? '上传中…' : '立即上传备份'}
        </button>
        <button disabled={!desktop || !settings?.configured || busy || editing} onClick={() => void refreshRemote()}>
          <RefreshCw size={15}/>{working === 'list' ? '读取中…' : '刷新云端快照'}
        </button>
        <button disabled={!desktop || busy} onClick={() => {
          setEditing(value => !value);
          if (settings) setForm(formOf(settings));
          setTestResult(null);
        }}><Server size={15}/>{editing ? '收起设置' : '编辑设置'}</button>
      </div>

      {!editing && settings?.configured && (
        <div className="backup-password-row">
          <label>WebDAV 应用密码（留空使用已保存密码）
            <input
              type="password"
              aria-label="WebDAV 应用密码"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={event => setPassword(event.target.value)}
              placeholder={settings.hasPassword ? `已保存 ${settings.passwordHint}` : '未保存密码'}
            />
          </label>
          {settings.encrypt ? <label>备份加密密码（本次运行，不保存）
            <input
              type="password"
              aria-label="备份加密密码"
              autoComplete="new-password"
              value={backupPassword}
              disabled={busy}
              onChange={event => setBackupPassword(event.target.value)}
              placeholder="至少 8 位；遗失不可恢复"
            />
          </label> : <span className="muted">未加密上传：WebDAV 服务商可读取快照内容（包括 SQLite 中的 AI API Key）。</span>}
        </div>
      )}

      {editing && (
        <div className="accounting-preferences">
          <label>服务器地址
            <input
              type="url"
              value={form.url}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, url: event.target.value }))}
              placeholder="https://dav.jianguoyun.com/dav/"
            />
          </label>
          <label>账号
            <input
              type="text"
              autoComplete="username"
              value={form.username}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, username: event.target.value }))}
              placeholder="坚果云 / Nextcloud 账号"
            />
          </label>
          <label>应用密码
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={busy}
              onChange={event => setPassword(event.target.value)}
              placeholder={settings?.hasPassword ? `已保存 ${settings.passwordHint}；留空不修改` : '服务器生成的应用密码'}
            />
          </label>
          <label>远程目录
            <input
              type="text"
              value={form.remoteDir}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, remoteDir: event.target.value }))}
              placeholder="/wheel/"
            />
          </label>
          <label>远端保留
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={form.keep}
              disabled={busy}
              onChange={event => setForm(current => ({ ...current, keep: Number(event.target.value) }))}
            />
            份自动上传快照（手动快照不会被自动删除）
          </label>
          <label className="check"><input
            type="checkbox"
            checked={form.autoUpload}
            disabled={busy}
            onChange={event => setForm(current => ({ ...current, autoUpload: event.target.checked }))}
          />每日自动备份后自动上传</label>
          <label className="check"><input
            type="checkbox"
            checked={form.encrypt}
            disabled={busy}
            onChange={event => setForm(current => ({ ...current, encrypt: event.target.checked }))}
          />加密上传（每次运行需提供备份密码）</label>
          <label className="check"><input
            type="checkbox"
            checked={form.allowInsecureHttp}
            disabled={busy}
            onChange={event => setForm(current => ({ ...current, allowInsecureHttp: event.target.checked }))}
          />允许不安全 HTTP（仅限 localhost / 局域网）</label>
          <p className="muted">
            应用密码保存在 Windows 凭据管理器；凭据库不可用时只保留在本次运行内存中，绝不写入 SQLite。
            恢复是整库替换而非同步：同一时间请只在一台设备上记账。手动快照与 pre-restore 安全快照不会被远端保留策略清理。
          </p>
          <div className="toolbar">
            <button className="primary" disabled={busy} onClick={() => void saveConfig()}>{working === 'save' ? '保存中…' : '保存设置'}</button>
            <button disabled={busy || !form.url.trim()} onClick={() => void testConnection()}>{working === 'test' ? '测试中…' : '测试连接'}</button>
            <button disabled={busy} onClick={() => { setEditing(false); if (settings) setForm(formOf(settings)); setTestResult(null); }}>取消</button>
          </div>
          {testResult && <div className={`alert ${testResult.writable ? 'success' : 'warning'}`} role="status">
            连接成功 · {testResult.writable ? '目录可写' : '目录只读（无法上传）'} · {testResult.snapshotCount} 份快照{testResult.server ? ` · ${testResult.server}` : ''}
          </div>}
        </div>
      )}

      <div className="section-heading">
        <h3>云端快照</h3>
        <span className="muted">{remote ? `${remote.length} 份 · 时间为本地时区` : '点击「刷新云端快照」读取'}</span>
      </div>

      {remote && (remote.length ? <div className="backup-list" role="list">
        {remote.map(item => <div key={item.fileName} className={`backup-row ${selected === item.fileName ? 'selected' : ''}`} role="listitem">
          <div className="backup-meta">
            <strong>{item.fileName}</strong>
            <span>
              <span className={`backup-kind ${item.fileName.startsWith('auto-') ? 'auto' : 'manual'}`}>{item.fileName.startsWith('auto-') ? '自动备份' : '手动备份'}</span>
              {item.encrypted && <span className="backup-lock"><Lock size={12}/>已加密</span>}
              {' · '}{sizeLabel(item.sizeBytes)}{' · '}{timeLabel(item.modifiedAt)}
            </span>
          </div>
          <div className="toolbar">
            <button disabled={busy} onClick={() => void inspectRemote(item)}>
              <CloudDownload size={14}/>{working === 'download' && selected === item.fileName ? '下载校验中…' : '恢复'}
            </button>
            <button className="danger" disabled={busy} onClick={() => setDeleteTarget(item)}><Trash2 size={14}/>删除</button>
          </div>
        </div>)}
      </div> : <p className="empty">云端目录中没有本应用的快照。上传后会显示在这里。</p>)}

      {selectedItem && !download && selectedItem.encrypted && (
        <div className="restore-validation">
          <div className="section-heading"><h3><Lock size={17}/> {selectedItem.fileName}</h3><span className="badge">已加密</span></div>
          <label className="restore-password">备份密码
            <input
              type="password"
              aria-label="云端备份密码"
              autoComplete="current-password"
              value={restorePassword}
              disabled={busy}
              onChange={event => setRestorePassword(event.target.value)}
            />
          </label>
          <p className="muted">下载后先在本机校验完整性与 schema；密码只用于校验和暂存，不会保存。</p>
          <div className="toolbar">
            <button disabled={busy || restorePassword.length < 8} onClick={() => void inspectRemote(selectedItem)}>
              {working === 'download' ? '下载校验中…' : '下载并校验'}
            </button>
            <button disabled={busy} onClick={() => { setSelected(null); setRestorePassword(''); }}>取消</button>
          </div>
        </div>
      )}

      {download && selectedItem && (
        <div className="restore-validation">
          <div className="section-heading">
            <h3><ShieldCheck size={17}/> {selectedItem.fileName}</h3>
            <span className={`badge ${download.validation.valid ? 'active' : 'closed'}`}>{download.validation.valid ? '校验通过' : '不可恢复'}</span>
          </div>
          <div className="validation-values">
            <span>完整性<strong>{download.validation.integrity || '未知'}</strong></span>
            <span>事件<strong>{download.validation.events}</strong></span>
            <span>账户<strong>{download.validation.accounts}</strong></span>
            <span>报价<strong>{download.validation.prices}</strong></span>
          </div>
          {!!download.validation.issues.length && <ul className="negative validation-issues">{download.validation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
          <p className="muted">
            已下载到本机：{download.localFile}。恢复会在下次启动、打开数据库之前执行：先为当前账本创建 pre-restore 安全快照，再整库替换；
            暂存期间账本只读。云端快照不是同步协议，恢复会覆盖本机自该快照之后的修改。
          </p>
          <div className="toolbar">
            <button
              className="danger"
              disabled={!download.validation.valid || busy}
              onClick={() => setConfirm(selectedItem)}
            >恢复此快照…</button>
            <button disabled={busy} onClick={() => { setDownload(null); setSelected(null); setRestorePassword(''); }}>关闭</button>
          </div>
        </div>
      )}

      {confirm && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="webdav-restore-title" className="modal">
        <h2 id="webdav-restore-title">确认从云端恢复账本？</h2>
        <p>将从 <strong>{confirm.fileName}</strong> 恢复。系统会先为当前账本创建 pre-restore 安全快照，并归档当前数据库及其 WAL/SHM 文件。</p>
        <p>恢复会在下次启动时生效。请完全退出应用并重新启动；暂存期间所有写入会被拒绝。</p>
        <p className="muted">这是整库替换，不是合并。若另一台设备在此快照之后写入，那些修改不会出现在恢复后的账本中。</p>
        <div className="toolbar">
          <button autoFocus disabled={busy} onClick={() => setConfirm(null)}>取消</button>
          <button className="danger" disabled={busy} onClick={() => void stageRemote()}>{working === 'stage' ? '正在安排…' : '确认安排恢复'}</button>
        </div>
      </section></div>}

      {deleteTarget && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="webdav-delete-title" className="modal">
        <h2 id="webdav-delete-title">删除云端快照？</h2>
        <p>将从 WebDAV 目录删除 <strong>{deleteTarget.fileName}</strong>。此操作不会影响本机账本与本地备份。</p>
        <div className="toolbar">
          <button autoFocus disabled={busy} onClick={() => setDeleteTarget(null)}>取消</button>
          <button className="danger" disabled={busy} onClick={() => void removeRemote(deleteTarget)}>{working === 'delete' ? '删除中…' : '确认删除'}</button>
        </div>
      </section></div>}
    </section>
  );
}
