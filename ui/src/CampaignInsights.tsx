import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { AccountingSettings, CallScenario, EventRow } from './types';
import { api, desktop, labels, money } from './lib';

export function AccountingPreferences({ settings, onSaved }: { settings: AccountingSettings | null; onSaved: (settings: AccountingSettings) => Promise<void> | void }) {
  const [includeDividends, setIncludeDividends] = useState(settings?.includeDividendsInCost ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setIncludeDividends(settings?.includeDividendsInCost ?? false); }, [settings?.includeDividendsInCost]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !settings) return;
    setBusy(true); setError('');
    try {
      const result = await api<AccountingSettings>('set_settings', { includeDividendsInCost: includeDividends });
      await onSaved(result);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">成本口径</CardTitle>
        <CardDescription>对全部战役生效</CardDescription>
      </CardHeader>
      <CardPanel>
        {error && <Alert variant="error" role="alert" className="negative mb-3">{error}</Alert>}
        <form onSubmit={save} className="accounting-preferences space-y-4">
          <label className="check flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-3.5 rounded border-input accent-primary" checked={includeDividends} disabled={!desktop || !settings || busy} onChange={event => setIncludeDividends(event.target.checked)} />
            分红计入有效成本
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">开启后，已收到的分红会摊薄 B 和 C′ 每股成本，历史成本图也会重新计算。A 纯股票成本保持原口径。</p>
          <p className="text-xs leading-relaxed text-muted-foreground">分红始终计入战役总收益；这个开关只决定成本的展示口径，默认关闭。</p>
          <Button type="submit" disabled={!desktop || !settings || busy || includeDividends === settings.includeDividendsInCost}>{busy ? '保存中…' : '保存成本设置'}</Button>
        </form>
      </CardPanel>
    </Card>
  );
}

export function CampaignTimeline({ events, onUndo }: { events: EventRow[]; onUndo?: (id: string) => void }) {
  return (
    <Card render={<section />}>
      <CardHeader>
        <CardTitle className="text-base">战役事件时间轴</CardTitle>
        <CardDescription>{events.length} 笔交易 · 按交易日期排序</CardDescription>
      </CardHeader>
      <CardPanel>
        {!events.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>本轮暂无交易事件</EmptyTitle>
              <EmptyDescription>录入平仓、指派或分红后，会在这里形成时间轴。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="event-timeline relative grid gap-4 border-s ps-5">
            {events.map(event => {
              const option = event.kind.startsWith('option_');
              const split = event.kind === 'stock_split';
              const priced = ['option_open_short', 'option_close', 'shares_buy', 'shares_sell', 'dividend'].includes(event.kind);
              return (
                <li key={event.id} className="relative">
                  <span className="absolute -start-[1.4rem] top-1 size-2.5 rounded-full border border-background bg-border" aria-hidden="true" />
                  <time dateTime={event.date} className="num block text-xs text-muted-foreground">{event.date}</time>
                  <div className="timeline-event mt-0.5 grid gap-0.5">
                    <strong className="text-sm font-medium">{labels[event.kind] ?? event.kind}</strong>
                    <span className="text-sm">{event.symbol}{option && ` ${event.expiry} ${event.strike}${event.right}`}</span>
                    <p className="text-xs text-muted-foreground">
                      {split
                        ? `${event.splitNumerator} : ${event.splitDenominator}${event.splitCashInLieu != null ? ` · 零股补偿 ${money(event.splitCashInLieu)}` : ''}`
                        : ['fee', 'adjustment'].includes(event.kind) ? money(event.amount) : `${event.qty} ${option ? '手' : '股'}`}
                      {priced && ` · 每股 ${money(event.price)}`}{event.fees > 0 && ` · 费用 ${money(event.fees)}`}
                    </p>
                    {event.note && <p className="timeline-note text-xs text-muted-foreground">{event.note}</p>}
                    {onUndo && <Button variant="link" size="xs" className="timeline-undo w-fit" onClick={() => onUndo(event.id)}>撤销</Button>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardPanel>
    </Card>
  );
}

export function CallAssignmentScenarios({ scenarios }: { scenarios: CallScenario[] }) {
  return (
    <Card render={<section />}>
      <CardHeader>
        <CardTitle className="text-base">被 Call 走收益预览</CardTitle>
        <CardDescription>仅作情景估算</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">每种情景独立假设该 Call 的全部未平仓手数按行权价被指派，未来指派费用按 $0 估算。预览不会写入交易，也不预测实际指派。</p>
        {!scenarios.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>本轮没有未平仓 Call</EmptyTitle>
              <EmptyDescription>持有股票并卖出 Call 后，可在这里预览指派收益。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="call-scenarios grid gap-3 lg:grid-cols-2">
            {scenarios.map(scenario => (
              <article key={scenario.contract} className="call-scenario space-y-3 rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-heading text-sm font-semibold">{scenario.contract}</h3>
                    <p className="text-xs text-muted-foreground">{scenario.qty} 手 · 卖出 {scenario.sharesSold} 股 @ {money(scenario.strike)}</p>
                  </div>
                  <Badge variant={scenario.closesCampaign ? 'secondary' : 'warning'} size="sm">{scenario.closesCampaign ? '本轮结算' : '部分指派'}</Badge>
                </div>
                <dl className="scenario-values grid grid-cols-2 gap-x-4 gap-y-3">
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">卖股净收入</dt><dd className="num text-sm font-medium">{money(scenario.saleProceeds)}</dd></div>
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">累计股票已实现盈亏</dt><dd className="num text-sm font-medium">{money(scenario.sharePnl)}</dd></div>
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">累计已落袋期权净收益</dt><dd className="num text-sm font-medium">{money(scenario.premiumRealized)}</dd></div>
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">累计分红</dt><dd className="num text-sm font-medium">{money(scenario.dividends)}</dd></div>
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">现金调整及独立费用</dt><dd className="num text-sm font-medium">{money(scenario.adjustments)}</dd></div>
                  <div className="grid gap-0.5"><dt className="text-xs text-muted-foreground">预估本次指派费用</dt><dd className="num text-sm font-medium">{money(scenario.assignmentFees)}</dd></div>
                </dl>
                <div className="scenario-total flex items-baseline justify-between gap-2 border-t pt-3">
                  <span className="text-xs text-muted-foreground">{scenario.closesCampaign ? '预计本轮总收益' : '指派后累计已实现收益'}</span>
                  <strong className="num text-lg font-semibold tracking-tight">{money(scenario.realizedTotal)}</strong>
                </div>
                {!scenario.closesCampaign && <p className="text-xs leading-relaxed text-muted-foreground">仍持有 {scenario.remainingShares} 股、{scenario.remainingContracts} 手期权。本数值不含剩余股票浮盈亏及未平仓权利金，不代表本轮最终总收益。</p>}
              </article>
            ))}
          </div>
        )}
      </CardPanel>
    </Card>
  );
}
