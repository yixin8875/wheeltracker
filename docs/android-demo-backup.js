/* Wheel Tracker · Android demo — backup view (WebDAV concept) */

function openBackup() {
  renderBackup();
  pushView('view-backup');
}

function shorten(name) {
  if (name.length <= 24) return name;
  return name.slice(0, 13) + '…' + name.slice(-8);
}

function renderBackup() {
  var toggles =
    rowToggle('i-repeat', 'blue', '自动备份', '每日首次启动或手动备份后上传', BACKUP.auto, 'toggleAuto') +
    rowToggle('i-wifi', 'green', '仅 Wi-Fi 上传', '移动网络下只做本地备份', BACKUP.wifi, 'toggleWifi') +
    rowToggle('i-shield', 'violet', '加密快照', 'AES-256-GCM · 密码不保存', BACKUP.encrypt, 'toggleEncrypt');

  $('backupBody').innerHTML =
    '<div class="cloud-card">' +
      '<div class="cloud-top">' +
        '<span class="cloud-icon"><svg class="icon"><use href="#i-cloud"/></svg></span>' +
        '<div class="cloud-info"><b>' + BACKUP.provider + ' · WebDAV</b>' +
          '<span id="cloudSub">上次上传 ' + BACKUP.lastUpload + ' · ' + shorten(BACKUP.lastFile) + '</span></div>' +
        '<span class="cloud-ok"><svg class="icon"><use href="#i-check"/></svg></span>' +
      '</div>' +
      '<div class="cloud-stats">' +
        '<div><span>本机大小</span><b>' + BACKUP.size + '</b></div>' +
        '<div><span>云端快照</span><b>' + BACKUP.copies + ' 份</b></div>' +
        '<div><span>最近恢复</span><b>' + BACKUP.lastRestore + '</b></div>' +
      '</div>' +
      '<div class="cloud-actions" id="backupActions">' +
        '<button class="btn primary" onclick="backupNow()">' +
          '<svg class="icon sm"><use href="#i-upload"/></svg>立即备份</button>' +
        '<button class="btn ghost" onclick="openRemoteSheet()">' +
          '<svg class="icon sm"><use href="#i-download"/></svg>从云端恢复</button>' +
      '</div>' +
      '<div class="progress" id="backupBarWrap" style="display:none"><i id="backupBar" style="width:0%"></i></div>' +
    '</div>' +
    '<div class="notice"><svg class="icon"><use href="#i-alert"/></svg>' +
      '<p>快照恢复是整库替换，不是同步。建议同一时间只在一台设备上记账。</p></div>' +
    '<div class="section-head"><h2>备份设置</h2><button class="link" onclick="openServerSheet()">编辑</button></div>' +
    '<div class="list-card">' +
      rowStatic('i-server', 'blue', '服务器', BACKUP.host) +
      rowStatic('i-folder', 'green', '远程目录', BACKUP.dir) +
      toggles +
    '</div>' +
    '<div class="section-head"><h2>云端快照</h2><span class="muted">最近 ' +
      BACKUP.remotes.length + ' 份</span></div>' +
    '<div id="remoteList">' + BACKUP.remotes.map(remoteRow).join('') + '</div>' +
    '<p class="footnote">只显示本应用创建的 wheel- / auto- 快照</p>';
}

function remoteRow(r) {
  return '<div class="remote-row">' +
    '<span class="file-icon"><svg class="icon"><use href="#i-lock"/></svg></span>' +
    '<div class="remote-text"><b>' + shorten(r.name) + '</b>' +
      '<small>' + r.time + ' · ' + r.size + ' · <span class="lock-tag">已加密</span></small></div>' +
    '<button class="restore-link" onclick="startRestore(\'' + r.name + '\')">恢复</button>' +
  '</div>';
}

function rowStatic(icon, color, title, value) {
  return '<div class="list-row static">' +
    '<span class="row-icon ' + color + '"><svg class="icon"><use href="#' + icon + '"/></svg></span>' +
    '<span class="row-text"><b>' + title + '</b></span>' +
    '<span class="row-value">' + value + '</span></div>';
}

function rowToggle(icon, color, title, sub, on, fn) {
  return '<div class="list-row static">' +
    '<span class="row-icon ' + color + '"><svg class="icon"><use href="#' + icon + '"/></svg></span>' +
    '<span class="row-text"><b>' + title + '</b><small>' + sub + '</small></span>' +
    '<button class="toggle' + (on ? ' on' : '') + '" aria-label="' + title +
      '" onclick="' + fn + '(this)"><span></span></button>' +
  '</div>';
}

function toggleAuto(el) { BACKUP.auto = el.classList.toggle('on'); }
function toggleWifi(el) { BACKUP.wifi = el.classList.toggle('on'); }
function toggleEncrypt(el) { BACKUP.encrypt = el.classList.toggle('on'); }

function backupNow() {
  if (BACKUP.busy) return;
  var wrap = $('backupBarWrap'), bar = $('backupBar'), sub = $('cloudSub');
  if (!wrap || !bar) return;
  BACKUP.busy = true;
  wrap.style.display = 'block';
  bar.style.width = '3%';
  if (sub) sub.textContent = '正在生成快照并加密上传…';

  var p = 3;
  var timer = setInterval(function () {
    p += 7;
    if (p > 96) p = 96;
    var b = $('backupBar');
    if (!b) { clearInterval(timer); BACKUP.busy = false; return; }
    b.style.width = p + '%';
    if (p >= 96) {
      clearInterval(timer);
      setTimeout(function () {
        BACKUP.busy = false;
        BACKUP.lastUpload = '刚刚';
        BACKUP.lastFile = 'wheel-' + Math.floor(Date.now() / 1000) + '-0.sqlite.enc';
        BACKUP.copies += 1;
        BACKUP.remotes.unshift({ name: BACKUP.lastFile, time: '刚刚', size: '2.4 MB' });
        if (BACKUP.remotes.length > 6) BACKUP.remotes.pop();
        showToast('备份完成 · 已加密上传 2.4 MB');
        renderBackup();
      }, 420);
    }
  }, 110);
}

function openRemoteSheet() {
  openSheet(sheetHead('从云端恢复', '选择一份快照 · 恢复前会创建本机安全快照', null) +
    BACKUP.remotes.map(remoteRow).join('') +
    '<div class="notice"><svg class="icon"><use href="#i-alert"/></svg>' +
      '<p>下载后先校验完整性与 schema 版本，通过后才会进入替换流程。</p></div>', true);
}
