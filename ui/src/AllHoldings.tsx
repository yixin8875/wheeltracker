import { Layers, TriangleAlert } from 'lucide-react';
import { money, percent } from './lib';
import type { AllHoldings } from './types';

function tone(value: number | null | undefined) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'positive' : 'negative';
}

function pnlLabel(value: number | null | undefined) {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${money(value)}`;
}

export function AllHoldingsPage({ view, onOpenHolding }: {
  view: AllHoldings;
  onOpenHolding: (accountId: string, campaignId: string) => void;
}) {
  const { holdings, options, totals } = view;
  return <section className="panel overview">
    <div className="section-heading">
      <div><h2><Layers size={18}/> 全部账户持仓</h2><span className="muted">{view.asOf} · 只读汇总 · 各账户分别列示，不合并持仓</span></div>
    </div>

    <div className="summary-strip overview-summary holdings-summary">
      <div><span>持仓市值</span><strong>{money(totals.marketValue)}</strong><small>{totals.pricedHoldings} 个持仓有参考价 · 共 {totals.totalShares} 股</small></div>
      <div><span>浮动盈亏</span><strong className={tone(totals.unrealizedPnl)}>{pnlLabel(totals.unrealizedPnl)}</strong><small>{percent(totals.unrealizedPct)} · 按实际成本口径</small></div>
      <div><span>实际成本总额</span><strong>{money(totals.costBasis)}</strong><small>已扣除这些持仓所属战役的累计落袋净权利金</small></div>
      <div><span>已落袋净权利金</span><strong>{money(totals.premiumRealized)}</strong><small>未平仓净权利金 {money(totals.premiumOpen)}</small></div>
      <div><span>未平仓 Put 义务</span><strong>{money(totals.optionCollateral)}</strong><small>{totals.optionCount} 个合约 · {totals.openContracts} 手</small></div>
    </div>

    {totals.unpricedHoldings > 0 && <div className="alert warning" role="status"><TriangleAlert size={16}/>有 {totals.unpricedHoldings} 个持仓尚无参考价，未计入持仓市值、实际成本总额与浮动盈亏。请先在「行情」页更新报价。</div>}

    <div className="section-heading"><h2>股票持仓</h2><span className="muted">{holdings.length} 个持仓</span></div>
    {!holdings.length ? <p className="empty">全部账户暂无股票持仓。</p> : <div className="table-wrap"><table className="overview-table holdings-table">
      <thead><tr><th>账户</th><th>标的</th><th>股数</th><th>实际成本 / 股</th><th>纯股票成本 / 股</th><th>参考价</th><th>持仓盈亏</th><th>盈亏率</th><th>操作</th></tr></thead>
      <tbody>{holdings.map(holding => <tr key={`${holding.accountId}:${holding.campaignId}`}>
        <td><strong>{holding.accountName}</strong><small className="muted">已落袋 {money(holding.premiumRealized)}</small></td>
        <td><strong>{holding.symbol}</strong><small className="muted">{holding.startedAt} 开始</small></td>
        <td>{holding.shares}</td>
        <td><strong>{money(holding.costB)}</strong>{holding.costC != null && <small className="muted">含未平仓 {money(holding.costC)}</small>}</td>
        <td>{money(holding.costA)}</td>
        <td>{money(holding.price)}{holding.price == null && <span className="account-tag">无参考价</span>}</td>
        <td className={tone(holding.unrealizedPnl)}>{pnlLabel(holding.unrealizedPnl)}{holding.costBasis != null && <small className="muted">成本 {money(holding.costBasis)}</small>}</td>
        <td className={tone(holding.unrealizedPnl)}>{percent(holding.unrealizedPct)}</td>
        <td><button onClick={() => onOpenHolding(holding.accountId, holding.campaignId)}>打开战役</button></td>
      </tr>)}</tbody>
    </table></div>}

    <div className="section-heading"><h2>未平仓期权</h2><span className="muted">按到期日排序 · 全部账户</span></div>
    {!options.length ? <p className="empty">全部账户暂无未平仓期权。</p> : <div className="table-wrap"><table className="overview-table holdings-table">
      <thead><tr><th>账户</th><th>合约</th><th>手数</th><th>每股净权利金</th><th>到期日</th><th>剩余天数</th><th>Put 义务</th><th>操作</th></tr></thead>
      <tbody>{options.map(option => <tr key={`${option.accountId}:${option.contract}`}>
        <td>{option.accountName}</td>
        <td>{option.contract}</td>
        <td>{option.openQty}</td>
        <td>{money(option.avgCredit)}</td>
        <td>{option.expiry}</td>
        <td><span className={option.daysLeft < 0 ? 'negative' : option.daysLeft <= 7 ? 'warning-text' : ''}>{option.daysLeft < 0 ? `已过期 ${-option.daysLeft} 天` : `${option.daysLeft} 天`}</span></td>
        <td>{option.right === 'P' ? money(option.collateral) : '—'}</td>
        <td><button onClick={() => onOpenHolding(option.accountId, option.campaignId)}>打开战役</button></td>
      </tr>)}</tbody>
    </table></div>}

    <p className="footnote">实际成本 = 纯股票成本扣减已落袋净权利金（按当前口径计入分红）；持仓盈亏 =（参考价 − 实际成本）× 股数，不含未平仓期权的浮动价值。合计只统计已有参考价的持仓，未记录参考价的持仓单独提示。已归档账户不参与统计；各账户持仓分别列示，不合并为一个虚假组合。</p>
  </section>;
}
