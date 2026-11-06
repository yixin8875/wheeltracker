import { useState } from 'react';
import { downloadCsv, labels, money } from './lib';
import type { EventRow } from './types';

const KINDS = ['option_open_short', 'option_close', 'option_expire', 'option_assign', 'shares_buy', 'shares_sell', 'dividend', 'fee', 'adjustment', 'cash_deposit', 'cash_withdrawal', 'stock_split'];
const CASH_KINDS = new Set(['cash_deposit', 'cash_withdrawal']);

function quantityLabel(event: EventRow) {
  if (event.kind === 'stock_split') return `${event.splitNumerator} : ${event.splitDenominator}`;
  if (event.kind === 'fee' || event.kind === 'adjustment' || CASH_KINDS.has(event.kind)) return '—';
  return String(event.qty);
}

function priceLabel(event: EventRow) {
  if (['option_open_short', 'option_close', 'shares_buy', 'shares_sell', 'dividend'].includes(event.kind)) return money(event.price);
  return '—';
}

function feeLabel(event: EventRow) {
  if (event.kind === 'stock_split' || event.kind === 'fee' || event.kind === 'adjustment' || CASH_KINDS.has(event.kind)) return '—';
  return money(event.fees);
}

function amountLabel(event: EventRow) {
  if (event.kind === 'stock_split') return event.splitCashInLieu != null ? `零股补偿 ${money(event.splitCashInLieu)}` : '—';
  if (event.kind === 'cash_deposit') return `入金 ${money(event.amount)}`;
  if (event.kind === 'cash_withdrawal') return `出金 ${money(event.amount)}`;
  if (event.kind === 'fee' || event.kind === 'adjustment') return money(event.amount);
  return '—';
}

export function EventLog({ events, onUndo, onEdit }: { events: EventRow[]; onUndo: (id: string) => void; onEdit: (event: EventRow) => void }) {
  const [symbol, setSymbol] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const filtered = events.filter(event =>
    event.symbol.includes(symbol.trim().toUpperCase())
    && (!kind || event.kind === kind)
    && (!from || event.date >= from)
    && (!until || event.date <= until)
  );

  function exportRows() {
    downloadCsv('wheel-events.csv', [
      ['id', 'date', 'kind', 'symbol', 'qty', 'multiplier', 'split_numerator', 'split_denominator', 'split_cash_in_lieu', 'price', 'fees', 'amount', 'expiry', 'strike', 'right', 'note'],
      ...filtered.map(event => [event.id, event.date, event.kind, event.symbol, event.qty, event.multiplier, event.splitNumerator, event.splitDenominator, event.splitCashInLieu, event.price, event.fees, event.amount, event.expiry, event.strike, event.right, event.note]),
    ]);
  }

  return <section className="panel">
    <div className="section-heading">
      <div><h2>交易事件日志</h2><span className="muted">{filtered.length} / {events.length} 笔 · 修改与撤销前都会重新校验后续交易</span></div>
      <button onClick={exportRows} disabled={!filtered.length}>导出交易 CSV</button>
    </div>
    <div className="filters">
      <label>标的<input aria-label="事件标的筛选" placeholder="全部标的" value={symbol} onChange={event => setSymbol(event.target.value)}/></label>
      <label>类型<select aria-label="事件类型筛选" value={kind} onChange={event => setKind(event.target.value)}><option value="">全部类型</option>{KINDS.map(value => <option key={value} value={value}>{labels[value] ?? value}</option>)}</select></label>
      <label>日期自<input aria-label="事件起始日期" type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
      <label>至<input aria-label="事件结束日期" type="date" value={until} onChange={event => setUntil(event.target.value)}/></label>
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>日期</th><th>类型</th><th>标的 / 合约</th><th>数量 / 拆股比例</th><th>每股价格</th><th>费用</th><th>金额 / 零股补偿</th><th>备注</th><th>操作</th></tr></thead>
      <tbody>{[...filtered].reverse().map(event => <tr key={event.id}>
        <td>{event.date}</td>
        <td>{labels[event.kind] ?? event.kind}</td>
        <td>{event.symbol || '账户'} {event.expiry} {event.strike}{event.right}{event.multiplier && event.multiplier !== 100 ? ` · ${event.multiplier} 股/手` : ''}</td>
        <td>{quantityLabel(event)}</td>
        <td>{priceLabel(event)}</td>
        <td>{feeLabel(event)}</td>
        <td>{amountLabel(event)}</td>
        <td className="note-cell">{event.note}</td>
        <td><div className="row-actions"><button onClick={() => onEdit(event)}>修改</button><button onClick={() => onUndo(event.id)}>撤销</button></div></td>
      </tr>)}</tbody>
    </table></div>
    {!filtered.length && <p className="empty">{events.length ? '没有符合筛选条件的事件。' : '暂无交易记录。'}</p>}
    <p className="footnote">修改会保留原记录的 ID 与序号，并在保存前重新回放整本账；若后续交易依赖这条记录，会拒绝修改并提示先撤销后续交易。撤销不会物理删除记录：原始数据仍保留在数据库中用于审计，但撤销后不再出现在当前界面、CSV 或 JSON 导出中。</p>
  </section>;
}
