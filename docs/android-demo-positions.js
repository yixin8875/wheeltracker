/* Wheel Tracker · Android demo — positions */

function setPosTab(tab) {
  state.posTab = tab;
  renderPositions();
}

function renderPositions() {
  $('segStocks').classList.toggle('active', state.posTab === 'stocks');
  $('segOptions').classList.toggle('active', state.posTab === 'options');
  var list = campaigns(), opts = options();
  $('posSub').textContent = list.length + ' 个标的 · ' + opts.length + ' 个合约';

  var host = $('positionsBody');
  if (state.posTab === 'stocks') {
    if (!list.length) {
      host.innerHTML = emptyBlock('i-layers', '没有持股', '切换账户，或先在期权里等待被指派');
      return;
    }
    host.innerHTML = list.map(function (c) {
      var pnl = (c.price - c.costB) * c.shares;
      var pnlPct = (c.price - c.costB) / c.costB * 100;
      var tone = pnl >= 0 ? 'green' : 'red';
      return '<button class="stock-card" onclick="openDetail(\'' + c.sym + '\')">' +
        '<div class="pos-top">' +
          '<span class="pos-sym">' + c.sym +
            (state.account === 'all' ? '<span class="acct-tag">' + accountName(c.account) + '</span>' : '') +
          '</span>' +
          '<span class="badge ' + tone + '">' + pctText(pnlPct) + '</span>' +
        '</div>' +
        '<div class="pos-mid">' +
          '<div><span>市值</span><b>' + usd(c.price * c.shares, 0) + '</b></div>' +
          '<div class="right"><span>浮动盈亏</span><b class="' + tone + '">' + usdSigned(pnl, 0) + '</b></div>' +
        '</div>' +
        '<div class="pos-bottom"><span>' + c.shares + ' 股 · B ' + usd(c.costB) + '</span>' +
          '<span>现价 ' + usd(c.price) + '</span></div>' +
      '</button>';
    }).join('');
    return;
  }

  if (!opts.length) {
    host.innerHTML = emptyBlock('i-clock', '没有未平仓合约', '切换到股票查看持股');
    return;
  }

  var sorted = opts.slice().sort(function (a, b) { return dteOf(a.date) - dteOf(b.date); });
  host.innerHTML = '<p class="swipe-hint">左滑卡片露出行权动作，也可以点「更多」</p>' +
    sorted.map(optionRow).join('');
}

function optionRow(o) {
  var dte = dteOf(o.date);
  var badge, tone;
  if (dte < 0) { badge = '已过期 ' + (-dte) + ' 天'; tone = 'red'; }
  else if (dte === 0) { badge = '今天到期'; tone = 'red'; }
  else if (dte <= 3) { badge = dte + ' 天后'; tone = 'amber'; }
  else { badge = dte + ' 天后'; tone = 'blue'; }

  var strikeText = '$' + o.strike + (o.type === 'put' ? 'P' : 'C');
  return '<div class="swipe-row"><div class="swipe-track">' +
    '<div class="option-card">' +
      '<div class="opt-main">' +
        '<div class="opt-title"><b>' + o.sym + ' ' + strikeText + '</b>' +
          '<span class="badge ' + (o.type === 'put' ? 'blue' : 'neutral') + '">' +
            (o.type === 'put' ? '卖出 Put' : '卖出 Call') + '</span>' +
          (state.account === 'all' ? '<span class="acct-tag">' + accountName(o.account) + '</span>' : '') +
        '</div>' +
        '<div class="opt-sub">' + o.qty + ' 手 · 净权利金 ' + usd(o.premium, 0) +
          (o.collateral ? ' · 义务 ' + usd(o.collateral, 0) : ' · 备兑') + '</div>' +
      '</div>' +
      '<div class="opt-dte"><span class="badge ' + tone + '">' + badge + '</span>' +
        '<b>' + mmdd(o.date) + '</b><small>到期日</small></div>' +
      '<button class="kebab" aria-label="更多操作" onclick="contractSheet(\'' + o.id + '\')">' +
        '<svg class="icon sm"><use href="#i-more"/></svg></button>' +
    '</div>' +
    '<div class="row-actions">' +
      '<button class="act blue" onclick="contractSheet(\'' + o.id + '\',\'close\')">' +
        '<svg class="icon"><use href="#i-arrow-down-left"/></svg>平仓</button>' +
      '<button class="act amber" onclick="contractSheet(\'' + o.id + '\',\'expire\')">' +
        '<svg class="icon"><use href="#i-x"/></svg>作废</button>' +
      '<button class="act red" onclick="contractSheet(\'' + o.id + '\',\'assign\')">' +
        '<svg class="icon"><use href="#i-check"/></svg>' +
        (o.type === 'put' ? '指派' : '被行权') + '</button>' +
    '</div>' +
  '</div></div>';
}
