import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { ScatterChartIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Campaign, Entry } from './types';
import { money, percent } from './lib';

echarts.use([ScatterChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const COLORS = ['#18181b', '#52525b', '#71717a', '#a16207', '#0f766e', '#6d28d9', '#b45309', '#9f1239'];
const INK = '#18181b';
const INK_2 = '#52525b';
const INK_3 = '#71717a';
const LINE = 'rgba(24, 24, 27, .18)';
const GRID = 'rgba(24, 24, 27, .07)';
const FONT = 'Inter, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

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
              color: item.campaign.status === 'active' ? '#ffffff' : color,
              borderColor: color,
              borderWidth: 2,
            },
            comparison: item,
          })),
      };
    });
    chart.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: INK_2, fontFamily: FONT, fontSize: 12 },
      grid: { left: 16, right: 24, top: 48, bottom: 16, containLabel: true },
      legend: { top: 4, itemWidth: 10, itemHeight: 10, itemGap: 16, textStyle: { color: INK_2, fontSize: 12 } },
      tooltip: {
        trigger: 'item',
        backgroundColor: '#ffffff',
        borderColor: LINE,
        borderWidth: 1,
        textStyle: { color: INK, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(24,24,27,.10); border-radius: 8px;',
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
            comparison.campaign.status === 'active' ? '<span style="color:#a16207">进行中收益不含未平仓权利金与浮盈亏</span>' : '',
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ScatterChartIcon className="size-4 text-muted-foreground" />战役对比</CardTitle>
        <CardDescription>{campaigns.length} 个战役 · 按标的着色</CardDescription>
      </CardHeader>
      <CardPanel className="space-y-3">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="compare-legend-note text-xs text-muted-foreground">空心为进行中 · 实心为已结束</span>
          <Button variant="outline" size="sm" onClick={() => setTable(!table)}>{table ? '查看图表' : '查看数据'}</Button>
        </div>
        <p className="compare-note text-xs leading-relaxed text-muted-foreground">横轴为持续天数，纵轴为已实现收益 ÷ 峰值投入。峰值投入按每日未平仓 Put 占用资金加当日持股的纯股票成本取最大值；进行中战役的已实现收益不含未平仓权利金与股票浮盈亏。</p>
        {!campaigns.length ? (
          <p className="text-sm text-muted-foreground">记录第一笔卖 Put 或股票买入后，这里会显示历次战役的收益对比。</p>
        ) : table ? (
          <div key="compare-data" className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标的</TableHead>
                  <TableHead>起止</TableHead>
                  <TableHead className="text-right">天数</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">已实现收益</TableHead>
                  <TableHead className="text-right">峰值投入</TableHead>
                  <TableHead className="text-right">收益率</TableHead>
                  <TableHead className="text-right">周期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparisons.map(item => (
                  <TableRow key={item.campaign.id}>
                    <TableCell className="font-medium">{item.campaign.symbol}</TableCell>
                    <TableCell className="num text-xs">{item.campaign.startedAt} → {item.campaign.endedAt ?? '进行中'}</TableCell>
                    <TableCell className="num text-right">{item.days}</TableCell>
                    <TableCell><Badge variant={item.campaign.status === 'active' ? 'warning' : 'secondary'} size="sm">{item.campaign.status === 'active' ? '进行中' : '已结束'}</Badge></TableCell>
                    <TableCell className={`num text-right ${item.realized < 0 ? 'negative text-destructive-foreground' : 'positive text-success-foreground'}`}>{money(item.realized)}</TableCell>
                    <TableCell className="num text-right">{item.capital > 0 ? money(item.capital) : '—'}</TableCell>
                    <TableCell className="num text-right">{percent(item.returnPct)}</TableCell>
                    <TableCell className="num text-right">{item.campaign.cycles}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div key="compare-plot" ref={element} className="compare-chart chart-surface" role="img" aria-label="战役散点图：横轴持续天数，纵轴已实现收益率，可切换数据表读取全部数值" />
        )}
      </CardPanel>
    </Card>
  );
}
