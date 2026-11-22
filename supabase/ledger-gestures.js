(() => {
  const notice = document.createElement('div');
  notice.className = 'gesture-notice';
  notice.setAttribute('role', 'status');
  document.body.append(notice);
  let start;
  let direction;
  let distance = 0;
  let syncing = false;
  let timer;

  function announce(message, transient = false) {
    clearTimeout(timer);
    notice.textContent = message;
    if (transient) timer = setTimeout(() => { notice.textContent = ''; }, 2800);
  }
  function cancel() {
    if (direction === 'pull') announce('');
    start = undefined;
    direction = undefined;
    distance = 0;
  }
  function hasHorizontalScroll(target) {
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  }
  function moveTab(forward) {
    const active = document.querySelector('#nav button.active');
    const next = forward ? active?.nextElementSibling : active?.previousElementSibling;
    next?.click();
  }

  // Wheel events include momentum and have no standard gesture-end signal.
  let lastWheel = -Infinity;
  let wheelTravel = 0;
  let wheelMode = '';
  document.addEventListener('wheel', event => {
    if (event.timeStamp - lastWheel > 220) {
      wheelTravel = 0;
      wheelMode = '';
    }
    lastWheel = event.timeStamp;
    if (event.ctrlKey || event.metaKey || event.shiftKey || syncing || document.body.inert ||
        event.target.closest('input, textarea, select, [contenteditable], [role="dialog"], .tx-wheel-overlay') ||
        hasHorizontalScroll(event.target)) wheelMode = 'native';
    if (!wheelMode) {
      if (!event.deltaX && !event.deltaY) return;
      wheelMode = Math.abs(event.deltaX) > 1.5 * Math.abs(event.deltaY) ? 'horizontal' : 'native';
    }
    if (wheelMode === 'native') return;
    if (event.cancelable) event.preventDefault();
    if (wheelMode === 'moved') return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerWidth : 1;
    wheelTravel += event.deltaX * unit;
    if (Math.abs(wheelTravel) >= 64) {
      wheelMode = 'moved';
      moveTab(wheelTravel > 0);
    }
  }, {passive: false});
  document.addEventListener('touchstart', event => {
    cancel();
    if (syncing || event.touches.length !== 1 ||
        event.target.closest('input, textarea, select, button, a, [contenteditable], [role="dialog"], .tx-wheel-overlay')) return;
    const {clientX: x, clientY: y} = event.touches[0];
    if (x < 24 || x > innerWidth - 24) return;
    if (hasHorizontalScroll(event.target)) return;
    start = {x, y, top: scrollY <= 0};
  }, {passive: true});
  document.addEventListener('touchmove', event => {
    if (!start) return;
    if (event.touches.length !== 1) return cancel();
    const dx = event.touches[0].clientX - start.x;
    const dy = event.touches[0].clientY - start.y;
    if (!direction) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dx) > 1.5 * Math.abs(dy)) direction = 'swipe';
      else if (start.top && scrollY <= 0 && dy > 1.5 * Math.abs(dx)) direction = 'pull';
      else return cancel();
    }
    if (!event.cancelable) return cancel();
    event.preventDefault();
    distance = direction === 'pull' ? dy : dx;
    if (direction === 'pull') announce(dy >= 72 ? '離して同期' : '下に引いて同期');
  }, {passive: false});
  document.addEventListener('touchcancel', cancel);
  document.addEventListener('touchend', async () => {
    const action = direction;
    const travel = distance;
    cancel();
    if (action === 'swipe' && Math.abs(travel) >= 64) {
      moveTab(travel < 0);
    }
    if (action !== 'pull' || travel < 72 || syncing) return;
    syncing = true;
    announce('同期中…');
    try { announce(await parent.syncAppHost.pullSync(), true); }
    catch (error) { announce(error.message || '同期できませんでした。', true); }
    finally { syncing = false; }
  });
})();
