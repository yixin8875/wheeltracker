import { useState } from 'react';
import { BellRingIcon, CalendarDaysIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
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

type BatchKind = 'option_expire' | 'option_assign';
type PasteMatch = { line: string; kind: BatchKind; position?: Position; conflict?: string };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchScore(upper: string, position: Position) {
  if (!new RegExp(`(^|[^A-Z0-9.])${escapeRegExp(position.symbol)}([^A-Z0-9.]|$)`).test(upper)) return 0;
  let score = 1;
  if (upper.includes(position.expiry)) score += 2;
  const strike = String(position.strike);
  const strikeShort = strike.endsWith('.0') ? strike.slice(0, -2) : strike;
  if (new RegExp(`(^|[^0-9.])${escapeRegExp(strikeShort)}([^0-9.]|$)`).test(upper)) score += 2;
  if (new RegExp(`(^|[^A-Z])${position.right}([^A-Z]|$)`).test(upper) || (position.right === 'P' ? /\bPUT\b/.test(upper) : /\bCALL\b/.test(upper))) score += 2;
  return score;
}

export function ExpiryCenter({ positions, leadDays, asOf, accountId, onEntry, onSettled, onOpenCampaign, onOpenCalendar }: {
  positions: Position[];
  leadDays: number;
  asOf: string;
  accountId: string;
  onEntry: (initial: Partial<NewEvent>) => void;
  onSettled?: (message: string) => void;
  onOpenCampaign: (id: string) => void;
  onOpenCalendar: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<ExpiryCheckSummary | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBatch, setPendingBatch] = useState<BatchKind | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pasteResult, setPasteResult] = useState<PasteMatch[] | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState('');
  const groups = expiryGroups(positions, leadDays);
  const reminders = positions.filter(position => position.daysLeft <= leadDays);
  const overdue = reminders.filter(position => position.daysLeft < 0).length;
  const todayCount = reminders.filter(position => position.daysLeft === 0).length;
  const critical = reminders.filter(position => position.daysLeft > 0 && position.daysLeft <= Math.min(3, leadDays)).length;
  const soon = reminders.filter(position => position.daysLeft > Math.min(3, leadDays) && position.daysLeft <= leadDays).length;
  const putObligation = reminders.reduce((total, position) => total + collateral(position), 0);
  const batchPositions = positions.filter(position => selected.has(position.contract));
  const batchQty = batchPositions.reduce((total, position) => total + position.openQty, 0);
  const batchObligation = batchPositions.reduce((total, position) => total + collateral(position), 0);
  const batchCash = batchPositions.reduce((total, position) => total + (position.right === 'P' ? -1 : 1) * position.strike * position.multiplier * position.openQty, 0);
  const batchShares = batchPositions.reduce((total, position) => total + (position.right === 'P' ? 1 : -1) * position.multiplier * position.openQty, 0);
  const pasteReady = pasteResult?.filter(match => match.position) ?? [];

  function toggleSelected(contract: string) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(contract)) next.delete(contract); else next.add(contract);
      return next;
    });
  }

  function toggleGroup(items: Position[], checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous);
      items.forEach(position => { if (checked) next.add(position.contract); else next.delete(position.contract); });
      return next;
    });
  }

  async function confirmBatch() {
    if (!pendingBatch || !batchPositions.length || batchBusy) return;
    setBatchBusy(true); setBatchError('');
    try {
      const reqs = batchPositions.map(position => ({
        accountId,
        kind: pendingBatch,
        date: pendingBatch === 'option_expire' ? position.expiry : today(),
        symbol: position.symbol,
        qty: position.openQty,
        expiry: position.expiry,
        strike: position.strike,
        right: position.right,
        multiplier: position.multiplier,
      }));
      await api<string[]>('add_events', { reqs });
      setSelected(new Set());
      setPendingBatch(null);
      onSettled?.(`已批量${pendingBatch === 'option_expire' ? '作废' : '指派'} ${reqs.length} 个合约。`);
    } catch (failure) {
      setBatchError(String(failure));
    } finally {
      setBatchBusy(false);
    }
  }

  function parsePaste() {
    const lines = pasteText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) { setPasteError('请先粘贴券商到期结果。'); setPasteResult(null); return; }
    const seen = new Set<string>();
    const matches: PasteMatch[] = [];
    for (const line of lines) {
      const upper = line.toUpperCase();
      const kind: BatchKind = /ASSIGN|EXERCIS|指派|行权/.test(upper) ? 'option_assign' : 'option_expire';
      const candidates = positions
        .map(position => ({ position, score: matchScore(upper, position) }))
        .filter(candidate => candidate.score >= 3)
        .sort((a, b) => b.score - a.score);
      if (!candidates.length) { matches.push({ line, kind }); continue; }
      const tied = candidates.filter(candidate => candidate.score === candidates[0].score);
      if (tied.length > 1) {
        matches.push({ line, kind, conflict: `匹配到多个合约：${tied.map(candidate => candidate.position.contract).join('、')}` });
        continue;
      }
      const position = candidates[0].position;
      const key = `${position.contract}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ line, kind, position });
    }
    setPasteError(''); setPasteResult(matches);
  }

  async function commitPaste() {
    if (!pasteReady.length || pasteBusy) return;
    setPasteBusy(true); setPasteError('');
    try {
      const reqs = pasteReady.map(({ position, kind }) => ({
        accountId,
        kind,
        date: kind === 'option_expire' ? position!.expiry : today(),
        symbol: position!.symbol,
        qty: position!.openQty,
        expiry: position!.expiry,
        strike: position!.strike,
        right: position!.right,
        multiplier: position!.multiplier,
      }));
      await api<string[]>('add_events', { reqs });
      setPasteResult(null); setPasteText('');
      onSettled?.(`已按券商结果入账 ${reqs.length} 条到期处理。`);
    } catch (failure) {
      setPasteError(String(failure));
    } finally {
      setPasteBusy(false);
    }
  }

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
              已检查：已过期 {summary.overdue} · 今天 {summary.today} · 3 天内 {summary.critical} · 提醒期内 {summary.soon}。{summary.notified ? `已发送 ${summary.notified} 条新通知。` : summary.total ? '没有新的系统通知。' : '当前没有到期提醒。'}{summary.alerts ? `另有 ${summary.alerts} 条条件提醒${summary.alertNotified ? `，已发送 ${summary.alertNotified} 条` : ''}。` : ''}
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

      {!!positions.length && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">批量处理</CardTitle>
            <CardDescription>勾选多个合约一起作废或指派；也可以直接粘贴券商的到期结果，由系统匹配当前持仓。</CardDescription>
          </CardHeader>
          <CardPanel className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-4 py-3">
              <span className="text-sm">已选 <strong className="num">{batchPositions.length}</strong> 个合约 · {batchQty} 手</span>
              <Button size="sm" variant="outline" disabled={!batchPositions.length} onClick={() => { setBatchError(''); setPendingBatch('option_expire'); }}>批量作废</Button>
              <Button size="sm" variant="outline" disabled={!batchPositions.length} onClick={() => { setBatchError(''); setPendingBatch('option_assign'); }}>批量指派</Button>
              {!!batchPositions.length && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清除选择</Button>}
              <span className="ms-auto text-xs text-muted-foreground">勾选表格左侧复选框，或用每组表头复选框全选</span>
            </div>

            <details className="rounded-xl border">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">粘贴券商到期结果</summary>
              <div className="space-y-3 border-t p-4">
                <p className="text-xs leading-relaxed text-muted-foreground">每行一个合约，包含标的、到期日、行权价和方向即可；带 ASSIGNED / 指派 / 行权 的行按指派处理，其余按到期作废。匹配不到或多重匹配的行会列在下方，不会入账。</p>
                <Textarea rows={4} aria-label="券商到期结果" placeholder={'例如：\nAAPL 2026-12-19 150P EXPIRED\nTSLA 2026-12-19 300C ASSIGNED'} value={pasteText} onChange={event => { setPasteText(event.target.value); setPasteResult(null); }} />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={parsePaste} disabled={!pasteText.trim()}>解析并匹配</Button>
                  {pasteResult && <span className="text-xs text-muted-foreground">可入账 {pasteReady.length} 条 · 未匹配 {pasteResult.length - pasteReady.length} 条</span>}
                </div>
                {pasteError && <Alert variant="error" role="alert">{pasteError}</Alert>}
                {pasteResult && (
                  pasteResult.length ? (
                    <>
                      <div className="overflow-hidden rounded-xl border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>粘贴内容</TableHead>
                              <TableHead>匹配合约</TableHead>
                              <TableHead>处理</TableHead>
                              <TableHead>手数</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {pasteResult.map((match, index) => (
                              <TableRow key={`${match.line}-${index}`}>
                                <TableCell className="max-w-[320px] whitespace-normal"><small>{match.line}</small></TableCell>
                                <TableCell>{match.position ? match.position.contract : '—'}</TableCell>
                                <TableCell>{labels[match.kind]}</TableCell>
                                <TableCell className={match.position ? 'num' : 'text-muted-foreground'}>{match.position ? `${match.position.openQty} 手` : match.conflict ?? '未匹配当前持仓'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {!!pasteReady.length && (
                        <div className="flex flex-wrap items-center gap-3">
                          <Button size="sm" disabled={pasteBusy} onClick={() => void commitPaste()}>{pasteBusy ? '正在入账…' : `写入 ${pasteReady.length} 条到期处理`}</Button>
                          <span className="text-xs text-muted-foreground">每条按该合约的全部未平仓手数处理；作废用到期日，指派用今天。</span>
                        </div>
                      )}
                    </>
                  ) : <p className="text-sm text-muted-foreground">没有可识别的行。</p>
                )}
              </div>
            </details>
          </CardPanel>
        </Card>
      )}

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
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label={`全选 ${group.title}`}
                        checked={group.items.every(position => selected.has(position.contract))}
                        onCheckedChange={checked => toggleGroup(group.items, checked === true)}
                      />
                    </TableHead>
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
                        <Checkbox
                          aria-label={`选择 ${position.contract}`}
                          checked={selected.has(position.contract)}
                          onCheckedChange={() => toggleSelected(position.contract)}
                        />
                      </TableCell>
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

      <AlertDialog open={!!pendingBatch} onOpenChange={open => { if (!open && !batchBusy) { setPendingBatch(null); setBatchError(''); } }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingBatch === 'option_assign' ? '批量标记指派？' : '批量标记到期作废？'}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBatch === 'option_assign'
                ? `将 ${batchPositions.length} 个合约共 ${batchQty} 手标记为指派。现金净变化 ${money(batchCash)}，持股变化 ${batchShares > 0 ? '+' : ''}${batchShares} 股。`
                : `将 ${batchPositions.length} 个合约共 ${batchQty} 手标记为到期作废。预计释放 Put 资金义务 ${money(batchObligation)}，不产生现金流。`}
              请确认与券商实际处理一致；入账后仍可在交易记录中撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-48 overflow-auto px-6 text-sm">
            <ul className="space-y-1">
              {batchPositions.map(position => (
                <li key={position.contract} className="flex justify-between gap-3">
                  <span>{position.contract}</span>
                  <span className="num text-muted-foreground">{position.openQty} 手</span>
                </li>
              ))}
            </ul>
          </div>
          {batchError && <Alert variant="error" role="alert" className="mx-6 mt-3 alert error">{batchError}</Alert>}
          <AlertDialogFooter className="mt-4">
            <AlertDialogClose render={<Button variant="outline" disabled={batchBusy}>取消</Button>} />
            <Button disabled={batchBusy || !batchPositions.length} onClick={() => void confirmBatch()}>
              {batchBusy ? '正在入账…' : pendingBatch === 'option_assign' ? '确认指派' : '确认作废'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
