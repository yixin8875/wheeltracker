import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Position } from './types';
import { money } from './lib';

const DAY = 86_400_000;
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function utc(value: string) {
  return Date.parse(`${value}T00:00:00Z`);
}
function iso(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}
function isoParts(value: string) {
  const [year, month] = value.split('-').map(Number);
  return { year, month: month - 1 };
}
function monthGrid(year: number, month: number) {
  const first = Date.UTC(year, month, 1);
  const weekday = (new Date(first).getUTCDay() + 6) % 7;
  const start = first - weekday * DAY;
  return Array.from({ length: 42 }, (_, index) => start + index * DAY);
}
function shiftMonth(year: number, month: number, delta: number) {
  const date = new Date(Date.UTC(year, month + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}
function monthTitle(year: number, month: number) {
  return `${year} 年 ${month + 1} 月`;
}

export function ExpiryCalendar({ asOf, positions, onOpenCampaign }: {
  asOf: string; positions: Position[]; onOpenCampaign: (id: string) => void;
}) {
  const initial = isoParts(asOf);
  const [cursor, setCursor] = useState(initial);
  const [selected, setSelected] = useState(asOf);
  const today = utc(asOf);
  const cells = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const byDate = useMemo(() => {
    const grouped = new Map<string, Position[]>();
    for (const position of positions) {
      const list = grouped.get(position.expiry) ?? [];
      list.push(position);
      grouped.set(position.expiry, list);
    }
    for (const list of grouped.values()) list.sort((left, right) => left.contract.localeCompare(right.contract));
    return grouped;
  }, [positions]);
  const selectedPositions = byDate.get(selected) ?? [];
  const upcoming = positions
    .filter(position => utc(position.expiry) >= today && utc(position.expiry) <= today + 30 * DAY)
    .sort((left, right) => left.expiry.localeCompare(right.expiry) || left.contract.localeCompare(right.contract));
  const total = positions.length;

  return <div className="calendar-page">
    <section className="panel">
      <div className="section-heading">
        <div><h2><CalendarDays size={18}/> 到期日历</h2><span className="muted">{total} 个未平仓合约 · 日期按美东交易日</span></div>
        <div className="toolbar">
          <button aria-label="上一个月" onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, -1))}><ChevronLeft size={16}/></button>
          <strong className="calendar-month">{monthTitle(cursor.year, cursor.month)}</strong>
          <button aria-label="下一个月" onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, 1))}><ChevronRight size={16}/></button>
          <button onClick={() => { setCursor(initial); setSelected(asOf); }}>回到今天</button>
        </div>
      </div>
      <div className="calendar-legend"><span><i className="legend-dot today"/>今天</span><span><i className="legend-dot selected"/>已选择</span><span><i className="legend-dot overdue"/>已过期</span><span><i className="legend-dot contracts"/>有到期</span></div>
      <div className="calendar-grid" role="grid" aria-label={`${monthTitle(cursor.year, cursor.month)}到期日历`}>
        {WEEKDAYS.map(day => <div key={day} className="calendar-weekday" role="columnheader">周{day}</div>)}
        {cells.map(value => {
          const date = iso(value);
          const list = byDate.get(date) ?? [];
          const outside = new Date(value).getUTCMonth() !== cursor.month;
          const overdue = list.length > 0 && value < today;
          const classes = ['calendar-cell', outside ? 'outside' : '', date === asOf ? 'today' : '', date === selected ? 'selected' : '', overdue ? 'overdue' : '', list.length ? 'has-contracts' : ''].filter(Boolean).join(' ');
          return <button key={date} type="button" role="gridcell" className={classes}
            aria-pressed={date === selected}
            aria-label={`${date}${list.length ? `，${list.length} 个到期合约` : '，无到期合约'}`}
            onClick={() => { setSelected(date); if (outside) setCursor(isoParts(date)); }}>
            <span className="calendar-day">{Number(date.slice(8))}</span>
            {list.slice(0, 2).map(position => <span key={position.contract} className="calendar-chip">{position.symbol} {position.strike}{position.right} ×{position.openQty}</span>)}
            {list.length > 2 && <span className="calendar-more">+{list.length - 2}</span>}
          </button>;
        })}
      </div>
    </section>

    <section className="panel">
      <div className="section-heading"><h2>{selected} 到期合约</h2><span className="muted">{selectedPositions.length ? `${selectedPositions.length} 个合约` : '无到期合约'}</span></div>
      {!selectedPositions.length ? <p className="empty">这一天没有未平仓期权到期。</p> : <div className="table-wrap"><table>
        <thead><tr><th>合约</th><th>方向</th><th>行权价</th><th>手数</th><th>每股净权利金</th><th>剩余天数</th><th>战役</th></tr></thead>
        <tbody>{selectedPositions.map(position => <tr key={position.contract}>
          <td>{position.contract}</td><td>{position.right === 'P' ? 'Put' : 'Call'}</td><td>{money(position.strike)}</td><td>{position.openQty}</td>
          <td>{money(position.avgCredit)}</td><td><span className={position.daysLeft < 0 ? 'negative' : position.daysLeft <= 7 ? 'warning-text' : ''}>{position.daysLeft < 0 ? `已过期 ${-position.daysLeft} 天` : `${position.daysLeft} 天`}</span></td>
          <td><button className="text-button" onClick={() => onOpenCampaign(position.campaignId)}>查看战役</button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <section className="panel">
      <div className="section-heading"><h2>未来 30 天</h2><span className="muted">从 {asOf} 起算</span></div>
      {!upcoming.length ? <p className="empty">未来 30 天没有到期合约。</p> : <div className="upcoming-strip">{upcoming.map(position => <button key={position.contract} className={`upcoming-chip ${position.daysLeft < 0 ? 'overdue' : position.daysLeft <= 7 ? 'critical' : ''}`} onClick={() => { setSelected(position.expiry); setCursor(isoParts(position.expiry)); }}>
        <strong>{position.expiry}</strong><span>{position.contract}</span><small>{position.daysLeft} 天后 · {position.openQty} 手</small>
      </button>)}</div>}
    </section>
  </div>;
}
