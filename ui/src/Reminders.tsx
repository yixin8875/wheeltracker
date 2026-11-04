import { useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, ChevronRight, TriangleAlert } from 'lucide-react';
import type { AccountingSettings, Position } from './types';
import { api, desktop, money } from './lib';

export type ReminderSeverity = 'overdue' | 'critical' | 'soon' | 'later';

export function reminderSeverity(daysLeft: number, leadDays: number): ReminderSeverity {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= Math.min(3, leadDays)) return 'critical';
  if (daysLeft <= leadDays) return 'soon';
  return 'later';
}

export function reminderPositions(positions: Position[], leadDays: number) {
  return positions
    .filter(position => reminderSeverity(position.daysLeft, leadDays) !== 'later')
    .sort((left, right) => left.daysLeft - right.daysLeft || left.contract.localeCompare(right.contract));
}

function dayLabel(daysLeft: number) {
  if (daysLeft < 0) return `已过期 ${-daysLeft} 天`;
  if (daysLeft === 0) return '今天到期';
  return `${daysLeft} 天后到期`;
}

export function ReminderCard({ positions, leadDays, onOpenPositions, onOpenCalendar, onOpenCampaign }: {
  positions: Position[]; leadDays: number; onOpenPositions: () => void; onOpenCalendar: () => void; onOpenCampaign: (id: string) => void;
}) {
  const reminders = reminderPositions(positions, leadDays);
  const overdue = reminders.filter(position => position.daysLeft < 0).length;
  return <section className="panel reminder-card">
    <div className="section-heading">
      <div><h2><CalendarClock size={18}/> 到期提醒</h2><span className="muted">未来 {leadDays} 天 · 按美东交易日计算</span></div>
      <div className="toolbar"><button onClick={onOpenCalendar}>到期日历</button><button onClick={onOpenPositions}>全部持仓<ChevronRight size={15}/></button></div>
    </div>
    {!reminders.length ? <p className="empty">未来 {leadDays} 天内没有到期合约。</p> : <div className="reminder-list">
      {overdue > 0 && <p className="reminder-summary negative" role="alert"><TriangleAlert size={15}/>{overdue} 个合约已过到期日，请核对后标记作废或指派。</p>}
      {reminders.slice(0, 5).map(position => {
        const severity = reminderSeverity(position.daysLeft, leadDays);
        return <button key={position.contract} className={`reminder-row ${severity}`} onClick={() => onOpenCampaign(position.campaignId)}>
          <span className="reminder-contract"><strong>{position.contract}</strong><small>{position.symbol} · {position.openQty} 手 · 净权利金 {money(position.avgCredit * position.openQty * position.multiplier)}</small></span>
          <span className="reminder-day">{dayLabel(position.daysLeft)}<small>{position.expiry}</small></span>
          <ChevronRight size={16}/>
        </button>;
      })}
      {reminders.length > 5 && <button className="text-button reminder-more" onClick={onOpenPositions}>另有 {reminders.length - 5} 个合约<ChevronRight size={15}/></button>}
    </div>}
  </section>;
}

export function ReminderPreferences({ settings, onSaved }: { settings: AccountingSettings | null; onSaved: (settings: AccountingSettings) => Promise<void> | void }) {
  const [leadDays, setLeadDays] = useState(settings?.reminderLeadDays ?? 7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setLeadDays(settings?.reminderLeadDays ?? 7); }, [settings?.reminderLeadDays]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !settings) return;
    if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 60) { setError('提醒天数必须是 0 到 60 之间的整数。'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<AccountingSettings>('set_preferences', {
        reminderLeadDays: leadDays,
        autoBackupEnabled: settings.autoBackupEnabled,
        autoBackupKeep: settings.autoBackupKeep,
      });
      await onSaved(result);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  const changed = Boolean(settings) && leadDays !== settings?.reminderLeadDays;
  return <section className="panel">
    <div className="section-heading"><h2>到期提醒</h2><span className="muted">仅应用内提醒，不发送系统通知</span></div>
    {error && <p className="negative" role="alert">{error}</p>}
    <form onSubmit={save} className="accounting-preferences">
      <label>提前提醒天数
        <input type="number" min={0} max={60} step={1} value={leadDays} disabled={!desktop || !settings || busy} onChange={event => setLeadDays(Number(event.target.value))}/>
      </label>
      <p className="muted">0–60 天。剩余 3 天内的合约标为紧急，已过到期日的合约标为过期。侧栏与仪表盘会显示数量徽标。</p>
      <p className="muted">到期天数按美东交易日计算；录入表单也默认使用纽约当前日期。</p>
      <button className="primary" disabled={!desktop || !settings || busy || !changed}>{busy ? '保存中…' : '保存提醒设置'}</button>
    </form>
  </section>;
}
