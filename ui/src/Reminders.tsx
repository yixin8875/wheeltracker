import { useEffect, useState, type FormEvent } from 'react';
import { CalendarClockIcon, ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import type { AccountingSettings, Position } from './types';
import { api, desktop, money } from './lib';

export type ReminderSeverity = 'overdue' | 'critical' | 'soon' | 'later';

const severityTone: Record<ReminderSeverity, string> = {
  overdue: 'border-destructive/40 bg-destructive/5 text-destructive-foreground',
  critical: 'border-warning/40 bg-warning/5 text-warning-foreground',
  soon: 'border-border bg-muted/40',
  later: 'border-border bg-card',
};

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

export function ReminderCard({ positions, leadDays, onOpenExpiry, onOpenCalendar, onOpenCampaign }: {
  positions: Position[]; leadDays: number; onOpenExpiry: () => void; onOpenCalendar: () => void; onOpenCampaign: (id: string) => void;
}) {
  const reminders = reminderPositions(positions, leadDays);
  const overdue = reminders.filter(position => position.daysLeft < 0).length;
  return (
    <Card className="reminder-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><CalendarClockIcon className="size-4 text-muted-foreground" />到期提醒</CardTitle>
        <CardDescription>未来 {leadDays} 天 · 按美东交易日计算</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-3">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onOpenCalendar}>到期日历</Button>
          <Button variant="outline" size="sm" onClick={onOpenExpiry}>到期处理<ChevronRightIcon /></Button>
        </div>
        {!reminders.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>未来 {leadDays} 天内没有到期合约</EmptyTitle>
              <EmptyDescription>有新开合约后，临近到期时会在这里提醒。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="reminder-list grid gap-2">
            {overdue > 0 && (
              <p className="reminder-summary negative flex items-center gap-2 text-sm text-destructive-foreground" role="alert">
                <TriangleAlertIcon className="size-4" />
                {overdue} 个合约已过到期日，请核对后标记作废或指派。
              </p>
            )}
            {reminders.slice(0, 5).map(position => {
              const severity = reminderSeverity(position.daysLeft, leadDays);
              return (
                <button
                  key={position.contract}
                  type="button"
                  className={`reminder-row ${severity} flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent/60 ${severityTone[severity]}`}
                  onClick={() => onOpenCampaign(position.campaignId)}
                >
                  <span className="reminder-contract min-w-0 flex-1">
                    <strong className="block text-sm font-medium">{position.contract}</strong>
                    <small className="block truncate text-xs text-muted-foreground">{position.symbol} · {position.openQty} 手 · 净权利金 {money(position.avgCredit * position.openQty * position.multiplier)}</small>
                  </span>
                  <span className="reminder-day text-right text-xs">
                    <span className="block font-medium">{dayLabel(position.daysLeft)}</span>
                    <small className="block text-muted-foreground">{position.expiry}</small>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
            {reminders.length > 5 && (
              <Button variant="link" size="sm" className="reminder-more w-fit" onClick={onOpenExpiry}>
                另有 {reminders.length - 5} 个合约<ChevronRightIcon />
              </Button>
            )}
          </div>
        )}
      </CardPanel>
    </Card>
  );
}

export function ReminderPreferences({ settings, onSaved }: { settings: AccountingSettings | null; onSaved: (settings: AccountingSettings) => Promise<void> | void }) {
  const [leadDays, setLeadDays] = useState(settings?.reminderLeadDays ?? 7);
  const [systemNotifications, setSystemNotifications] = useState(settings?.systemNotificationsEnabled ?? false);
  const [closeToTray, setCloseToTray] = useState(settings?.closeToTray ?? false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    setLeadDays(settings?.reminderLeadDays ?? 7);
    setSystemNotifications(settings?.systemNotificationsEnabled ?? false);
    setCloseToTray(settings?.closeToTray ?? false);
  }, [settings?.reminderLeadDays, settings?.systemNotificationsEnabled, settings?.closeToTray]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !settings) return;
    if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 60) { setError('提醒天数必须是 0 到 60 之间的整数。'); return; }
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await api<AccountingSettings>('set_preferences', {
        reminderLeadDays: leadDays,
        autoBackupEnabled: settings.autoBackupEnabled,
        autoBackupKeep: settings.autoBackupKeep,
        systemNotificationsEnabled: systemNotifications,
        closeToTray,
      });
      await onSaved(result);
      setStatus('提醒设置已保存。');
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  async function testNotification() {
    if (testing || !desktop) return;
    setTesting(true); setError(''); setStatus('');
    try { await api('send_test_notification'); setStatus('测试通知已发送。若没有看到，请检查 Windows 通知设置。'); }
    catch (failure) { setError(String(failure)); }
    finally { setTesting(false); }
  }
  const changed = Boolean(settings) && (
    leadDays !== settings?.reminderLeadDays
    || systemNotifications !== settings?.systemNotificationsEnabled
    || closeToTray !== settings?.closeToTray
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">提醒设置</CardTitle>
        <CardDescription>应用内提醒 · 可选 Windows 系统通知与托盘</CardDescription>
      </CardHeader>
      <CardPanel>
        {error && <Alert variant="error" role="alert" className="negative mb-3">{error}</Alert>}
        {status && <Alert variant="success" role="status" className="positive mb-3">{status}</Alert>}
        <form onSubmit={save} className="accounting-preferences space-y-4">
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            提前提醒天数
            <Input type="number" min={0} max={60} step={1} className="max-w-40" value={leadDays} disabled={!desktop || !settings || busy} onChange={event => setLeadDays(Number(event.target.value))} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">0–60 天。剩余 3 天内的合约标为紧急，已过到期日的合约标为过期。侧栏、托盘与仪表盘会显示数量徽标。</p>
          <p className="text-xs leading-relaxed text-muted-foreground">到期天数按美东交易日计算；录入表单也默认使用纽约当前日期。</p>
          <label className="check flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-3.5 rounded border-input accent-primary" checked={systemNotifications} disabled={!desktop || !settings || busy} onChange={event => setSystemNotifications(event.target.checked)} />
            发送 Windows 系统通知
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">应用运行期间每小时检查一次；同一合约在每个到期阶段只提醒一次（进入提醒期、3 天内、到期当天、已过期）。窗口最小化时仍会提醒。</p>
          <label className="check flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-3.5 rounded border-input accent-primary" checked={closeToTray} disabled={!desktop || !settings || busy} onChange={event => setCloseToTray(event.target.checked)} />
            关闭窗口时隐藏到托盘
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">开启后点窗口关闭按钮只会隐藏窗口，应用继续运行并发送到期通知；从托盘菜单「退出」才会完全结束。</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!desktop || !settings || busy || !changed}>{busy ? '保存中…' : '保存提醒设置'}</Button>
            <Button type="button" variant="outline" disabled={!desktop || testing || busy} onClick={() => void testNotification()}>{testing ? '发送中…' : '发送测试通知'}</Button>
          </div>
        </form>
      </CardPanel>
    </Card>
  );
}
