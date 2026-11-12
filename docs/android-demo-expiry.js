/* Wheel Tracker · Android demo — expiry centre */

var CHIPS = [
  { key: 'all',     label: '全部' },
  { key: 'overdue', label: '已过期', danger: true },
  { key: 'today',   label: '今天' },
  { key: 'soon',    label: '3 天内' },
  { key: 'notice',  label: '提醒期' },
  { key: 'month',   label: '30 天' }
];

function matchFilter(o, key) {
  var d = dteOf(o.date);
  if (key === 'all') return true;
  if (key === 'overdue') return d < 0;
  if (key === 'today') return d === 0;
  if (key === 'soon') return d >= 0 && d <= 3;
  if (key === 'notice') return d > 3 && d <= 10;
  if (key === 'month') return d > 10 && d <= 30;
  if (key.indexOf('date:') === 0) return o.date === key.slice(5);
  return true;
}

function setExpiryFilter(key) {
  state.expiryFilter = key;
  renderExpiry();
}

function pickDay(iso) {
  state.expiryFilter = state.expiryFilter === 'date:' + iso ? 'all' : 'date:' + iso;
  renderExpiry();
}

function renderExpiry() {
  var opts = options();

  $('expiryChips').innerHTML = CHIPS.map(function (c) {
    var n = opts.filter(function (o) { return matchFilter(o, c.key); }).length;
    var cls = 'chip' + (state.expiryFilter === c.key ? ' active' : '') + (c.danger ? ' danger' : '');
    return '<button class="' + cls + '" onclick="setExpiryFilter(\'' + c.key + '\')">' +
      c.label + ' <b>' + n + '</b></button>';
  }).join('');

  renderWeek(opts);

  var filtered = opts.filter(function (o) { return matchFilter(o, state.expiryFilter); });
  var host = $('expiryBody');
  var html = '';

  if (state.expiryFilter.indexOf('date:') === 0) {
    html += '<div class="date-filter"><span>筛选 <b>' + mmdd(state.expiryFilter.slice(5)) + '</b> 到期的合约</span>' +
      '<button onclick="setExpiryFilter(\'all\')">清除</button></div>';
  }

  if (!filtered.length) {
    host.innerHTML = html + emptyBlock('i-check', '这里没有要处理的合约', '换个筛选条件，或去「记一笔」卖出新的 Put');
    return;
  }

  var groups = [
    { label: '已过期', cls: 'red', test: function (o) { return dteOf(o.date) < 0; } },
    { label: '今天到期', cls: 'red', test: function (o) { return dteOf(o.date) === 0; } },
    { label: '3 天内', cls: 'amber', test: function (o) { return dteOf(o.date) > 0 && dteOf(o.date) <= 3; } },
    { label: '提醒期', cls: 'blue', test: function (o) { return dteOf(o.date) > 3 && dteOf(o.date) <= 10; } },
    { label: '未来 30 天', cls: '', test: function (o) { return dteOf(o.date) > 10 && dteOf(o.date) <= 30; } }
  ];

  groups.forEach(function (g) {
    var items = filtered.filter(g.test).sort(function (a, b) { return dteOf(a.date) - dteOf(b.date); });
    if (!items.length) return;
    html += '<div class="expiry-group"><div class="expiry-group-head ' + g.cls + '">' +
      '<span class="tag-dot"></span><h3>' + g.label + '</h3><span>' + items.length + ' 个</span></div>' +
      items.map(expiryCard).join('') + '</div>';
  });

  host.innerHTML = html;
  syncBadge();
}

function expiryCard(o) {
  var dte = dteOf(o.date);
  var badge, tone;
  if (dte < 0) { badge = '已过期 ' + (-dte) + ' 天'; tone = 'red'; }
  else if (dte === 0) { badge = '今天'; tone = 'red'; }
  else if (dte <= 3) { badge = dte + ' 天后'; tone = 'amber'; }
  else { badge = dte + ' 天后'; tone = 'blue'; }

  return '<div class="expiry-card' + (dte < 0 ? ' overdue' : '') + '">' +
    '<div class="expiry-top"><div><b>' + o.sym + '</b>' +
      '<span class="badge ' + (o.type === 'put' ? 'blue' : 'neutral') + '">$' + o.strike +
        (o.type === 'put' ? 'P' : 'C') + '</span>' +
      (state.account === 'all' ? '<span class="acct-tag">' + accountName(o.account) + '</span>' : '') +
      '</div><span class="badge ' + tone + '">' + badge + '</span></div>' +
    '<div class="expiry-meta">' +
      '<span>' + o.qty + ' 手</span>' +
      '<span>净权利金 <b>' + usd(o.premium, 0) + '</b></span>' +
      (o.collateral ? '<span>义务 <b>' + usd(o.collateral, 0) + '</b></span>' : '<span>备兑 <b>无义务</b></span>') +
      '<span>' + mmdd(o.date) + '</span>' +
    '</div>' +
    '<div class="expiry-actions">' +
      '<button onclick="contractSheet(\'' + o.id + '\',\'close\')">平仓</button>' +
      '<button onclick="contractSheet(\'' + o.id + '\',\'expire\')">作废</button>' +
      '<button class="danger" onclick="contractSheet(\'' + o.id + '\',\'assign\')">' +
        (o.type === 'put' ? '指派' : '被行权') + '</button>' +
    '</div>' +
  '</div>';
}

function renderWeek(opts) {
  var monday = new Date(TODAY.getTime());
  monday.setDate(TODAY.getDate() - ((TODAY.getDay() + 6) % 7));
  var names = ['一', '二', '三', '四', '五', '六', '日'];
  var html = '';
  for (var i = 0; i < 7; i++) {
    var d = new Date(monday.getTime());
    d.setDate(monday.getDate() + i);
    var iso = isoOf(d);
    var isToday = iso === isoOf(TODAY);
    var has = opts.some(function (o) { return o.date === iso; });
    var sel = state.expiryFilter === 'date:' + iso;
    html += '<button class="day' + (isToday ? ' today' : '') + (sel ? ' selected' : '') +
      '" onclick="pickDay(\'' + iso + '\')">' +
      '<span>周' + names[i] + '</span><b>' + d.getDate() + '</b>' +
      (has ? '<i class="has-dot"></i>' : '') +
    '</button>';
  }
  $('weekStrip').innerHTML = html;
}

function syncBadge() {
  var n = options().filter(function (o) { return dteOf(o.date) <= 3; }).length;
  var b = $('expiryBadge');
  b.textContent = n;
  b.style.display = n ? '' : 'none';
}

function checkExpiry() {
  var n = options().filter(function (o) { return dteOf(o.date) <= 7; }).length;
  showToast('已检查 ' + n + ' 个合约 · 通知已发送（同一阶段只提醒一次）');
}
