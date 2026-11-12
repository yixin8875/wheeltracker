/* Wheel Tracker · Android demo — entry forms */

function entryForm(type, pre) {
  var sym = pre.sym || 'NVDA';
  var isOption = type === 'sell-put' || type === 'sell-call';
  var todayIso = isoOf(TODAY);

  if (isOption) {
    var exp = pre.exp || '2026-11-21';
    var strike = pre.strike || (type === 'sell-put' ? '120' : '135');
    var prem = pre.premium || (type === 'sell-put' ? '2.30' : '1.85');
    return '<label class="field"><span>标的</span>' +
        '<input id="eSym" value="' + sym + '" autocomplete="off" oninput="updateEntry()"></label>' +
      '<div class="field-row">' +
        '<label class="field"><span>行权价</span>' +
          '<input id="eStrike" inputmode="decimal" value="' + strike + '" oninput="updateEntry()"></label>' +
        '<label class="field"><span>到期日</span>' +
          '<input id="eExp" type="date" value="' + exp + '" onchange="updateEntry()"></label>' +
      '</div>' +
      '<label class="field"><span>手数 · 每手 100 股</span>' +
        '<div class="qty-stepper">' +
          '<button type="button" onclick="stepQty(-1)" aria-label="减少">−</button>' +
          '<input id="eQty" inputmode="numeric" value="1" oninput="updateEntry()">' +
          '<button type="button" onclick="stepQty(1)" aria-label="增加">+</button>' +
        '</div></label>' +
      '<div class="field-row">' +
        '<label class="field"><span>权利金 / 股</span>' +
          '<input id="ePrem" inputmode="decimal" value="' + prem + '" oninput="updateEntry()"></label>' +
        '<label class="field"><span>费用</span>' +
          '<input id="eFee" inputmode="decimal" value="1.30" oninput="updateEntry()"></label>' +
      '</div>' +
      '<div class="preview-card" id="entryPreview"></div>' +
      '<button class="btn primary block" onclick="saveEntry()">保存</button>';
  }

  if (type === 'buy-close') {
    return '<label class="field"><span>标的</span>' +
        '<input id="eSym" value="' + sym + '"></label>' +
      '<div class="field-row">' +
        '<label class="field"><span>行权价</span>' +
          '<input id="eStrike" inputmode="decimal" value="' + (pre.strike || '130') + '" oninput="updateEntry()"></label>' +
        '<label class="field"><span>买入价 / 股</span>' +
          '<input id="ePrem" inputmode="decimal" value="0.65" oninput="updateEntry()"></label>' +
      '</div>' +
      '<label class="field"><span>手数</span><div class="qty-stepper">' +
        '<button type="button" onclick="stepQty(-1)">−</button>' +
        '<input id="eQty" inputmode="numeric" value="' + (pre.qty || 1) + '" oninput="updateEntry()">' +
        '<button type="button" onclick="stepQty(1)">+</button></div></label>' +
      '<div class="preview-card" id="entryPreview"></div>' +
      '<button class="btn primary block" onclick="saveEntry()">保存</button>';
  }

  if (type === 'expire' || type === 'assign') {
    return '<label class="field"><span>标的</span>' +
        '<input id="eSym" value="' + sym + '"></label>' +
      '<div class="field-row">' +
        '<label class="field"><span>行权价</span>' +
          '<input id="eStrike" inputmode="decimal" value="' + (pre.strike || '120') + '"></label>' +
        '<label class="field"><span>发生日</span>' +
          '<input id="eExp" type="date" value="' + (pre.exp || todayIso) + '"></label>' +
      '</div>' +
      '<label class="field"><span>手数</span><div class="qty-stepper">' +
        '<button type="button" onclick="stepQty(-1)">−</button>' +
        '<input id="eQty" inputmode="numeric" value="' + (pre.qty || 1) + '">' +
        '<button type="button" onclick="stepQty(1)">+</button></div></label>' +
      '<div class="preview-card">' +
        '<div class="preview-row"><span>' + (type === 'expire' ? '处理方式' : '结果') + '</span>' +
          '<b>' + (type === 'expire' ? '保留全部权利金' : '按行权价接股 / 交股') + '</b></div>' +
        '<div class="preview-row"><span>影响</span><b>更新持仓与有效成本 B</b></div>' +
      '</div>' +
      '<button class="btn primary block" onclick="saveEntry()">保存</button>';
  }

  if (type === 'stock') {
    return '<div class="field-row">' +
        '<label class="field"><span>方向</span><select id="eSide">' +
          '<option value="buy">买入</option><option value="sell">卖出</option></select></label>' +
        '<label class="field"><span>标的</span><input id="eSym" value="' + sym + '"></label>' +
      '</div>' +
      '<div class="field-row">' +
        '<label class="field"><span>股数</span>' +
          '<input id="eQty" inputmode="numeric" value="100" oninput="updateEntry()"></label>' +
        '<label class="field"><span>价格</span>' +
          '<input id="ePrem" inputmode="decimal" value="' + (pre.price || '126.40') + '" oninput="updateEntry()"></label>' +
      '</div>' +
      '<div class="preview-card" id="entryPreview"></div>' +
      '<button class="btn primary block" onclick="saveEntry()">保存</button>';
  }

  return '<div class="field-row">' +
      '<label class="field"><span>类型</span><select id="eSide">' +
        '<option>入金</option><option>出金</option><option>分红</option><option>费用</option>' +
      '</select></label>' +
      '<label class="field"><span>日期</span>' +
        '<input id="eExp" type="date" value="' + todayIso + '"></label>' +
    '</div>' +
    '<label class="field"><span>金额</span>' +
      '<input id="ePrem" inputmode="decimal" value="1000.00" oninput="updateEntry()"></label>' +
    '<div class="preview-card" id="entryPreview"></div>' +
    '<button class="btn primary block" onclick="saveEntry()">保存</button>';
}
