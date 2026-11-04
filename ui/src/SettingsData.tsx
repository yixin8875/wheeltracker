import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, DatabaseBackup, FileJson, FileSpreadsheet, Lock, ShieldCheck } from 'lucide-react';
import type { AccountingSettings, AppInfo, Backup, BackupValidation, Campaign, Entry, EventRow, Position, RestoreStatus } from './types';
import { api, desktop, downloadBytes, downloadCsv } from './lib';
import { exportWorkbook } from './export';

const KIND_LABEL: Record<Backup['kind'], string> = { manual: '手动备份', auto: '自动备份', safety: '恢复前安全快照', unknown: '其他 SQLite' };

function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function SettingsData({ accountId, info, events, campaigns, entries, positions, settings, restoreStatus, onRestoreStatus, onNotice, onError, onPreferencesSaved }: {
  accountId: string; info: AppInfo | null; events: EventRow[]; campaigns: Campaign[]; entries: Entry[]; positions: Position[];
  settings: AccountingSettings | null; restoreStatus: RestoreStatus | null;
  onRestoreStatus: (status: RestoreStatus) => void; onNotice: (message: string) => void; onError: (message: string) => void;
  onPreferencesSaved: (settings: AccountingSettings) => void;
}) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [validation, setValidation] = useState<BackupValidation | null>(null);
  const [confirm, setConfirm] = useState<Backup | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [autoEnabled, setAutoEnabled] = useState(settings?.autoBackupEnabled ?? true);
  const [autoKeep, setAutoKeep] = useState(settings?.autoBackupKeep ?? 7);

  useEffect(() => { setAutoEnabled(settings?.autoBackupEnabled ?? true); setAutoKeep(settings?.autoBackupKeep ?? 7); }, [settings?.autoBackupEnabled, settings?.autoBackupKeep]);

  const loadBackups = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    try { setBackups(await api<Backup[]>('list_backups')); }
    catch (failure) { onError(String(failure)); }
    finally { setLoading(false); }
  }, [onError]);

  useEffect(() => { void loadBackups(); }, [loadBackups]);
  useEffect(() => {
    if (!desktop) return;
    api<RestoreStatus>('restore_status').then(onRestoreStatus).catch(() => undefined);
  }, [onRestoreStatus]);

  async function rebuild() {
    if (working) return;
    setWorking('rebuild');
    try {
      const result = await api<{ events: number; campaigns: number; entries: number; issues: string[] }>('rebuild', { accountId });
      if (result.issues.length) onError(result.issues.join('；'));
      else onNotice(`检查通过：${result.events} 笔交易、${result.campaigns} 个战役、${result.entries} 条台账。`);
    } catch (failure) { onError(String(failure)); }
    finally { setWorking(''); }
  }

  async function manualBackup() {
    if (working) return;
    const password = backupPassword;
    if (password && password.length < 8) { onError('加密密码至少需要 8 个字符。'); return; }
    setWorking('backup');
    try {
      const path = await api<string>('backup_now', { password: password || null });
      onNotice(password ? `加密备份已保存：${path}。请妥善保管密码，遗失后无法恢复。` : `备份已保存：${path}`);
      setBackupPassword('');
      await loadBackups();
    } catch (failure) { onError(String(failure)); }
    finally { setWorking(''); }
  }

  async function exportJson() {
    if (working) return;
    setWorking('json');
    try {
      const text = await api<string>('export_json');
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBytes(`wheel-ledger-${stamp}.json`, new TextEncoder().encode(text), 'application/json');
      onNotice(`已导出 JSON：${text.length.toLocaleString()} 字符，包含所有账户的事件、报价与设置。JSON 仅供查看与迁移，不能直接恢复。`);
    } catch (failure) { onError(String(failure)); }
    finally { setWorking(''); }
  }

  async function saveAutoBackup() {
    if (working || !settings) return;
    if (!Number.isInteger(autoKeep) || autoKeep < 1 || autoKeep > 100) { onError('自动备份保留份数必须是 1 到 100 之间的整数。'); return; }
    setWorking('preferences');
    try {
      const result = await api<AccountingSettings>('set_preferences', {
        reminderLeadDays: settings.reminderLeadDays,
        autoBackupEnabled: autoEnabled,
        autoBackupKeep: autoKeep,
      });
      onPreferencesSaved(result);
      onNotice(autoEnabled ? `自动备份已开启，保留最近 ${autoKeep} 份。` : '自动备份已关闭。');
    } catch (failure) { onError(String(failure)); }
    finally { setWorking(''); }
  }

  async function inspect(backup: Backup) {
    if (working) return;
    setSelected(backup.fileName); setValidation(null);
    if (backup.encrypted && !restorePassword) return;
    setWorking('validate');
    try { setValidation(await api<BackupValidation>('validate_backup', { fileName: backup.fileName, password: backup.encrypted ? restorePassword : null })); }
    catch (failure) { onError(String(failure)); }
    finally { setWorking(''); }
  }

  async function stage() {
    if (!confirm || working) return;
    setWorking('restore');
    try {
      await api<unknown>('stage_restore', { fileName: confirm.fileName, password: confirm.encrypted ? restorePassword : null });
      setConfirm(null);
      setRestorePassword('');
      onNotice('恢复已安排。请完全退出并重新启动应用，重启后才会替换当前账本。');
      try { onRestoreStatus(await api<RestoreStatus>('restore_status')); } catch { /* the banner also refreshes with the ledger */ }
    } catch (failure) { onError(String(failure)); }
    finally { setWorking(''); }
  }

  const pending = restoreStatus?.pending ?? null;
  const autoChanged = Boolean(settings) && (autoEnabled !== settings?.autoBackupEnabled || autoKeep !== settings?.autoBackupKeep);
  const selectedBackup = backups.find(backup => backup.fileName === selected) ?? null;
  const validationBackup = backups.find(backup => backup.fileName === validation?.fileName) ?? null;

  return <>
    <section className="panel">
      <div className="section-heading"><h2>备份与维护</h2><span className="muted">v{info?.version ?? '0.3.0'}</span></div>
      <p className="muted break-path">本地数据库：{info?.dbPath ?? '请在桌面应用中查看'}</p>
      <div className="toolbar">
        <button disabled={!desktop || Boolean(working)} onClick={() => void rebuild()}>{working === 'rebuild' ? '检查中…' : '重算并检查账本'}</button>
        <button disabled={!desktop || Boolean(working)} onClick={() => void manualBackup()}><DatabaseBackup size={15}/>{working === 'backup' ? '备份中…' : '备份 SQLite'}</button>
        <button disabled={!events.length} onClick={() => downloadCsv('wheel-events.csv', [['id', 'date', 'kind', 'symbol', 'qty', 'multiplier', 'split_numerator', 'split_denominator', 'split_cash_in_lieu', 'price', 'fees', 'amount', 'expiry', 'strike', 'right', 'note'], ...events.map(event => [event.id, event.date, event.kind, event.symbol, event.qty, event.multiplier, event.splitNumerator, event.splitDenominator, event.splitCashInLieu, event.price, event.fees, event.amount, event.expiry, event.strike, event.right, event.note])])}>导出交易 CSV</button>
        <button disabled={!events.length} onClick={() => { exportWorkbook({ entries, events, positions, campaigns }); onNotice(`已生成 Excel 工作簿：台账 ${entries.length} 条、交易 ${events.length} 笔、持仓 ${positions.length} 个、战役 ${campaigns.length} 个。`); }}><FileSpreadsheet size={15}/>导出 Excel 工作簿</button>
        <button disabled={!desktop || Boolean(working)} onClick={() => void exportJson()}><FileJson size={15}/>{working === 'json' ? '导出中…' : '导出 JSON'}</button>
      </div>
      <div className="backup-password-row">
        <label>加密密码（可选，至少 8 位）
          <input type="password" aria-label="备份加密密码" autoComplete="new-password" placeholder="留空则生成普通 .sqlite" value={backupPassword} disabled={!desktop || Boolean(working)} onChange={event => setBackupPassword(event.target.value)}/>
        </label>
        <span className="muted">填写后生成 .sqlite.enc 加密备份；密码遗失将无法恢复，请另行保存。JSON 导出包含所有账户的事件、报价与设置，仅供查看与迁移，不能直接恢复。</span>
      </div>
    </section>

    <section className="panel">
      <div className="section-heading"><h2>自动备份</h2><span className="muted">每天最多一次 · 仅清理自动备份</span></div>
      <div className="accounting-preferences auto-backup-form">
        <label className="check"><input type="checkbox" checked={autoEnabled} disabled={!desktop || !settings || Boolean(working)} onChange={event => setAutoEnabled(event.target.checked)}/>启用每日自动备份</label>
        <label>保留最近
          <input type="number" min={1} max={100} step={1} value={autoKeep} disabled={!desktop || !settings || Boolean(working)} onChange={event => setAutoKeep(Number(event.target.value))}/>
          份自动备份
        </label>
        <p className="muted">启动应用和每 30 分钟检查一次 UTC 日期；同一天只生成一份 auto-*.sqlite。手动备份与恢复前安全快照永不被自动清理。</p>
        <button className="primary" disabled={!desktop || !settings || Boolean(working) || !autoChanged} onClick={() => void saveAutoBackup()}>{working === 'preferences' ? '保存中…' : '保存自动备份设置'}</button>
      </div>
    </section>

    {(pending || restoreStatus?.lastResult || restoreStatus?.failed.length) && <section className="panel restore-panel">
      <div className="section-heading"><h2><ArchiveRestore size={18}/> 恢复状态</h2></div>
      {pending && <div className="alert warning" role="alert"><strong>等待重启：</strong>将从 {pending.backupFile} 恢复。请完全退出并重新启动应用；重启前账本只读。恢复前安全快照：{pending.safetyFile}。</div>}
      {restoreStatus?.lastResult && <div className={`alert ${restoreStatus.lastResult.ok ? 'success' : 'error'}`} role="status">
        <strong>{restoreStatus.lastResult.ok ? '上次恢复成功' : '上次恢复失败'}：</strong>{restoreStatus.lastResult.message}
        {restoreStatus.lastResult.safetyFile && <> · 安全快照 {restoreStatus.lastResult.safetyFile}</>}
        <small className="muted"> {restoreStatus.lastResult.at}</small>
      </div>}
      {!!restoreStatus?.failed.length && <p className="muted">已隔离 {restoreStatus.failed.length} 个失败标记：{restoreStatus.failed.join('、')}</p>}
    </section>}

    <section className="panel">
      <div className="section-heading"><h2>备份列表</h2><span className="muted">{loading ? '读取中…' : `${backups.length} 个文件 · 时间为 UTC`}</span></div>
      {!backups.length ? <p className="empty">还没有备份。点击「备份 SQLite」创建第一份手动备份。</p> : <div className="backup-list" role="list">
        {backups.map(backup => <div key={backup.fileName} className={`backup-row ${selected === backup.fileName ? 'selected' : ''}`} role="listitem">
          <div className="backup-meta"><strong>{backup.fileName}</strong><span><span className={`backup-kind ${backup.kind}`}>{KIND_LABEL[backup.kind]}</span>{backup.encrypted && <span className="backup-lock"><Lock size={12}/>已加密</span>} · {sizeLabel(backup.sizeBytes)} · {backup.modifiedAt ?? '时间未知'} UTC</span></div>
          <button disabled={!desktop || Boolean(working) || Boolean(pending)} onClick={() => void inspect(backup)}>{working === 'validate' && selected === backup.fileName ? '校验中…' : '校验与恢复'}</button>
        </div>)}
      </div>}
      {selectedBackup?.encrypted && !validation && <div className="restore-validation">
        <div className="section-heading"><h3><Lock size={17}/> {selectedBackup.fileName}</h3><span className="badge">已加密</span></div>
        <label className="restore-password">恢复密码
          <input type="password" aria-label="恢复密码" autoComplete="current-password" value={restorePassword} disabled={!desktop || Boolean(working)} onChange={event => setRestorePassword(event.target.value)}/>
        </label>
        <p className="muted">此备份使用密码加密，需先解密校验。密码只用于本次校验与暂存，不会保存。</p>
        <button disabled={!desktop || Boolean(working) || restorePassword.length < 8} onClick={() => void inspect(selectedBackup)}>{working === 'validate' ? '解密校验中…' : '解密并校验'}</button>
      </div>}
      {validation && <div className="restore-validation">
        <div className="section-heading"><h3><ShieldCheck size={17}/> {validation.fileName}</h3><span className={`badge ${validation.valid ? 'active' : 'closed'}`}>{validation.valid ? '校验通过' : '不可恢复'}</span></div>
        <div className="validation-values"><span>完整性<strong>{validation.integrity || '未知'}</strong></span><span>事件<strong>{validation.events}</strong></span><span>账户<strong>{validation.accounts}</strong></span><span>报价<strong>{validation.prices}</strong></span></div>
        {!!validation.issues.length && <ul className="negative validation-issues">{validation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        <p className="muted">恢复会在下次启动、打开数据库之前执行：先把当前账本归档，再替换为所选备份。若替换失败，会保留原数据库。暂存恢复后，账本在重启前只读。</p>
        <button className="danger" disabled={!validation.valid || Boolean(pending) || Boolean(working) || Boolean(validationBackup?.encrypted && restorePassword.length < 8)} onClick={() => { const backup = backups.find(item => item.fileName === validation.fileName); if (backup) setConfirm(backup); }}>恢复此备份…</button>
      </div>}
    </section>

    {confirm && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="restore-title" className="modal"><h2 id="restore-title">确认恢复账本？</h2><p>将从 <strong>{confirm.fileName}</strong> 恢复。系统会先为当前账本创建 pre-restore-*.sqlite 安全快照，并归档当前数据库及其 WAL/SHM 文件。</p>{confirm.encrypted && <p>此备份已加密：暂存时会用恢复密码解密出临时副本，替换完成后立即删除明文副本，原加密备份保留。</p>}<p>恢复会在下次启动时生效。请完全退出应用并重新启动；暂存期间所有写入会被拒绝。</p><div className="toolbar"><button autoFocus disabled={Boolean(working)} onClick={() => setConfirm(null)}>取消</button><button className="danger" disabled={Boolean(working) || Boolean(confirm.encrypted && restorePassword.length < 8)} onClick={() => void stage()}>{working === 'restore' ? '正在安排…' : '确认安排恢复'}</button></div></section></div>}
  </>;
}
