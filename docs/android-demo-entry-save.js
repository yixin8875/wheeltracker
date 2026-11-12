/* Wheel Tracker · Android demo — entry preview & save */

function stepQty(delta) {
  var el = $('eQty');
  if (!el) return;
  var v = parseInt(el.value, 10) || 0;
  el.value = Math.max(1, v + delta);
  updateEntry();
}

function numOf(id) {
  var el = $(id);
  if (!el) return 0;
  var n = parseFloat(String(el.value).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function updateEntry() {
  var box = $('entryPreview');
  if (!box) return;
  var type = entryState.type;
  var qtyEl = $('eQty');
  var qty = Math.max(1, parseInt(qtyEl ? qtyEl.value : 1, 10) || 1);

  if (type === 'sell-put' || type === 'sell-call') {
    var strike = numOf('eStrike'), prem = numOf('ePrem'), fee = numOf('eFee');
    var net = prem * 100 * qty - fee;
    var coll = type === 'sell-put' ? strike * 100 * qty : 0;
    var expEl = $('eExp');
    var dte = expEl && expEl.value ? dteOf(expEl.value.slice(0, 10)) : 0;
    if (dte < 1) dte = 1;
    var annual = coll > 0 ? net / coll * 365 / dte * 100 : 0;

    box.innerHTML =
      '<div class="preview-row"><span>净权利金</span>' +
        '<b class="green">' + usdSigned(net) + '</b></div>' +
      '<div class="preview-row"><span>' + (coll ? '资金义务' : '备兑') + '</span>' +
        '<b>' + (coll ? usd(coll, 0) : '用持股担保') + '</b></div>' +
      '<div class="preview-row"><span>剩余天数</span>' +
        '<b>' + dte + ' 天' + (coll ? ' · 年化 ' + annual.toFixed(1) + '%' : '') + '</b></div>' +
      '<div class="preview-net"><span>本次入账</span><b>' + usd(net) + '</b></div>';
    return;
  }

  if (type === 'buy-close') {
    var cost = numOf('ePrem') * 100 * qty;
    box.innerHTML =
      '<div class="preview-row"><span>平仓成本</span><b class="red">' + usd(cost + 1.3) + '</b></div>' +
      '<div class="preview-row"><span>释放义务</span>' +
        '<b>' + usd(numOf('eStrike') * 100 * qty, 0) + '</b></div>' +
      '<div class="preview-net"><span>减少未平仓</span><b>' + usd(cost, 0) + '</b></div>';
    return;
  }

  if (type === 'stock') {
    var shares = numOf('eQty'), price = numOf('ePrem');
    var sideEl = $('eSide');
    var selling = sideEl && sideEl.value === 'sell';
    box.innerHTML =
      '<div class="preview-row"><span>成交金额</span><b>' + usd(shares * price) + '</b></div>' +
      '<div class="preview-row"><span>操作</span><b>' + (selling ? '卖出' : '买入') +
        ' ' + shares + ' 股</b></div>' +
      '<div class="preview-net"><span>现金变动</span>' +
        '<b>' + usdSigned((selling ? 1 : -1) * shares * price) + '</b></div>';
    return;
  }

  box.innerHTML =
    '<div class="preview-row"><span>金额</span><b>' + usd(numOf('ePrem')) + '</b></div>' +
    '<div class="preview-row"><span>入账账户</span>' +
      '<b>' + (currentAccount() ? currentAccount().name : '主账户') + '</b></div>';
}

function saveEntry() {
  var type = entryState.type;
  var meta = ENTRY_TYPES.filter(function (t) { return t.key === type; })[0] || { label: '交易' };
  var symEl = $('eSym');
  var sym = symEl ? symEl.value.trim().toUpperCase() : '';

  if (type === 'sell-put' || type === 'sell-call') {
    var strike = numOf('eStrike');
    var qty = Math.max(1, numOf('eQty'));
    var net = numOf('ePrem') * 100 * qty - numOf('eFee');
    var expEl = $('eExp');
    var date = expEl && expEl.value ? expEl.value.slice(0, 10) : '2026-11-21';
    var account = currentAccount() ? currentAccount().id : 'main';

    OPTIONS.push({
      id: 'new-' + Date.now(),
      sym: sym || 'NVDA',
      account: account,
      type: type === 'sell-put' ? 'put' : 'call',
      strike: strike,
      date: date,
      qty: qty,
      premium: Math.round(net),
      collateral: type === 'sell-put' ? strike * 100 * qty : 0
    });
    renderHome(); renderPositions(); renderExpiry();
    closeSheet();
    showToast('已保存：' + meta.label + ' ' + (sym || '') + ' $' + strike +
      ' × ' + qty + ' 手 · 净权利金 ' + usd(net));
    return;
  }

  if (type === 'buy-close' || type === 'expire' || type === 'assign') {
    var idx = -1;
    for (var i = 0; i < OPTIONS.length; i++) {
      if (OPTIONS[i].sym === sym) { idx = i; break; }
    }
    var removed = idx >= 0 ? OPTIONS.splice(idx, 1)[0] : null;
    if (removed) {
      var c = campaignOf(removed.sym);
      if (c) c.realized += removed.premium;
    }
    renderHome(); renderPositions(); renderExpiry();
    var active = document.querySelector('.view.active');
    if (active && active.id === 'view-detail') renderDetail();
    closeSheet();
    showToast('已保存：' + meta.label + (sym ? ' ' + sym : '') + ' · 账本已更新');
    return;
  }

  closeSheet();
  showToast('已保存：' + meta.label + (sym ? ' ' + sym : '') + ' · 账本已更新');
}
