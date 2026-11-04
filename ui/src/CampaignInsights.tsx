import { useEffect, useState, type FormEvent } from 'react';
import type { AccountingSettings, CallScenario, EventRow } from './types';
import { api, desktop, labels, money } from './lib';

export function AccountingPreferences({ settings, onSaved }: { settings: AccountingSettings | null; onSaved: (settings: AccountingSettings) => Promise<void> }) {
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
  return <section className="panel">
    <div className="section-heading"><h2>成本口径</h2><span className="muted">对全部战役生效</span></div>
    {error && <p className="negative" role="alert">{error}</p>}
    <form onSubmit={save} className="accounting-preferences">
      <label className="check"><input type="checkbox" checked={includeDividends} disabled={!desktop || !settings || busy} onChange={event => setIncludeDividends(event.target.checked)}/>分红计入有效成本</label>
      <p className="muted">开启后，已收到的分红会摊薄 B 和 C′ 每股成本，历史成本图也会重新计算。A 纯股票成本保持原口径。</p>
      <p className="muted">分红始终计入战役总收益；这个开关只决定成本的展示口径，默认关闭。</p>
      <button className="primary" disabled={!desktop || !settings || busy || includeDividends === settings.includeDividendsInCost}>{busy ? '保存中…' : '保存成本设置'}</button>
    </form>
  </section>;
}

export function CampaignTimeline({ events }: { events: EventRow[] }) {
  return <section className="panel">
    <div className="section-heading"><h2>战役事件时间轴</h2><span className="muted">{events.length} 笔交易 · 按交易日期排序</span></div>
    {!events.length ? <p className="empty">本轮暂无交易事件。</p> : <ol className="event-timeline">{events.map(event => {
      const option = event.kind.startsWith('option_');
      const priced = ['option_open_short', 'option_close', 'shares_buy', 'shares_sell', 'dividend'].includes(event.kind);
      return <li key={event.id}>
        <time dateTime={event.date}>{event.date}</time>
        <div className="timeline-event"><strong>{labels[event.kind] ?? event.kind}</strong><span>{event.symbol}{option && ` ${event.expiry} ${event.strike}${event.right}`}</span>
          <p className="muted">{['fee', 'adjustment'].includes(event.kind) ? money(event.amount) : `${event.qty} ${option ? '手' : '股'}`}{priced && ` · 每股 ${money(event.price)}`}{event.fees > 0 && ` · 费用 ${money(event.fees)}`}</p>
          {event.note && <p className="timeline-note">{event.note}</p>}
        </div>
      </li>;
    })}</ol>}
  </section>;
}

export function CallAssignmentScenarios({ scenarios }: { scenarios: CallScenario[] }) {
  return <section className="panel">
    <div className="section-heading"><h2>被 Call 走收益预览</h2><span className="muted">仅作情景估算</span></div>
    <p className="muted">每种情景独立假设该 Call 的全部未平仓手数按行权价被指派，未来指派费用按 $0 估算。预览不会写入交易，也不预测实际指派。</p>
    {!scenarios.length ? <p className="empty">本轮没有未平仓 Call。持有股票并卖出 Call 后，可在这里预览指派收益。</p> : <div className="call-scenarios">{scenarios.map(scenario => <article key={scenario.contract} className="call-scenario">
      <div className="section-heading"><div><h3>{scenario.contract}</h3><p className="muted">{scenario.qty} 手 · 卖出 {scenario.sharesSold} 股 @ {money(scenario.strike)}</p></div><span className={`badge ${scenario.closesCampaign ? 'closed' : 'active'}`}>{scenario.closesCampaign ? '本轮结算' : '部分指派'}</span></div>
      <dl className="scenario-values">
        <div><dt>卖股净收入</dt><dd>{money(scenario.saleProceeds)}</dd></div>
        <div><dt>累计股票已实现盈亏</dt><dd>{money(scenario.sharePnl)}</dd></div>
        <div><dt>累计已落袋期权净收益</dt><dd>{money(scenario.premiumRealized)}</dd></div>
        <div><dt>累计分红</dt><dd>{money(scenario.dividends)}</dd></div>
        <div><dt>现金调整及独立费用</dt><dd>{money(scenario.adjustments)}</dd></div>
        <div><dt>预估本次指派费用</dt><dd>{money(scenario.assignmentFees)}</dd></div>
      </dl>
      <div className="scenario-total"><span>{scenario.closesCampaign ? '预计本轮总收益' : '指派后累计已实现收益'}</span><strong>{money(scenario.realizedTotal)}</strong></div>
      {!scenario.closesCampaign && <p className="muted">仍持有 {scenario.remainingShares} 股、{scenario.remainingContracts} 手期权。本数值不含剩余股票浮盈亏及未平仓权利金，不代表本轮最终总收益。</p>}
    </article>)}</div>}
  </section>;
}
