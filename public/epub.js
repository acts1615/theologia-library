// 앱 안 EPUB 리더: 장 단위로 읽고, 책 전체를 0~1000의 가상 '쪽'으로 환산해 읽은 위치를 기록한다.
// 본문은 스크립트가 막힌 iframe 안에서만 열린다(서버가 CSP로 차단, iframe sandbox 에도 allow-scripts 없음).
(() => {
'use strict';
const TL = () => window.TL;
const $ = (s, el = document) => el.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SCALE = 1000;
let E = null;

const prefs = () => { try { return Object.assign({ zoom: 1.1, theme: 'light' }, JSON.parse(localStorage.getItem('tl-epub') || '{}')); } catch { return { zoom: 1.1, theme: 'light' }; } };
const savePrefs = () => { try { localStorage.setItem('tl-epub', JSON.stringify({ zoom: E.zoom, theme: E.theme })); } catch {} };
const THEMES = { light: ['#ffffff', '#222222'], sepia: ['#f4ecd8', '#4a3b24'], dark: ['#1d1d1b', '#d8d8d0'] };
const api = (url, method, body, keepalive) => TL().api(url, method, body, keepalive);
const base = () => `/api/epub/${encodeURIComponent(E.file.id)}`;

async function open({ fileId, page, terms }) {
  const t = TL(); const file = t.fileById(fileId); if (!file) return;
  if (E) await close(true);
  const w = t.work(file.workId); const siblings = t.filesOf(w);
  const el = document.createElement('div'); el.className = 'reader ep'; el.id = 'reader-epub';
  el.innerHTML = `
    <div class="r-bar">
      <button class="btn sm" data-act="side-toggle" title="사이드바 접기·펴기" aria-label="사이드바 접기·펴기">☰</button>
      <button class="btn sm" data-e="close" title="서재로 돌아가기 (Esc)">← 서재</button>
      <div class="r-title"><b>${t.esc(w.title)}</b><small id="e-ch">${t.esc(file.name)}</small></div>
      ${siblings.length > 1 ? `<select id="e-file" title="같은 작품의 다른 파일">${siblings.map((f, i) => `<option value="${t.esc(f.id)}" ${f.id === file.id ? 'selected' : ''}>${i + 1}/${siblings.length} · ${t.esc(f.name)}</option>`).join('')}</select>` : ''}
      <span class="r-sp"></span>
      <div class="r-find"><input id="e-q" type="search" placeholder="이 책에서 찾기 (Ctrl+F)" autocomplete="off" aria-label="이 책에서 찾기" /></div>
      <div class="r-grp"><button class="btn sm" data-e="prev" title="이전 장 (←)">‹ 이전 장</button><span id="e-pct" class="r-print" title="책 전체에서의 위치">0%</span><button class="btn sm" data-e="next" title="다음 장 (→)">다음 장 ›</button></div>
      <div class="r-grp"><button class="btn sm" data-e="zout" title="글자 작게">A−</button><button class="btn sm" data-e="zin" title="글자 크게">A＋</button><button class="btn sm" data-e="theme" title="바탕색 바꾸기">바탕</button></div>
      <button class="btn sm" data-e="toc" title="목차·책갈피 (Ctrl+D: 지금 위치에 책갈피)">목차·책갈피<span id="e-mkn" class="r-mkn"></span></button>
      <span class="r-save" id="e-save"></span>
    </div>
    <div class="r-body">
      <aside class="r-toc" id="e-toc" hidden></aside>
      <div class="ep-wrap" id="e-wrap"><iframe id="e-frame" sandbox="allow-same-origin" title="EPUB 본문"></iframe><div class="r-msg" id="e-msg">EPUB을 여는 중…</div></div>
    </div>`;
  document.body.appendChild(el);
  const p = prefs();
  E = { el, file, work: w, info: null, ch: -1, pos: 0, recorded: -1, zoom: p.zoom, theme: p.theme, tab: 'toc', find: null, token: Symbol(), marks: (file.marks || []).slice(), pending: null,
        terms: (terms || []).map((x) => String(x).replace(/\s+/g, '').toLowerCase()).filter(Boolean) };
  bind(el); mkCount();
  const token = E.token;
  try {
    const info = await api(`${base()}/info`);
    if (!E || E.token !== token) return;
    if (info.drm) { $('#e-msg').textContent = '암호(DRM)가 걸린 EPUB이라 열 수 없습니다. 이 파일은 구입한 서점의 앱에서만 읽을 수 있습니다.'; return; }
    if (!info.spine.length) { $('#e-msg').textContent = '읽을 수 있는 본문이 없는 EPUB입니다.'; return; }
    E.info = info; E.fileLoaded = true;
    const startPos = file.lastPage > 0 ? clamp((file.lastPage - 1) / (SCALE - 1), 0, 1) : 0;
    goPos(page ? clamp((page - 1) / (SCALE - 1), 0, 1) : startPos, { terms: E.terms });
    recordSoon(0); E.recorded = -1;
  } catch (e) {
    if (E && E.token === token) { const m = $('#e-msg'); if (m) m.textContent = /404|파일/.test(String(e && e.message)) ? '파일을 찾을 수 없습니다. 이동되었거나 삭제되었을 수 있습니다.' : 'EPUB을 열 수 없습니다: ' + (e && e.message || e); }
  }
}

// ---------- 위치 ----------
const spineAt = (pos) => { const sp = E.info.spine; for (let i = sp.length - 1; i >= 0; i--) if (pos >= sp[i].start) return i; return 0; };
function goPos(pos, opt = {}) {
  const i = spineAt(pos); const s = E.info.spine[i];
  const frac = s.end > s.start ? clamp((pos - s.start) / (s.end - s.start), 0, 1) : 0;
  goChapter(i, { frac, ...opt });
}
function goChapter(i, opt = {}) {
  i = clamp(i, 0, E.info.spine.length - 1);
  E.pending = { frac: opt.frac || 0, anchor: opt.anchor || '', end: !!opt.end, hit: opt.hit != null ? opt.hit : null, terms: opt.terms || null };
  if (i === E.ch && E.frame && E.frame.contentDocument && E.frame.contentDocument.body) { applyPending(); return; }
  E.ch = i; const fr = $('#e-frame');
  E.frame = fr; fr.onload = () => onLoad(E.token);
  fr.src = `${base()}/r/${E.info.spine[i].path.split('/').map(encodeURIComponent).join('/')}?h=1`;
  const m = $('#e-msg'); if (m) m.hidden = false;
  chapterLabel();
}
function chapterLabel() {
  if (!E || !E.info) return;
  const sp = E.info.spine[E.ch]; let name = '';
  for (const t of E.info.toc) { if (t.spine <= E.ch && (t.spine < E.ch || !t.anchor)) name = t.title; if (t.spine > E.ch) break; }
  const el = $('#e-ch'); if (el) el.textContent = `${name || '제 ' + (E.ch + 1) + '장'} · ${E.ch + 1}/${E.info.spine.length}`;
  return sp;
}
function styleDoc(doc) {
  let st = doc.getElementById('tl-style'); if (!st) { st = doc.createElement('style'); st.id = 'tl-style'; (doc.head || doc.documentElement).appendChild(st); }
  const [bg, fg] = THEMES[E.theme] || THEMES.light; const dark = E.theme === 'dark';
  st.textContent = `html{zoom:${E.zoom};background:${bg} !important}
body{background:${bg} !important;color:${fg} !important;max-width:46em;margin:0 auto !important;padding:28px 36px 90px !important;line-height:1.75;font-family:'Noto Serif KR','Nanum Myeongjo',AppleMyungjo,Georgia,serif;word-break:keep-all;overflow-wrap:anywhere;box-sizing:border-box}
${dark ? `body *{color:${fg} !important;background-color:transparent !important;border-color:#555 !important}a{color:#9cc4ff !important}` : (E.theme === 'sepia' ? `body *{color:${fg} !important;background-color:transparent !important}` : '')}
img,svg,video{max-width:100% !important;height:auto}
::highlight(tl-hit){background:#fff3a3;color:#222}::highlight(tl-hit-cur){background:#ffb347;color:#000}`;
}
function onLoad(token) {
  if (!E || E.token !== token) return;
  const fr = E.frame; let doc; try { doc = fr.contentDocument; } catch { return; }
  if (!doc || !doc.body) return;
  const m = $('#e-msg'); if (m) m.hidden = true;
  styleDoc(doc);
  const win = fr.contentWindow;
  win.addEventListener('scroll', onScroll, { passive: true });
  doc.addEventListener('click', onDocClick);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('mousedown', () => {});
  applyPending();
  setTimeout(() => { if (E && E.token === token && E.frame === fr) applyPending(true); }, 350);  // 그림이 늦게 불러와질 때 한 번 더 맞춘다
}
function maxScroll() { const d = E.frame.contentDocument; return Math.max(0, d.documentElement.scrollHeight - E.frame.clientHeight); }
function applyPending(again) {
  const pd = E.pending; if (!pd) return;
  const d = E.frame.contentDocument, win = E.frame.contentWindow; if (!d || !d.body) return;
  highlightAll(pd.terms || (E.find && E.find.q ? [E.find.q] : []));
  let done = false;
  if (pd.hit != null && E.find) { const r = focusHit(pd.hit); if (r) done = true; }
  if (!done && pd.anchor) { let a = null; try { a = d.getElementById(pd.anchor) || d.getElementsByName(pd.anchor)[0]; } catch {} if (a) { a.scrollIntoView(); done = true; } }
  if (!done) win.scrollTo(0, pd.end ? maxScroll() : Math.round(maxScroll() * pd.frac));
  if (again) E.pending = null;
  if (!again) { E.suppress = performance.now() + 250; }
  measurePos(); if (again) recordSoon(1200);
}
function measurePos() {
  if (!E || !E.info) return; const s = E.info.spine[E.ch]; const d = E.frame.contentDocument; if (!d || !d.documentElement) return;
  const ms = maxScroll(); const fr = ms > 0 ? clamp(E.frame.contentWindow.scrollY / ms, 0, 1) : 1;
  E.pos = s.start + (s.end - s.start) * fr; E.atEnd = E.ch === E.info.spine.length - 1 && fr > 0.97;
  const pct = $('#e-pct'); if (pct) pct.textContent = Math.round(E.atEnd ? 100 : E.pos * 100) + '%';
  markCurToc();
}
let raf = 0;
function onScroll() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (!E || !E.info) return; measurePos(); if (!(E.suppress > performance.now())) recordSoon(1500); }); }

// ---------- 기록 ----------
const pageOf = () => (E.atEnd ? SCALE : clamp(Math.round(E.pos * (SCALE - 1)) + 1, 1, SCALE));
function recordSoon(ms) { if (!E) return; clearTimeout(E.saveTimer); E.saveTimer = setTimeout(() => flush(false), ms); const s = $('#e-save'); if (s) s.textContent = '기록 중…'; }
async function flush(keepalive) {
  if (!E || !E.info) return; clearTimeout(E.saveTimer); measurePos();
  const page = pageOf(), fid = E.file.id; if (page === E.recorded && !keepalive) { const s = $('#e-save'); if (s) s.textContent = '기록됨'; return; }
  E.recorded = page;
  try { const out = await api(`/api/library/files/${encodeURIComponent(fid)}/progress`, 'POST', { page, pages: SCALE }, keepalive); TL().applyRecord(out); const s = $('#e-save'); if (s) s.textContent = `${Math.round(page / 10)}% 기록됨`; }
  catch { const s = $('#e-save'); if (s) s.textContent = '기록 실패'; }
}

// ---------- 본문 안 링크·키 ----------
function onDocClick(ev) {
  const a = ev.target.closest && ev.target.closest('a[href]'); if (!a) return;
  ev.preventDefault();
  const href = a.getAttribute('href') || '';
  if (/^(https?:|mailto:|tel:)/i.test(href)) return;        // 바깥 주소는 열지 않는다
  let u; try { u = new URL(href, E.frame.contentWindow.location.href); } catch { return; }
  const pre = `${base()}/r/`; if (!u.pathname.startsWith(pre)) return;
  const path = decodeURIComponent(u.pathname.slice(pre.length)); const i = E.info.spine.findIndex((s) => s.path === path);
  const anchor = decodeURIComponent((u.hash || '').slice(1));
  if (i >= 0) goChapter(i, { anchor });
}
function onKey(ev) {
  const t = ev.target; const inField = t && /input|textarea|select/i.test(t.tagName);
  if (inField && !((ev.ctrlKey || ev.metaKey) && /^[dD]$/.test(ev.key))) return;
  if (ev.ctrlKey || ev.metaKey) {
    if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); $('#e-q').focus(); $('#e-q').select(); return; }
    if (ev.key === 'd' || ev.key === 'D') { ev.preventDefault(); addMark(); return; }
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoom(0.1); return; }
    if (ev.key === '-') { ev.preventDefault(); zoom(-0.1); return; }
    return;
  }
  const win = E.frame && E.frame.contentWindow; if (!win) return;
  const ms = maxScroll(), y = win.scrollY;
  if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
  if (ev.key === 'ArrowRight') { ev.preventDefault(); goChapter(E.ch + 1); return; }
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); goChapter(E.ch - 1); return; }
  if ((ev.key === 'PageDown' || ev.key === ' ' || ev.key === 'ArrowDown') && y >= ms - 2 && E.ch < E.info.spine.length - 1) { ev.preventDefault(); goChapter(E.ch + 1); return; }
  if ((ev.key === 'PageUp' || ev.key === 'ArrowUp') && y <= 1 && E.ch > 0) { ev.preventDefault(); goChapter(E.ch - 1, { end: true }); }
}
function zoom(d) { E.zoom = clamp(Math.round((E.zoom + d) * 100) / 100, 0.7, 2.2); savePrefs(); restyle(); }
function restyle() { const d = E.frame && E.frame.contentDocument; if (d && d.body) { const keep = E.pos; styleDoc(d); E.pending = null; const s = E.info.spine[E.ch]; const fr = s.end > s.start ? clamp((keep - s.start) / (s.end - s.start), 0, 1) : 0; E.frame.contentWindow.scrollTo(0, Math.round(maxScroll() * fr)); } }

// ---------- 책갈피·목차 ----------
const marksSorted = () => E.marks.slice().sort((a, b) => a.page - b.page);
function mkCount() { const e = $('#e-mkn'); if (e) e.textContent = E && E.marks.length ? ` ${E.marks.length}` : ''; }
let mkTimer = 0;
function saveMarks() {
  mkCount(); clearTimeout(mkTimer);
  mkTimer = setTimeout(async () => { try { const out = await api(`/api/library/files/${encodeURIComponent(E.file.id)}/marks`, 'PUT', { marks: E.marks }); TL().applyRecord(out); } catch { TL().toast && TL().toast('책갈피를 저장하지 못했습니다.'); } }, 350);
}
function addMark() {
  measurePos(); const page = pageOf(); const sp = E.info.spine[E.ch]; const label = (($('#e-ch') || {}).textContent || '').replace(/ · \d+\/\d+$/, '');
  if (E.marks.some((m) => Math.abs(m.page - page) <= 2)) { TL().toast && TL().toast('이 위치에는 이미 책갈피가 있습니다.'); return; }
  E.marks.push({ id: 'm' + Math.random().toString(36).slice(2, 9), page, title: `${label} (${Math.round(E.pos * 100)}%)`, level: 0 });
  saveMarks(); E.tab = 'mark'; showToc(true); TL().toast && TL().toast('책갈피를 추가했습니다.');
}
function showToc(force) { const b = $('#e-toc'); if (!b) return; if (force === true) b.hidden = false; else b.hidden = !b.hidden; if (!b.hidden) renderToc(); }
function tabsHtml() {
  const n = E.find && E.find.q ? E.find.hits : 0;
  return `<div class="tp-tabs"><button data-e="tab-toc" class="${E.tab === 'toc' ? 'on' : ''}">목차</button><button data-e="tab-mark" class="${E.tab === 'mark' ? 'on' : ''}">책갈피${E.marks.length ? ` <span>${E.marks.length}</span>` : ''}</button><button data-e="tab-find" class="${E.tab === 'find' ? 'on' : ''}">검색${n ? ` <span>${n}</span>` : ''}</button></div>`;
}
function renderToc() {
  const b = $('#e-toc'); if (!b || b.hidden) return; const esc = TL().esc; let h = tabsHtml();
  if (E.tab === 'find') { b.innerHTML = h + findHtml(); return; }
  if (E.tab === 'mark') {
    h += E.marks.length ? marksSorted().map((m) => `<div class="mk" data-mid="${esc(m.id)}"><a href="#" data-pg="${m.page}" class="mk-t">${esc(m.title || '책갈피')}</a><button class="mk-x" data-e="mk-del" data-id="${esc(m.id)}" title="삭제">✕</button></div>`).join('')
      : '<p class="help" style="padding:12px">책갈피가 없습니다. Ctrl+D 로 지금 위치에 추가합니다.</p>';
    b.innerHTML = h; return;
  }
  h += E.info.toc.length ? E.info.toc.map((t, i) => `<div class="mk lv${t.level}" data-ti="${i}"><a href="#" data-ti="${i}" class="mk-t" style="padding-left:${t.level * 14}px">${esc(t.title)}</a></div>`).join('')
    : '<p class="help" style="padding:12px">이 책에는 목차 정보가 없습니다. 이전·다음 장 버튼으로 읽을 수 있습니다.</p>';
  b.innerHTML = h; markCurToc();
}
function markCurToc() {
  const b = $('#e-toc'); if (!b || b.hidden || E.tab !== 'toc' || !E.info) return; let cur = -1;
  E.info.toc.forEach((t, i) => { if (t.pos <= E.pos + 1e-9 && (t.spine <= E.ch)) cur = i; });
  b.querySelectorAll('.mk[data-ti]').forEach((r) => r.classList.toggle('cur', +r.dataset.ti === cur));
}

// ---------- 책 안 검색 ----------
const FLAT = (s) => String(s).replace(/\s+/g, '').toLowerCase();
async function runFind(q) {
  q = String(q || '').trim(); const box = $('#e-q');
  if (FLAT(q).length < 2) { E.find = null; highlightAll([]); if (E.tab === 'find') { E.tab = 'toc'; } renderToc(); return; }
  E.tab = 'find'; showToc(true); const myq = q; E.find = { q, hits: 0, results: [], cur: -1, busy: true }; renderToc();
  try {
    const out = await api(`${base()}/search?q=${encodeURIComponent(q)}`);
    if (!E || !E.find || E.find.q !== myq) return;
    E.find = { q, hits: out.total, pages: out.pages, results: out.results, cur: -1, busy: false }; renderToc(); highlightAll([q]);
    if (out.results.length) stepFind(1);
  } catch { if (E && E.find) { E.find.busy = false; E.find.err = true; renderToc(); } }
}
function findHtml() {
  const f = E.find, esc = TL().esc; if (!f) return '<p class="help" style="padding:12px">위의 “이 책에서 찾기”에 검색어를 넣고 Enter를 누르세요.</p>';
  if (f.busy) return '<p class="help" style="padding:12px">찾는 중…</p>'; if (f.err) return '<p class="help" style="padding:12px">검색하지 못했습니다.</p>';
  if (!f.results.length) return `<p class="help" style="padding:12px">“${esc(f.q)}”에 해당하는 내용이 없습니다.</p>`;
  const nav = `<div class="tp-head"><button class="btn sm" data-e="fprev">‹ 이전</button><button class="btn sm" data-e="fnext">다음 ›</button><span class="help" style="margin-left:auto">${f.hits}곳 · ${f.pages}개 장${f.hits >= 3000 ? ' (일부)' : ''}</span></div>`;
  return nav + f.results.map((r, i) => `<a href="#" class="fd ${i === f.cur ? 'cur' : ''}" data-ri="${i}"><small>${Math.round(r.pos * 100)}% · ${r.spine + 1}장</small><span>${esc(r.pre)}<mark>${esc(r.hit)}</mark>${esc(r.post)}</span></a>`).join('');
}
function stepFind(d) {
  const f = E.find; if (!f || !f.results.length) return; f.cur = ((f.cur < 0 ? (d > 0 ? -1 : 0) : f.cur) + d + f.results.length) % f.results.length; gotoHit(f.cur);
}
function gotoHit(i) {
  const f = E.find, r = f.results[i]; f.cur = i; const k = f.results.slice(0, i).filter((x) => x.spine === r.spine).length;
  goChapter(r.spine, { hit: k, frac: 0 }); const b = $('#e-toc');
  if (b && !b.hidden && E.tab === 'find') { b.querySelectorAll('.fd').forEach((a) => a.classList.toggle('cur', +a.dataset.ri === i)); const c = b.querySelector('.fd.cur'); if (c) c.scrollIntoView({ block: 'nearest' }); }
}
// 본문(DOM)에서 검색어 위치를 찾는다: 공백을 뺀 글자로 맞춘다
function ranges(doc, q) {
  const fq = FLAT(q); if (!fq) return []; const out = [];
  const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/^(script|style)$/i.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const map = []; let flat = ''; let n;
  while ((n = w.nextNode())) { const t = n.nodeValue; for (let i = 0; i < t.length; i++) { if (/\s/.test(t[i])) continue; flat += t[i].toLowerCase(); map.push([n, i]); } }
  let at = 0; while ((at = flat.indexOf(fq, at)) >= 0) { const a = map[at], b = map[at + fq.length - 1]; const r = doc.createRange(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1] + 1); out.push(r); at += fq.length; if (out.length > 2000) break; }
  return out;
}
function highlightAll(terms) {
  const win = E.frame && E.frame.contentWindow; if (!win || !win.CSS || !win.CSS.highlights) return; const d = E.frame.contentDocument; if (!d || !d.body) return;
  try { win.CSS.highlights.clear(); } catch {}
  const q = (terms || []).filter(Boolean)[0]; if (!q) { E.rngs = []; return; }
  const rs = []; for (const t of terms) rs.push(...ranges(d, t)); E.rngs = ranges(d, q);
  try { win.CSS.highlights.set('tl-hit', new win.Highlight(...rs)); } catch {}
}
function focusHit(k) {
  const win = E.frame.contentWindow; const r = (E.rngs || [])[k] || (E.rngs || [])[0]; if (!r) return false;
  try { win.CSS.highlights.set('tl-hit-cur', new win.Highlight(r)); } catch {}
  const rect = r.getBoundingClientRect(); win.scrollTo(0, Math.max(0, win.scrollY + rect.top - E.frame.clientHeight * 0.3)); return true;
}

// ---------- 연결 ----------
function bind(el) {
  el.addEventListener('click', (e) => {
    const g = e.target.closest('[data-e],a[data-ti],a[data-pg],a[data-ri]'); if (!g || !E) return;
    if (g.dataset.ti != null && !g.dataset.e) { e.preventDefault(); const t = E.info.toc[+g.dataset.ti]; goChapter(t.spine, { anchor: t.anchor }); return; }
    if (g.dataset.pg != null && !g.dataset.e) { e.preventDefault(); goPos(clamp((+g.dataset.pg - 1) / (SCALE - 1), 0, 1)); return; }
    if (g.dataset.ri != null && !g.dataset.e) { e.preventDefault(); gotoHit(+g.dataset.ri); return; }
    switch (g.dataset.e) {
      case 'close': close(); break;
      case 'prev': if (E.info) goChapter(E.ch - 1); break;
      case 'next': if (E.info) goChapter(E.ch + 1); break;
      case 'zin': zoom(0.1); break; case 'zout': zoom(-0.1); break;
      case 'theme': E.theme = E.theme === 'light' ? 'sepia' : E.theme === 'sepia' ? 'dark' : 'light'; savePrefs(); restyle(); break;
      case 'toc': showToc(); break;
      case 'tab-toc': E.tab = 'toc'; renderToc(); break; case 'tab-mark': E.tab = 'mark'; renderToc(); break; case 'tab-find': E.tab = 'find'; renderToc(); break;
      case 'mk-del': E.marks = E.marks.filter((m) => m.id !== g.dataset.id); saveMarks(); renderToc(); break;
      case 'fprev': stepFind(-1); break; case 'fnext': stepFind(1); break;
    }
  });
  const q = $('#e-q', el);
  q.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); if (E.find && E.find.q === q.value.trim() && E.find.results.length) stepFind(e.shiftKey ? -1 : 1); else runFind(q.value); } else if (e.key === 'Escape') { q.value = ''; runFind(''); q.blur(); } });
  q.addEventListener('search', () => { if (!q.value) runFind(''); });
  const sel = $('#e-file', el); if (sel) sel.addEventListener('change', () => { const id = sel.value; close(true).then(() => window.TLReader.open({ fileId: id })); });
}
document.addEventListener('keydown', (e) => {
  if (!E || e.defaultPrevented) return;
  if (document.getElementById('modal')) return;
  onKey(e);
}, true);
window.addEventListener('beforeunload', () => { if (E && E.info) flush(true); });

async function close(silent) {
  if (!E) return; const e = E; if (e.info) await flush(false);
  clearTimeout(e.saveTimer); e.token = Symbol(); e.el.remove(); E = null;
  if (!silent) TL().afterReader();
}
window.TLEpub = { open, close, isOpen: () => !!E, __state: () => E };
})();
