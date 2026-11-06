import { useState } from 'react';
import { AlarmClock, BellRing, CalendarDays, TriangleAlert } from 'lucide-react';
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
    { key: 'overdue', title: '已过期', note: '券商可能已自动行权或作废，请先核对', tone: 'negative' },
    { key: 'today', title: '今天到期', note: '今天收盘前需要决定：平仓、作废或准备指派', tone: 'warning-text' },
    { key: 'critical', title: '3 天内到期', note: '优先处理，避免资金义务临时增加', tone: 'warning-text' },
    { key: 'soon', title: `提醒期内（${leadDays} 天内）`, note: '可以开始考虑平仓或滚动', tone: '' },
    { key: 'later', title: '未来 30 天', note: '仅作提前查看，尚未进入提醒期', tone: 'muted' },
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

  return <section className="panel expiry-center">
    <div className="section-heading">
      <div><h2><AlarmClock size={18}/> 到期处理中心</h2><span className="muted">{asOf} · 按美东交易日 · 提醒期 {leadDays} 天</span></div>
      <div className="toolbar">
        <button onClick={checkNow} disabled={!desktop || checking}><BellRing size={15}/>{checking ? '检查中…' : '检查到期并通知'}</button>
        <button onClick={onOpenCalendar}><CalendarDays size={15}/>到期日历</button>
      </div>
    </div>

    <div className="summary-strip expiry-summary">
      <div><span>已过期</span><strong className={overdue ? 'negative' : ''}>{overdue}</strong><small>必须核对后作废 / 指派</small></div>
      <div><span>今天到期</span><strong className={todayCount ? 'warning-text' : ''}>{todayCount}</strong><small>美东交易日今天</small></div>
      <div><span>3 天内</span><strong className={critical ? 'warning-text' : ''}>{critical}</strong><small>进入紧急处理区间</small></div>
      <div><span>提醒期内</span><strong>{soon}</strong><small>{leadDays} 天内 · 共 {reminders.length} 个</small></div>
      <div><span>提醒期内 Put 义务</span><strong>{money(putObligation)}</strong><small>若全部被指派所需现金</small></div>
    </div>

    {error && <p className="negative" role="alert">{error}</p>}
    {summary && <p className={summary.total ? 'positive' : 'muted'} role="status">
      已检查：已过期 {summary.overdue} · 今天 {summary.today} · 3 天内 {summary.critical} · 提醒期内 {summary.soon}。{summary.notified ? `已发送 ${summary.notified} 条新通知。` : summary.total ? '没有新的系统通知。' : '当前没有到期提醒。'}
    </p>}
    {overdue > 0 && <p className="expiry-alert" role="alert"><TriangleAlert size={16}/>有 {overdue} 个合约已过到期日。请先查看券商记录：若已作废，用「到期作废」；若已被指派，用「指派 / 行权」；若已在券商处平仓，用「买入平仓」。不要留着继续占用资金义务。</p>}

    {!positions.length ? <p className="empty">没有未平仓期权。新开卖 Put / 卖 Call 后会自动进入到期处理。</p> : !groups.length ? <p className="empty">30 天内没有到期合约。更远的合约可在「当前持仓」查看。</p> : groups.map(group => <section className="expiry-group" key={group.key}>
      <div className="section-heading">
        <div><h3>{group.title} <span className="count">{group.items.length}</span></h3><span className="muted">{group.note}</span></div>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>合约</th><th>手数</th><th>到期日</th><th>剩余</th><th>净权利金</th><th>Put 资金义务</th><th>操作</th></tr></thead>
        <tbody>{group.items.map(position => <tr key={`${group.key}-${position.contract}`} className={`expiry-row ${group.key}`}>
          <td><strong>{position.contract}</strong><small className="muted">{position.symbol} · {position.multiplier} 股/手</small></td>
          <td>{position.openQty}</td>
          <td>{position.expiry}</td>
          <td className={group.tone}>{dayLabel(position.daysLeft)}</td>
          <td>{money(position.avgCredit * position.openQty * position.multiplier)}</td>
          <td>{position.right === 'P' ? money(collateral(position)) : <span className="muted">按持股</span>}</td>
          <td><div className="toolbar">
            {(['option_close', 'option_expire', 'option_assign'] as const).map(kind => <button key={kind} onClick={() => act(position, kind)}>{labels[kind]}</button>)}
            <button className="text-button" onClick={() => onOpenCampaign(position.campaignId)}>战役</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
    <p className="footnote">到期天数按美东交易日计算。作废与指派必须与券商实际处理一致；过期合约不会自动消失，也不会自动释放资金义务。系统通知只在应用运行时检查，开启「关闭窗口时隐藏到托盘」后可继续接收。</p>
  </section>;
}
