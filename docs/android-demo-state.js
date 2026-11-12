/* Wheel Tracker · Android demo — options, reports, backup, ui state */

var OPTIONS = [
  { id: 'amzn-205p',  sym: 'AMZN',  account: 'income', type: 'put',  strike: 205, date: '2026-11-07', qty: 2, premium: 1275, collateral: 41000 },
  { id: 'tsla-240p',  sym: 'TSLA',  account: 'main',   type: 'put',  strike: 240, date: '2026-11-12', qty: 1, premium: 512,  collateral: 24000 },
  { id: 'msft-415p',  sym: 'MSFT',  account: 'growth', type: 'put',  strike: 415, date: '2026-11-14', qty: 1, premium: 338,  collateral: 41500 },
  { id: 'nvda-130c',  sym: 'NVDA',  account: 'main',   type: 'call', strike: 130, date: '2026-11-21', qty: 3, premium: 690,  collateral: 0 },
  { id: 'googl-190p', sym: 'GOOGL', account: 'income', type: 'put',  strike: 190, date: '2026-11-28', qty: 1, premium: 410,  collateral: 19000 }
];

var MONTHLY = [
  { m: '1月', v: 1240 }, { m: '2月', v: 1680 }, { m: '3月', v: 860 },
  { m: '4月', v: 1920 }, { m: '5月', v: 1340 }, { m: '6月', v: 1760 },
  { m: '7月', v: 980 },  { m: '8月', v: 2140 }, { m: '9月', v: 1622.35 },
  { m: '10月', v: 2260 }, { m: '11月', v: 2840 }
];

var BACKUP = {
  provider: '坚果云', host: 'dav.jianguoyun.com', dir: '/wheel/',
  lastUpload: '今天 08:30', lastRestore: '—',
  lastFile: 'wheel-1762903800-0.sqlite.enc',
  size: '2.4 MB', copies: 7, auto: true, wifi: true, encrypt: true,
  busy: false,
  remotes: [
    { name: 'wheel-1762903800-0.sqlite.enc', time: '今天 08:30', size: '2.4 MB' },
    { name: 'wheel-1762817400-0.sqlite.enc', time: '昨天 08:30', size: '2.4 MB' },
    { name: 'wheel-1762731000-0.sqlite.enc', time: '11/10 08:30', size: '2.3 MB' },
    { name: 'auto-1762644600-0.sqlite.enc',  time: '11/09 08:30', size: '2.3 MB' },
    { name: 'auto-1762558200-0.sqlite.enc',  time: '11/08 08:30', size: '2.2 MB' }
  ]
};

var state = {
  tab: 'home',
  account: 'all',
  posTab: 'stocks',
  detailSym: 'NVDA',
  expiryFilter: 'all',
  theme: 'light',
  stack: []
};

var scrollMem = {};
var entryState = { type: null, prefill: {} };
var screenEl, viewportEl, fabEl, detailActionsEl;
var toastTimer, sheetTimer;

var ENTRY_TYPES = [
  { key: 'sell-put',  label: '卖出 Put',   desc: '现金担保 · 收权利金', icon: 'i-arrow-down-left', color: 'blue' },
  { key: 'sell-call', label: '卖出 Call',  desc: '备兑 · 持股上方',     icon: 'i-trend',           color: 'green' },
  { key: 'buy-close', label: '买入平仓',   desc: '买回空头合约',        icon: 'i-repeat',          color: 'amber' },
  { key: 'expire',    label: '到期作废',   desc: '保留全部权利金',      icon: 'i-x',               color: 'violet' },
  { key: 'assign',    label: '被指派',     desc: 'Put 接股 / Call 交股', icon: 'i-check',          color: 'amber' },
  { key: 'stock',     label: '股票交易',   desc: '买入或卖出正股',      icon: 'i-layers',          color: 'blue' },
  { key: 'dividend',  label: '分红 / 费用', desc: '现金收支',           icon: 'i-credit-card',     color: 'green' },
  { key: 'cash',      label: '入金 / 出金', desc: '账户现金变动',       icon: 'i-wallet',          color: 'violet' }
];
