'use strict';
// 서점 검색 창 전용: 사이트가 걸어 둔 '글자 선택·복사·오른쪽 클릭 금지'를 풀어 ISBN 등을 복사할 수 있게 한다.
// (이 창에서만 동작하며, 서점 사이트의 다른 기능은 건드리지 않는다.)
const EVENTS = ['copy', 'cut', 'selectstart', 'contextmenu', 'dragstart', 'mousedown', 'mouseup', 'keydown', 'keyup'];
const BLOCK_KEYS = (e) => (e.ctrlKey || e.metaKey) && ['c', 'a', 'x', 'C', 'A', 'X'].includes(e.key);
for (const t of EVENTS) {
  window.addEventListener(t, (e) => {
    if (t === 'keydown' || t === 'keyup') { if (!BLOCK_KEYS(e)) return; }
    else if (t === 'mousedown' || t === 'mouseup') { if (e.button === 0) return; }   // 왼쪽 클릭·드래그는 사이트 기능을 그대로 둔다
    e.stopImmediatePropagation();
  }, true);
}
function unlock() {
  try {
    for (const k of ['oncopy', 'oncut', 'onselectstart', 'oncontextmenu', 'ondragstart']) { try { document[k] = null; } catch {} if (document.body) { try { document.body[k] = null; } catch {} } if (document.documentElement) { try { document.documentElement[k] = null; } catch {} } }
    if (!document.getElementById('tl-unlock')) { const s = document.createElement('style'); s.id = 'tl-unlock'; s.textContent = '*,*::before,*::after{-webkit-user-select:text!important;user-select:text!important;-webkit-touch-callout:default!important}'; (document.head || document.documentElement).appendChild(s); }
  } catch {}
}
document.addEventListener('DOMContentLoaded', unlock);
window.addEventListener('load', unlock);
setInterval(unlock, 2000);
