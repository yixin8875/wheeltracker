/* Wheel Tracker · Android demo — navigation & home */

function showView(id, resetScroll) {
  var prev = document.querySelector('.view.active');
  if (prev) scrollMem[prev.id] = viewportEl.scrollTop;

  var views = document.querySelectorAll('.view');
  for (var i = 0; i < views.length; i++) views[i].classList.toggle('active', views[i].id === id);

  var main = { 'view-home': 'home', 'view-positions': 'positions', 'view-expiry': 'expiry', 'view-me': 'me' };
  var isMain = !!main[id];
  screenEl.classList.toggle('subpage', !isMain);
  screenEl.classList.toggle('detail-page', id === 'view-detail');
  fabEl.classList.toggle('show', isMain);
  detailActionsEl.classList.toggle('show', id === 'view-detail');

  var tabs = document.querySelectorAll('.tab');
  for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('active', tabs[j].dataset.tab === main[id]);
  if (isMain) state.tab = main[id];

  viewportEl.scrollTop = resetScroll ? 0 : (scrollMem[id] || 0);
}

function switchTab(tab) {
  closeSheet();
  state.stack = [];
  showView('view-' + tab, true);
}

function pushView(id) {
  state.stack.push(document.querySelector('.view.active').id);
  showView(id, true);
}

function goBack() {
  var prev = state.stack.pop() || 'view-home';
  showView(prev, false);
}

function renderHome() {
  var acc = currentAccount();
  var av = $('acctAvatar');
  av.textContent = acc ? acc.initial : '全';
  av.className = 'avatar ' + (acc ? acc.cls : 'blue');
  $('acctName').textContent = acc ? acc.name : '全部账户';
  $('acctSub').textContent = acc ? acc.broker + ' · USD' : ACCOUNTS.length + ' 个账户 · USD';

  $('heroLabel').textContent = '已落袋净收租 · ' + (acc ? acc.name : '全部账户');
  $('heroPill').textContent = '本月 +$2,840';

  var realized = realizedNow();
  var whole = Math.floor(realized);
  var cents = Math.round((realized - whole) * 100);
  $('heroRealized').innerHTML = '<small>$</small><span>' + fmt(whole, 0) + '</span><em>.' +
    (cents < 10 ? '0' + cents : cents) + '</em>';

  var open = openNow(), ob = obligationNow(), cash = cashNow();
  $('heroOpen').textContent = usd(open, 0);
  $('heroCollateral').textContent = usd(ob, 0);
  var cover = ob > 0 ? cash / ob * 100 : 999;
  var coverEl = $('heroCoverage');
  coverEl.textContent = cover > 900 ? '—' : Math.round(cover) + '%';
  coverEl.className = cover < 100 ? 'neg' : '';

  var warn = $('cashWarning');
  if (cover < 100) {
    warn.classList.add('show');
    $('cashWarningText').textContent = '现金覆盖率 ' + Math.round(cover) +
      '%，Put 义务高于账户现金 ' + usd(ob - cash, 0);
  } else {
    warn.classList.remove('show');
  }

  var need = options().filter(function (o) { return dteOf(o.date) <= 3; });
  var alertBtn = $('expiryAlert');
  if (need.length) {
    alertBtn.style.display = '';
    $('alertTitle').textContent = need.length + ' 个合约需要处理';
    $('alertSub').textContent = need.map(function (o) {
      var d = dteOf(o.date);
      return o.sym + ' ' + (d < 0 ? '已过期' : d === 0 ? '今天' : d + ' 天后');
    }).join(' · ');
  } else {
    alertBtn.style.display = 'none';
  }

  var list = campaigns();
  var host = $('campaignList');
  if (!list.length) {
    host.innerHTML = emptyBlock('i-layers', '这个账户还没有持股', '现金担保 Put 在「持仓 → 期权」里查看');
    return;
  }
  host.innerHTML = list.map(campaignCard).join('');
}

function campaignCard(c) {
  var margin = (c.price - c.costB) / c.costB * 100;
  var tone = margin >= 8 ? 'green' : margin >= 0 ? 'amber' : 'red';
  var toneColor = tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'var(--red)';
  var next = OPTIONS.filter(function (o) { return o.sym === c.sym; })[0];
  var nextText = next
    ? (next.strike + (next.type === 'put' ? 'P' : 'C') + ' · ' + mmdd(next.date))
    : '待卖出';
  var change = (c.price - c.prev) / c.prev * 100;

  return '<button class="campaign" onclick="openDetail(\'' + c.sym + '\')">' +
    '<div class="campaign-top">' +
      '<span class="campaign-sym"><span class="sym">' + c.sym + '</span>' +
        (state.account === 'all' ? '<span class="acct-tag">' + accountName(c.account) + '</span>' : '') +
        '<span class="dot-live"></span></span>' +
      '<span class="badge ' + tone + '">安全边际 ' + pctText(margin) + '</span>' +
    '</div>' +
    '<div class="campaign-mid">' +
      '<div class="campaign-cost"><span>有效成本 B</span><b>' + usd(c.costB) + '</b></div>' +
      spark(c.series, toneColor) +
      '<div class="campaign-price"><span>现价</span><b>' + usd(c.price) + '</b>' +
        '<small class="' + (change >= 0 ? 'green' : 'red') + '">' + pctText(change, 2) + '</small></div>' +
    '</div>' +
    '<div class="campaign-metrics">' +
      '<div><span>持股</span><b>' + c.shares + ' 股</b></div>' +
      '<div><span>已落袋</span><b>' + usd(c.realized, 0) + '</b></div>' +
      '<div><span>下一张合约</span><b>' + nextText + '</b></div>' +
    '</div>' +
  '</button>';
}

function spark(series, color) {
  var min = Math.min.apply(null, series), max = Math.max.apply(null, series);
  var span = (max - min) || 1;
  var pts = series.map(function (v, i) {
    return [2 + i * (56 / (series.length - 1)), 27 - (v - min) / span * 23];
  });
  var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
  var area = d + ' L 58 29 L 2 29 Z';
  return '<svg class="spark" viewBox="0 0 60 30" style="color:' + color + '">' +
    '<path d="' + area + '" fill="currentColor" opacity=".1"/>' +
    '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
}
