// 앱 안 마크다운(.md) 리더: 본문을 안전하게 변환해 보여 주고, 스크롤 위치를 0~1000으로 기록한다.
// 원문 속 HTML 은 글자로만 보이고(실행 안 됨), 그림은 설명 글자로 바꾸며, 웹 주소가 아닌 링크는 막는다.
(() => {
'use strict';
const TL = () => window.TL;
const $ = (s, el = document) => el.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SCALE = 1000;
let M = null;
const THEMES = { light: ['#fbf9f4', '#222'], sepia: ['#f4ecd8', '#4a3b24'], dark: ['#1d1d1b', '#d8d8d0'] };
const prefs = () => { try { return Object.assign({ size: 18, theme: 'light' }, JSON.parse(localStorage.getItem('tl-md') || '{}')); } catch { return { size: 18, theme: 'light' }; } };
const savePrefs = () => { try { localStorage.setItem('tl-md', JSON.stringify({ size: M.size, theme: M.theme })); } catch {} };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(text, wiki) {
  if (wiki) text = String(text).replace(/\[\[([^\]\n|#]+)(?:[#|]([^\]\n]*))?\]\]/g, (m, n, a) => `[${(a || n).trim().replace(/[\[\]]/g, '')}](#note:${encodeURIComponent(n.trim())})`);
  const mk = window.marked; if (!mk) return '<pre>' + esc(text) + '</pre>';
  const m = new mk.Marked({ gfm: true, renderer: { html(t) { return esc(t.text != null ? t.text : t); }, image(t) { return '[그림: ' + esc((t && t.text) || '') + ']'; } } });
  const div = document.createElement('div'); div.innerHTML = m.parse(text);
  div.querySelectorAll('a').forEach((a) => { const h = a.getAttribute('href') || ''; if (wiki && /^#note:/.test(h)) { a.setAttribute('data-note', decodeURIComponent(h.slice(6))); a.setAttribute('href', '#'); a.className = 'wl'; } else if (!/^(https?:|mailto:|tel:)/i.test(h)) a.removeAttribute('href'); else { a.setAttribute('rel', 'noopener noreferrer'); a.setAttribute('target', '_blank'); } });
  div.querySelectorAll('script,style,iframe,object,embed,form,input,button,img,svg,link,meta').forEach((n) => n.remove());
  return div.innerHTML;
}
function restyle() { const [bg, fg] = THEMES[M.theme] || THEMES.light; const v = $('#m-view', M.el); v.style.background = bg; v.style.color = fg; $('#m-art', M.el).style.fontSize = M.size + 'px'; }
function frac() { const v = $('#m-view', M.el); const ms = v.scrollHeight - v.clientHeight; return ms > 0 ? clamp(v.scrollTop / ms, 0, 1) : 1; }
function pageOf() { const f = frac(); return f > 0.99 ? SCALE : clamp(Math.round(f * (SCALE - 1)) + 1, 1, SCALE); }
function recordSoon(ms) { if (!M) return; clearTimeout(M.saveTimer); M.saveTimer = setTimeout(() => flush(false), ms); const s = $('#m-save', M.el); if (s) s.textContent = '기록 중…'; }
async function flush(keepalive) {
  if (!M || !M.loaded) return; clearTimeout(M.saveTimer);
  const page = pageOf(); if (page === M.recorded && !keepalive) return; M.recorded = page;
  try { const out = await TL().api(`/api/library/files/${encodeURIComponent(M.file.id)}/progress`, 'POST', { page, pages: SCALE }, keepalive); TL().applyRecord(out); const s = $('#m-save', M.el); if (s) s.textContent = `${Math.round(page / 10)}% 기록됨`; }
  catch { const s = $('#m-save', M.el); if (s) s.textContent = '기록 실패'; }
}
async function open({ fileId }) {
  const t = TL(); const file = t.fileById(fileId); if (!file) return; if (M) await close(true);
  const w = t.work(file.workId);
  const el = document.createElement('div'); el.className = 'reader md'; el.id = 'reader-md';
  el.innerHTML = `<div class="r-bar">
      <button class="btn sm" data-act="side-toggle" title="사이드바 접기·펴기" aria-label="사이드바 접기·펴기">☰</button>
      <button class="btn sm" data-m="close" title="서재로 돌아가기 (Esc)">← 서재</button>
      <div class="r-title"><b>${t.esc(w.title)}</b><small>${t.esc(file.name)}</small></div>
      <span class="r-sp"></span>
      <span id="m-pct" class="r-print">0%</span>
      <div class="r-grp"><button class="btn sm" data-m="zout" title="글자 작게">A−</button><button class="btn sm" data-m="zin" title="글자 크게">A＋</button><button class="btn sm" data-m="theme" title="바탕색 바꾸기">바탕</button></div>
      <span class="r-save" id="m-save"></span>
    </div>
    <div class="md-wrap"><div id="m-view" class="md-view" tabindex="0"><article id="m-art" class="md-art">여는 중…</article></div></div>`;
  document.body.appendChild(el);
  const p = prefs(); M = { el, file, size: p.size, theme: p.theme, recorded: -1, loaded: false, token: Symbol() };
  const token = M.token; restyle();
  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-m]'); if (!g) return;
    switch (g.dataset.m) { case 'close': close(false); break; case 'zin': M.size = Math.min(32, M.size + 2); savePrefs(); restyle(); break; case 'zout': M.size = Math.max(12, M.size - 2); savePrefs(); restyle(); break; case 'theme': M.theme = M.theme === 'light' ? 'sepia' : M.theme === 'sepia' ? 'dark' : 'light'; savePrefs(); restyle(); break; }
  });
  const v = $('#m-view', el);
  v.addEventListener('scroll', () => { if (!M || !M.loaded) return; $('#m-pct', el).textContent = Math.round(frac() * 100) + '%'; recordSoon(1500); });
  try {
    const r = await TL().api('/api/md/' + encodeURIComponent(file.id));
    if (!M || M.token !== token) return;
    $('#m-art', el).innerHTML = render(r.text);
    M.loaded = true;
    const f = file.lastPage > 0 ? clamp((file.lastPage - 1) / (SCALE - 1), 0, 1) : 0;
    requestAnimationFrame(() => { if (!M) return; v.scrollTop = f * (v.scrollHeight - v.clientHeight); $('#m-pct', el).textContent = Math.round(frac() * 100) + '%'; M.recorded = pageOf(); v.focus(); });
  } catch (e) { if (M && M.token === token) $('#m-art', el).textContent = '파일을 열 수 없습니다: ' + (e && e.message || e); }
}
async function close(silent) {
  if (!M) return; const m = M; if (m.loaded) await flush(false);
  clearTimeout(m.saveTimer); m.token = Symbol(); m.el.remove(); M = null; if (!silent) TL().afterReader();
}
document.addEventListener('keydown', (e) => { if (M && e.key === 'Escape' && !e.defaultPrevented && !document.getElementById('modal')) { e.preventDefault(); close(false); } }, true);
window.addEventListener('beforeunload', () => { if (M && M.loaded) flush(true); });
window.TLMd = { render, open, close, isOpen: () => !!M, __state: () => M };
})();
