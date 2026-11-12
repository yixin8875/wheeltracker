/* Wheel Tracker · Android demo — contract actions */

function contractSheet(id, action) {
  var o = optionById(id);
  if (!o) { closeSheet(); return; }
  if (action) { confirmAction(id, action); return; }

  var dte = dteOf(o.date);
  var when = dte < 0 ? '已过期 ' + (-dte) + ' 天' : dte === 0 ? '今天到期' : dte + ' 天后到期';

  openSheet(sheetHead(o.sym + ' $' + o.strike + (o.type === 'put' ? 'P' : 'C'),
    when + ' · ' + accountName(o.account), null) +
    '<div class="action-hero">' +
      '<span class="badge ' + (o.type === 'put' ? 'blue' : 'neutral') + '">' +
        (o.type === 'put' ? '卖出 Put' : '卖出 Call') + '</span>' +
      '<h3>' + o.qty + ' 手 · 净权利金 ' + usd(o.premium, 0) + '</h3>' +
      '<p>' + (o.collateral ? '资金义务 ' + usd(o.collateral, 0) : '备兑，无需额外资金') + '</p>' +
    '</div>' +
    '<div class="action-list">' +
      '<button class="action-row" onclick="confirmAction(\'' + o.id + '\',\'close\')">' +
        '<span class="row-icon blue"><svg class="icon"><use href="#i-arrow-down-left"/></svg></span>' +
        '<span class="row-text"><b>买入平仓</b><small>买回合约，释放资金义务</small></span>' +
        '<svg class="icon sm chev"><use href="#i-chev-right"/></svg></button>' +
      '<button class="action-row" onclick="confirmAction(\'' + o.id + '\',\'expire\')">' +
        '<span class="row-icon amber"><svg class="icon"><use href="#i-x"/></svg></span>' +
        '<span class="row-text"><b>到期作废</b><small>权利金全部转为已落袋</small></span>' +
        '<svg class="icon sm chev"><use href="#i-chev-right"/></svg></button>' +
      '<button class="action-row" onclick="confirmAction(\'' + o.id + '\',\'assign\')">' +
        '<span class="row-icon green"><svg class="icon"><use href="#i-check"/></svg></span>' +
        '<span class="row-text"><b>' + (o.type === 'put' ? '被指派接股' : '被 Call 走') + '</b>' +
          '<small>' + (o.type === 'put'
            ? '按 $' + o.strike + ' 买入 ' + (o.qty * 100) + ' 股'
            : '按 $' + o.strike + ' 卖出持股') + '</small></span>' +
        '<svg class="icon sm chev"><use href="#i-chev-right"/></svg></button>' +
    '</div>' +
    '<button class="btn ghost block" onclick="closeSheet()">取消</button>');
}

function confirmAction(id, action) {
  var o = optionById(id);
  if (!o) return;
  var qtyShares = o.qty * 100;
  var label, desc, btn, tone;

  if (action === 'close') {
    var cost = 0.65 * 100 * o.qty + 1.3;
    label = '买入平仓';
    desc = '按当前报价 $0.65 买回 ' + o.qty + ' 手，释放义务 ' + usd(o.collateral, 0) + '。';
    btn = '确认平仓 · ' + usd(cost);
    tone = 'primary';
  } else if (action === 'expire') {
    label = '到期作废';
    desc = '合约到期未行权，' + usd(o.premium) + ' 权利金全部保留为已落袋。';
    btn = '确认作废';
    tone = 'primary';
  } else {
    if (o.type === 'put') {
      var basis = (o.strike * qtyShares - o.premium) / qtyShares;
      label = '被指派接股';
      desc = '按 $' + o.strike + ' 买入 ' + qtyShares + ' 股，扣除本次权利金后新成本 B 为 ' +
        usd(basis) + '。';
    } else {
      label = '被 Call 走';
      desc = '按 $' + o.strike + ' 卖出 ' + qtyShares + ' 股，权利金 ' + usd(o.premium) + ' 保留。';
    }
    btn = '确认指派';
    tone = 'danger';
  }

  openSheet(sheetHead(label, o.sym + ' $' + o.strike + (o.type === 'put' ? 'P' : 'C') +
    ' · ' + o.qty + ' 手', 'contractSheet(\'' + o.id + '\')') +
    '<div class="action-hero"><h3>' + o.sym + ' $' + o.strike +
      (o.type === 'put' ? 'P' : 'C') + '</h3><p>' + desc + '</p></div>' +
    '<div class="checklist">' +
      '<div><svg class="icon"><use href="#i-check"/></svg>写入本地事件流，可撤销</div>' +
      '<div><svg class="icon"><use href="#i-check"/></svg>持仓与有效成本 B 立即重算</div>' +
      '<div><svg class="icon"><use href="#i-check"/></svg>下次备份自动上传</div>' +
    '</div>' +
    '<button class="btn ' + tone + ' block" onclick="doAction(\'' + o.id + '\',\'' +
      action + '\')">' + btn + '</button>' +
    '<button class="btn ghost block" onclick="closeSheet()">取消</button>');
}

function doAction(id, action) {
  var o = optionById(id);
  if (!o) return;
  var msg;
  if (action === 'close') {
    msg = '已平仓 ' + o.sym + ' $' + o.strike + (o.type === 'put' ? 'P' : 'C');
  } else if (action === 'expire') {
    msg = '已作废 ' + o.sym + ' · 权利金 ' + usd(o.premium, 0) + ' 转为已落袋';
  } else {
    msg = '已记录指派 ' + o.sym + ' · 持仓已重算';
  }
  for (var i = 0; i < OPTIONS.length; i++) {
    if (OPTIONS[i].id === id) { OPTIONS.splice(i, 1); break; }
  }
  var c = campaignOf(o.sym);
  if (c) c.realized += o.premium;
  renderHome(); renderPositions(); renderExpiry();
  var active = document.querySelector('.view.active');
  if (active && active.id === 'view-detail') renderDetail();
  closeSheet();
  showToast(msg);
}
