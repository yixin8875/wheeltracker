/* Wheel Tracker · Android demo — cloud restore flow */

function startRestore(name) {
  openSheet(sheetHead('从云端恢复', '整库替换 · 当前账本会先创建安全快照', 'openRemoteSheet()') +
    '<div class="restore-file"><span class="file-icon"><svg class="icon"><use href="#i-lock"/></svg></span>' +
      '<div><b>' + shorten(name) + '</b><small>2.4 MB · AES-256-GCM · 坚果云</small></div></div>' +
    '<div class="progress-card">' +
      '<h3 id="restoreTitle">正在下载快照</h3>' +
      '<p id="restoreSub">' + name + '</p>' +
      '<div class="progress"><i id="restoreBar" style="width:4%"></i></div>' +
    '</div>', true);

  var p = 4;
  var timer = setInterval(function () {
    if (!$('restoreBar')) { clearInterval(timer); return; }
    p += 9;
    $('restoreBar').style.width = Math.min(p, 78) + '%';
    if (p >= 78) {
      clearInterval(timer);
      setTimeout(function () { showValidate(name); }, 480);
    }
  }, 90);
}

function showValidate(name) {
  if (!$('restoreTitle')) return;
  openSheet(sheetHead('校验通过', '快照可以安全恢复', 'openRemoteSheet()') +
    '<div class="restore-file"><span class="file-icon"><svg class="icon"><use href="#i-lock"/></svg></span>' +
      '<div><b>' + shorten(name) + '</b><small>2.4 MB · AES-256-GCM</small></div></div>' +
    '<div class="validate-ok">' +
      '<div class="ok-head"><svg class="icon"><use href="#i-check"/></svg>完整性检查通过</div>' +
      '<div class="validate-stats">' +
        '<div><span>事件</span><b>1,284</b></div>' +
        '<div><span>账户</span><b>3</b></div>' +
        '<div><span>Schema</span><b>v4</b></div>' +
      '</div>' +
      '<p>账本结构与当前版本一致，未发现损坏或缺失的表。</p>' +
    '</div>' +
    '<div class="notice"><svg class="icon"><use href="#i-alert"/></svg>' +
      '<p>恢复会替换本机全部账本数据。替换会在下次启动时完成，失败自动回滚。</p></div>' +
    '<button class="btn primary block" onclick="confirmRestore(\'' + name + '\')">创建安全快照并恢复</button>' +
    '<button class="btn ghost block" onclick="closeSheet()">取消</button>', true);
}

function confirmRestore(name) {
  openSheet(sheetHead('正在恢复', '请勿关闭应用', null) +
    '<div class="progress-card"><span class="spinner"></span>' +
      '<h3 id="restoreStage">创建本机安全快照</h3>' +
      '<p>pre-restore-20261112.sqlite</p>' +
      '<div class="progress"><i id="restoreBar2" style="width:8%"></i></div>' +
    '</div>', true);

  var stage = 1;
  var timer = setInterval(function () {
    var bar = $('restoreBar2'), label = $('restoreStage');
    if (!bar || !label) { clearInterval(timer); return; }
    var p = parseInt(bar.style.width, 10) + 12;
    bar.style.width = Math.min(p, 100) + '%';
    if (p >= 46 && stage === 1) {
      stage = 2;
      label.textContent = '写入暂存标记';
      var sub = document.querySelector('#sheet .progress-card p');
      if (sub) sub.textContent = 'pending.json · 下次启动替换账本';
    }
    if (p >= 100) {
      clearInterval(timer);
      setTimeout(function () {
        BACKUP.lastRestore = '刚刚';
        openSheet(sheetHead('已准备恢复', '下次启动完成替换', null) +
          '<div class="success-state">' +
            '<span class="success-icon"><svg class="icon"><use href="#i-check"/></svg></span>' +
            '<h3>快照已暂存</h3>' +
            '<p>重启 Wheel Tracker 后，账本将替换为所选快照。若替换失败，会自动回滚到当前版本。</p>' +
            '<p class="hint">演示环境不会真正替换数据。</p>' +
          '</div>' +
          '<button class="btn primary block" onclick="closeSheet()">知道了</button>', true);
      }, 700);
    }
  }, 220);
}
