import { Landmark, TriangleAlert } from 'lucide-react';
import { money, percent } from './lib';
import type { AllAccountsOverview, OverviewAccount } from './types';

function coverageTone(value: number | null | undefined) {
  if (value == null) return '';
  return value < 1 ? 'negative' : 'positive';
}

function cashLabel(account: OverviewAccount) {
  return account.cashTracked ? money(account.accountCash) : '—';
}

export function AccountsOverview({ overview, onOpenAccount }: {
  overview: AllAccountsOverview;
  onOpenAccount: (id: string) => void;
}) {
  const { accounts, totals } = overview;
  return <section className="panel overview">
    <div className="section-heading">
      <div><h2><Landmark size={18}/> 全部账户总览</h2><span className="muted">{overview.asOf} · 只读汇总 · 不合并持仓或成本</span></div>
    </div>

    <div className="summary-strip overview-summary">
      <div><span>账本现金</span><strong>{money(totals.accountCash)}</strong><small>{totals.cashTrackedAccounts} 个账户已记录入金 / 出金</small></div>
      <div><span>总 Put 资金义务</span><strong>{money(totals.collateral)}</strong><small>全部 {totals.accountCount} 个可用账户</small></div>
      <div><span>综合覆盖率</span><strong className={coverageTone(totals.cashCoverage)}>{percent(totals.cashCoverage)}</strong><small>已记录现金账户的 Put 义务 {money(totals.trackedCollateral)}</small></div>
      <div><span>现金缺口</span><strong className={totals.cashShortfall > 0 ? 'negative' : ''}>{money(totals.cashShortfall)}</strong><small>各账户缺口之和，盈余不抵扣</small></div>
      <div><span>未平仓净权利金</span><strong>{money(totals.premiumOpen)}</strong><small>{totals.openContracts} 手 · {totals.activeCampaigns} 个进行中战役</small></div>
    </div>

    {totals.untrackedPutAccounts > 0 && <div className="alert warning" role="status"><TriangleAlert size={16}/>有 {totals.untrackedPutAccounts} 个账户持有未平仓 Put，但尚未记录入金 / 出金，这些义务未计入综合覆盖率。请先补录期初入金，再判断整体资金是否足够。</div>}
    {totals.untrackedPutAccounts === 0 && totals.untrackedAccounts > 0 && <p className="footnote">{totals.untrackedAccounts} 个账户未记录入金 / 出金，未计入「账本现金」；其交易现金流净额仍在账户行显示。</p>}

    {!accounts.length ? <p className="empty">没有可用账户。可在「设置 → 账户」新建账户。</p> : <div className="table-wrap"><table className="overview-table">
      <thead><tr><th>账户</th><th>账本现金</th><th>Put 义务</th><th>覆盖率</th><th>缺口</th><th>未平仓净权利金</th><th>持仓</th><th>操作</th></tr></thead>
      <tbody>{accounts.map(account => <tr key={account.id} className={account.cashTracked ? '' : 'overview-row untracked'}>
        <td><strong>{account.name}</strong><small className="muted">{account.activeCampaigns} 个进行中战役 · 持股 {account.sharesHeld} 股</small>{!account.cashTracked && <span className="account-tag">未记录现金</span>}</td>
        <td>{cashLabel(account)}{!account.cashTracked && <small className="muted">交易净额 {money(account.accountCash)}</small>}</td>
        <td>{money(account.collateral)}</td>
        <td className={coverageTone(account.cashCoverage)}>{percent(account.cashCoverage)}</td>
        <td className={account.cashShortfall > 0 ? 'negative' : ''}>{account.cashTracked ? money(account.cashShortfall) : '—'}</td>
        <td>{money(account.premiumOpen)}</td>
        <td>{account.openPositions} 个 · {account.openContracts} 手</td>
        <td><button onClick={() => onOpenAccount(account.id)}>打开账户</button></td>
      </tr>)}</tbody>
    </table></div>}

    <p className="footnote">总览只汇总现金、义务与未平仓权利金，不合并不同账户的持仓、成本或报表；切换账户后可查看单账户详情。已归档账户不参与统计。现金仍只反映账本事件，不含未记录的利息、在途资金或融资额度。</p>
  </section>;
}
