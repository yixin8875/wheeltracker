import { useEffect, useState } from 'react';
import { Scale, Wallet } from 'lucide-react';
import { api, labels, money, percent } from './lib';
import type { CashMovement, Summary } from './types';

/** Account cash is derived from the event stream, so it is only a real cash
 * balance once the user has recorded at least one deposit or withdrawal. */
export function AccountCashPanel({ summary, onEntry, onReconcile }: {
  summary: Summary;
  onEntry: (kind: 'cash_deposit' | 'cash_withdrawal') => void;
  onReconcile: () => void;
}) {
  const cash = summary.accountCash ?? 0;
  const deposits = summary.cashDeposits ?? 0;
  const withdrawals = summary.cashWithdrawals ?? 0;
  const collateral = summary.collateral ?? 0;
  const tracked = summary.cashTracked ?? false;
  const coverage = summary.cashCoverage;
  const shortfall = summary.cashShortfall ?? 0;
  return <section className="panel cash-panel">
    <div className="section-heading">
      <div><h2><Wallet size={18}/> 账户现金与 Put 覆盖</h2><span className="muted">由全部交易现金流与入金 / 出金推导</span></div>
      <div className="toolbar">
        <button onClick={() => onEntry('cash_deposit')}>记录入金</button>
        <button onClick={() => onEntry('cash_withdrawal')}>记录出金</button>
        <button onClick={onReconcile}><Scale size={15}/>与券商对账</button>
      </div>
    </div>
    <div className="summary-strip cash-summary">
      <div>
        <span>{tracked ? '账户现金' : '交易现金流净额'}</span>
        <strong className={cash < 0 ? 'negative' : ''}>{money(cash)}</strong>
        <small>累计入金 {money(deposits)} · 累计出金 {money(withdrawals)}</small>
      </div>
      <div>
        <span>Put 资金义务</span>
        <strong>{money(collateral)}</strong>
        <small>行权价 × 每手股数 × 未平仓手数</small>
      </div>
      <div>
        <span>现金覆盖率</span>
        <strong className={coverage == null ? '' : coverage < 1 ? 'negative' : 'positive'}>{percent(coverage ?? null)}</strong>
        <small>{!tracked ? '记录入金后计算' : collateral <= 0 ? '当前没有未平仓 Put' : coverage != null && coverage < 1 ? `缺口 ${money(shortfall)}` : '现金足以承接全部 Put 指派'}</small>
      </div>
    </div>
    {!tracked && <p className="footnote warning-text">尚未记录入金 / 出金，账户现金只代表交易现金流，不含期初余额，也不能据此判断券商现金是否足够。补录历史账本时，先记录一笔期初入金。</p>}
    {tracked && cash < 0 && <p className="footnote negative">账户现金为负：可能漏记了入金，或漏记了卖出 / 分红等现金流入。可先用「与券商对账」定位差额。</p>}
    <p className="footnote">账户现金 = 全部交易现金流 + 累计入金 − 累计出金；只反映账本已记录的事件，不包含未记录的交易、利息或券商费用。入金 / 出金不计入战役收益，也不影响 A / B / C′ 成本。</p>
  </section>;
}

export function ReconcileModal({ accountId, summary, onClose }: {
  accountId: string;
  summary: Summary;
  onClose: () => void;
}) {
  const [movements, setMovements] = useState<CashMovement[] | null>(null);
  const [error, setError] = useState('');
  const [broker, setBroker] = useState('');
  const cash = summary.accountCash ?? 0;
  const tracked = summary.cashTracked ?? false;

  useEffect(() => {
    let cancelled = false;
    api<CashMovement[]>('cash_movements', { accountId, limit: 60 })
      .then(list => { if (!cancelled) setMovements(list); })
      .catch(failure => { if (!cancelled) setError(String(failure)); });
    return () => { cancelled = true; };
  }, [accountId]);

  const normalized = broker.replace(/[,$\s]/g, '');
  const brokerValue = normalized === '' ? null : Number(normalized);
  const difference = brokerValue != null && Number.isFinite(brokerValue) ? brokerValue - cash : null;

  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="reconcile-title" className="modal wide">
    <div className="section-heading"><div><h2 id="reconcile-title">与券商对账</h2><span className="muted">只读对照，不会修改账本</span></div><button onClick={onClose}>关闭</button></div>
    <div className="reconcile-grid">
      <label>券商显示的现金余额（USD）
        <input autoFocus type="text" inputMode="decimal" placeholder="例如 12,345.67" value={broker} onChange={event => setBroker(event.target.value)}/>
      </label>
      <dl className="scenario-values reconcile-values">
        <div><dt>账本现金</dt><dd>{money(cash)}</dd></div>
        <div><dt>券商现金</dt><dd>{brokerValue != null && Number.isFinite(brokerValue) ? money(brokerValue) : '—'}</dd></div>
        <div><dt>差额</dt><dd className={difference == null ? '' : difference === 0 ? 'positive' : 'negative'}>{difference == null ? '—' : money(difference)}</dd></div>
      </dl>
    </div>
    {!tracked && <p className="alert warning" role="status">账本尚未记录入金 / 出金，账本现金不含期初余额；请先补录期初入金，对账差额才有意义。</p>}
    {difference != null && <p className={`footnote ${difference === 0 ? 'positive' : 'negative'}`}>{difference === 0 ? '账本现金与券商一致。' : '差额 = 券商现金 − 账本现金。正数通常表示账本漏记了入金或现金流入；负数通常表示漏记了出金或现金流出，或多记了入金。'}</p>}
    {error && <p className="negative" role="alert">{error}</p>}
    <h3>最近的现金变动</h3>
    {movements == null && !error ? <p role="status">正在读取现金变动…</p> : movements && movements.length ? <div className="table-wrap cash-movements"><table>
      <thead><tr><th>日期</th><th>类型</th><th>标的 / 备注</th><th>现金变动</th><th>变动后余额</th></tr></thead>
      <tbody>{movements.map((movement, index) => <tr key={`${movement.date}-${index}`}>
        <td>{movement.date}</td>
        <td>{labels[movement.kind] ?? movement.kind}</td>
        <td>{[movement.symbol, movement.note].filter(Boolean).join(' · ') || '账户级'}</td>
        <td className={movement.amount < 0 ? 'negative' : 'positive'}>{money(movement.amount)}</td>
        <td>{money(movement.balanceAfter)}</td>
      </tr>)}</tbody>
    </table></div> : movements && !movements.length ? <p className="empty">账本还没有产生现金变动的事件。</p> : null}
    <p className="footnote">现金变动按美东交易日排序，展示最近 60 笔；到期作废不产生现金，因此不在列表中。对账结果不会保存。</p>
  </section></div>;
}
