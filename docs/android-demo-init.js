/* Wheel Tracker · Android demo — bootstrap */

function init() {
  screenEl = $('screen');
  viewportEl = $('viewport');
  fabEl = $('fab');
  detailActionsEl = $('detailActions');

  renderHome();
  renderPositions();
  renderExpiry();
  renderMe();
  renderThemeSeg();
  showView('view-home', true);

  var hour = new Date().getHours();
  var greet = hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  $('greeting').textContent = greet + '，Yixin';
  $('todayLine').textContent = '11月12日 周四 · 美东交易日';

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSheet();
  });
}

init();
