/* Wheel Tracker · Android demo — data */

var TODAY = new Date(2026, 10, 12); // 2026-11-12 周四

var ACCOUNTS = [
  { id: 'main',   name: '主账户',   broker: '盈透证券', cash: 86400, cls: 'blue',  initial: '主' },
  { id: 'growth', name: '成长账户', broker: '嘉信理财', cash: 41200, cls: 'green', initial: '成' },
  { id: 'income', name: '收租账户', broker: '富途证券', cash: 14700, cls: 'amber', initial: '收' }
];

var CAMPAIGNS = [
  {
    sym: 'NVDA', account: 'main',
    shares: 300, costA: 121.80, costB: 114.62, costC: 111.05,
    price: 126.40, prev: 124.85, realized: 6884.50,
    series: [118.2, 119.4, 118.8, 120.6, 121.3, 120.1, 122.4, 123.1, 124.2, 124.85, 126.4],
    timeline: [
      { t: '11/05 10:12', p: '卖出 130C ×3 · 权利金 $2.30', v: '+$690.00', tone: 'green' },
      { t: '10/24 09:41', p: '卖出 122P ×3 到期作废', v: '+$1,014.00', tone: 'green' },
      { t: '10/10 22:03', p: '买入 300 股 @ $121.80', v: '−$36,540', tone: 'muted' },
      { t: '09/26 09:33', p: '卖出 118P ×3 被指派', v: '—', tone: 'muted' }
    ]
  },
  {
    sym: 'TSLA', account: 'main',
    shares: 200, costA: 262.40, costB: 246.80, costC: 241.10,
    price: 251.30, prev: 254.10, realized: 4400.00,
    series: [258.4, 256.2, 259.1, 255.4, 252.8, 253.9, 250.2, 248.6, 249.8, 254.1, 251.3],
    timeline: [
      { t: '11/12 09:31', p: '卖出 240P ×1 · 今日到期', v: '+$512.00', tone: 'green' },
      { t: '10/31 15:20', p: '卖出 250C ×2 平仓', v: '−$380.00', tone: 'red' },
      { t: '10/03 10:05', p: '卖出 235P ×2 到期作废', v: '+$1,240.00', tone: 'green' }
    ]
  },
  {
    sym: 'MSFT', account: 'growth',
    shares: 100, costA: 428.20, costB: 415.75, costC: 408.30,
    price: 432.10, prev: 429.60, realized: 4921.85,
    series: [419.5, 421.2, 418.8, 423.6, 425.1, 424.4, 427.8, 428.9, 430.2, 429.6, 432.1],
    timeline: [
      { t: '11/07 09:44', p: '卖出 415P ×1 · 11/14 到期', v: '+$338.00', tone: 'green' },
      { t: '10/17 14:02', p: '卖出 430C ×1 到期作废', v: '+$612.00', tone: 'green' },
      { t: '09/19 09:36', p: '卖出 400P ×1 被指派', v: '—', tone: 'muted' }
    ]
  }
];
