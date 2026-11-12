import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { CostPoint, Price } from './types';
import { money } from './lib';
echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const TRACKS = [
  { name: 'A · 纯股票成本', key: 'costA' as const, color: '#a39a88', type: 'dashed' },
  { name: 'B · 已落袋有效成本', key: 'costB' as const, color: '#0f5fbe', type: 'solid' },
  { name: 'C′ · 含未平仓权利金', key: 'costC' as const, color: '#c9c0ad', type: 'dotted' },
];
const INK = '#1e1c17';
const INK_2 = '#575249';
const INK_3 = '#8b8477';
const LINE = 'rgba(30, 28, 23, .17)';
const GRID = 'rgba(30, 28, 23, .07)';
const FONT = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif';

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
        itemStyle: { color: item.color, borderColor: '#fffefa', borderWidth: 2 },
        lineStyle: { width: item.key === 'costB' ? 2.5 : 1.5, type: item.type, opacity: item.key === 'costB' ? 1 : .9 },
        markLine: item.key !== 'costB' || (!lastPrice && callStrike == null) ? undefined : {
          symbol: 'none',
          silent: true,
          label: { color: INK_3, fontSize: 11, formatter: (parameter: { name?: string }) => parameter.name ?? '' },
          data: [
            lastPrice != null ? { name: `现价 ${money(lastPrice)}`, yAxis: lastPrice, lineStyle: { color: INK, type: 'dashed', width: 1 } } : null,
            callStrike != null ? { name: `Call 行权价 ${money(callStrike)}`, yAxis: callStrike, lineStyle: { color: '#8a5a12', type: 'dashed', width: 1 } } : null,
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
        backgroundColor: '#fffefa',
        borderColor: LINE,
        borderWidth: 1,
        textStyle: { color: INK, fontSize: 12 },
        extraCssText: 'box-shadow: 0 8px 24px rgba(30,28,23,.10);',
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

  return <section className="panel"><div className="section-heading"><h2>每股成本轨迹</h2><div className="toolbar"><label className="sr-only" htmlFor="cost-track">成本口径</label><select id="cost-track" value={track} onChange={event => setTrack(event.target.value)}><option value="all">三轨对比</option><option value="costA">纯股票成本</option><option value="costB">已落袋有效成本</option><option value="costC">含未平仓权利金</option></select><button onClick={() => setTable(!table)}>{table ? '查看图表' : '查看数据'}</button></div></div>
    {!points.length ? <p className="empty">持有股票后，这里会显示每笔事件对应的每股成本。</p> : table ? <div key="cost-data" className="table-wrap"><table><thead><tr><th>日期</th><th>持股</th><th>A 纯股票</th><th>B 已落袋</th><th>C′ 含未平仓</th><th>参考价</th><th>成本变化 B</th></tr></thead><tbody>{points.map((point, i) => {
      const previous = i > 0 ? points[i - 1].costB : null;
      return <tr key={i}><td>{point.at}</td><td>{point.shares}</td><td>{money(point.costA)}</td><td>{money(point.costB)}</td><td>{money(point.costC)}</td><td>{money(priceAt(point.at))}</td><td>{previous == null ? '—' : money(point.costB - previous)}</td></tr>;
    })}</tbody></table></div> : <><div key="cost-plot" ref={element} className="cost-chart" role="img" aria-label="三轨每股成本阶梯图，叠加已保存参考价与 Call 行权价，可切换数据表读取全部数值"/><p className="muted chart-call-note">{quotes.length ? `参考价来自行情页已保存报价${symbol ? `（${symbol}）` : ''}${lastPrice != null ? `，最新 ${money(lastPrice)}` : ''}。` : '暂无可用的已保存报价；在行情页更新后可对照现货成本线。'}{callStrike != null ? ` 虚线为当前 Call 行权价 ${money(callStrike)}。` : ''}</p></>}
  </section>;
}
