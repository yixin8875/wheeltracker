/* Wheel Tracker · Android demo — reports */

function openReports() {
  renderReports();
  pushView('view-reports');
}

function renderReports() {
  var total = MONTHLY.reduce(function (s, m) { return s + m.v; }, 0);
  var max = Math.max.apply(null, MONTHLY.map(function (m) { return m.v; }));

  var bars = MONTHLY.map(function (m) {
    var hgt = Math.max(3, Math.round(m.v / max * 100));
    var active = m.m === '11月';
    return '<div class="bar-wrap"><span class="bar' + (active ? ' active' : '') +
      '" style="height:' + hgt + '%">' +
      (active ? '<i class="bar-tip">' + usd(m.v, 0) + '</i>' : '') +
      '</span><span class="bar-label">' + m.m.replace('月', '') + '</span></div>';
  }).join('');

  var attr = [
    { sym: 'NVDA', v: 6884.50 }, { sym: 'MSFT', v: 4921.85 }, { sym: 'TSLA', v: 4400.00 },
    { sym: 'AMZN', v: 1860.00 }, { sym: 'GOOGL', v: 576.00 }
  ];
  var attrMax = attr[0].v;

  $('reportBody').innerHTML =
    '<div class="report-hero"><div class="top"><span>累计已落袋净收租</span>' +
      '<span class="badge green">11 个月</span></div>' +
      '<div class="report-big">' + usd(total) + '</div>' +
      '<div class="report-sub">3 个账户 · 已扣除平仓成本与费用</div></div>' +
    '<div class="chart-card"><div class="card-head"><b>月度收租</b><span>2026 年</span></div>' +
      '<div class="bars">' + bars + '</div></div>' +
    '<div class="report-rows">' +
      '<div class="report-row"><span>卖出权利金</span><b class="green">+$20,640.00</b></div>' +
      '<div class="report-row"><span>买入平仓成本</span><b class="red">−$2,150.00</b></div>' +
      '<div class="report-row"><span>交易费用</span><b class="red">−$487.65</b></div>' +
      '<div class="report-row"><span>现金分红</span><b class="green">+$640.00</b></div>' +
      '<div class="report-row total"><span>合计净收租</span><b>' + usd(total) + '</b></div>' +
    '</div>' +
    '<div class="section-head"><h2>按标的归因</h2><span class="muted">已落袋</span></div>' +
    '<div class="attr-list">' + attr.map(function (a) {
      return '<div class="attr-row"><span class="attr-sym">' + a.sym + '</span>' +
        '<span class="attr-bar"><i style="width:' + Math.round(a.v / attrMax * 100) + '%"></i></span>' +
        '<b>' + usd(a.v, 0) + '</b></div>';
    }).join('') + '</div>' +
    '<p class="footnote">报表以已实现口径计算 · 手机端只读，复杂编辑回桌面端</p>';
}
