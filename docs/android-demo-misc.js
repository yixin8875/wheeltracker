/* Wheel Tracker · Android demo — import & WebDAV settings sheets */

function openImportSheet() {
  openSheet(sheetHead('导入交易', '手机端负责轻量导入', null) +
    '<div class="action-list">' +
      '<button class="action-row" onclick="closeSheet();showToast(\'已选择 wheel-2026.csv · 12 笔待确认\')">' +
        '<span class="row-icon blue"><svg class="icon"><use href="#i-file"/></svg></span>' +
        '<span class="row-text"><b>CSV 文件</b><small>从文件管理器选择 · 自动识别标准列</small></span>' +
        '<svg class="icon sm chev"><use href="#i-chev-right"/></svg></button>' +
      '<button class="action-row" onclick="closeSheet();showToast(\'已选择 3 张截图 · 识别到 8 笔交易\')">' +
        '<span class="row-icon violet"><svg class="icon"><use href="#i-sparkles"/></svg></span>' +
        '<span class="row-text"><b>相册截图</b><small>AI 识别成交记录 · 逐行确认</small></span>' +
        '<svg class="icon sm chev"><use href="#i-chev-right"/></svg></button>' +
      '<button class="action-row" onclick="closeSheet();showToast(\'请先在桌面端导出 JSON，再用备份恢复\')">' +
        '<span class="row-icon green"><svg class="icon"><use href="#i-database"/></svg></span>' +
        '<span class="row-text"><b>从桌面端迁移</b><small>WebDAV 快照恢复最稳妥</small></span>' +
        '<svg class="icon sm chev"><use href="#i-chev-right"/></svg></button>' +
    '</div>' +
    '<div class="sheet-note"><svg class="icon"><use href="#i-alert"/></svg>' +
      '<p>复杂列映射、批量修正请在桌面端完成，避免手机上误改历史事件。</p></div>');
}

function openServerSheet() {
  openSheet(sheetHead('WebDAV 设置', '密码保存在系统凭据库，不写入账本', null) +
    '<label class="field"><span>服务器</span>' +
      '<input id="sUrl" value="https://dav.jianguoyun.com/dav/" autocomplete="off"></label>' +
    '<div class="field-row">' +
      '<label class="field"><span>账号</span>' +
        '<input id="sUser" value="yixin@example.com" autocomplete="off"></label>' +
      '<label class="field"><span>应用密码</span>' +
        '<input id="sPass" type="password" value="demo-password" autocomplete="off"></label>' +
    '</div>' +
    '<label class="field"><span>远程目录</span>' +
      '<input id="sDir" value="/wheel/" autocomplete="off"></label>' +
    '<div class="list-card" style="margin-bottom:10px">' +
      rowToggle('i-repeat', 'blue', '自动备份', '每日首次启动后上传', BACKUP.auto, 'toggleAuto') +
      rowToggle('i-wifi', 'green', '仅 Wi-Fi', '移动网络只做本地备份', BACKUP.wifi, 'toggleWifi') +
      rowToggle('i-shield', 'violet', '加密快照', 'AES-256-GCM', BACKUP.encrypt, 'toggleEncrypt') +
    '</div>' +
    '<button class="btn ghost block" style="margin-top:2px" onclick="testServer(this)">测试连接</button>' +
    '<div id="serverTest"></div>' +
    '<button class="btn primary block" onclick="saveServer()">保存设置</button>', true);
}

function testServer(btn) {
  var box = $('serverTest');
  if (!box) return;
  var urlEl = $('sUrl');
  var hostText = urlEl ? urlEl.value.replace('https://', '').replace('http://', '') : '';
  btn.disabled = true;
  box.innerHTML = '<div class="test-ok" style="background:var(--surface-2);color:var(--muted)">' +
    '<span class="spinner"></span>正在连接 ' + hostText + '…</div>';
  setTimeout(function () {
    box.innerHTML = '<div class="test-ok"><svg class="icon"><use href="#i-check"/></svg>' +
      '连接成功 · 目录可写 · 7 份快照</div>';
    btn.disabled = false;
  }, 900);
}

function saveServer() {
  closeSheet();
  showToast('WebDAV 设置已保存 · 密码已写入系统凭据库');
}
