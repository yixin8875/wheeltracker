import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { ScatterChart as ScatterIcon } from 'lucide-react';
import type { Campaign, Entry } from './types';
import { money, percent } from './lib';

echarts.use([ScatterChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const COLORS = ['#0f5fbe', '#7d7668', '#2f6f6a', '#a05f2c', '#5b6b8a', '#8a5a12', '#4d6b4f', '#9c4a44'];
const INK_3 = '#8b8477';
const LINE = 'rgba(30, 28, 23, .17)';
const GRID = 'rgba(30, 28, 23, .07)';
const FONT = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

function utc(value: string) {
  return Date.parse(`${value}T00:00:00Z`);
}
function daysBetween(from: string, to: string) {
  return Math.max(0, Math.round((utc(to) - utc(from)) / 86_400_000));
}

interface Comparison {
  campaign: Campaign;
  days: number;
  realized: number;
  capital: number;
  returnPct: number | null;
}

/** Peak capital: open Put collateral plus the cost of shares at the latest
 * cost point of each day. It is an approximation of the money tied up. */
export function comparisonFor(campaign: Campaign, entries: Entry[], asOf: string): Comparison {
  const related = entries.filter(entry => entry.campaignId === campaign.id);
  const dates = new Set<string>([campaign.startedAt, campaign.endedAt ?? asOf]);
  for (const entry of related) {
    dates.add(entry.openedAt);
    if (entry.closedAt) dates.add(entry.closedAt);
  }
  for (const point of campaign.costPoints) dates.add(point.at);
  const costPoints = [...campaign.costPoints].sort((left, right) => left.at.localeCompare(right.at));
  let capital = 0;
  for (const date of [...dates].sort()) {
    const collateral = related
      .filter(entry => entry.openedAt <= date && (!entry.closedAt || entry.closedAt > date))
      .reduce((sum, entry) => sum + entry.collateral, 0);
    let sharesCost = 0;
    for (const point of costPoints) {
      if (point.at <= date) sharesCost = point.shares * point.costA;
      else break;
    }
    capital = Math.max(capital, collateral + sharesCost);
  }
  const realized = campaign.realizedPnl ?? campaign.premiumRealized + campaign.dividends + campaign.sharePnl + campaign.adjustments;
  const days = daysBetween(campaign.startedAt, campaign.endedAt ?? asOf);
  return { campaign, days, realized, capital, returnPct: capital > 0 ? realized / capital : null };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

export function CampaignCompare({ campaigns, entries, asOf }: { campaigns: Campaign[]; entries: Entry[]; asOf: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [table, setTable] = useState(false);
  const comparisons = useMemo(() => campaigns.map(campaign => comparisonFor(campaign, entries, asOf)), [campaigns, entries, asOf]);
  const symbols = useMemo(() => [...new Set(campaigns.map(campaign => campaign.symbol))].sort(), [campaigns]);
  const colors = useMemo(() => new Map(symbols.map((symbol, index) => [symbol, COLORS[index % COLORS.length]])), [symbols]);

  useEffect(() => {
    if (!element.current || table || !comparisons.length) return;
    const chart = echarts.init(element.current);
    const series = symbols.map(symbol => {
      const color = colors.get(symbol) ?? COLORS[0];
      return {
        name: symbol,
        type: 'scatter',
        symbolSize: 14,
        data: comparisons
          .filter(item => item.campaign.symbol === symbol && item.returnPct != null)
          .map(item => ({
            name: item.campaign.id,
            value: [item.days, Number(((item.returnPct ?? 0) * 100).toFixed(2))],
            itemStyle: {
              color: item.campaign.status === 'active' ? '#fffefa' : color,
              borderColor: color,
              borderWidth: 2,
            },
            comparison: item,
          })),
      };
    });
    chart.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#575249', fontFamily: FONT, fontSize: 12 },
      grid: { left: 16, right: 24, top: 48, bottom: 16, containLabel: true },
      legend: { top: 4, itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: '#575249', fontSize: 12 } },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#fffefa',
        borderColor: LINE,
        borderWidth: 1,
        textStyle: { color: '#1e1c17', fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(30,28,23,.10);',
        formatter: (parameter: unknown) => {
          const item = parameter as { data?: { comparison?: Comparison } };
          const comparison = item.data?.comparison;
          if (!comparison) return '';
          return [
            `<strong>${escapeHtml(comparison.campaign.symbol)} · ${comparison.days} 天</strong>`,
            `状态：${comparison.campaign.status === 'active' ? '进行中' : '已结束'}`,
            `已实现收益：${money(comparison.realized)}`,
            `峰值投入：${money(comparison.capital)}`,
            `收益率：${percent(comparison.returnPct)}`,
            `周期：${comparison.campaign.cycles} 次了结`,
            comparison.campaign.status === 'active' ? '<span style="color:#8a5a12">进行中收益不含未平仓权利金与浮盈亏</span>' : '',
          ].filter(Boolean).join('<br/>');
        },
      },
      xAxis: {
        type: 'value', name: '持续天数', nameLocation: 'middle', nameGap: 26, minInterval: 1,
        nameTextStyle: { color: INK_3, fontSize: 11 }, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false },
        axisLabel: { color: INK_3, fontSize: 11 }, splitLine: { lineStyle: { color: GRID } },
      },
      yAxis: {
        type: 'value', name: '已实现收益率 %',
        nameTextStyle: { color: INK_3, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: INK_3, fontSize: 11, formatter: '{value}%' }, splitLine: { lineStyle: { color: GRID } },
      },
      series,
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [comparisons, symbols, colors, table]);

  return <section className="panel">
    <div className="section-heading">
      <div><h2><ScatterIcon size={18}/> 战役对比</h2><span className="muted">{campaigns.length} 个战役 · 按标的着色</span></div>
      <div className="toolbar"><span className="muted compare-legend-note">空心为进行中 · 实心为已结束</span><button onClick={() => setTable(!table)}>{table ? '查看图表' : '查看数据'}</button></div>
    </div>
    <p className="muted compare-note">横轴为持续天数，纵轴为已实现收益 ÷ 峰值投入。峰值投入按每日未平仓 Put 占用资金加当日持股的纯股票成本取最大值；进行中战役的已实现收益不含未平仓权利金与股票浮盈亏。</p>
    {!campaigns.length ? <p className="empty">记录第一笔卖 Put 或股票买入后，这里会显示历次战役的收益对比。</p> : table ? <div key="compare-data" className="table-wrap"><table>
      <thead><tr><th>标的</th><th>起止</th><th>天数</th><th>状态</th><th>已实现收益</th><th>峰值投入</th><th>收益率</th><th>周期</th></tr></thead>
      <tbody>{comparisons.map(item => <tr key={item.campaign.id}>
        <td>{item.campaign.symbol}</td>
        <td>{item.campaign.startedAt} → {item.campaign.endedAt ?? '进行中'}</td>
        <td>{item.days}</td>
        <td><span className={`badge ${item.campaign.status}`}>{item.campaign.status === 'active' ? '进行中' : '已结束'}</span></td>
        <td className={item.realized < 0 ? 'negative' : 'positive'}>{money(item.realized)}</td>
        <td>{item.capital > 0 ? money(item.capital) : '—'}</td>
        <td>{percent(item.returnPct)}</td>
        <td>{item.campaign.cycles}</td>
      </tr>)}</tbody>
    </table></div> : <div key="compare-plot" ref={element} className="compare-chart" role="img" aria-label="战役散点图：横轴持续天数，纵轴已实现收益率，可切换数据表读取全部数值"/>}
  </section>;
}
