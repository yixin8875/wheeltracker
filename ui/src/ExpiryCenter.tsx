import { useState } from 'react';
import { BellRingIcon, CalendarDaysIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, desktop, labels, money, today } from './lib';
import type { ExpiryCheckSummary, NewEvent, Position } from './types';

export type ExpiryBucket = 'overdue' | 'today' | 'critical' | 'soon' | 'later' | 'beyond';

export function expiryBucket(daysLeft: number, leadDays: number): ExpiryBucket {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft === 0) return 'today';
  if (daysLeft <= Math.min(3, leadDays)) return 'critical';
  if (daysLeft <= leadDays) return 'soon';
  if (daysLeft <= 30) return 'later';
  return 'beyond';
}

export function expiryGroups(positions: Position[], leadDays: number) {
  const groups: { key: Exclude<ExpiryBucket, 'beyond'>; title: string; note: string; tone: string }[] = [
    { key: 'overdue', title: '已过期', note: '券商可能已自动行权或作废，请先核对', tone: 'negative text-destructive-foreground' },
    { key: 'today', title: '今天到期', note: '今天收盘前需要决定：平仓、作废或准备指派', tone: 'warning-text text-warning-foreground' },
    { key: 'critical', title: '3 天内到期', note: '优先处理，避免资金义务临时增加', tone: 'warning-text text-warning-foreground' },
    { key: 'soon', title: `提醒期内（${leadDays} 天内）`, note: '可以开始考虑平仓或滚动', tone: '' },
    { key: 'later', title: '未来 30 天', note: '仅作提前查看，尚未进入提醒期', tone: 'text-muted-foreground' },
  ];
  return groups
    .map(group => ({ ...group, items: positions.filter(position => expiryBucket(position.daysLeft, leadDays) === group.key) }))
    .filter(group => group.items.length > 0);
}

function dayLabel(daysLeft: number) {
  if (daysLeft < 0) return `已过期 ${-daysLeft} 天`;
  if (daysLeft === 0) return '今天到期';
  return `${daysLeft} 天后到期`;
}

function collateral(position: Position) {
  return position.right === 'P' ? position.strike * position.multiplier * position.openQty : 0;
}

export function ExpiryCenter({ positions, leadDays, asOf, onEntry, onOpenCampaign, onOpenCalendar }: {
  positions: Position[];
  leadDays: number;
  asOf: string;
  onEntry: (initial: Partial<NewEvent>) => void;
  onOpenCampaign: (id: string) => void;
  onOpenCalendar: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<ExpiryCheckSummary | null>(null);
  const [error, setError] = useState('');
  const groups = expiryGroups(positions, leadDays);
  const reminders = positions.filter(position => position.daysLeft <= leadDays);
  const overdue = reminders.filter(position => position.daysLeft < 0).length;
  const todayCount = reminders.filter(position => position.daysLeft === 0).length;
  const critical = reminders.filter(position => position.daysLeft > 0 && position.daysLeft <= Math.min(3, leadDays)).length;
  const soon = reminders.filter(position => position.daysLeft > Math.min(3, leadDays) && position.daysLeft <= leadDays).length;
  const putObligation = reminders.reduce((total, position) => total + collateral(position), 0);

  async function checkNow() {
    if (checking || !desktop) return;
    setChecking(true); setError(''); setSummary(null);
    try { setSummary(await api<ExpiryCheckSummary>('check_expiries')); }
    catch (failure) { setError(String(failure)); }
    finally { setChecking(false); }
  }

  function act(position: Position, kind: 'option_close' | 'option_expire' | 'option_assign') {
    onEntry({
      kind,
      date: kind === 'option_expire' ? position.expiry : today(),
      symbol: position.symbol,
      qty: position.openQty,
      expiry: position.expiry,
      strike: position.strike,
      right: position.right,
      multiplier: position.multiplier,
    });
  }

  return (
    <div className="expiry-center grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">概览</CardTitle>
          <CardDescription>{asOf} · 按美东交易日 · 提醒期 {leadDays} 天</CardDescription>
        </CardHeader>
        <CardPanel className="space-y-4">
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={checkNow} disabled={!desktop || checking}>
              {checking ? <Spinner className="size-4" /> : <BellRingIcon />}
              {checking ? '检查中…' : '检查到期并通知'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onOpenCalendar}><CalendarDaysIcon />到期日历</Button>
          </div>
          <div className="expiry-summary grid gap-4 rounded-xl border bg-muted/40 p-4 sm:grid-cols-2 xl:grid-cols-5">
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">已过期</span><strong className={`num text-xl font-semibold ${overdue ? 'negative text-destructive-foreground' : ''}`}>{overdue}</strong><small className="text-xs text-muted-foreground">需核对后处理</small></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">今天到期</span><strong className={`num text-xl font-semibold ${todayCount ? 'warning-text text-warning-foreground' : ''}`}>{todayCount}</strong><small className="text-xs text-muted-foreground">美东今天</small></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">3 天内</span><strong className={`num text-xl font-semibold ${critical ? 'warning-text text-warning-foreground' : ''}`}>{critical}</strong><small className="text-xs text-muted-foreground">3 天内到期</small></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">提醒期内</span><strong className="num text-xl font-semibold">{soon}</strong><small className="text-xs text-muted-foreground">{leadDays} 天内 · 共 {reminders.length} 个</small></div>
            <div className="grid gap-0.5"><span className="text-xs text-muted-foreground">提醒期内 Put 义务</span><strong className="num text-xl font-semibold">{money(putObligation)}</strong><small className="text-xs text-muted-foreground">若全部被指派所需现金</small></div>
          </div>
          {error && <Alert variant="error" role="alert" className="negative">{error}</Alert>}
          {summary && (
            <Alert variant={summary.total ? 'success' : 'default'} role="status" className={summary.total ? 'positive' : ''}>
              已检查：已过期 {summary.overdue} · 今天 {summary.today} · 3 天内 {summary.critical} · 提醒期内 {summary.soon}。{summary.notified ? `已发送 ${summary.notified} 条新通知。` : summary.total ? '没有新的系统通知。' : '当前没有到期提醒。'}
            </Alert>
          )}
          {overdue > 0 && (
            <Alert variant="error" role="alert" className="expiry-alert">
              <TriangleAlertIcon />
              有 {overdue} 个合约已过到期日。请核对券商记录后作废、指派或平仓，不要让资金义务继续挂账。
            </Alert>
          )}
        </CardPanel>
      </Card>

      {!positions.length ? (
        <Card>
          <CardPanel>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有未平仓期权</EmptyTitle>
                <EmptyDescription>新开卖 Put / 卖 Call 后会自动进入到期处理。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardPanel>
        </Card>
      ) : !groups.length ? (
        <Card>
          <CardPanel>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>30 天内没有到期合约</EmptyTitle>
                <EmptyDescription>更远的合约可在「当前持仓」查看。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardPanel>
        </Card>
      ) : groups.map(group => (
        <Card className="expiry-group" key={group.key}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {group.title}
              <Badge variant="secondary" size="sm">{group.items.length}</Badge>
            </CardTitle>
            <CardDescription>{group.note}</CardDescription>
          </CardHeader>
          <CardPanel>
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>合约</TableHead>
                    <TableHead className="text-right">手数</TableHead>
                    <TableHead>到期日</TableHead>
                    <TableHead>剩余</TableHead>
                    <TableHead className="text-right">净权利金</TableHead>
                    <TableHead className="text-right">Put 资金义务</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.items.map(position => (
                    <TableRow key={`${group.key}-${position.contract}`} className={`expiry-row ${group.key}`}>
                      <TableCell>
                        <strong className="block font-medium">{position.contract}</strong>
                        <small className="block text-xs text-muted-foreground">{position.symbol} · {position.multiplier} 股/手</small>
                      </TableCell>
                      <TableCell className="num text-right">{position.openQty}</TableCell>
                      <TableCell className="num">{position.expiry}</TableCell>
                      <TableCell className={group.tone}>{dayLabel(position.daysLeft)}</TableCell>
                      <TableCell className="num text-right">{money(position.avgCredit * position.openQty * position.multiplier)}</TableCell>
                      <TableCell className="num text-right">{position.right === 'P' ? money(collateral(position)) : <span className="text-muted-foreground">按持股</span>}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1">
                          {(['option_close', 'option_expire', 'option_assign'] as const).map(kind => (
                            <Button key={kind} variant="outline" size="xs" onClick={() => act(position, kind)}>{labels[kind]}</Button>
                          ))}
                          <Button variant="ghost" size="xs" onClick={() => onOpenCampaign(position.campaignId)}>战役</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardPanel>
        </Card>
      ))}
      <p className="footnote text-xs leading-relaxed text-muted-foreground">按美东交易日计算。作废与指派需与券商实际处理一致；过期合约不会自动释放资金义务。系统通知仅在应用运行时检查。</p>
    </div>
  );
}
