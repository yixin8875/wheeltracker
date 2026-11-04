import { useState } from 'react';
import type { Entry } from './types';
import { downloadCsv, labels, money, percent } from './lib';
import { exportLedger } from './export';
export function LedgerTable({ entries, openCampaign }: { entries: Entry[]; openCampaign: (id: string) => void }) {
  const [symbol, setSymbol] = useState(''); const [status, setStatus] = useState(''); const [right, setRight] = useState(''); const [from, setFrom] = useState(''); const [until, setUntil] = useState('');
  const filtered = entries.filter(entry => entry.symbol.includes(symbol.trim().toUpperCase()) && (!status || entry.status === status) && (!right || entry.right === right) && (!from || entry.openedAt >= from) && (!until || entry.openedAt <= until));
  const exportRows = () => downloadCsv('wheel-ledger.csv', [
    ['开仓日期', '平仓日期', '标的', '合约', '方向', '手数', '状态', '毛权利金', '平仓成本', '费用', '净权利金', '占用资金', '天数', '年化收益率', '战役'],
    ...filtered.map(entry => [entry.openedAt, entry.closedAt, entry.symbol, entry.contract, entry.right, entry.qty, labels[entry.status], entry.premiumGross, entry.closeCost, entry.fees, entry.netPremium, entry.collateral, entry.daysHeld, entry.annualizedReturn, entry.campaignId]),
  ]);
  return <section className="panel"><div className="section-heading"><h2>收租明细</h2><div className="toolbar"><button onClick={() => exportLedger(filtered)} disabled={!filtered.length}>导出 Excel</button><button onClick={exportRows} disabled={!filtered.length}>导出 CSV</button></div></div><div className="filters">
    <label>标的<input placeholder="全部标的" value={symbol} onChange={e => setSymbol(e.target.value)}/></label>
    <label>状态<select value={status} onChange={e => setStatus(e.target.value)}><option value="">全部状态</option>{['open', 'closed', 'expired', 'assigned'].map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
    <label>方向<select value={right} onChange={e => setRight(e.target.value)}><option value="">Put 与 Call</option><option value="P">Sell Put</option><option value="C">Sell Call</option></select></label>
    <label>开仓自<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>至<input type="date" value={until} onChange={e => setUntil(e.target.value)}/></label>
  </div><div className="table-wrap"><table><thead><tr><th>开仓日期</th><th>合约</th><th>手数</th><th>状态</th><th>毛权利金</th><th>平仓成本</th><th>费用</th><th>净权利金</th><th>占用资金</th><th>天数</th><th>年化</th></tr></thead><tbody>{filtered.map(entry => <tr key={entry.id}><td>{entry.openedAt}</td><td><button className="text-button" onClick={() => openCampaign(entry.campaignId)}>{entry.contract}</button></td><td>{entry.qty}</td><td><span className={`badge ${entry.status}`}>{labels[entry.status]}</span></td><td>{money(entry.premiumGross)}</td><td>{money(entry.closeCost)}</td><td>{money(entry.fees)}</td><td>{money(entry.netPremium)}</td><td>{money(entry.collateral)}</td><td>{entry.daysHeld ?? '—'}</td><td>{percent(entry.annualizedReturn)}</td></tr>)}</tbody></table></div>
    {!filtered.length && <p className="empty">没有符合筛选条件的收租记录。</p>}<div className="table-footer"><span>{filtered.length} 笔记录</span><span>已落袋净收租 <strong>{money(filtered.filter(entry => entry.status !== 'open').reduce((sum, entry) => sum + entry.netPremium, 0))}</strong></span><span>未平仓净权利金 <strong>{money(filtered.filter(entry => entry.status === 'open').reduce((sum, entry) => sum + entry.netPremium, 0))}</strong></span></div></section>;
}
