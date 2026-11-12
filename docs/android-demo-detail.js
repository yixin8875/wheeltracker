/* Wheel Tracker · Android demo — campaign detail */

function openDetail(sym) {
  state.detailSym = sym;
  renderDetail();
  pushView('view-detail');
}

function renderDetail() {
  var c = campaignOf(state.detailSym);
  if (!c) return;
  $('detailSymbol').textContent = c.sym;
  $('detailSub').textContent = accountName(c.account) + ' · 持有 ' + c.shares + ' 股';

  var margin = (c.price - c.costB) / c.costB * 100;
  var tone = margin >= 8 ? 'green' : margin >= 0 ? 'amber' : 'red';
  var change = (c.price - c.prev) / c.prev * 100;
  var opts = OPTIONS.filter(function (o) { return o.sym === c.sym; });

  var lo = Math.min.apply(null, c.series.concat([c.costB]));
  var hi = Math.max.apply(null, c.series.concat([c.costB]));
  var pad = (hi - lo) * 0.18 || 1;
  var chart = lineChart(c.series, lo - pad, hi + pad, c.costB, c.price);

  var html = '';
  html += '<div class="detail-hero">' +
    '<div class="detail-hero-top"><span>有效成本 B · ' + accountName(c.account) + '</span>' +
      '<span class="badge ' + tone + '">安全边际 ' + pctText(margin) + '</span></div>' +
    '<div class="detail-big">' + usd(c.costB) + '</div>' +
    '<div class="detail-price"><span>现价 <b>' + usd(c.price) + '</b> · ' +
      '<span class="' + (change >= 0 ? 'green' : 'red') + '">' + pctText(change, 2) + '</span></span>' +
      '<span>市值 ' + usd(c.price * c.shares, 0) + '</span></div>' +
    '<div class="cost-tracks">' +
      '<div><span>A 纯股票成本</span><b>' + usd(c.costA) + '</b></div>' +
      '<div class="active"><span>B 已落袋</span><b>' + usd(c.costB) + '</b></div>' +
      '<div><span>C′ 含未平仓</span><b>' + usd(c.costC) + '</b></div>' +
    '</div>' +
  '</div>';

  html += '<div class="chart-card"><div class="card-head"><b>成本阶梯</b><span>近 30 天 · B 成本线</span></div>' +
    '<div class="big-chart">' + chart + '</div>' +
    '<div class="chart-x"><span>10/14</span><span>10/29</span><span>今天</span></div></div>';

  html += '<div class="section-head"><h2>持仓</h2><span class="muted">' + c.shares + ' 股 · ' +
    opts.length + ' 个合约</span></div>';

  html += '<div class="stock-card">' +
    '<div class="pos-top"><span class="pos-sym">正股 ' + c.sym + '</span>' +
      '<span class="badge ' + (c.price >= c.costB ? 'green' : 'red') + '">' + pctText(margin) + '</span></div>' +
    '<div class="pos-mid"><div><span>持股</span><b>' + c.shares + ' 股</b></div>' +
      '<div class="right"><span>浮动盈亏</span><b class="' + (c.price >= c.costB ? 'green' : 'red') + '">' +
        usdSigned((c.price - c.costB) * c.shares, 0) + '</b></div></div>' +
    '<div class="pos-bottom"><span>A ' + usd(c.costA) + ' · B ' + usd(c.costB) + '</span>' +
      '<span>现价 ' + usd(c.price) + '</span></div>' +
  '</div>';

  if (opts.length) {
    html += '<div class="stack" style="margin-top:9px">' + opts.map(function (o) {
      var dte = dteOf(o.date);
      var badge = dte < 0 ? '已过期' : dte === 0 ? '今天' : dte + ' 天后';
      var tone2 = dte <= 3 ? 'red' : 'blue';
      return '<div class="detail-opt">' +
        '<div class="detail-opt-top"><div><b>' + o.sym + ' $' + o.strike +
          (o.type === 'put' ? 'P' : 'C') + '</b>' +
          '<span class="badge ' + (o.type === 'put' ? 'blue' : 'neutral') + '">' +
            (o.type === 'put' ? '卖出 Put' : '卖出 Call') + '</span></div>' +
          '<span class="badge ' + tone2 + '">' + badge + '</span></div>' +
        '<div class="detail-opt-meta"><span>' + o.qty + ' 手 · 净权利金 ' + usd(o.premium, 0) + '</span>' +
          '<span>到期 ' + mmdd(o.date) + '</span></div>' +
        '<div class="expiry-actions">' +
          '<button onclick="contractSheet(\'' + o.id + '\',\'close\')">平仓</button>' +
          '<button onclick="contractSheet(\'' + o.id + '\',\'expire\')">作废</button>' +
          '<button class="danger" onclick="contractSheet(\'' + o.id + '\',\'assign\')">' +
            (o.type === 'put' ? '指派' : '被行权') + '</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  var putOpt = opts.filter(function (o) { return o.type === 'put'; })[0];
  var callOpt = opts.filter(function (o) { return o.type === 'call'; })[0];

  if (callOpt) {
    var sale = callOpt.strike * c.shares;
    var basis = c.costB * c.shares;
    html += '<div class="assign-preview">' +
      '<h3>若被 Call 走 · $' + callOpt.strike + '</h3>' +
      '<div class="assign-big">' + usdSigned(sale - basis + c.realized + callOpt.premium, 0) + '</div>' +
      '<div class="assign-sub">预计总收益（含历史已落袋）</div>' +
      '<div class="assign-rows">' +
        '<div><span>行权收入</span><b>' + usd(sale, 0) + '</b></div>' +
        '<div><span>股票成本 B</span><b>' + usd(basis, 0) + '</b></div>' +
        '<div><span>历史已落袋</span><b>' + usd(c.realized) + '</b></div>' +
        '<div><span>本次未平仓权利金</span><b>' + usd(callOpt.premium) + '</b></div>' +
      '</div></div>';
  } else if (putOpt) {
    var shares = putOpt.qty * 100;
    var cost = putOpt.strike * shares;
    var newCost = (cost - putOpt.premium) / shares;
    html += '<div class="assign-preview">' +
      '<h3>若被 Put 指派 · $' + putOpt.strike + '</h3>' +
      '<div class="assign-big">' + usd(newCost) + '</div>' +
      '<div class="assign-sub">指派后的新有效成本 B（每 100 股）</div>' +
      '<div class="assign-rows">' +
        '<div><span>买入金额</span><b>' + usd(cost, 0) + '</b></div>' +
        '<div><span>本次权利金</span><b>' + usd(putOpt.premium) + '</b></div>' +
        '<div><span>新增持股</span><b>' + shares + ' 股</b></div>' +
        '<div><span>合计持股</span><b>' + (c.shares + shares) + ' 股</b></div>' +
      '</div></div>';
  }

  html += '<div class="section-head"><h2>交易记录</h2><span class="muted">最近 ' +
    c.timeline.length + ' 笔</span></div>' +
    '<div class="timeline">' + c.timeline.map(function (t) {
      return '<div class="tl-item"><span class="tl-dot"></span><div style="flex:1">' +
        '<time>' + t.t + '</time><p>' + t.p + '</p></div>' +
        '<b class="' + (t.tone === 'green' ? 'green' : t.tone === 'red' ? 'red' : 'muted') + '">' +
        t.v + '</b></div>';
    }).join('') + '</div>';

  html += '<p class="detail-note">A 是纯股票成本，B 扣除该标的已落袋权利金，C′ 再扣除未平仓权利金。' +
    '手机端只读历史，完整编辑回桌面端。</p>';

  $('detailBody').innerHTML = html;
  $('detailPrimary').textContent = '卖 Call';
}

function openDetailPrimary() {
  openEntrySheet({ type: 'sell-call', sym: state.detailSym });
}

function lineChart(values, min, max, costB, last) {
  var w = 320, h = 150, padL = 6, padR = 46, padT = 12, padB = 12;
  var span = (max - min) || 1;
  var pts = values.map(function (v, i) {
    return [
      padL + i * (w - padL - padR) / (values.length - 1),
      padT + (1 - (v - min) / span) * (h - padT - padB)
    ];
  });
  var d = pts.map(function (p, i) {
    return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
  }).join(' ');
  var area = d + ' L ' + pts[pts.length - 1][0].toFixed(1) + ' ' + (h - padB) +
    ' L ' + pts[0][0].toFixed(1) + ' ' + (h - padB) + ' Z';
  var yB = padT + (1 - (costB - min) / span) * (h - padT - padB);
  var lp = pts[pts.length - 1];

  var grid = '';
  for (var i = 0; i < 4; i++) {
    var y = padT + i * (h - padT - padB) / 3;
    grid += '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + y + '" y2="' + y +
      '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4"/>';
  }

  return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="成本阶梯图">' +
    '<defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="var(--accent)" stop-opacity=".2"/>' +
      '<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>' +
    '</linearGradient></defs>' + grid +
    '<path d="' + area + '" fill="url(#areaFill)"/>' +
    '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + yB + '" y2="' + yB +
      '" stroke="var(--green)" stroke-width="1.2" stroke-dasharray="5 4"/>' +
    '<text x="' + (w - padR + 6) + '" y="' + (yB + 3.5) +
      '" class="chart-tag" fill="var(--green)">B ' + fmt(costB) + '</text>' +
    '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + lp[0].toFixed(1) + '" cy="' + lp[1].toFixed(1) +
      '" r="3.6" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>' +
    '<text x="' + (lp[0] - 2) + '" y="' + (lp[1] - 10) +
      '" class="chart-tag" text-anchor="end" fill="var(--text-2)">' + fmt(last) + '</text>' +
  '</svg>';
}
