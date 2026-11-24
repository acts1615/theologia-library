// 분할 화면: 책 2권(좌우·상하) 또는 4권(2×2)을 한 화면에 나란히 펼쳐 읽는다.
// 칸마다 독립된 읽기 화면(iframe)이라 스크롤·쪽·확대·읽은 기록이 따로 움직인다.
(() => {
'use strict';
const TL = () => window.TL;
const LAYOUTS = { l2: ['좌우 2권', 2], l2v: ['상하 2권', 2], l4: ['2×2 4권', 4] };
const KEY = 'tl-split';
let SP = null; // { el, layout, panes:[{fileId}|null], act }

function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; } }
function save() { if (!SP) return; try { localStorage.setItem(KEY, JSON.stringify({ layout: SP.layout, files: SP.panes.map((p) => (p ? p.fileId : null)) })); } catch {} }

function firstFile(w) { const fs = TL().filesOf(w).filter((f) => !f.missing); return fs[0] || null; }

function open(fileIds) {
  if (SP) return;
  const t = TL(); const st = load();
  let ids = (fileIds && fileIds.length ? fileIds : (st.files || [])).filter((id) => id && t.fileById(id));
  let layout = LAYOUTS[st.layout] ? st.layout : 'l2';
  if (ids.length > 2) layout = 'l4'; else if (ids.length && fileIds && fileIds.length && layout === 'l4') layout = 'l2';
  const n = LAYOUTS[layout][1];
  const el = document.createElement('div'); el.id = 'split';
  document.body.appendChild(el);
  SP = { el, layout, panes: Array.from({ length: n }, (_, i) => (ids[i] ? { fileId: ids[i] } : null)), act: 0 };
  render();
}
function close() {
  if (!SP) return; save();
  SP.el.querySelectorAll('iframe').forEach((f) => { try { f.src = 'about:blank'; } catch {} });
  SP.el.remove(); SP = null; if (TL().afterReader) TL().afterReader();
}
function setLayout(layout) {
  const n = LAYOUTS[layout][1]; const old = SP.panes.filter(Boolean);
  SP.layout = layout; SP.panes = Array.from({ length: n }, (_, i) => old[i] || null); SP.act = Math.min(SP.act, n - 1); save(); render();
}
function render() {
  const t = TL();
  const bar = `<div class="sp-bar"><button class="btn sm" data-act="side-toggle" title="사이드바 접기·펴기 (Ctrl+B)" aria-label="사이드바 접기·펴기">☰</button><b>⫼ 분할 화면</b>${Object.entries(LAYOUTS).map(([k, v]) => `<button class="btn sm ${SP.layout === k ? 'on' : ''}" data-sp="layout" data-v="${k}">${v[0]}</button>`).join('')}<span class="sp-sp"></span><small>칸 위쪽의 “✕ 칸 비우기”로 다른 책을 고를 수 있습니다</small><button class="btn sm" data-sp="exit">닫기</button></div>`;
  SP.el.innerHTML = bar + `<div class="sp-grid ${SP.layout}">${SP.panes.map((p, i) => `<div class="sp-pane ${i === SP.act ? 'act' : ''}" data-i="${i}"></div>`).join('')}</div>`;
  SP.panes.forEach((p, i) => paneFill(i));
}
function paneFill(i) {
  const box = SP.el.querySelector(`.sp-pane[data-i="${i}"]`); if (!box) return;
  const p = SP.panes[i];
  if (p) { box.innerHTML = `<iframe src="/?pane=${encodeURIComponent(p.fileId)}" title="분할 ${i + 1}"></iframe>`; return; }
  box.innerHTML = `<div class="sp-pick"><h4>${i + 1}번 칸 · 읽을 책 고르기</h4><input type="search" placeholder="제목·저자로 찾기" data-sp="q" autocomplete="off"><div class="sp-list"></div></div>`;
  fillList(box, '');
}
function fillList(box, q) {
  const t = TL(); const list = box.querySelector('.sp-list'); const qq = q.trim().toLowerCase();
  const checked = new Set(t.checkedWorks());
  let ws = t.works().filter((w) => !qq || `${w.title} ${(w.authors || []).join(' ')} ${w.author || ''}`.toLowerCase().includes(qq));
  ws = ws.filter((w) => firstFile(w));
  if (!qq) ws.sort((a, b) => (checked.has(b.id) - checked.has(a.id)) || String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')));
  const shown = ws.slice(0, 60);
  list.innerHTML = shown.length ? shown.map((w) => { const f = firstFile(w); const au = Array.isArray(w.authors) ? w.authors.join(', ') : (w.author || ''); return `<button class="sp-it" data-sp="pick" data-f="${t.esc(f.id)}"><b>${t.esc(w.title)}</b><small>${t.esc(au)}${checked.has(w.id) ? ' · 선택한 책' : ''}</small></button>`; }).join('') + (ws.length > shown.length ? `<div class="sp-empty">검색어를 더 써서 좁혀 보세요 (${ws.length}권 중 ${shown.length}권 표시)</div>` : '') : '<div class="sp-empty">찾는 책이 없습니다.</div>';
}
document.addEventListener('click', (e) => {
  const o = e.target.closest('#split-open');
  if (o) {
    const t = TL(); const ids = [];
    for (const wid of t.checkedWorks()) { const w = t.work(wid); const f = w && firstFile(w); if (f) ids.push(f.id); }
    open(ids.slice(0, 4)); return;
  }
  if (!SP) return;
  const b = e.target.closest('[data-sp]'); const pane = e.target.closest('.sp-pane');
  if (pane) { SP.act = Number(pane.dataset.i); SP.el.querySelectorAll('.sp-pane').forEach((x) => x.classList.toggle('act', x === pane)); }
  if (!b) return;
  const k = b.dataset.sp;
  if (k === 'exit') close();
  else if (k === 'layout') setLayout(b.dataset.v);
  else if (k === 'pick') { const i = Number(pane.dataset.i); SP.panes[i] = { fileId: b.dataset.f }; save(); paneFill(i); }
});
document.addEventListener('input', (e) => { const q = e.target.closest && e.target.closest('[data-sp=q]'); if (q && SP) fillList(q.closest('.sp-pane'), q.value); });
window.addEventListener('message', (e) => {
  if (!SP || e.origin !== location.origin || !e.data || e.data.tlPane !== 'closed') return;
  const fr = [...SP.el.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source); if (!fr) return;
  const i = Number(fr.closest('.sp-pane').dataset.i); SP.panes[i] = null; save(); paneFill(i);
});
window.TLSplit = { open, close, isOpen: () => !!SP };
})();
