// 본문 검색 화면: 서재 전체(또는 선택한 범위)의 PDF 본문에서 낱말·문구·성경 구절을 찾아 책별로 묶어 보여 준다.
// 색인은 '한국어OCR' 앱이 PDF 폴더 안(_서재색인)에 만든 것을 읽기 전용으로 쓴다. 문장은 찾는 대로 원본 PDF에서 읽어 온다.
(() => {
'use strict';
const TL = () => window.TL;
const esc = (s) => TL().esc(s);
const num = (n) => Number(n || 0).toLocaleString('ko-KR');
const $ = (s, el = document) => el.querySelector(s);

const EXAMPLES = ['합력하여', '"하나님의 주권"', '칭의 OR 의인', '은혜 -값싼', '롬 8:28', '요 3:16', '창 1', '시 23편'];
const ST = { q: '', scope: null, res: null, loading: false, err: '', status: null, sort: 'hits', facet: '', open: new Set(), shown: 30, more: {}, token: 0, snip: new Map() };
let root = null, observer = null; const queue = []; let running = 0;

async function loadStatus() {
  try { ST.status = await TL().api('/api/search/status'); } catch { ST.status = { available: false, error: '색인 상태를 읽지 못했습니다.' }; }
  render();
}

async function run({ q, scope }) {
  q = String(q || '').trim();
  ST.q = q; ST.scope = scope || ST.scope; ST.open = new Set(); ST.shown = 30; ST.more = {}; ST.facet = '';
  if (!q) { ST.res = null; ST.err = ''; ST.loading = false; render(); return; }
  const token = ++ST.token; ST.loading = true; ST.err = ''; render();
  try {
    const r = await TL().api('/api/search', 'POST', { q, workIds: ST.scope && ST.scope.ids ? ST.scope.ids : undefined });
    if (token !== ST.token) return;
    ST.loading = false;
    if (r.error) { ST.err = r.error; ST.res = null; if (r.unavailable) ST.status = { available: false, error: r.error }; }
    else { ST.res = r; if (r.works.length === 1) ST.open.add(r.works[0].workId); }
  } catch (e) { if (token !== ST.token) return; ST.loading = false; ST.err = e.message || '검색에 실패했습니다.'; ST.res = null; }
  render();
  const c = $('.tsr-top'); if (c && c.scrollIntoView) { const sc = root && root.closest('.content'); if (sc) sc.scrollTop = 0; }
}

function mount(el) {
  if (el.firstElementChild && el.firstElementChild.id === 'tsr') { root = el.firstElementChild; return; }
  el.innerHTML = '<div id="tsr" class="tsr"></div>'; root = el.firstElementChild;
  root.addEventListener('click', onClick);
  render();
  if (!ST.status) loadStatus();
}
function unmount() { if (observer) { observer.disconnect(); observer = null; } queue.length = 0; root = null; }

// ───────── 화면 ─────────
function pageLabel(f, p) {
  const seg = (f.pnum || []).find(([a, b]) => p >= a && p <= b);
  return seg ? `${p + seg[2]}쪽 <em>(PDF ${p + 1})</em>` : `PDF ${p + 1}쪽`;
}
function helpHtml() {
  const s = ST.status;
  let info = '';
  if (s && s.available) {
    const ok = (s.by['글자층'] || {}).books || 0;
    info = `<p class="tsr-info">본문 색인 <b>${num(s.mapped)}</b> / ${num(s.files)}권이 연결되어 있어요. 이 가운데 글자를 읽을 수 있는 책은 ${num(ok)}권이고, <a data-act="tsr-notext">스캔본·글자 깨짐 ${num((s.noText || []).length)}권</a>은 본문 검색이 안 돼요.</p>`;
  } else if (s && !s.available) info = `<p class="tsr-warn">${esc(s.error === 'index-not-found' ? '아직 본문 색인이 없습니다. 설정의 ‘본문 색인 만들기’에서 만들거나, PDF 폴더 안에 _서재색인 폴더(한국어OCR 앱이 만든 색인)를 두세요.' : s.error || '색인을 열 수 없습니다.')}</p>`;
  else info = '<p class="tsr-info">색인을 확인하는 중…</p>';
  return `<div class="tsr-help"><h2>서재 본문 검색</h2>
    <p>위 검색창에 낱말이나 성경 구절을 적고 Enter를 누르세요. 범위는 오른쪽 위에서 고를 수 있어요(전체 서재 · 지금 보는 분류·성경 책·읽기 목록 · 열어 둔 책).</p>
    <div class="tsr-ex">${EXAMPLES.map((x) => `<button data-act="tsr-ex" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <ul class="tsr-syn">
      <li><b>낱말</b> 공백으로 이으면 <i>같은 쪽에 모두</i> 있는 곳 · <code>은혜 믿음</code></li>
      <li><b>문구</b> 따옴표로 묶으면 한 덩어리 · <code>"하나님의 주권"</code></li>
      <li><b>또는</b> <code>칭의 OR 의인</code> · <code>칭의|의인</code></li>
      <li><b>제외</b> <code>-낱말</code> 또는 <code>NOT 낱말</code> · <code>은혜 -값싼</code></li>
      <li><b>성경 구절</b> <code>롬 8:28</code> · <code>로마서 8장 28절</code> · <code>롬 8</code> · <code>Rom 8:28-30</code> — 그 절을 포함하는 범위(롬 8:28-30)와 장 전체(로마서 8장)를 다룬 곳까지 함께 찾아요.</li>
      <li>띄어쓰기는 상관없어요. 조사가 붙은 말(은혜를·은혜의)도 찾아요. 낱말은 두 글자 이상.</li>
    </ul>${info}</div>`;
}

function filteredWorks() {
  const r = ST.res; if (!r) return [];
  let ws = r.works;
  if (ST.facet) ws = ws.filter((w) => (ST.facet === '__none' ? !w.category : w.category === ST.facet));
  const by = { hits: (a, b) => b.pages - a.pages, title: (a, b) => a.title.localeCompare(b.title, 'ko'), author: (a, b) => (a.author ? 0 : 1) - (b.author ? 0 : 1) || a.author.localeCompare(b.author, 'ko') || a.title.localeCompare(b.title, 'ko') }[ST.sort];
  return [...ws].sort(by);
}

function groupHtml(w) {
  const open = ST.open.has(w.workId);
  let body = '';
  if (open) {
    body = '<div class="tg-body">' + w.files.map((f) => {
      const k = f.fileId, lim = 12 + (ST.more[k] || 0), shown = f.pages.slice(0, lim);
      const rest = f.count - shown.length;
      return `<div class="tg-file">${w.files.length > 1 ? `<div class="tg-fn">${esc(f.name)} · ${num(f.count)}쪽</div>` : ''}${f.status !== '글자층' ? '<div class="tg-bad">이 파일은 글자 층이 없거나 깨져 있어서 결과가 정확하지 않을 수 있어요.</div>' : ''}
        ${shown.map((p) => `<div class="th" data-act="tsr-open" data-f="${esc(k)}" data-p="${p}" data-w="${esc(w.workId)}"><span class="th-p">${pageLabel(f, p)}${f.raws[p] ? `<span class="th-raw">${esc(f.raws[p])}</span>` : ''}</span><span class="th-s" data-k="${esc(k)}:${p}"></span></div>`).join('')}
        ${rest > 0 ? `<button class="btn sm th-more" data-act="tsr-more" data-f="${esc(k)}">더 보기 (${num(rest)}쪽)</button>` : ''}</div>`;
    }).join('') + '</div>';
  }
  return `<section class="tg ${open ? 'open' : ''}" data-w="${esc(w.workId)}">
    <header data-act="tsr-tog" data-w="${esc(w.workId)}"><span class="tg-ar">${open ? '▾' : '▸'}</span>
      <div class="tg-t"><b>${esc(w.title)}</b><small>${esc([w.author, w.category].filter(Boolean).join(' · '))}</small></div>
      <span class="tg-n">${num(w.pages)}쪽</span><button class="btn sm tg-go" data-act="tsr-book" data-w="${esc(w.workId)}" title="이 책 정보 열기">책</button></header>${body}</section>`;
}

function render() {
  if (!root) return;
  const r = ST.res, s = ST.status;
  let h = '<div class="tsr-top"></div>';
  if (ST.loading) h += `<div class="tsr-msg">‘${esc(ST.q)}’ 찾는 중…</div>`;
  else if (ST.err) h += `<div class="tsr-msg warn">${esc(ST.err)}</div>` + helpHtml();
  else if (!r) h += helpHtml();
  else {
    const ws = filteredWorks();
    const cats = new Map(); for (const w of r.works) { const c = w.category || '__none'; cats.set(c, (cats.get(c) || 0) + 1); }
    const facets = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    h += `<div class="tsr-head"><div class="tsr-q"><h2>${esc(r.what)}</h2>${r.kind === 'ref' ? '<span class="tsr-badge">성경 구절</span>' : ''}</div>
      <div class="tsr-sum"><b>${num(r.works.length)}</b>권 · <b>${num(r.pages)}</b>쪽${r.scopeBooks ? ` <small>(검색한 책 ${num(r.scopeBooks)}권 중)</small>` : ''}${ST.scope ? ` · 범위: ${esc(ST.scope.label)}` : ''}</div>
      ${r.kind === 'ref' ? '<div class="tsr-note">그 절을 포함하는 범위(예: 롬 8:28-30)와 장 전체를 다룬 곳까지 함께 보여요.</div>' : '<div class="tsr-note">같은 말이 쪽 안에 실제로 있는지는 펼칠 때 원본에서 확인해 문장을 보여 드려요.</div>'}
      ${r.partial ? '<div class="tsr-note warn">결과가 너무 많아 일부만 보여요. 낱말을 더 붙이거나 범위를 좁혀 보세요.</div>' : ''}
    </div>
    <div class="tsr-tools"><label>정렬 <select id="tsr-sort"><option value="hits" ${ST.sort === 'hits' ? 'selected' : ''}>많이 나온 책순</option><option value="title" ${ST.sort === 'title' ? 'selected' : ''}>제목순</option><option value="author" ${ST.sort === 'author' ? 'selected' : ''}>저자순</option></select></label>
      <div class="tsr-facets"><button class="${ST.facet ? '' : 'on'}" data-act="tsr-facet" data-v="">전체 ${num(r.works.length)}</button>${facets.map(([c, n]) => `<button class="${ST.facet === c ? 'on' : ''}" data-act="tsr-facet" data-v="${esc(c)}">${esc(c === '__none' ? '분류 없음' : c)} ${num(n)}</button>`).join('')}</div>
      <span class="tsr-sp"></span><button class="btn sm" data-act="tsr-all">${ST.open.size ? '모두 접기' : '위 10권 펼치기'}</button></div>`;
    if (!ws.length) h += '<div class="tsr-msg">찾은 곳이 없어요. 낱말 철자와 범위를 확인해 보세요.</div>';
    else h += ws.slice(0, ST.shown).map(groupHtml).join('') + (ws.length > ST.shown ? `<button class="btn more" data-act="tsr-moreg">더 보기 (${num(ws.length - ST.shown)}권 남음)</button>` : '');
    if (s && s.available && (s.noText || []).length) h += `<p class="tsr-foot">스캔본·글자 깨짐 ${num(s.noText.length)}권은 본문 검색 결과에 나오지 않아요. <a data-act="tsr-notext">목록 보기</a></p>`;
  }
  root.innerHTML = h;
  const sel = $('#tsr-sort', root); if (sel) sel.onchange = () => { ST.sort = sel.value; render(); };
  watchSnippets();
}

// ───────── 문장 (원본 PDF에서 읽기) ─────────
function pnumOf(fileId) { const r = ST.res; if (r) for (const w of r.works) for (const f of w.files) if (f.fileId === fileId) return f.pnum || []; return []; }
function highlightTerms(fileId, p) {
  const r = ST.res; if (!r) return [];
  if (r.kind === 'ref') { for (const w of r.works) for (const f of w.files) if (f.fileId === fileId && f.raws[p]) return [f.raws[p]]; return []; }
  return r.terms || [];
}
const reEsc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function makeSnippet(text, terms) {
  const flat = []; let f = '';
  for (let i = 0; i < text.length; i++) { if (/\s/.test(text[i])) continue; f += text[i].toLowerCase(); flat.push(i); }
  const ts = terms.map((t) => String(t).replace(/\s+/g, '').toLowerCase()).filter(Boolean);
  let best = -1, len = 0;
  for (const t of ts) { const i = f.indexOf(t); if (i >= 0 && (best < 0 || i < best)) { best = i; len = t.length; } }
  const one = (x) => x.replace(/\s+/g, ' ');
  const pos = f.length ? best / f.length : 0;
  if (best < 0) return { found: false, pos: 0, html: `<span class="dim">${esc(one(text).slice(0, 100))}…</span>` };
  const a = Math.max(0, flat[best] - 46), b = Math.min(text.length, flat[best + len - 1] + 1 + 70);
  const win = one(text.slice(a, b));
  const re = new RegExp(ts.map((t) => [...t].map(reEsc).join('\\s*')).join('|'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(win))) { if (!m[0]) { re.lastIndex++; continue; } out += esc(win.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; }
  out += esc(win.slice(last));
  return { found: true, pos, html: (a > 0 ? '…' : '') + out + (b < text.length ? '…' : '') };
}
async function loadSnippet(el) {
  const k = el.dataset.k; if (!k || el.dataset.state) return;
  el.dataset.state = 'q';
  const i = k.lastIndexOf(':'), fileId = k.slice(0, i), p = +k.slice(i + 1);
  const key = `${k}|${ST.token}`;
  try {
    let sn = ST.snip.get(key);
    if (!sn) {
      const text = await window.TLReader.pageText(fileId, p + 1, true);
      sn = makeSnippet(text, highlightTerms(fileId, p)); ST.snip.set(key, sn);
      if (ST.snip.size > 800) ST.snip.delete(ST.snip.keys().next().value);
    }
    if (el.isConnected) { el.innerHTML = posHtml(sn) + sn.html; el.dataset.state = 'done'; if (!sn.found) el.parentElement.classList.add('weak'); }
  } catch { if (el.isConnected) { el.innerHTML = '<span class="dim">(문장을 읽지 못했어요 — 눌러서 열어 보세요)</span>'; el.dataset.state = 'err'; } }
}
const posHtml = (sn) => sn.found ? `<span class="th-pos" title="쪽 안에서 찾은 곳(대략)"><i style="top:${Math.min(92, Math.round(sn.pos * 100))}%"></i></span>` : '';
function pump() {
  while (running < 3 && queue.length) {
    const el = queue.shift(); if (!el.isConnected) continue;
    running++; loadSnippet(el).finally(() => { running--; pump(); });
  }
}
function watchSnippets() {
  if (observer) observer.disconnect();
  queue.length = 0;
  if (!root || !window.TLReader) return;
  observer = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { observer.unobserve(e.target); if (!e.target.dataset.state) { queue.push(e.target); } } pump(); }, { root: root.closest('.content'), rootMargin: '200px' });
  root.querySelectorAll('.th-s').forEach((el) => { const c = ST.snip.get(`${el.dataset.k}|${ST.token}`); if (c) { el.innerHTML = posHtml(c) + c.html; el.dataset.state = 'done'; if (!c.found) el.parentElement.classList.add('weak'); } else observer.observe(el); });
}

// ───────── 누르기 ─────────
function onClick(e) {
  const a = e.target.closest('[data-act]'); if (!a || !root.contains(a)) return;
  const act = a.dataset.act;
  if (act === 'tsr-ex') { window.TLSearchHost.setQuery(a.dataset.q); return; }
  if (act === 'tsr-tog') { if (e.target.closest('.tg-go')) return; const id = a.dataset.w; ST.open.has(id) ? ST.open.delete(id) : ST.open.add(id); render(); return; }
  if (act === 'tsr-book') { e.stopPropagation(); window.TLSearchHost.showBook(a.dataset.w); return; }
  if (act === 'tsr-more') { ST.more[a.dataset.f] = (ST.more[a.dataset.f] || 0) + 30; render(); return; }
  if (act === 'tsr-moreg') { ST.shown += 30; render(); return; }
  if (act === 'tsr-facet') { ST.facet = a.dataset.v; ST.shown = 30; render(); return; }
  if (act === 'tsr-all') { if (ST.open.size) ST.open.clear(); else filteredWorks().slice(0, 10).forEach((w) => ST.open.add(w.workId)); render(); return; }
  if (act === 'tsr-notext') { window.TLSearchHost.showNoText(); return; }
  if (act === 'tsr-open') {
    const fileId = a.dataset.f, p = +a.dataset.p;
    if (window.TLReader) window.TLReader.open({ fileId, page: p + 1, terms: highlightTerms(fileId, p), best: true, pnum: pnumOf(fileId) });
  }
}

window.TLSearch = { mount, unmount, run, loadStatus, state: ST, makeSnippet };
})();
