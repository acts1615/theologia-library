// 앱 안 PDF 리더: 연속 스크롤, 읽은 쪽 자동 기록, 이어 읽기, 목차, 확대/축소, 텍스트 선택.
// PDF 렌더링은 pdf.js(Apache-2.0)를 앱에 포함해 사용합니다 (인터넷 불필요).
(() => {
'use strict';
const TL = () => window.TL;
const VENDOR = '/vendor/pdfjs/';
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import(VENDOR + 'pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs'; return m; });
  return pdfjsPromise;
}
const docOpts = (pdfjs, url) => ({
  url, cMapUrl: VENDOR + 'cmaps/', cMapPacked: true, standardFontDataUrl: VENDOR + 'standard_fonts/',
  wasmUrl: VENDOR + 'wasm/', iccUrl: VENDOR + 'iccs/', isEvalSupported: false, enableXfa: false,
});
const $ = (s, el = document) => el.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CSS_UNITS = 96 / 72; // pdf.js scale 1.333 = 실제 크기(100%)

let R = null; // 현재 열린 리더 상태

// ---------- 쪽수 측정 (읽지 않은 파일의 전체 쪽수를 조용히 알아내기) ----------
const measured = new Set();
async function measure(files) {
  const todo = files.filter((f) => !(f.pages > 0) && !f.missing && !measured.has(f.id));
  if (!todo.length) return;
  let pdfjs; try { pdfjs = await loadPdfjs(); } catch { return; }
  for (const f of todo) {
    measured.add(f.id);
    let task;
    try {
      task = pdfjs.getDocument({ ...docOpts(pdfjs, '/api/pdf/' + encodeURIComponent(f.id)), disableAutoFetch: true });
      const doc = await Promise.race([task.promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))]);
      const out = await TL().api(`/api/library/files/${encodeURIComponent(f.id)}/pages`, 'POST', { pages: doc.numPages });
      TL().applyRecord(out);
    } catch {} finally { try { task && task.destroy(); } catch {} }
  }
}

// ---------- 리더 ----------
async function open({ fileId, page, terms, best, pnum }) {
  const t = TL(); const file = t.fileById(fileId); if (!file) return;
  if (/\.(?:md|markdown)$/i.test(file.path || file.name || '') && window.TLMd) { if (R) await close(true); if (window.TLEpub && window.TLEpub.isOpen()) await window.TLEpub.close(true); return window.TLMd.open({ fileId }); }
  if (window.TLMd && window.TLMd.isOpen()) await window.TLMd.close(true);
  if (/\.epub$/i.test(file.path || file.name || '') && window.TLEpub) { if (R) await close(true); return window.TLEpub.open({ fileId, page, terms }); }
  if (window.TLEpub && window.TLEpub.isOpen()) await window.TLEpub.close(true);
  if (R) await close(true);
  const w = t.work(file.workId); window.__tlReadWork = w.id;
  const el = document.createElement('div'); el.className = 'reader'; el.id = 'reader';
  const siblings = t.filesOf(w);
  el.innerHTML = `
    <div class="r-bar">
      <button class="btn sm" data-act="side-toggle" title="사이드바 접기·펴기 (Ctrl+B)" aria-label="사이드바 접기·펴기">☰</button>
      <button class="btn sm" data-r="close" title="서재로 돌아가기 (Esc)">← 서재</button>
      <div class="r-title"><b>${t.esc(w.title)}</b><small id="r-fname">${t.esc(file.name)}</small></div>
      ${siblings.length > 1 ? `<select id="r-file" title="같은 작품의 다른 PDF">${siblings.map((f, i) => `<option value="${t.esc(f.id)}" ${f.id === file.id ? 'selected' : ''}>${i + 1}/${siblings.length} · ${t.esc(f.name)}</option>`).join('')}</select>` : ''}
      <span class="r-sp"></span>
      <div class="r-find"><input id="r-q" type="search" placeholder="이 책에서 찾기 (Ctrl+F)" autocomplete="off" aria-label="이 책에서 찾기" /></div>
      <div class="r-grp"><button class="btn sm" data-r="prev" title="이전 쪽 (←)">‹</button>
        <input id="r-page" type="number" min="1" value="1" aria-label="쪽" /><span id="r-total">/ –</span><span id="r-print" class="r-print" title="이 쪽의 책 인쇄 쪽 번호"></span><input id="r-pp" class="r-pp" type="number" min="1" placeholder="인쇄쪽" title="책에 인쇄된 쪽 번호로 이동 (Enter)" hidden />
        <button class="btn sm" data-r="next" title="다음 쪽 (→)">›</button></div>
      <div class="r-grp"><button class="btn sm" data-r="zout" title="축소 (Ctrl −)">−</button><span id="r-zoom">–</span><button class="btn sm" data-r="zin" title="확대 (Ctrl +)">＋</button><button class="btn sm" data-r="fit">너비 맞춤</button></div>
      ${terms && terms.length ? `<span class="r-hit" title="검색어가 노란색으로 표시됩니다"><b>${t.esc(terms.join(' · ').slice(0, 40))}</b><small id="r-hitn"></small><button data-r="hitprev" title="이전 위치">‹</button><button data-r="hitnext" title="다음 위치">›</button><button data-r="hitoff" title="강조 끄기">×</button></span>` : ''}
      <button class="btn sm" data-r="toc" title="목차·책갈피 (Ctrl+D: 지금 쪽에 책갈피 추가)">목차·책갈피<span id="r-mkn" class="r-mkn"></span></button>
      <button class="btn sm" data-r="ext" title="기본 PDF 뷰어로 열기">↗</button>
      <span class="r-save" id="r-save"></span>
    </div>
    <div class="r-body">
      <aside class="r-toc" id="r-toc" hidden></aside>
      <div class="r-scroll" id="r-scroll" tabindex="0"><div class="r-pages" id="r-pages"></div><div class="r-msg" id="r-msg">PDF를 여는 중…</div></div>
    </div>`;
  document.body.appendChild(el);
  R = { el, file, work: w, doc: null, pdfjs: null, scale: 1.3333, fit: true, N: 0, base: null, pages: [], page: 1, recorded: 0,
        terms: (terms || []).map((t) => String(t).replace(/\s+/g, '').toLowerCase()).filter(Boolean), best: !!best, hits: new Map(), hi: -1, focusPage: (terms && terms.length && page) ? page : 0, pnum: pnum || [], rendered: new Map(), queue: [], active: 0, io: null, saveTimer: null, closed: false, token: Symbol(), toc: null, tab: 'toc', find: null, ptext: new Map(), marks: ((file.marks || []).map((m) => ({ ...m }))), mkTimer: null, mkEdit: '' };
  bind(el); mkCount();
  const token = R.token;
  try {
    R.pdfjs = await loadPdfjs();
    const task = R.pdfjs.getDocument(docOpts(R.pdfjs, '/api/pdf/' + encodeURIComponent(file.id) + (R.best ? '?best=1' : '')));
    task.onPassword = (cb, reason) => askPassword(reason).then((pw) => (pw == null ? close() : cb(pw)));
    R.task = task;
    R.doc = await task.promise;
    if (R.token !== token) return;
    R.N = R.doc.numPages;
    const p1 = await R.doc.getPage(1); R.base = p1.getViewport({ scale: 1 });
    try { const z = JSON.parse(localStorage.getItem('tl-zoom') || 'null'); if (z && z.fit === false && z.scale > 0.3) { R.fit = false; R.scale = z.scale; } } catch {}
    $('#r-total').textContent = '/ ' + R.N; $('#r-page').max = R.N;
    $('#r-msg').remove();
    buildPages(); loadPnum();
    const start = clamp(page || (file.lastPage > 0 ? file.lastPage : 1), 1, R.N);
    goTo(start, true);
    // 처음 연 쪽도 기록 (열자마자 '읽는 중'으로 반영)
    recordSoon(0); R.recorded = 0;
    R.doc.getOutline().then((o) => { R.toc = o && o.length ? o : null; const b = $('#r-toc'); if (b && !b.hidden) renderToc(); }).catch(() => {});
  } catch (e) {
    if (R && R.token === token) {
      const msg = $('#r-msg'); if (msg) msg.innerHTML = '';
      if (msg) { msg.textContent = /Missing PDF|404|파일/i.test(String(e && e.message)) ? '파일을 찾을 수 없습니다. 이동되었거나 삭제되었을 수 있습니다.' : 'PDF를 열 수 없습니다: ' + (e && e.message ? e.message : e); msg.classList.add('err'); }
    }
  }
}

function askPassword(reason) {
  return new Promise((resolve) => {
    const m = document.createElement('div'); m.className = 'scrim'; m.style.zIndex = 140;
    m.innerHTML = `<div class="modal" style="width:380px"><header><h2>암호가 필요한 PDF</h2></header><div class="mb"><p class="help">${reason === 2 ? '암호가 맞지 않습니다. 다시 입력해 주세요.' : '이 PDF를 열려면 암호를 입력하세요.'}</p><input id="pw" type="password" style="width:100%;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px" autofocus></div><footer><button class="btn" data-x="no">취소</button><button class="btn primary" data-x="ok">열기</button></footer></div>`;
    document.body.appendChild(m); const inp = $('#pw', m); inp.focus();
    const done = (v) => { m.remove(); resolve(v); };
    m.addEventListener('click', (e) => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'ok' ? inp.value : null); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value); });
  });
}

function effScale() {
  const sc = $('#r-scroll'); if (!sc || !R.base) return R.scale;
  if (R.fit) return clamp((sc.clientWidth - 56) / R.base.width, 0.4, 3.2);
  return R.scale;
}
function buildPages() {
  const host = $('#r-pages'); host.innerHTML = ''; R.pages = [];
  const sc = effScale(); R.cur = sc;
  const w = Math.round(R.base.width * sc), h = Math.round(R.base.height * sc);
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= R.N; n++) {
    const d = document.createElement('div'); d.className = 'r-page'; d.dataset.n = n; d.style.width = w + 'px'; d.style.height = h + 'px';
    d.innerHTML = `<span class="r-ph">${n}</span>`; frag.appendChild(d); R.pages.push(d);
  }
  host.appendChild(frag);
  $('#r-zoom').textContent = Math.round((sc / CSS_UNITS) * 100) + '%';
  if (R.io) R.io.disconnect();
  R.io = new IntersectionObserver((ents) => {
    for (const e of ents) { const n = +e.target.dataset.n; if (e.isIntersecting) enqueue(n); else release(n); }
  }, { root: $('#r-scroll'), rootMargin: '1400px 0px' });
  for (const d of R.pages) R.io.observe(d);
}

function enqueue(n) {
  if (!R || R.rendered.has(n) || R.queue.includes(n)) return;
  R.queue.push(n); pump();
}
function pump() {
  if (!R) return;
  while (R.active < 2 && R.queue.length) {
    R.queue.sort((a, b) => Math.abs(a - R.page) - Math.abs(b - R.page));
    const n = R.queue.shift(); R.active++;
    renderPage(n).catch(() => {}).finally(() => { if (R) { R.active--; pump(); } });
  }
}
async function renderPage(n) {
  const Rr = R; if (!Rr || Rr.rendered.has(n)) return;
  const rec = { cancelled: false, task: null, text: null }; Rr.rendered.set(n, rec);
  const page = await Rr.doc.getPage(n); if (R !== Rr || rec.cancelled) return;
  const sc = Rr.cur, vp = page.getViewport({ scale: sc });
  const host = Rr.pages[n - 1]; host.style.width = Math.round(vp.width) + 'px'; host.style.height = Math.round(vp.height) + 'px';
  const dpr = window.devicePixelRatio || 1;
  const ratio = Math.min(dpr, Math.sqrt(2.4e7 / (vp.width * vp.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = Math.floor(vp.width) + 'px'; canvas.style.height = Math.floor(vp.height) + 'px';
  const ctx = canvas.getContext('2d', { alpha: false });
  rec.task = page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null, background: '#ffffff' });
  try { await rec.task.promise; } catch { return; }
  if (R !== Rr || rec.cancelled) return;
  const ph = host.querySelector('.r-ph'); if (ph) ph.remove();
  host.appendChild(canvas);
  const tl = document.createElement('div'); tl.className = 'textLayer';
  tl.style.setProperty('--scale-factor', String(sc)); tl.style.setProperty('--total-scale-factor', String(sc));
  host.appendChild(tl);
  try { rec.text = new Rr.pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }); await rec.text.render(); } catch {}
  rec.page = page;
  if (R === Rr && !rec.cancelled) { markHits(Rr, n, tl); updateHitCount(); if (Rr.focusPage === n) { Rr.focusPage = 0; setTimeout(() => { if (R === Rr) stepHit(0); }, 120); } }
}
// ---------- 검색어 강조 (CSS Custom Highlight: 글자 층 위에 노란 배경만 얹는다) ----------
function markHits(Rr, n, tl) {
  if (!Rr.terms.length || !window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
  const nodes = []; const w = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
  let flat = ''; const map = [];
  while (w.nextNode()) { const nd = w.currentNode, tx = nd.nodeValue; nodes.push(nd); for (let i = 0; i < tx.length; i++) { if (/\s/.test(tx[i])) continue; flat += tx[i].toLowerCase(); map.push([nd, i]); } }
  const ranges = [];
  for (const t of Rr.terms) {
    let at = 0;
    while (t && (at = flat.indexOf(t, at)) >= 0) {
      const a = map[at], b = map[at + t.length - 1];
      try { const r = new Range(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1] + 1); ranges.push(r); } catch {}
      at += t.length;
    }
  }
  if (!ranges.length) return;
  let h = CSS.highlights.get('tl-hit'); if (!h) { h = new Highlight(); CSS.highlights.set('tl-hit', h); }
  Rr.hits.set(n, ranges); for (const r of ranges) h.add(r);
}
function hitList() {
  if (!R) return [];
  const out = [];
  for (const n of [...R.hits.keys()].sort((a, b) => a - b)) for (const rg of R.hits.get(n)) { let top = 0; try { top = rg.getBoundingClientRect().top; } catch {} out.push({ n, rg, top }); }
  return out.sort((a, b) => a.n - b.n || a.top - b.top);
}
function updateHitCount() {
  const el = $('#r-hitn'); if (!el || !R) return;
  const F = R.find;
  if (F && F.q && R.terms[0] === F.q && F.hits) { el.textContent = F.cur >= 0 ? `${F.cur + 1}/${F.hits}곳` : `${F.hits}곳`; return; }
  const l = hitList(); el.textContent = l.length ? (R.hi >= 0 ? `${R.hi + 1}/${l.length}곳` : `${l.length}곳`) : '';
}
// 찾은 글자 위치로: dir 0 = 현재 쪽의 첫 곳, 1/-1 = 다음/이전 (열려 있는 쪽들 안에서)
function stepHit(dir) {
  if (!R) return; const l = hitList(); if (!l.length) return;
  let i;
  if (dir === 0) { const k = l.findIndex((x) => x.n >= R.page); i = k < 0 ? 0 : k; } else i = ((R.hi < 0 ? (dir > 0 ? -1 : 0) : R.hi) + dir + l.length) % l.length;
  R.hi = i;
  const sc = $('#r-scroll'), rc = l[i].rg.getBoundingClientRect(), box = sc.getBoundingClientRect();
  sc.scrollTo({ top: sc.scrollTop + (rc.top - box.top) - sc.clientHeight * 0.35, behavior: dir === 0 ? 'auto' : 'smooth' });
  try { if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') CSS.highlights.set('tl-hit-cur', new Highlight(l[i].rg)); } catch {}
  updateHitCount();
}
function unmarkHits(Rr, n) {
  const rs = Rr.hits && Rr.hits.get(n); if (!rs) return;
  const h = window.CSS && CSS.highlights && CSS.highlights.get('tl-hit'); if (h) for (const r of rs) h.delete(r);
  Rr.hits.delete(n);
}
function clearHits() {
  if (!R) return; R.terms = [];
  for (const n of [...R.hits.keys()]) unmarkHits(R, n);
  const chip = $('.r-hit', R.el); if (chip) chip.remove();
  try { if (window.CSS && CSS.highlights) CSS.highlights.delete('tl-hit-cur'); } catch {}
}

// ---------- 본문 검색용: 쪽 글자 꺼내기 (열린 PDF 몇 개를 기억해 둔다) ----------
const docCache = new Map();
async function pageText(fileId, page1, best) {
  const key = fileId + (best ? ':b' : '');
  let ent = docCache.get(key);
  if (!ent) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ ...docOpts(pdfjs, '/api/pdf/' + encodeURIComponent(fileId) + (best ? '?best=1' : '')), disableAutoFetch: true });
    ent = { task, promise: task.promise, t: 0 }; docCache.set(key, ent);
    task.promise.catch(() => docCache.delete(key));
    while (docCache.size > 4) { const old = [...docCache.entries()].sort((a, b) => a[1].t - b[1].t)[0]; docCache.delete(old[0]); try { old[1].task.destroy(); } catch {} }
  }
  ent.t = Date.now();
  const doc = await ent.promise; const pg = await doc.getPage(page1);
  try { const tc = await pg.getTextContent(); return tc.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join(''); } finally { pg.cleanup(); }
}

// ISBN 찾기용: 앞쪽 12쪽(표제지·판권지)과 뒤쪽 6쪽(판권지·광고)의 글자를 모은다. 스캔본처럼 글자가 없으면 빈 글자만 돌려준다.
async function isbnTexts(fileId) {
  await pageText(fileId, 1);
  const ent = docCache.get(fileId); const doc = await ent.promise; const N = doc.numPages;
  const pages = []; for (let i = 1; i <= Math.min(N, 12); i++) pages.push(i);
  for (let i = Math.max(13, N - 5); i <= N; i++) pages.push(i);
  const texts = []; for (const n of pages) { try { texts.push(await pageText(fileId, n)); } catch {} }
  return { texts, numPages: N };
}

function release(n) {
  if (!R) return;
  const i = R.queue.indexOf(n); if (i >= 0) R.queue.splice(i, 1);
  const rec = R.rendered.get(n); if (!rec) return;
  rec.cancelled = true; try { rec.task && rec.task.cancel(); } catch {} try { rec.text && rec.text.cancel(); } catch {}
  unmarkHits(R, n);
  const host = R.pages[n - 1];
  if (host) { host.querySelectorAll('canvas').forEach((c) => { c.width = 0; c.height = 0; }); host.querySelectorAll('canvas,.textLayer').forEach((x) => x.remove()); if (!host.querySelector('.r-ph')) host.insertAdjacentHTML('afterbegin', `<span class="r-ph">${n}</span>`); }
  try { rec.page && rec.page.cleanup(); } catch {}
  R.rendered.delete(n);
}
function rebuild(keepPage) {
  if (!R || !R.N) return;
  for (const n of [...R.rendered.keys()]) release(n);
  R.queue = []; buildPages(); goTo(keepPage || R.page, true);
}

// ---------- 이동/현재 쪽 ----------
function goTo(n, instant) {
  if (!R || !R.N) return;
  n = clamp(Math.round(n) || 1, 1, R.N);
  const sc = $('#r-scroll'), el = R.pages[n - 1];
  sc.scrollTo({ top: el.offsetTop - 12, behavior: 'auto' });
  setPage(n);
}
function currentFromScroll() {
  const sc = $('#r-scroll'); if (!sc || !R.N) return R.page;
  const y = sc.scrollTop + sc.clientHeight * 0.3;
  let lo = 0, hi = R.N - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R.pages[mid].offsetTop <= y) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
const printedOf = (segs, p0) => { for (const [a, b, d] of segs || []) if (p0 >= a && p0 <= b) return p0 + d; return null; };
const pdfOfPrinted = (segs, pr) => { for (const [a, b, d] of segs || []) if (a <= pr - d && pr - d <= b) return pr - d; return null; };
function showPrinted() {
  if (!R) return; const el = $('#r-print'), pp = $('#r-pp'); if (!el) return;
  const has = R.pnum && R.pnum.length; if (pp) pp.hidden = !has;
  const n = has ? printedOf(R.pnum, R.page - 1) : null;
  el.textContent = n != null ? `· 인쇄 ${n}쪽` : '';
}
async function loadPnum() {
  const Rr = R; if (!Rr || Rr.pnum.length) return;
  try { const j = await TL().api('/api/search/pnum?fileId=' + encodeURIComponent(Rr.file.id)); if (R === Rr) { Rr.pnum = j.pnum || []; showPrinted(); } } catch {}
}
function setPage(n) {
  if (!R) return;
  R.page = n; const inp = $('#r-page'); if (inp && document.activeElement !== inp) inp.value = n;
  showPrinted(); markCur();
  if (n !== R.recorded) recordSoon(1200);
  pump();
}
let raf = 0;
function onScroll() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (R && R.N) setPage(currentFromScroll()); }); }

// ---------- 기록 ----------
function recordSoon(ms) { if (!R) return; clearTimeout(R.saveTimer); R.saveTimer = setTimeout(() => flush(false), ms); const s = $('#r-save'); if (s) s.textContent = '기록 중…'; }
async function flush(keepalive) {
  if (!R || !R.N) return;
  clearTimeout(R.saveTimer); const page = R.page, fid = R.file.id, N = R.N;
  if (page === R.recorded && !keepalive) { const s = $('#r-save'); if (s) s.textContent = page ? '기록됨' : ''; return; }
  R.recorded = page;
  try {
    const out = await TL().api(`/api/library/files/${encodeURIComponent(fid)}/progress`, 'POST', { page, pages: N }, keepalive);
    TL().applyRecord(out);
    const s = $('#r-save'); if (s) s.textContent = `p.${page} 기록됨`;
  } catch { const s = $('#r-save'); if (s) s.textContent = '기록 실패'; }
}

// ---------- 목차·책갈피 ----------
const printedLabel = (page) => { const n = R.pnum && R.pnum.length ? printedOf(R.pnum, page - 1) : null; return n != null ? ` · 인쇄 ${n}` : ''; };
function mkCount() { const e = $('#r-mkn'); if (e) e.textContent = R && R.marks.length ? ` ${R.marks.length}` : ''; }
function curMarkId() { let id = ''; for (const m of R.marks) { if (m.page <= R.page) id = m.id; else break; } return id; }
function markCur() { const box = $('#r-toc'); if (!box || box.hidden || R.tab === 'find') return; const cur = curMarkId(); box.querySelectorAll('.mk').forEach((r) => r.classList.toggle('cur', r.dataset.mid === cur)); const ad = $('[data-r=mk-add]', box); if (ad) ad.textContent = `＋ 지금 쪽 (p.${R.page})`; }
function tabsHtml() {
  const n = R.find && R.find.q ? R.find.hits : 0;
  return `<div class="tp-tabs"><button data-r="tab-toc" class="${R.tab === 'find' ? '' : 'on'}">목차·책갈피</button><button data-r="tab-find" class="${R.tab === 'find' ? 'on' : ''}">검색 결과${n ? ` <span>${n}</span>` : ''}</button></div>`;
}
function renderToc() {
  const box = $('#r-toc'); const t = TL(); if (!box || !R) return;
  if (R.tab === 'find') { renderFind(); return; }
  const cur = curMarkId();
  const mrow = (m) => R.mkEdit === m.id
    ? `<div class="mk edit" data-mid="${m.id}" style="padding-left:${10 + m.level * 14}px"><input class="mk-in" value="${t.esc(m.title)}" placeholder="p.${m.page}" maxlength="200" /><small>p.${m.page}</small></div>`
    : `<div class="mk ${m.id === cur ? 'cur' : ''}" data-mid="${m.id}" style="padding-left:${10 + m.level * 14}px"><a href="#" data-r="mk-go" title="${t.esc(m.title || 'p.' + m.page)}">${t.esc(m.title || 'p.' + m.page)}</a><small>p.${m.page}${printedLabel(m.page)}</small><span class="mk-act"><button data-r="mk-edit" title="이름 바꾸기">✎</button><button data-r="mk-lv" title="들여쓰기 바꾸기 (장 ▸ 절 ▸ 소절)">⇥</button><button data-r="mk-del" title="삭제">×</button></span></div>`;
  const tocRow = (it, depth) => `<div class="toc-i" style="padding-left:${10 + depth * 14}px"><a href="#" data-i="${it.__id}">${t.esc(it.title || '(제목 없음)')}</a></div>${(it.items || []).map((c) => tocRow(c, depth + 1)).join('')}`;
  let html = tabsHtml() + `<div class="tp-head"><button class="btn sm primary" data-r="mk-add">＋ 지금 쪽 (p.${R.page})</button><button class="btn sm" data-r="mk-paste" title="목차 글을 붙여 넣어 한꺼번에 만들기">목차 붙여넣기</button></div>`;
  html += `<div class="tp-sec">내 책갈피 <span>${R.marks.length}</span>${R.marks.length ? '<button class="tp-clear" data-r="mk-clear" title="내 책갈피 모두 지우기">모두 지우기</button>' : ''}</div>`;
  html += R.marks.length ? R.marks.map(mrow).join('') : '<p class="help" style="padding:4px 12px 10px">아직 없습니다. 읽다가 <b>Ctrl+D</b>를 누르거나 위 버튼으로 지금 쪽을 추가하세요.</p>';
  if (R.toc) {
    let id = 0; R.tocMap = new Map();
    const tag = (list) => list.forEach((it) => { it.__id = id++; R.tocMap.set(it.__id, it); tag(it.items || []); });
    tag(R.toc); html += `<div class="tp-sec">PDF에 들어 있는 목차</div>` + R.toc.map((it) => tocRow(it, 0)).join('');
  }
  box.innerHTML = html;
  const inp = $('.mk-in', box); if (inp) { inp.focus(); inp.select(); }
}
function saveMarks() {
  clearTimeout(R.mkTimer); const r = R, fid = R.file.id, marks = R.marks.map(({ id, page, title, level }) => ({ id, page, title, level }));
  r.mkTimer = setTimeout(async () => {
    try { const out = await TL().api(`/api/library/files/${encodeURIComponent(fid)}/marks`, 'PUT', { marks }); TL().applyRecord(out); }
    catch (e) { TL().toast && TL().toast('책갈피를 저장하지 못했습니다: ' + (e && e.message || e), true); }
  }, 350);
}
const sortMarks = () => { R.marks = R.marks.map((m, i) => ({ m, i })).sort((a, b) => a.m.page - b.m.page || a.i - b.i).map((x) => x.m); };
function addMark(page, title, level) {
  if (!R || !R.N) return null;
  const m = { id: 'm' + Math.random().toString(36).slice(2, 9), page: page || R.page, title: title || '', level: level || 0 };
  R.marks.push(m); sortMarks(); mkCount(); saveMarks(); return m;
}
function addHere() {
  const box = $('#r-toc'); const m = addMark(); if (!m) return;
  R.mkEdit = m.id; if (box.hidden) box.hidden = false; renderToc();
  const row = box.querySelector(`.mk[data-mid="${m.id}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
}
// ---------- 이 책에서 찾기 ----------
const FIND_MAX = 3000;
async function pageEntry(n) {
  let e = R.ptext.get(n); if (e) return e;
  const pg = await R.doc.getPage(n); let o = '';
  try { const tc = await pg.getTextContent(); o = tc.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join(''); } finally { pg.cleanup(); }
  let f = ''; const idx = [];
  for (let i = 0; i < o.length; i++) { const ch = o[i]; if (/\s/.test(ch)) continue; f += ch.toLowerCase(); idx.push(i); }
  e = { o, f, m: Int32Array.from(idx) }; R.ptext.set(n, e); return e;
}
function pageMatches(e, q) {
  const out = []; let at = 0;
  while ((at = e.f.indexOf(q, at)) >= 0) {
    const s = e.m[at], t = e.m[at + q.length - 1] + 1;
    const pre = e.o.slice(Math.max(0, s - 34), s).replace(/\s+/g, ' '), hit = e.o.slice(s, t).replace(/\s+/g, ' '), post = e.o.slice(t, t + 60).replace(/\s+/g, ' ');
    out.push({ pre: pre.length >= 34 ? '…' + pre.slice(-32) : pre, hit, post });
    at += q.length;
  }
  return out;
}
function refreshHighlights() {
  if (!R) return;
  for (const n of [...R.hits.keys()]) unmarkHits(R, n);
  R.hi = -1;
  for (const [n, rec] of R.rendered) { const tl = R.pages[n - 1] && R.pages[n - 1].querySelector('.textLayer'); if (tl && rec) markHits(R, n, tl); }
  try { if (window.CSS && CSS.highlights) CSS.highlights.delete('tl-hit-cur'); } catch {}
  updateHitCount();
}
function ensureChip(label) {
  let chip = $('.r-hit', R.el);
  if (!chip) {
    chip = document.createElement('span'); chip.className = 'r-hit'; chip.title = '검색어가 노란색으로 표시됩니다';
    chip.innerHTML = '<b></b><small id="r-hitn"></small><button data-r="hitprev" title="이전 위치">‹</button><button data-r="hitnext" title="다음 위치">›</button><button data-r="hitoff" title="강조 끄기">×</button>';
    R.el.querySelector('[data-r=toc]').before(chip);
  }
  chip.querySelector('b').textContent = label.slice(0, 40);
}
let findRender = 0;
function findRenderSoon() { if (findRender) return; findRender = setTimeout(() => { findRender = 0; if (R && R.tab === 'find' && !$('#r-toc').hidden) renderFind(); else { const b = $('[data-r=tab-find] span', R && R.el); if (R) { const tb = $('[data-r=tab-find]', R.el); if (tb) tb.innerHTML = `검색 결과${R.find && R.find.hits ? ` <span>${R.find.hits}</span>` : ''}`; } } }, 160); }
async function runFind(raw) {
  if (!R || !R.N) return;
  const q = String(raw || '').replace(/\s+/g, '').toLowerCase(); const label = String(raw || '').trim();
  const box = $('#r-toc'); R.tab = 'find'; if (box.hidden) box.hidden = false;
  if (q.length < 2) { R.find = { q: '', label, hits: 0, pages: 0, results: [], done: true, scanned: 0, msg: '두 글자 이상 입력해 주세요.', token: Symbol() }; renderFind(); return; }
  const token = Symbol();
  const F = R.find = { q, label, cur: -1, hits: 0, pages: 0, results: [], done: false, scanned: 0, noText: false, msg: '', limit: 600, token };
  R.terms = [q]; ensureChip(label); refreshHighlights();
  renderFind();
  let textSeen = 0;
  for (let from = 1; from <= R.N; from += 6) {
    const batch = []; for (let n = from; n < Math.min(R.N, from + 5) + 1; n++) batch.push(n);
    let ents; try { ents = await Promise.all(batch.map((n) => pageEntry(n))); } catch { ents = []; }
    if (!R || R.find !== F) return;
    ents.forEach((e, i) => {
      const n = batch[i]; textSeen += e.f.length; F.scanned = n;
      if (F.hits >= FIND_MAX) return;
      const ms = pageMatches(e, q); if (!ms.length) return;
      F.pages++; ms.forEach((m, k) => { if (F.hits < FIND_MAX) { F.results.push({ page: n, k, ...m }); F.hits++; } });
    });
    if (from === 1 && batch.length && R.N > 0) { /* 처음 몇 쪽 확인 후 아래서 글자 유무 판단 */ }
    if (F.scanned >= Math.min(R.N, 30) && textSeen < 20 && !F.hits) { F.noText = true; break; }
    if (F.hits >= FIND_MAX) { F.msg = `${FIND_MAX}곳을 넘어 여기까지만 보여 드립니다. 더 구체적으로 검색해 보세요.`; break; }
    findRenderSoon();
  }
  F.done = true; if (F.noText) F.msg = '이 PDF에는 글자 정보가 없어(스캔본) 책 안에서 찾을 수 없습니다.';
  if (R && R.find === F) { renderFind(); updateHitCount(); }
}
function renderFind() {
  const box = $('#r-toc'); const t = TL(); if (!box || !R) return;
  const F = R.find;
  let html = tabsHtml();
  if (!F) html += '<p class="help" style="padding:12px">위쪽 검색창에 낱말을 입력하고 Enter를 누르면 이 책 안에서 찾아 여기에 보여 줍니다.<br><br>띄어쓰기가 달라도 찾아집니다. 결과를 누르면 그 쪽의 해당 위치로 이동합니다.</p>';
  else {
    const status = F.done ? (F.hits ? `<b>${t.esc(F.label)}</b> — ${num(F.hits)}곳 · ${num(F.pages)}쪽` : `<b>${t.esc(F.label)}</b> — 찾지 못했습니다`) : `<b>${t.esc(F.label)}</b> 찾는 중… ${F.scanned}/${R.N}쪽 · ${num(F.hits)}곳`;
    html += `<div class="fd-stat">${status}${F.done ? '' : '<button class="tp-clear" data-r="fd-stop">중단</button>'}</div>`;
    if (F.msg) html += `<p class="help" style="padding:2px 12px 8px">${t.esc(F.msg)}</p>`;
    const rows = F.results.slice(0, F.limit); let last = 0;
    html += rows.map((r, ri) => { const head = r.page !== last ? `<div class="fd-pg">p.${r.page}${printedLabel(r.page)}</div>` : ''; last = r.page; return `${head}<a href="#" class="fd${ri === F.cur ? ' cur' : ''}" data-r="fd-go" data-ri="${ri}" data-p="${r.page}" data-k="${r.k}"><span>${t.esc(r.pre)}</span><mark>${t.esc(r.hit)}</mark><span>${t.esc(r.post)}</span></a>`; }).join('');
    if (F.results.length > F.limit) html += `<button class="btn sm fd-more" data-r="fd-more">더 보기 (${num(F.results.length - F.limit)}곳 남음)</button>`;
  }
  const keep = box.scrollTop; box.innerHTML = html; box.scrollTop = keep;
}
const num = (n) => Number(n || 0).toLocaleString('ko-KR');
function markFindCur(scroll) {
  const box = $('#r-toc'); if (box && R.tab === 'find') { box.querySelectorAll('.fd').forEach((r) => r.classList.toggle('cur', R.find && +r.dataset.ri === R.find.cur)); if (scroll) { const c = box.querySelector('.fd.cur'); if (c) c.scrollIntoView({ block: 'nearest' }); } }
  updateHitCount();
}
// 다음/이전 위치: 책 안 검색 중이면 결과 목록(책 전체) 순서대로, 아니면 열려 있는 쪽의 강조 순서대로
function stepAny(dir) {
  const F = R && R.find;
  if (F && F.q && R.terms[0] === F.q && F.results.length) {
    const n = F.results.length; F.cur = F.cur < 0 ? (dir > 0 ? 0 : n - 1) : (F.cur + dir + n) % n;
    if (F.cur >= F.limit) F.limit = F.cur + 50;
    if (R.tab === 'find') renderFind();
    const r = F.results[F.cur]; markFindCur(true); focusHit(r.page, r.k); return;
  }
  stepHit(dir);
}
function focusHit(page, k) {
  goTo(page); let tries = 0;
  const go = () => {
    if (!R) return; const rs = R.hits.get(page);
    if (!rs || !rs.length) { if (++tries < 30) setTimeout(go, 90); return; }
    const l = hitList(); let c = 0, idx = -1;
    for (let i = 0; i < l.length; i++) if (l[i].n === page) { if (c === k) { idx = i; break; } c++; }
    if (idx < 0) idx = l.findIndex((x) => x.n === page);
    if (idx < 0) return; R.hi = idx - 1; stepHit(1);
  };
  setTimeout(go, 60);
}

function finishEdit(commit) {
  const box = $('#r-toc'); const id = R.mkEdit; if (!id) return; const inp = $('.mk-in', box);
  const m = R.marks.find((x) => x.id === id);
  if (m && commit && inp) { m.title = inp.value.replace(/\s+/g, ' ').trim(); saveMarks(); }
  R.mkEdit = ''; renderToc();
}
function pasteModal() {
  const old = document.getElementById('mk-modal'); if (old) { old.remove(); return; }   // 다시 누르면 접힌다
  const t = TL(); const m = document.createElement('div'); m.className = 'mk-drop'; m.id = 'mk-modal';
  const btn = document.querySelector('.reader [data-r="mk-paste"]'); const br = btn ? btn.getBoundingClientRect() : { left: 20, bottom: 90 };
  const w = Math.min(480, window.innerWidth - 24); m.style.width = w + 'px'; m.style.top = Math.round(br.bottom + 6) + 'px'; m.style.left = Math.round(Math.max(12, Math.min(br.left, window.innerWidth - w - 12))) + 'px';
  const hasP = R.pnum && R.pnum.length;
  m.innerHTML = `<div class="mk-dh"><b>목차 붙여넣기</b><button class="btn sm" data-x="no" title="접기 (Esc)">✕</button></div><div class="mb">
    <p class="help">책의 목차 글을 붙여 넣으세요. "제목 ··· 23" 처럼 줄 끝에 인쇄 쪽 번호가 있으면 읽어 들입니다. 들여쓰기와 번호(1.1)로 장·절을 나눕니다.</p>
    <textarea id="mk-text" rows="9" class="mk-ta" placeholder="제1장 서론 ........ 13&#10;  1.1 연구의 목적 ...... 15&#10;제2장 교회와 직분 ...... 45"></textarea>
    <div class="mk-off"><span>PDF 쪽 = 인쇄 쪽 +</span><input id="mk-off" type="number" value="0" style="width:72px"><button class="btn sm" id="mk-here" title="목차의 첫 항목이 있는 쪽을 PDF에서 열어 둔 채로 누르세요">첫 항목 = 지금 쪽(p.${R.page})</button>
      ${hasP ? '<label class="mk-auto"><input type="checkbox" id="mk-auto" checked> 인쇄 쪽 번호 기능으로 자동 계산</label>' : ''}</div>
    <p class="help" id="mk-prev" style="min-height:2.6em"></p>
    <label class="mk-auto"><input type="checkbox" id="mk-rep"> 기존 내 책갈피를 모두 바꾸기(끄면 추가)</label>
  </div><footer><button class="btn" data-x="no">취소</button><button class="btn primary" data-x="ok" disabled>반영</button></footer>`;
  document.body.appendChild(m);
  const ta = $('#mk-text', m), off = $('#mk-off', m), prev = $('#mk-prev', m), ok = $('[data-x=ok]', m), auto = $('#mk-auto', m);
  let items = [], timer = 0;
  const pageFor = (pr) => { if (auto && auto.checked) { const p0 = pdfOfPrinted(R.pnum, pr); if (p0 != null) return p0 + 1; } return pr + (+off.value || 0); };
  const view = () => {
    const good = items.map((i) => ({ ...i, page: pageFor(i.printed) })).filter((i) => i.page >= 1 && i.page <= R.N);
    if (!items.length) { prev.textContent = ta.value.trim() ? '쪽 번호가 붙은 줄을 찾지 못했습니다.' : ''; ok.disabled = true; return good; }
    const f = good[0], skipped = items.length - good.length;
    prev.textContent = `${items.length}개 항목을 읽었습니다${skipped ? ` (쪽 범위를 벗어난 ${skipped}개는 제외)` : ''}.` + (f ? ` 예: "${f.title}" → PDF p.${f.page}` : '');
    ok.disabled = !good.length; return good;
  };
  const parse = () => { clearTimeout(timer); timer = setTimeout(async () => { try { items = (await t.api('/api/toc/parse', 'POST', { text: ta.value })).items; } catch { items = []; } view(); }, 250); };
  ta.addEventListener('input', parse); off.addEventListener('input', view); if (auto) auto.addEventListener('change', view);
  $('#mk-here', m).addEventListener('click', () => { if (!items.length) { prev.textContent = '먼저 목차 글을 붙여 넣어 주세요.'; return; } if (auto) auto.checked = false; off.value = R.page - items[0].printed; view(); });
  const done = (v) => { clearTimeout(timer); m.remove(); if (!v) return; const good = view(); if (!good.length) return;
    if ($('#mk-rep', m).checked) R.marks = [];
    for (const g of good) R.marks.push({ id: 'm' + Math.random().toString(36).slice(2, 9), page: g.page, title: g.title, level: g.level });
    sortMarks(); mkCount(); saveMarks(); renderToc(); t.toast && t.toast(`책갈피 ${good.length}개를 추가했습니다.`); };
  m.addEventListener('click', (e) => { const x = e.target.closest('[data-x]'); if (x) done(x.dataset.x === 'ok'); });   // 바깥을 눌러도 닫히지 않는다: 책을 보면서 붙여 넣을 수 있게
  m.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') done(false); });
  ta.focus();
}
async function gotoDest(it) {
  try {
    let dest = it.dest; if (typeof dest === 'string') dest = await R.doc.getDestination(dest);
    if (!Array.isArray(dest)) return;
    const idx = typeof dest[0] === 'object' ? await R.doc.getPageIndex(dest[0]) : Number(dest[0]);
    goTo(idx + 1);
  } catch {}
}

// ---------- 이벤트 ----------
function setZoom(mult) {
  R.fit = false; R.scale = clamp(R.cur * mult, 0.4, 4);
  try { localStorage.setItem('tl-zoom', JSON.stringify({ fit: false, scale: R.scale })); } catch {}
  rebuild(R.page);
}
function bind(el) {
  const sc = $('#r-scroll', el);
  sc.addEventListener('scroll', onScroll, { passive: true });
  el.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-r],a[data-i]'); if (!a || !R) return;
    if (a.dataset.i != null && !a.dataset.r) { e.preventDefault(); gotoDest(R.tocMap.get(+a.dataset.i)); return; }
    switch (a.dataset.r) {
      case 'close': close(); break;
      case 'prev': goTo(R.page - 1); break;
      case 'next': goTo(R.page + 1); break;
      case 'zin': setZoom(1.15); break;
      case 'zout': setZoom(1 / 1.15); break;
      case 'fit': R.fit = true; try { localStorage.setItem('tl-zoom', JSON.stringify({ fit: true })); } catch {} rebuild(R.page); break;
      case 'hitoff': clearHits(); break;
      case 'hitprev': stepAny(-1); break;
      case 'hitnext': stepAny(1); break;
      case 'toc': { const box = $('#r-toc'); box.hidden = !box.hidden; if (!box.hidden) renderToc(); break; }
      case 'tab-toc': R.tab = 'toc'; renderToc(); break;
      case 'tab-find': R.tab = 'find'; renderToc(); break;
      case 'fd-go': { e.preventDefault(); if (R.find) { R.find.cur = +a.dataset.ri; markFindCur(false); } focusHit(+a.dataset.p, +a.dataset.k || 0); break; }
      case 'fd-more': if (R.find) { R.find.limit += 600; renderFind(); } break;
      case 'fd-stop': if (R.find) { R.find.token = Symbol(); R.find = { ...R.find, done: true, msg: '검색을 중단했습니다.' }; renderFind(); } break;
      case 'mk-add': addHere(); break;
      case 'mk-paste': pasteModal(); break;
      case 'mk-go': { e.preventDefault(); const m = R.marks.find((x) => x.id === a.closest('.mk').dataset.mid); if (m) goTo(m.page); break; }
      case 'mk-edit': { R.mkEdit = a.closest('.mk').dataset.mid; renderToc(); break; }
      case 'mk-lv': { const m = R.marks.find((x) => x.id === a.closest('.mk').dataset.mid); if (m) { m.level = (m.level + 1) % 3; saveMarks(); renderToc(); } break; }
      case 'mk-del': { R.marks = R.marks.filter((x) => x.id !== a.closest('.mk').dataset.mid); mkCount(); saveMarks(); renderToc(); break; }
      case 'mk-clear': { if (R.marks.length && confirm(`내 책갈피 ${R.marks.length}개를 모두 지울까요?`)) { R.marks = []; mkCount(); saveMarks(); renderToc(); } break; }
      case 'ext': { const D = TL().D; if (D) D.openPdf(R.file.path); break; }
    }
  });
  const inp = $('#r-page', el);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { goTo(+inp.value); sc.focus(); } e.stopPropagation(); });
  inp.addEventListener('blur', () => { if (R) inp.value = R.page; });
  const pp = $('#r-pp', el);
  pp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const p0 = pdfOfPrinted(R.pnum, +pp.value); if (p0 == null) { TL().toast ? TL().toast('이 번호의 인쇄 쪽을 찾지 못했어요.', true) : (pp.value = ''); } else { goTo(p0 + 1); pp.value = ''; sc.focus(); } }
    e.stopPropagation();
  });
  const fq = $('#r-q', el);
  fq.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); const v = fq.value.replace(/\s+/g, '').toLowerCase(); if (R.find && R.find.q && R.find.q === v && v) { stepAny(e.shiftKey ? -1 : 1); } else runFind(fq.value); }
    else if (e.key === 'Escape') { e.preventDefault(); fq.blur(); }
  });
  const tocBox = $('#r-toc', el);
  tocBox.addEventListener('keydown', (e) => { if (e.target.classList && e.target.classList.contains('mk-in')) { if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishEdit(false); } e.stopPropagation(); } });
  tocBox.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('mk-in') && R && R.mkEdit) setTimeout(() => { if (R && R.mkEdit && !$('.mk-in:focus', tocBox)) finishEdit(true); }, 120); });
  const sel = $('#r-file', el);
  if (sel) sel.addEventListener('change', async () => { const id = sel.value; await close(true); open({ fileId: id }); });
  let rz = 0; window.addEventListener('resize', () => { if (R && R.fit) { clearTimeout(rz); rz = setTimeout(() => R && R.fit && rebuild(R.page), 250); } });
  sc.addEventListener('wheel', (e) => { if (e.ctrlKey && R) { e.preventDefault(); clearTimeout(R.wz); R.wz = setTimeout(() => setZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1), 60); } }, { passive: false });
}
document.addEventListener('keydown', (e) => {
  if (!R) return;
  const typing = /input|textarea|select/i.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F') && !document.getElementById('modal')) { e.preventDefault(); const q = $('#r-q'); if (q) { q.focus(); q.select(); } return; }
  if (e.key === 'Escape' && e.target && e.target.matches && e.target.matches('.mk-in,#r-q,#mk-text')) return;
  if (e.key === 'Escape' && !document.getElementById('modal')) { const d = document.getElementById('mk-modal'); e.preventDefault(); if (d) d.remove(); else close(); return; }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); addHere(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); goTo(R.page + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(R.page - 1); }
  else if (e.key === 'Home') { e.preventDefault(); goTo(1); }
  else if (e.key === 'End') { e.preventDefault(); goTo(R.N); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(1.15); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(1 / 1.15); }
}, true);
window.addEventListener('beforeunload', () => { if (R && R.N) flush(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden && R && R.N) flush(false); });

async function close(silent) {
  if (!R) return;
  { const d = document.getElementById('mk-modal'); if (d) d.remove(); }
  const r = R; if (r.N) await flush(false);
  r.closed = true; clearTimeout(r.saveTimer); r.token = Symbol(); r.find = null;
  try { r.io && r.io.disconnect(); } catch {}
  for (const n of [...r.rendered.keys()]) { const rec = r.rendered.get(n); rec.cancelled = true; try { rec.task && rec.task.cancel(); } catch {} }
  try { r.task && r.task.destroy(); } catch {}
  try { const h = window.CSS && CSS.highlights && CSS.highlights.get('tl-hit'); if (h) h.clear(); if (window.CSS && CSS.highlights) CSS.highlights.delete('tl-hit-cur'); } catch {}
  r.el.remove(); R = null;
  if (!silent) TL().afterReader();
}

window.TLReader = { open, close: (s) => (window.TLMd && window.TLMd.isOpen() ? window.TLMd.close(s) : window.TLEpub && window.TLEpub.isOpen() ? window.TLEpub.close(s) : close(s)), measure, pageText, isbnTexts, isOpen: () => !!R || !!(window.TLEpub && window.TLEpub.isOpen()) || !!(window.TLMd && window.TLMd.isOpen()), __state: () => R };
})();
