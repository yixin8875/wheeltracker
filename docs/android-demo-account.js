/* Wheel Tracker · Android demo — account switcher, notices, profile, theme */

function openAccountSheet() {
  var rows = ACCOUNTS.map(function (a) {
    var on = state.account === a.id;
    return '<button class="account-row" onclick="pickAccount(\'' + a.id + '\')">' +
      '<span class="avatar ' + a.cls + '">' + a.initial + '</span>' +
      '<span class="acc-copy"><b>' + a.name + '</b><small>' + a.broker +
        ' · 现金 ' + usd(a.cash, 0) + '</small></span>' +
      '<span class="acc-cash">' + usd(a.cash, 0) + '</span>' +
      '<span class="account-check' + (on ? ' on' : '') + '">' +
        '<svg class="icon"><use href="#i-check"/></svg></span>' +
    '</button>';
  }).join('');

  var total = ACCOUNTS.reduce(function (s, a) { return s + a.cash; }, 0);
  var allOn = state.account === 'all';

  openSheet(sheetHead('账户', '切换后所有页面按账户过滤', null) +
    '<button class="account-row" onclick="pickAccount(\'all\')">' +
      '<span class="avatar blue">全</span>' +
      '<span class="acc-copy"><b>全部账户</b><small>' + ACCOUNTS.length +
        ' 个账户合并查看</small></span>' +
      '<span class="acc-cash">' + usd(total, 0) + '</span>' +
      '<span class="account-check' + (allOn ? ' on' : '') + '">' +
        '<svg class="icon"><use href="#i-check"/></svg></span>' +
    '</button>' + rows +
    '<button class="manage-link" onclick="closeSheet();showToast(\'账户管理在桌面端完成\')">' +
      '管理账户与现金</button>');
}

function pickAccount(id) {
  state.account = id;
  state.expiryFilter = 'all';
  renderHome();
  renderPositions();
  renderExpiry();
  renderMe();
  closeSheet();
  var acc = currentAccount();
  showToast('已切换到 ' + (acc ? acc.name : '全部账户'));
}

function openNoticeSheet() {
  var list = options().filter(function (o) { return dteOf(o.date) <= 7; })
    .sort(function (a, b) { return dteOf(a.date) - dteOf(b.date); });

  var rows = list.map(function (o) {
    var d = dteOf(o.date);
    var when = d < 0 ? '已过期 ' + (-d) + ' 天' : d === 0 ? '今天到期' : d + ' 天后到期';
    return '<button class="list-row" onclick="closeSheet();switchTab(\'expiry\')">' +
      '<span class="row-icon ' + (d <= 3 ? 'amber' : 'blue') + '">' +
        '<svg class="icon"><use href="#i-clock"/></svg></span>' +
      '<span class="row-text"><b>' + o.sym + ' $' + o.strike +
        (o.type === 'put' ? 'P' : 'C') + ' · ' + o.qty + ' 手</b>' +
        '<small>' + when + ' · 净权利金 ' + usd(o.premium, 0) + '</small></span>' +
      '<svg class="icon sm chev"><use href="#i-chev-right"/></svg>' +
    '</button>';
  }).join('');

  openSheet(sheetHead('到期提醒', '每天 09:30 检查 · 同一合约同一阶段只提醒一次', null) +
    '<div class="list-card">' +
      (rows || emptyBlock('i-check', '没有临近到期的合约', '一切都在计划内')) +
    '</div>' +
    '<div class="sheet-note"><svg class="icon"><use href="#i-bell"/></svg>' +
      '<p>提醒通过 Android 通知渠道发送，点通知会直接打开到期页。</p></div>' +
    '<button class="btn primary block" onclick="closeSheet();checkExpiry()">' +
      '立即检查并发送</button>');
}

function renderMe() {
  var acc = currentAccount();
  $('meAccounts').textContent = acc
    ? acc.broker + ' · 现金 ' + usd(acc.cash, 0)
    : ACCOUNTS.length + ' 个账户 · 现金 ' + usd(cashNow(), 0);
  $('meAccountSub').textContent = acc ? acc.name : '全部账户 · ' + ACCOUNTS.length + ' 个';
  $('meWebdavSub').textContent = 'WebDAV · ' + BACKUP.lastUpload + ' 已备份';
  $('meVersion').textContent = '0.7.0';
}

function refreshQuotes() {
  showToast('报价已更新 · 腾讯财经 · 演示数据不变');
  var btn = document.querySelector('#view-positions .icon-btn .icon');
  if (btn) {
    btn.style.transition = 'transform .6s';
    btn.style.transform = 'rotate(360deg)';
    setTimeout(function () { btn.style.transition = ''; btn.style.transform = ''; }, 650);
  }
}

function setTheme(mode) {
  state.theme = mode;
  var dark = mode === 'dark' ||
    (mode === 'auto' && window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0B0D10' : '#F3F4F6');
  renderThemeSeg();
}

function renderThemeSeg() {
  var labels = { light: '浅色', dark: '深色', auto: '跟随' };
  var host = $('themeSeg');
  if (!host) return;
  host.innerHTML = ['light', 'dark', 'auto'].map(function (k) {
    return '<button class="' + (state.theme === k ? 'active' : '') +
      '" onclick="setTheme(\'' + k + '\')">' + labels[k] + '</button>';
  }).join('');
}
