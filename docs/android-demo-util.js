/* Wheel Tracker · Android demo — formatting & selectors */

function $(id) { return document.getElementById(id); }

function fmt(n, d) {
  if (d == null) d = 2;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function usd(n, d) { return '$' + fmt(n, d); }
function usdSigned(n, d) { return (n >= 0 ? '+' : '−') + '$' + fmt(Math.abs(n), d); }
function pctText(n, d) { return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d == null ? 1 : d) + '%'; }

function dateOf(iso) { return new Date(iso + 'T00:00:00'); }
function dteOf(iso) {
  var a = dateOf(iso);
  var b = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate());
  return Math.round((a - b) / 86400000);
}
function mmdd(iso) { var d = dateOf(iso); return (d.getMonth() + 1) + '/' + d.getDate(); }
function isoOf(d) {
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

function currentAccount() {
  return state.account === 'all' ? null : ACCOUNTS.filter(function (a) { return a.id === state.account; })[0];
}
function inAccount(item) { return state.account === 'all' || item.account === state.account; }
function accountName(id) {
  var a = ACCOUNTS.filter(function (x) { return x.id === id; })[0];
  return a ? a.name : '';
}
function cashNow() {
  return state.account === 'all'
    ? ACCOUNTS.reduce(function (s, a) { return s + a.cash; }, 0)
    : currentAccount().cash;
}
function campaigns() { return CAMPAIGNS.filter(inAccount); }
function options() { return OPTIONS.filter(inAccount); }
function realizedNow() {
  var base = campaigns().reduce(function (s, c) { return s + c.realized; }, 0);
  var extra = (state.account === 'all' || state.account === 'income') ? 2436 : 0;
  return base + extra;
}
function openNow() { return options().reduce(function (s, o) { return s + o.premium; }, 0); }
function obligationNow() { return options().reduce(function (s, o) { return s + o.collateral; }, 0); }
function optionById(id) { return OPTIONS.filter(function (o) { return o.id === id; })[0]; }
function campaignOf(sym) { return CAMPAIGNS.filter(function (c) { return c.sym === sym; })[0]; }

function emptyBlock(icon, title, sub) {
  return '<div class="empty"><svg class="icon"><use href="#' + icon + '"/></svg>' +
    '<b>' + title + '</b><p>' + sub + '</p></div>';
}
