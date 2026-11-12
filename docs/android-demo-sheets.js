/* Wheel Tracker · Android demo — bottom sheet & toast primitives */

function sheetHead(title, sub, backAction) {
  return '<div class="sheet-grip"></div>' +
    '<div class="sheet-head"><div class="sheet-title-row">' +
      '<div>' +
        '<div class="sheet-title-flex">' +
          (backAction
            ? '<button class="sheet-back" aria-label="返回" onclick="' + backAction + '">' +
              '<svg class="icon"><use href="#i-chev-left"/></svg></button>'
            : '') +
          '<h2>' + title + '</h2>' +
        '</div>' +
        (sub ? '<p>' + sub + '</p>' : '') +
      '</div>' +
      '<button class="sheet-close" aria-label="关闭" onclick="closeSheet()">' +
        '<svg class="icon"><use href="#i-x"/></svg></button>' +
    '</div></div>';
}

function openSheet(html, full) {
  var sheet = $('sheet');
  sheet.innerHTML = html;
  sheet.classList.toggle('full', !!full);
  $('scrim').classList.add('open');
  sheet.classList.add('open');
  screenEl.classList.add('sheet-open');
  sheet.scrollTop = 0;
}

function closeSheet() {
  var sheet = $('sheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  $('scrim').classList.remove('open');
  screenEl.classList.remove('sheet-open');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(function () {
    if (!sheet.classList.contains('open')) sheet.innerHTML = '';
  }, 380);
}

function showToast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
}
