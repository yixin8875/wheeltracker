import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestoreIcon, DatabaseBackupIcon, FileJsonIcon, FileSpreadsheetIcon, LockIcon, ShieldCheckIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import type { AccountingSettings, AppInfo, Backup, BackupValidation, Campaign, Entry, EventRow, Position, RestoreStatus } from './types';
import { api, desktop, downloadBytes, downloadCsv } from './lib';
import { exportWorkbook } from './export';
import { WebDavSettings } from './WebDavSettings';

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
        systemNotificationsEnabled: settings.systemNotificationsEnabled,
        closeToTray: settings.closeToTray,
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

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">本地备份与导出</CardTitle>
          <CardDescription>v{info?.version ?? '—'}</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          <p className="text-xs break-all text-muted-foreground">本地数据库：{info?.dbPath ?? '请在桌面应用中查看'}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!desktop || Boolean(working)} onClick={() => void rebuild()}>{working === 'rebuild' ? '检查中…' : '重算并检查账本'}</Button>
            <Button variant="outline" size="sm" disabled={!desktop || Boolean(working)} onClick={() => void manualBackup()}><DatabaseBackupIcon />{working === 'backup' ? '备份中…' : '备份 SQLite'}</Button>
            <Button variant="outline" size="sm" disabled={!events.length} onClick={() => downloadCsv('wheel-events.csv', [['id', 'date', 'kind', 'symbol', 'qty', 'multiplier', 'split_numerator', 'split_denominator', 'split_cash_in_lieu', 'price', 'fees', 'amount', 'expiry', 'strike', 'right', 'note'], ...events.map(event => [event.id, event.date, event.kind, event.symbol, event.qty, event.multiplier, event.splitNumerator, event.splitDenominator, event.splitCashInLieu, event.price, event.fees, event.amount, event.expiry, event.strike, event.right, event.note])])}>导出交易 CSV</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!events.length}
              onClick={() => { exportWorkbook({ entries, events, positions, campaigns }); onNotice(`已生成 Excel 工作簿：台账 ${entries.length} 条、交易 ${events.length} 笔、持仓 ${positions.length} 个、战役 ${campaigns.length} 个。`); }}
            >
              <FileSpreadsheetIcon />导出 Excel 工作簿
            </Button>
            <Button variant="outline" size="sm" disabled={!desktop || Boolean(working)} onClick={() => void exportJson()}><FileJsonIcon />{working === 'json' ? '导出中…' : '导出 JSON'}</Button>
          </div>
          <div className="backup-password-row flex flex-wrap items-end gap-3 rounded-xl border bg-muted/30 p-3">
            <label className="grid min-w-56 flex-1 gap-1.5 text-xs font-medium text-muted-foreground">
              加密密码（可选，至少 8 位）
              <Input type="password" aria-label="备份加密密码" autoComplete="new-password" placeholder="留空则生成普通 .sqlite" value={backupPassword} disabled={!desktop || Boolean(working)} onChange={event => setBackupPassword(event.target.value)} />
            </label>
            <span className="max-w-md text-xs leading-relaxed text-muted-foreground">填写后生成 .sqlite.enc 加密备份；密码遗失无法恢复。JSON 含全部事件、报价与设置，仅供查看与迁移，不能恢复。</span>
          </div>
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">自动备份</CardTitle>
          <CardDescription>每天最多一次 · 仅清理自动备份</CardDescription>
        </CardHeader>
        <CardPanel className="auto-backup-form space-y-3">
          <label className="check flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-3.5 rounded border-input accent-primary" checked={autoEnabled} disabled={!desktop || !settings || Boolean(working)} onChange={event => setAutoEnabled(event.target.checked)} />
            启用每日自动备份
          </label>
          <label className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            保留最近
            <Input type="number" className="w-24" min={1} max={100} step={1} value={autoKeep} disabled={!desktop || !settings || Boolean(working)} onChange={event => setAutoKeep(Number(event.target.value))} />
            份自动备份
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">启动时与每 30 分钟检查一次 UTC 日期，同一天只生成一份 auto-*.sqlite。手动备份与恢复前快照不会被自动清理。</p>
          <Button disabled={!desktop || !settings || Boolean(working) || !autoChanged} onClick={() => void saveAutoBackup()}>{working === 'preferences' ? '保存中…' : '保存自动备份设置'}</Button>
        </CardPanel>
      </Card>

      {(pending || restoreStatus?.lastResult || (restoreStatus?.failed.length ?? 0) > 0) && (
        <Card className="restore-panel">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ArchiveRestoreIcon className="size-4 text-muted-foreground" />恢复状态</CardTitle>
          </CardHeader>
          <CardPanel className="space-y-2">
            {pending && <Alert variant="warning" role="alert"><strong>等待重启：</strong>将从 {pending.backupFile} 恢复。请完全退出并重新启动应用；重启前账本只读。恢复前安全快照：{pending.safetyFile}。</Alert>}
            {restoreStatus?.lastResult && (
              <Alert variant={restoreStatus.lastResult.ok ? 'success' : 'error'} role="status" className={restoreStatus.lastResult.ok ? 'success' : 'error'}>
                <strong>{restoreStatus.lastResult.ok ? '上次恢复成功' : '上次恢复失败'}：</strong>{restoreStatus.lastResult.message}
                {restoreStatus.lastResult.safetyFile && <> · 安全快照 {restoreStatus.lastResult.safetyFile}</>}
                <small className="text-muted-foreground"> {restoreStatus.lastResult.at}</small>
              </Alert>
            )}
            {!!restoreStatus?.failed.length && <p className="text-xs text-muted-foreground">已隔离 {restoreStatus.failed.length} 个失败标记：{restoreStatus.failed.join('、')}</p>}
          </CardPanel>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">备份列表</CardTitle>
          <CardDescription>{loading ? '读取中…' : `${backups.length} 个文件 · 时间为 UTC`}</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-3">
          {!backups.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>还没有备份</EmptyTitle>
                <EmptyDescription>点击「备份 SQLite」创建第一份手动备份。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="backup-list grid gap-2" role="list">
              {backups.map(backup => (
                <div key={backup.fileName} className={`backup-row flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${selected === backup.fileName ? 'selected bg-accent/60' : ''}`} role="listitem">
                  <div className="backup-meta min-w-0">
                    <strong className="block truncate text-sm font-medium">{backup.fileName}</strong>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant={backup.kind === 'manual' ? 'info' : backup.kind === 'auto' ? 'secondary' : 'outline'} size="sm">{KIND_LABEL[backup.kind]}</Badge>
                      {backup.encrypted && <span className="backup-lock inline-flex items-center gap-1"><LockIcon className="size-3" />已加密</span>}
                      · {sizeLabel(backup.sizeBytes)} · {backup.modifiedAt ?? '时间未知'} UTC
                    </span>
                  </div>
                  <Button variant="outline" size="xs" disabled={!desktop || Boolean(working) || Boolean(pending)} onClick={() => void inspect(backup)}>{working === 'validate' && selected === backup.fileName ? '校验中…' : '校验与恢复'}</Button>
                </div>
              ))}
            </div>
          )}
          {selectedBackup?.encrypted && !validation && (
            <div className="restore-validation space-y-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-heading flex items-center gap-2 text-sm font-semibold"><LockIcon className="size-4" /> {selectedBackup.fileName}</h3>
                <Badge variant="outline" size="sm">已加密</Badge>
              </div>
              <label className="grid max-w-xs gap-1.5 text-xs font-medium text-muted-foreground">
                恢复密码
                <Input type="password" aria-label="恢复密码" autoComplete="current-password" value={restorePassword} disabled={!desktop || Boolean(working)} onChange={event => setRestorePassword(event.target.value)} />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">此备份使用密码加密，需先解密校验。密码只用于本次校验与暂存，不会保存。</p>
              <Button variant="outline" size="sm" disabled={!desktop || Boolean(working) || restorePassword.length < 8} onClick={() => void inspect(selectedBackup)}>{working === 'validate' ? '解密校验中…' : '解密并校验'}</Button>
            </div>
          )}
          {validation && (
            <div className="restore-validation space-y-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-heading flex items-center gap-2 text-sm font-semibold"><ShieldCheckIcon className="size-4" /> {validation.fileName}</h3>
                <Badge variant={validation.valid ? 'success' : 'destructive'} size="sm">{validation.valid ? '校验通过' : '不可恢复'}</Badge>
              </div>
              <div className="validation-values grid grid-cols-2 gap-3 sm:grid-cols-4">
                <span className="grid gap-0.5 text-xs text-muted-foreground">完整性<strong className="num text-sm font-medium text-foreground">{validation.integrity || '未知'}</strong></span>
                <span className="grid gap-0.5 text-xs text-muted-foreground">事件<strong className="num text-sm font-medium text-foreground">{validation.events}</strong></span>
                <span className="grid gap-0.5 text-xs text-muted-foreground">账户<strong className="num text-sm font-medium text-foreground">{validation.accounts}</strong></span>
                <span className="grid gap-0.5 text-xs text-muted-foreground">报价<strong className="num text-sm font-medium text-foreground">{validation.prices}</strong></span>
              </div>
              {!!validation.issues.length && <ul className="negative validation-issues list-disc space-y-1 ps-5 text-xs text-destructive-foreground">{validation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
              <p className="text-xs leading-relaxed text-muted-foreground">恢复会在下次启动、打开数据库之前执行：先把当前账本归档，再替换为所选备份。若替换失败，会保留原数据库。暂存恢复后，账本在重启前只读。</p>
              <Button
                variant="destructive"
                size="sm"
                disabled={!validation.valid || Boolean(pending) || Boolean(working) || Boolean(validationBackup?.encrypted && restorePassword.length < 8)}
                onClick={() => { const backup = backups.find(item => item.fileName === validation.fileName); if (backup) setConfirm(backup); }}
              >
                恢复此备份…
              </Button>
            </div>
          )}
        </CardPanel>
      </Card>

      <WebDavSettings onNotice={onNotice} onError={onError} onRestoreStatus={onRestoreStatus} />

      {confirm && (
        <div className="modal-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
          <section role="dialog" aria-modal="true" aria-labelledby="restore-title" className="modal w-full max-w-lg space-y-3 rounded-2xl border bg-card p-5 shadow-xl">
            <h2 id="restore-title" className="font-heading text-base font-semibold">确认恢复账本？</h2>
            <p className="text-sm text-muted-foreground">将从 <strong className="text-foreground">{confirm.fileName}</strong> 恢复。系统会先为当前账本创建 pre-restore-*.sqlite 安全快照，并归档当前数据库及其 WAL/SHM 文件。</p>
            {confirm.encrypted && <p className="text-sm text-muted-foreground">此备份已加密：暂存时会用恢复密码解密出临时副本，替换完成后立即删除明文副本，原加密备份保留。</p>}
            <p className="text-sm text-muted-foreground">恢复会在下次启动时生效。请完全退出应用并重新启动；暂存期间所有写入会被拒绝。</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" autoFocus disabled={Boolean(working)} onClick={() => setConfirm(null)}>取消</Button>
              <Button variant="destructive" size="sm" disabled={Boolean(working) || Boolean(confirm.encrypted && restorePassword.length < 8)} onClick={() => void stage()}>{working === 'restore' ? '正在安排…' : '确认安排恢复'}</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
