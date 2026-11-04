import { useState, type FormEvent } from 'react';
import { api, labels, money, percent, today } from './lib';
import type { NewEvent, Position } from './types';
import { SymbolPicker } from './SymbolPicker';
import { QuoteReference } from './MarketData';
export function EntryForm({ initial, positions, onSaved }: { initial?: Partial<NewEvent>; positions: Position[]; onSaved: (message: string) => void }) {
  const defaults: NewEvent = { date: today(), kind: 'option_open_short', symbol: '', qty: 1, price: 0, fees: 0, amount: 0, expiry: '', strike: 0, right: 'P', note: '' };
  const [form, setForm] = useState<NewEvent>({ ...defaults, ...initial }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [keep, setKeep] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [roll, setRoll] = useState(false);
  const [next, setNext] = useState({ expiry: '', strike: 0, price: 0, fees: 0 });
  const rolling = roll && form.kind === 'option_close';
  const option = form.kind.startsWith('option_'); const amountOnly = ['fee', 'adjustment'].includes(form.kind);
  const hasPrice = !['option_expire', 'option_assign'].includes(form.kind) && !amountOnly;
  const hasFees = !['option_expire', 'dividend', 'fee', 'adjustment'].includes(form.kind);
  const update = <K extends keyof NewEvent>(key: K, value: NewEvent[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const cash = form.kind === 'option_open_short' ? form.price * 100 * form.qty - form.fees : form.kind === 'option_close' ? -form.price * 100 * form.qty - form.fees : form.kind === 'shares_buy' ? -form.price * form.qty - form.fees : form.kind === 'shares_sell' ? form.price * form.qty - form.fees : form.kind === 'dividend' ? form.price * form.qty : form.kind === 'fee' ? -form.amount : form.kind === 'adjustment' ? form.amount : null;
  const collateral = option && form.strike ? form.strike * 100 * form.qty : 0;
  const days = form.expiry ? Math.round((Date.parse(form.expiry) - Date.parse(form.date)) / 86400000) : 0;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || submitted) return;
    setError(''); setBusy(true);
    try {
      const req = { ...form, symbol: form.symbol.trim().toUpperCase(), ...(!option ? { expiry: undefined, strike: undefined, right: undefined } : {}), ...(!hasPrice ? { price: 0 } : {}), ...(!hasFees ? { fees: 0 } : {}) };
      if (rolling) {
        await api<string[]>('add_events', { reqs: [req, { ...req, kind: 'option_open_short', ...next }] });
      } else {
        await api<string>('add_event', { req });
      }
      if (keep) {
        setForm({ ...defaults, date: form.date, symbol: form.symbol, kind: form.kind, right: form.right });
        setNext({ expiry: '', strike: 0, price: 0, fees: 0 });
      } else {
        setSubmitted(true);
      }
      onSaved('交易已保存，持仓与成本已重算。');
    } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  function choosePosition(index: string) { const position = positions[Number(index)]; if (!position) return; setForm(previous => ({ ...previous, symbol: position.symbol, expiry: position.expiry, strike: position.strike, right: position.right, qty: position.openQty, date: previous.kind === 'option_expire' ? position.expiry : previous.date })); }
  return <section className="panel entry-panel"><div className="section-heading"><h2>记录交易</h2><span className="muted">USD · 1 手 = 100 股</span></div><form onSubmit={save}>
    {error && <div className="alert error" role="alert">保存失败：{error}</div>}
    {form.kind === 'option_close' && <label className="check"><input type="checkbox" checked={roll} onChange={e => setRoll(e.target.checked)}/>滚动：平仓后同时开出新合约</label>}
    <div className="form-grid"><label>交易类型<select value={form.kind} onChange={e => update('kind', e.target.value)}>{Object.keys(labels).filter(key => key.startsWith('option_') || ['shares_buy', 'shares_sell', 'dividend', 'fee', 'adjustment'].includes(key)).map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}</select></label>
    <label>交易日期<input type="date" required value={form.date} onChange={e => update('date', e.target.value)}/></label>
    {option && form.kind !== 'option_open_short' && <label className="full">选择当前持仓<select defaultValue="" onChange={e => choosePosition(e.target.value)}><option value="" disabled>选择合约以自动填写</option>{positions.map((position, i) => <option key={position.contract} value={i}>{position.contract} · {position.openQty} 手</option>)}</select></label>}
    <div className="full"><SymbolPicker autoFocus value={form.symbol} onChange={symbol => update('symbol', symbol)}/><QuoteReference symbol={form.symbol}/></div>
    {!amountOnly && <label>{option ? '手数' : '股数'}<input type="number" required min="1" step="1" value={form.qty} onChange={e => update('qty', e.target.valueAsNumber)}/></label>}
    {option && <><label>到期日<input type="date" required value={form.expiry} onChange={e => update('expiry', e.target.value)}/></label><label>期权方向<select value={form.right} onChange={e => update('right', e.target.value)}><option value="P">Put</option><option value="C">Call</option></select></label><label>行权价<input type="number" required min="0.0001" step="any" value={form.strike} onChange={e => update('strike', e.target.valueAsNumber)}/></label></>}
    {hasPrice && <label>{option ? '每股权利金 / 平仓价' : form.kind === 'dividend' ? '每股分红' : '每股成交价'}<input type="number" required min={option ? '0' : '0.0001'} step="any" value={form.price} onChange={e => update('price', e.target.valueAsNumber)}/></label>}
    {hasFees && <label>费用总额<input type="number" required min="0" step="any" value={form.fees} onChange={e => update('fees', e.target.valueAsNumber)}/></label>}
    {amountOnly && <label>美元金额<input type="number" required min={form.kind === 'fee' ? '0.0001' : undefined} step="any" value={form.amount} onChange={e => update('amount', e.target.valueAsNumber)}/></label>}
    <label className="full">备注<textarea rows={2} value={form.note} onChange={e => update('note', e.target.value)} placeholder="选填：记录成交说明"/></label></div>
    {rolling && <fieldset className="panel"><legend>新合约 · 同标的、方向与手数</legend><div className="form-grid"><label>新到期日<input type="date" required min={form.date} value={next.expiry} onChange={e => setNext({ ...next, expiry: e.target.value })}/></label><label>新行权价<input type="number" required min="0.0001" step="any" value={next.strike} onChange={e => setNext({ ...next, strike: e.target.valueAsNumber })}/></label><label>新每股权利金<input type="number" required min="0" step="any" value={next.price} onChange={e => setNext({ ...next, price: e.target.valueAsNumber })}/></label><label>新开仓费用<input type="number" required min="0" step="any" value={next.fees} onChange={e => setNext({ ...next, fees: e.target.valueAsNumber })}/></label></div><p className="muted">两条交易一起保存；任一条无效时整笔滚动均不入账。</p></fieldset>}
    <div className="entry-preview"><span>{rolling ? '滚动现金净变化' : '现金净变化'}<strong>{money(rolling ? (cash ?? 0) + next.price * 100 * form.qty - next.fees : cash)}</strong></span>{form.kind === 'option_open_short' && <><span>合约名义金额<strong>{money(collateral)}</strong></span><span>预计静态年化<strong>{collateral && days > 0 ? percent((cash ?? 0) / collateral * 365 / days) : '—'}</strong></span></>}</div>
    {form.kind === 'adjustment' && <p className="muted">现金调整计入战役收支，不覆盖持股数或股票成本。</p>}
    {form.kind === 'option_expire' && <p className="muted">确认合约已到期作废后录入；被指派的合约请使用“指派 / 行权”。</p>}
    <div className="form-actions"><label className="check"><input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)}/>保存后继续录入</label><button type="submit" className="primary" disabled={busy || submitted}>{submitted ? '已保存' : busy ? '保存中…' : '保存交易'}</button></div>
  </form></section>;
}
