import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect } from '@/components/native-select';
import type { CostPoint, Price } from './types';
import { money } from './lib';
echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const TRACKS = [
  { name: 'A · 纯股票成本', key: 'costA' as const, color: '#a1a1aa', type: 'dashed' },
  { name: 'B · 已落袋有效成本', key: 'costB' as const, color: '#18181b', type: 'solid' },
  { name: 'C′ · 含未平仓权利金', key: 'costC' as const, color: '#d4d4d8', type: 'dotted' },
];
const INK = '#18181b';
const INK_2 = '#52525b';
const INK_3 = '#71717a';
const LINE = 'rgba(24, 24, 27, .18)';
const GRID = 'rgba(24, 24, 27, .07)';
const FONT = 'Inter, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

export function CostChart({ points, prices = [], symbol, callStrike }: { points: CostPoint[]; prices?: Price[]; symbol?: string; callStrike?: number }) {
  const element = useRef<HTMLDivElement>(null);
  const [table, setTable] = useState(false);
  const [track, setTrack] = useState('all');
  const quotes = useMemo(() => [...prices].filter(price => price.close > 0).sort((left, right) => left.date.localeCompare(right.date)), [prices]);
  const quoteByDate = useMemo(() => new Map(quotes.map(price => [price.date, price.close])), [quotes]);
  const axis = useMemo(() => [...new Set([...points.map(point => point.at), ...quotes.map(price => price.date)])].sort(), [points, quotes]);
  const lastPrice = quotes.length ? quotes[quotes.length - 1].close : null;

  function priceAt(date: string) {
    let value: number | null = null;
    for (const quote of quotes) {
      if (quote.date <= date) value = quote.close;
      else break;
    }
    return value;
  }
  function costAt(date: string) {
    let current: CostPoint | null = null;
    for (const point of points) {
      if (point.at <= date) current = point;
      else break;
    }
    return current;
  }

  useEffect(() => {
    if (!element.current || table || !points.length) return;
    const chart = echarts.init(element.current);
    const series = TRACKS
      .filter(item => track === 'all' || track === item.key)
      .map(item => ({
        name: item.name,
        type: 'line' as const,
        step: 'end' as const,
        symbolSize: 8,
        data: axis.map(date => costAt(date)?.[item.key] ?? null),
        connectNulls: true,
        itemStyle: { color: item.color, borderColor: '#ffffff', borderWidth: 2 },
        lineStyle: { width: item.key === 'costB' ? 2.5 : 1.5, type: item.type, opacity: item.key === 'costB' ? 1 : .9 },
        markLine: item.key !== 'costB' || (!lastPrice && callStrike == null) ? undefined : {
          symbol: 'none',
          silent: true,
          label: { color: INK_3, fontSize: 11, formatter: (parameter: { name?: string }) => parameter.name ?? '' },
          data: [
            lastPrice != null ? { name: `现价 ${money(lastPrice)}`, yAxis: lastPrice, lineStyle: { color: INK, type: 'dashed', width: 1 } } : null,
            callStrike != null ? { name: `Call 行权价 ${money(callStrike)}`, yAxis: callStrike, lineStyle: { color: '#a16207', type: 'dashed', width: 1 } } : null,
          ].filter(Boolean),
        },
      }));
    const priceSeries = quotes.length ? [{
      name: '参考价',
      type: 'line' as const,
      symbolSize: 4,
      data: axis.map(date => quoteByDate.get(date) ?? null),
      connectNulls: false,
      itemStyle: { color: INK_2 },
      lineStyle: { width: 1.5, type: 'solid', opacity: .7 },
    }] : [];
    chart.setOption({
      backgroundColor: 'transparent', textStyle: { color: INK_2, fontFamily: FONT, fontSize: 12 },
      grid: { left: 16, right: 20, top: 48, bottom: 16, containLabel: true },
      legend: { top: 4, itemWidth: 14, itemHeight: 8, itemGap: 20, textStyle: { color: INK_2, fontSize: 12 } },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#ffffff',
        borderColor: LINE,
        borderWidth: 1,
        textStyle: { color: INK, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(24,24,27,.10); border-radius: 8px;',
        axisPointer: { type: 'cross' },
        formatter: (parameters: unknown) => {
          const list = parameters as { axisValue?: string }[];
          const date = list[0]?.axisValue;
          if (!date) return '';
          const point = costAt(date);
          if (!point) return `${date}<br/>暂无成本点`;
          const previousIndex = points.findIndex(item => item.at === point.at) - 1;
          const previous = previousIndex >= 0 ? points[previousIndex] : null;
          const price = quoteByDate.get(date);
          const delta = (key: 'costA' | 'costB' | 'costC') => previous ? point[key] - previous[key] : 0;
          const sign = (value: number) => `${value >= 0 ? '+' : ''}${money(value)}`;
          return [
            `<strong>${date}</strong>`,
            `A 纯股票：${money(point.costA)}（Δ ${sign(delta('costA'))}）`,
            `B 已落袋：${money(point.costB)}（Δ ${sign(delta('costB'))}）`,
            `C′ 含未平仓：${money(point.costC)}（Δ ${sign(delta('costC'))}）`,
            price != null ? `参考价：${money(price)}` : '',
          ].filter(Boolean).join('<br/>');
        },
      },
      xAxis: {
        type: 'category', data: axis, boundaryGap: false,
        axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false },
        axisLabel: { color: INK_3, fontSize: 11, alignMinLabel: 'left', alignMaxLabel: 'right', hideOverlap: true, formatter: (value: string) => value.slice(5) },
      },
      yAxis: {
        type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: INK_3, fontSize: 11, formatter: (value: number) => `$${value}` },
        splitLine: { lineStyle: { color: GRID } },
      },
      series: [...series, ...priceSeries],
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [points, prices, quotes, quoteByDate, axis, lastPrice, callStrike, table, track]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">每股成本轨迹</CardTitle>
      </CardHeader>
      <CardPanel className="space-y-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="sr-only" htmlFor="cost-track">成本口径</label>
          <NativeSelect id="cost-track" className="w-44" value={track} onChange={event => setTrack(event.target.value)}>
            <option value="all">三轨对比</option>
            <option value="costA">纯股票成本</option>
            <option value="costB">已落袋有效成本</option>
            <option value="costC">含未平仓权利金</option>
          </NativeSelect>
          <Button variant="outline" size="sm" onClick={() => setTable(!table)}>{table ? '查看图表' : '查看数据'}</Button>
        </div>
        {!points.length ? (
          <p className="text-sm text-muted-foreground">持有股票后，这里会显示每笔事件对应的每股成本。</p>
        ) : table ? (
          <div key="cost-data" className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead className="text-right">持股</TableHead>
                  <TableHead className="text-right">A 纯股票</TableHead>
                  <TableHead className="text-right">B 已落袋</TableHead>
                  <TableHead className="text-right">C′ 含未平仓</TableHead>
                  <TableHead className="text-right">参考价</TableHead>
                  <TableHead className="text-right">成本变化 B</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {points.map((point, i) => {
                  const previous = i > 0 ? points[i - 1].costB : null;
                  return (
                    <TableRow key={i}>
                      <TableCell className="num">{point.at}</TableCell>
                      <TableCell className="num text-right">{point.shares}</TableCell>
                      <TableCell className="num text-right">{money(point.costA)}</TableCell>
                      <TableCell className="num text-right">{money(point.costB)}</TableCell>
                      <TableCell className="num text-right">{money(point.costC)}</TableCell>
                      <TableCell className="num text-right">{money(priceAt(point.at))}</TableCell>
                      <TableCell className="num text-right">{previous == null ? '—' : money(point.costB - previous)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <>
            <div key="cost-plot" ref={element} className="cost-chart chart-surface" role="img" aria-label="三轨每股成本阶梯图，叠加已保存参考价与 Call 行权价，可切换数据表读取全部数值" />
            <p className="chart-call-note text-xs leading-relaxed text-muted-foreground">{quotes.length ? `参考价来自行情页已保存报价${symbol ? `（${symbol}）` : ''}${lastPrice != null ? `，最新 ${money(lastPrice)}` : ''}。` : '暂无可用的已保存报价；在行情页更新后可对照现货成本线。'}{callStrike != null ? ` 虚线为当前 Call 行权价 ${money(callStrike)}。` : ''}</p>
          </>
        )}
      </CardPanel>
    </Card>
  );
}
