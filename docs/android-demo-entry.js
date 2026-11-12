/* Wheel Tracker · Android demo — entry sheet, step 1 */

function openEntrySheet(opts) {
  opts = opts || {};
  entryState.prefill = opts;
  if (opts.type) {
    entryState.type = opts.type;
    openEntryForm();
  } else {
    openEntryTypes();
  }
}

function openEntryTypes() {
  openSheet(sheetHead('记一笔', '两步完成 · 之后可以从持仓直接平仓', null) +
    '<div class="type-grid">' + ENTRY_TYPES.map(function (t) {
      return '<button class="type-card" onclick="pickEntryType(\'' + t.key + '\')">' +
        '<span class="type-icon ' + t.color + '">' +
          '<svg class="icon"><use href="#' + t.icon + '"/></svg></span>' +
        '<b>' + t.label + '</b><small>' + t.desc + '</small>' +
      '</button>';
    }).join('') + '</div>' +
    '<div class="sheet-note"><svg class="icon"><use href="#i-alert"/></svg>' +
      '<p>离线也能记账；行情失败只会让预览缺少现价，不影响保存。</p></div>', true);
}

function pickEntryType(key) {
  entryState.type = key;
  openEntryForm();
}

function openEntryForm() {
  var type = entryState.type;
  var meta = ENTRY_TYPES.filter(function (t) { return t.key === type; })[0] || ENTRY_TYPES[0];
  var pre = entryState.prefill || {};

  openSheet(sheetHead(meta.label, meta.desc, 'openEntryTypes()') +
    entryForm(type, pre) +
    '<div class="sheet-note"><svg class="icon"><use href="#i-shield"/></svg>' +
      '<p>保存后立即写入本地账本，WebDAV 会在下次备份时一并上传。</p></div>', true);

  updateEntry();
}
