(() => {
'use strict';
const D = window.theologiaDesktop; // Electron 연동 (브라우저에서 열면 없음)
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { unread: '읽을 예정', reading: '읽는 중', finished: '완독' };
const TONES = ['olive', 'rust', 'navy', 'plum', 'sand', 'char', 'blue', 'teal'];

const S = {
  lib: { folders: [], works: [], files: [] }, ref: { bibleBooks: [], categories: [] }, settings: {},
  sideOff: (() => { try { return localStorage.getItem('tl.sideOff') === '1'; } catch (e) { return false; } })(),
  nav: 'all', category: '', bible: '', bibleOpen: {}, q: '', sort: 'read', mode: 'meta', tq: '', tscope: 'filter', tRan: false, noText: null, view: (() => { try { return localStorage.getItem('tl.view') || 'card'; } catch (e) { return 'card'; } })(), open: null, checked: new Set(), limit: 120,
  busy: '', refreshing: false, saveState: '',
};
let filesBy = new Map(); // workId -> files[]

// ---------- 유틸 ----------
async function api(path, method = 'GET', body, keepalive) {
  const r = await fetch(path, { method, keepalive: !!keepalive, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && j.error) || `요청 실패 (${r.status})`);
  return j;
}
function toast(msg, err) {
  let box = $('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3800);
}
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const fmtSize = (n) => n == null ? '' : n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const pct = (w) => w.totalPages > 0 ? Math.min(100, Math.round((w.currentPage / w.totalPages) * 100)) : (w.status === 'finished' ? 100 : 0);
const num = (n) => Number(n).toLocaleString('ko-KR');

function reindex() {
  filesBy = new Map();
  for (const f of S.lib.files) { if (!filesBy.has(f.workId)) filesBy.set(f.workId, []); filesBy.get(f.workId).push(f); }
  for (const arr of filesBy.values()) arr.sort((a, b) => (a.partNumber ?? 1e9) - (b.partNumber ?? 1e9) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  if (S.open && !S.lib.works.some((w) => w.id === S.open)) S.open = null;
  for (const id of [...S.checked]) if (!S.lib.works.some((w) => w.id === id)) S.checked.delete(id);
}
const work = (id) => S.lib.works.find((w) => w.id === id);
const filesOf = (w) => filesBy.get(w.id) || [];
const hasMissing = (w) => filesOf(w).some((f) => f.missing);
const needsCheck = (w) => w.review || hasMissing(w);

function setLib(lib) { S.lib = lib; reindex(); }

// ---------- 필터/정렬 ----------
function visibleWorks(noQ) {
  const toks = noQ ? [] : S.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = S.lib.works.filter((w) => {
    if (S.nav === 'reading' && w.status !== 'reading') return false;
    if (S.nav === 'unread' && w.status !== 'unread') return false;
    if (S.nav === 'finished' && w.status !== 'finished') return false;
    if (S.nav === 'review' && !needsCheck(w)) return false;
    if (S.nav === 'readlist' && !w.inList) return false;
    if (S.nav === 'notext' && !(S.noText && S.noText.has(w.id))) return false;
    if (S.nav === 'unmatched' && (w.isbn || w.fillState === 'done')) return false;
    if (S.nav === 'lowclass' && !(w.classSource === 'auto' && w.classConf === 'low')) return false;
    if (S.category === '__none' ? w.category : S.category && w.category !== S.category) return false;
    if (S.bible && !w.bibleBooks.includes(S.bible)) return false;
    if (toks.length) {
      const hay = [w.title, w.author, w.publisher, w.isbn, w.year, w.category, w.note, w.tags.join(' '), w.bibleBooks.join(' '), filesOf(w).map((f) => f.name).join(' ')].join(' ').toLowerCase();
      if (!toks.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const ko = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });
  const idn = (w) => parseInt(w.id.slice(1), 10) || 0;
  if (S.sort === 'read') list.sort((a, b) => String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')) || idn(b) - idn(a));
  else if (S.sort === 'recent') list.sort((a, b) => idn(b) - idn(a));
  else if (S.sort === 'title') list.sort((a, b) => ko(a.title, b.title));
  else if (S.sort === 'author') list.sort((a, b) => (a.author ? 0 : 1) - (b.author ? 0 : 1) || ko(a.author, b.author) || ko(a.title, b.title));
  else if (S.sort === 'progress') list.sort((a, b) => pct(b) - pct(a) || ko(a.title, b.title));
  return list;
}

// ---------- 렌더 ----------
// 왼쪽 사이드바 접기: 상태는 이 기기에 기억한다
function setSide(off) {
  S.sideOff = !!off; document.body.classList.toggle('side-off', S.sideOff);
  try { localStorage.setItem('tl.sideOff', S.sideOff ? '1' : '0'); } catch (e) {}
}
function renderShell() {
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark">T</div><div><b>Theologia Library</b><small>개인 신학 서재 <span class="ver" title="앱 버전">ver${esc((S.settings && S.settings.version) || '')}</span></small></div></div>
      <div class="side-scroll" id="side"></div>
      <div class="side-foot">
        <button class="btn primary" data-act="add-folder">＋ 폴더 연결</button>
        <button class="btn" data-act="settings">설정</button>
      </div>
    </aside>
    <section class="main">
      <div class="bar">
        <button class="icon-btn side-tg" data-act="side-toggle" title="사이드바 접기·펴기 (Ctrl+B)" aria-label="사이드바 접기·펴기">☰</button>
        <div class="seg modeseg" title="무엇을 찾을까요"><button data-act="mode" data-v="meta" class="on">제목·저자</button><button data-act="mode" data-v="text">본문</button></div>
        <div class="search"><input id="q" type="search" placeholder="전체 검색: 제목·저자·출판사·성경 책·태그   ( / )" autocomplete="off" /></div>
        <select id="scope" title="본문을 찾을 범위"></select>
        <select id="sort" title="정렬">
          <option value="read">최근 읽은순</option><option value="recent">최근 추가순</option><option value="title">제목순</option><option value="author">저자순</option><option value="progress">진행률순</option>
        </select>
        <div class="seg viewseg" title="보기 방식"><button data-act="view" data-v="card" class="${S.view === 'card' ? 'on' : ''}">카드</button><button data-act="view" data-v="list" class="${S.view === 'list' ? 'on' : ''}">목록</button></div>
        <span class="count" id="count"></span>
      </div>
      <div id="selbar" class="selbar" hidden></div>
      <div class="content" id="content"></div>
    </section>
    <aside class="drawer" id="drawer" hidden></aside>
  </div>`;
  $('#q').addEventListener('input', (e) => { if (S.mode === 'text') { S.tq = e.target.value; return; } S.q = e.target.value; S.limit = 120; renderList(); });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && S.mode === 'text') { e.preventDefault(); runText(true); } });
  $('#scope').addEventListener('change', (e) => { S.tscope = e.target.value; if (S.tq) runText(true); });
  $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; renderList(); });
  setSide(S.sideOff);
}

// 구약·신약 묶음: 직접 펼치거나 접은 값이 우선, 정하지 않았으면 선택한 책이 있는 쪽만 펼친다
function isBibleOpen(t) {
  if (S.bibleOpen[t] !== undefined) return S.bibleOpen[t];
  return !!(S.bible && (S.ref.bibleBooks || []).some((b) => b.testament === t && b.name === S.bible));
}
function renderSide() {
  const w = S.lib.works;
  const cnt = { all: w.length, readlist: 0, reading: 0, unread: 0, finished: 0, review: 0 };
  const cats = new Map(); let none = 0, low = 0; const bcount = new Map();
  for (const x of w) {
    cnt[x.status]++; if (x.inList) cnt.readlist++; if (needsCheck(x)) cnt.review++;
    if (x.category) cats.set(x.category, (cats.get(x.category) || 0) + 1); else none++;
    if (x.classSource === 'auto' && x.classConf === 'low') low++;
    for (const b of x.bibleBooks || []) bcount.set(b, (bcount.get(b) || 0) + 1);
  }
  const nav = (id, label, n, warn) => `<button class="nav ${S.nav === id && !S.category ? 'on' : ''} ${warn && n ? 'warn' : ''}" data-act="nav" data-v="${id}"><span>${label}</span><span class="n">${num(n)}</span></button>`;
  const GEN = new Set(['영어', '개발·IT', '수험서', '소설', '시·에세이', '동양 고전', '서양 고전·철학', '역사', '만화·학습만화', '과학·교양', '인문·사회', '자기계발']);
  const catBtn = ([c, n]) => `<button class="nav ${S.category === c ? 'on' : ''}" data-act="cat" data-v="${esc(c)}"><span>${esc(c)}</span><span class="n">${num(n)}</span></button>`;
  const catSorted = [...cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  const catGen = catSorted.filter(([c]) => GEN.has(c)), catTheo = catSorted.filter(([c]) => !GEN.has(c));
  const catRows = catGen.length && catTheo.length
    ? `<div class="catgrp">신학</div>${catTheo.map(catBtn).join('')}<div class="catgrp">일반</div>${catGen.map(catBtn).join('')}`
    : catSorted.map(catBtn).join('');
  const folders = S.lib.folders.map((f) => `
    <div class="folder ${f.missing ? 'gone' : ''}" title="${esc(f.path)}">
      <div class="nm">${esc(base(f.path))}<small>${f.missing ? '폴더를 찾을 수 없음' : num(f.fileCount || 0) + '개 PDF'}</small></div>
      <button class="icon-btn" data-act="rescan" data-v="${esc(f.path)}" title="다시 스캔">↻</button>
      <button class="icon-btn" data-act="rm-folder" data-v="${esc(f.path)}" title="서재에서 폴더 빼기 (파일은 그대로)">✕</button>
    </div>`).join('');
  const bookRows = (t) => (S.ref.bibleBooks || []).filter((b) => b.testament === t).map((b) => { const n = bcount.get(b.name) || 0; return `<button class="nav sub ${S.bible === b.name ? 'on' : ''} ${n ? '' : 'zero'}" data-act="bbook" data-v="${esc(b.name)}"><span>${esc(b.name)}</span><span class="n">${num(n)}</span></button>`; }).join('');
  const bTotal = (t) => (S.ref.bibleBooks || []).filter((b) => b.testament === t).reduce((s, b) => s + (bcount.get(b.name) || 0), 0);
  const bHead = (t, label) => { const open = isBibleOpen(t); return `<button class="nav grp" data-act="btoggle" data-v="${t}"><span>${open ? '▾' : '▸'} ${label}</span><span class="n">${num((S.ref.bibleBooks || []).filter((b) => b.testament === t).length)}권</span></button>${open ? bookRows(t) : ''}`; };
  $('#side').innerHTML = `
    ${S.refreshing ? '<div class="busy"><i class="dot"></i>폴더 갱신 중…</div>' : ''}
    <h6>서재</h6>
    ${nav('all', '전체 문헌', cnt.all)}${nav('readlist', '★ 읽기 목록', cnt.readlist)}${nav('reading', '읽는 중', cnt.reading)}${nav('unread', '읽을 예정', cnt.unread)}${nav('finished', '완독', cnt.finished)}${nav('review', '확인 필요', cnt.review, true)}
    ${S.settings && S.settings.notesDir ? '<h6>노트</h6><button class="nav" data-act="note-search"><span>✎ 노트 검색</span></button>' : ''}
    <h6>성경 66권</h6>
    ${bHead('old', '구약 39권')}${bHead('new', '신약 27권')}
    ${S.noText && S.noText.size ? `<h6>본문 검색</h6>${nav('notext', '본문 없음 (스캔본)', S.noText.size)}` : ''}
    ${low ? `<h6>자동 분류</h6>${nav('lowclass', '분류 확인 필요', low, true)}` : ''}
    ${cats.size || none ? '<h6>분류</h6>' + catRows + (none ? `<button class="nav ${S.category === '__none' ? 'on' : ''}" data-act="cat" data-v="__none"><span>미분류</span><span class="n">${num(none)}</span></button>` : '') : ''}
    ${S.settings.kakao || fillStats().ok ? `<h6>서점 정보</h6><div style="padding:2px 10px 6px">${fillStatsHtml()}</div>${fillJobHtml()}${nav('unmatched', '서점 정보 없음', fillStats().miss + fillStats().wait)}` : ''}
    <h6>연결된 폴더</h6>
    ${folders || '<div style="padding:4px 10px;color:var(--faint);font-size:12.5px">아직 연결된 폴더가 없습니다.</div>'}`;
}

// 사이드바에서 고른 성경 책이 (자료 삭제 등으로) 더는 없으면 선택을 푼다.
function renderBibleSelect() {
  if (!S.bible) return;
  if (!S.lib.works.some((w) => w.bibleBooks.includes(S.bible))) S.bible = '';
}

function card(w) {
  const files = filesOf(w), p = pct(w), tone = TONES[hash(w.id) % TONES.length];
  const img = w.coverUrl && /^(https?:|\/api\/epub\/)/i.test(w.coverUrl);
  const chips = [`<span class="chip">PDF ${files.length}</span>`];
  if (w.status !== 'unread') chips.push(`<span class="chip ${w.status}">${STATUS[w.status]}</span>`);
  if (w.lastReadAt && w.status !== 'finished') { const rf = resumeFile(w); if (rf) chips.push(`<span class="chip reading">p.${rf.lastPage} 까지</span>`); }
  if (w.review) chips.push('<span class="chip warn">그룹 확인</span>');
  if (hasMissing(w)) chips.push('<span class="chip warn">파일 없음</span>');
  return `<div class="card ${S.open === w.id ? 'on' : ''}" data-act="open" data-v="${w.id}">
    <input class="chk" type="checkbox" data-act="check" data-v="${w.id}" ${S.checked.has(w.id) ? 'checked' : ''} aria-label="선택" />
    <button class="star ${w.inList ? 'on' : ''}" data-act="toggle-list" data-v="${w.id}" title="${w.inList ? '읽기 목록에서 빼기' : '읽기 목록에 넣기'}">${w.inList ? '★' : '☆'}</button>
    <div class="cover t-${tone} ${img ? 'img' : ''}" ${img ? `style="background-image:url('${esc(w.coverUrl)}')"` : ''}><span>${esc(w.title)}</span><i>${w.category ? esc(w.category.slice(0, 8)) : 'PDF'}</i></div>
    <div class="info"><h3>${esc(w.title)}</h3><div class="au">${esc(w.author || '저자 미상')}</div>
      ${locBtn(w)}
      <div class="chips">${chips.join('')}</div>
      ${w.totalPages > 0 ? `<div class="prog"><i style="width:${p}%"></i></div>` : ''}
      <div class="c-rd">${readBtn(w, 'rd')}</div></div>
  </div>`;
}

function row(w) {
  const files = filesOf(w), p = pct(w);
  return `<tr class="${S.open === w.id ? 'on' : ''}" data-act="open" data-v="${w.id}">
    <td class="c-chk"><input type="checkbox" data-act="check" data-v="${w.id}" ${S.checked.has(w.id) ? 'checked' : ''} aria-label="선택" /></td>
    <td class="c-star"><button class="star ${w.inList ? 'on' : ''}" data-act="toggle-list" data-v="${w.id}" title="${w.inList ? '읽기 목록에서 빼기' : '읽기 목록에 넣기'}">${w.inList ? '★' : '☆'}</button></td>
    <td class="c-title"><b>${esc(w.title)}</b>${hasMissing(w) ? ' <span class="chip warn">파일 없음</span>' : ''}${w.review ? ' <span class="chip warn">그룹 확인</span>' : ''}<div>${locBtn(w, 'sm')}</div></td>
    <td class="c-au">${esc(w.author || '')}</td><td class="c-cat">${esc(w.category || '')}</td>
    <td class="c-st"><span class="chip ${w.status}">${STATUS[w.status]}</span></td>
    <td class="c-pg">${w.totalPages > 0 ? `<div class="prog"><i style="width:${p}%"></i></div><small>${p}%</small>` : ''}</td>
    <td class="c-n">${files.length}</td><td class="c-rdt">${readBtn(w, 'rd')}</td></tr>`;
}

const NAVLABEL = { reading: '읽는 중', unread: '읽을 예정', finished: '완독', review: '확인 필요', readlist: '★ 읽기 목록', unmatched: '서점 정보 없음', lowclass: '분류 확인 필요', notext: '본문 없음(스캔본)' };
function scopeInfo() {
  const parts = [];
  if (S.nav !== 'all' && NAVLABEL[S.nav]) parts.push(NAVLABEL[S.nav]);
  if (S.category) parts.push(S.category === '__none' ? '분류 없음' : S.category);
  if (S.bible) parts.push(S.bible);
  if (S.tscope === 'open' && S.open && work(S.open)) return { ids: [S.open], label: '이 책: ' + work(S.open).title, key: 'open:' + S.open };
  if (S.tscope === 'filter' && parts.length) { const ids = visibleWorks(true).map((w) => w.id); return { ids, label: `${parts.join(' · ')} (${num(ids.length)}권)`, key: 'f:' + parts.join('|') + ':' + ids.length, parts }; }
  return { ids: null, label: '전체 서재', key: 'all' };
}
let lastScopeKey = '';
function runText(force) {
  const q = S.tq.trim(); if (!q || !window.TLSearch) return;
  const sc = scopeInfo(); lastScopeKey = sc.key; S.tRan = true;
  window.TLSearch.mount($('#content')); window.TLSearch.run({ q, scope: sc });
}
function renderScopeSelect() {
  const el = $('#scope'); if (!el) return;
  const parts = scopeInfo(); const filt = S.tscope === 'filter' ? parts : (() => { const x = []; if (S.nav !== 'all' && NAVLABEL[S.nav]) x.push(NAVLABEL[S.nav]); if (S.category) x.push(S.category === '__none' ? '분류 없음' : S.category); if (S.bible) x.push(S.bible); return { parts: x }; })();
  const fp = filt.parts || [];
  el.innerHTML = `<option value="filter">${fp.length ? '범위: ' + esc(fp.join(' · ')) : '범위: 전체 서재'}</option>${fp.length ? '<option value="all">범위: 전체 서재</option>' : ''}${S.open && work(S.open) ? `<option value="open">범위: 이 책 (${esc(work(S.open).title.slice(0, 18))})</option>` : ''}`;
  el.value = [...el.options].some((o) => o.value === S.tscope) ? S.tscope : 'filter'; if (el.value !== S.tscope) S.tscope = el.value;
}
function setMode(m) {
  S.mode = m; const q = $('#q');
  document.body.classList.toggle('tmode', m === 'text');
  q.value = m === 'text' ? S.tq : S.q;
  q.placeholder = m === 'text' ? '본문 검색 — 낱말 · "문구" · 롬 8:28 · A OR B · -제외   (Enter)' : '제목·저자·파일명·태그 검색   ( / )';
  document.querySelectorAll('.modeseg button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
  if (m === 'text' && window.TLSearch) window.TLSearch.loadStatus();
  renderList(); q.focus();
}
window.TLSearchHost = {
  setQuery(q) { if (S.mode !== 'text') setMode('text'); S.tq = q; $('#q').value = q; runText(true); },
  showBook(id) { S.open = id; renderAll(); },
  showNoText() { S.nav = 'notext'; S.category = ''; S.bible = ''; setMode('meta'); },
};
async function loadSearchStatus() {
  try { const s = await api('/api/search/status'); if (s && s.available) { S.noText = new Set(s.noText || []); renderSide(); } } catch {}
}

function renderList() {
  renderSide(); renderBibleSelect();
  if (S.mode === 'text' && window.TLSearch) {
    renderScopeSelect(); $('#selbar').hidden = true; $('#count').textContent = '';
    window.TLSearch.mount($('#content'));
    if (S.tRan && S.tq.trim() && scopeInfo().key !== lastScopeKey) runText();
    return;
  }
  if (window.TLSearch) window.TLSearch.unmount();
  const list = visibleWorks();
  $('#count').textContent = `${num(list.length)} / ${num(S.lib.works.length)}`;
  const sb = $('#selbar');
  if (S.checked.size) {
    sb.hidden = false;
    sb.innerHTML = `<b>${S.checked.size}개 선택</b>
      <button class="btn sm primary" data-act="merge" ${S.checked.size < 2 ? 'disabled' : ''}>하나의 작품으로 합치기</button>
      <button class="btn sm" data-act="bulk-list" data-v="1">★ 읽기 목록에 넣기</button>
      <button class="btn sm" data-act="bulk-list" data-v="0">읽기 목록에서 빼기</button>
      <span class="selsep"></span>
      <button class="btn sm" data-act="bulk-status" data-v="unread">읽을 예정으로</button>
      <button class="btn sm" data-act="bulk-status" data-v="reading">읽는 중으로</button>
      <button class="btn sm" data-act="bulk-status" data-v="finished">완독으로</button>
      <button class="btn sm" data-act="bulk-cat">분류 바꾸기…</button>
      <button class="btn sm" data-act="uncheck">선택 해제</button>
      <span style="color:var(--muted);font-size:12.5px">${S.checked.size < 2 ? '합치려면 2개 이상 선택하세요' : '같은 책의 분할 PDF를 하나로 묶습니다'}</span>`;
  } else sb.hidden = true;
  const c = $('#content');
  if (!S.lib.works.length) {
    c.innerHTML = `<div class="empty"><div class="big">서재를 시작해 볼까요?</div>
      <p>PDF가 들어 있는 폴더를 연결하면 하위 폴더까지 찾아서, 같은 책의 분할 파일을 하나의 작품으로 묶어 줍니다.<br>파일은 원래 위치에 그대로 두고, 경로와 정리 내용만 이 서재에 기록합니다.</p>
      <ol class="first-steps"><li><b>폴더 연결</b> — 책이 들어 있는 폴더를 고르면 PDF·EPUB를 찾아 작품으로 묶습니다.</li><li><b>자동 분류 확인</b> — 이름으로 분류합니다. 왼쪽 ‘분류 확인 필요’에서 틀린 것을 고쳐 주세요. 여러 권을 선택하면 한꺼번에 바꿀 수 있습니다.</li><li><b>서점 정보 채우기</b> — 설정에 카카오 키를 넣으면 표지와 저자를 채웁니다. 키가 없어도 서재는 쓸 수 있습니다.</li><li><b>백업</b> — 설정의 ‘백업 파일 만들기’로 분류와 메모를 가끔 저장해 두세요.</li></ol>
      ${D ? '<button class="btn primary" data-act="add-folder">＋ 폴더 연결</button>' : '<p style="color:var(--danger)">폴더 연결은 Theologia Library 데스크톱 앱에서만 사용할 수 있습니다.</p>'}</div>`;
    return;
  }
  const openIdx = S.open ? list.findIndex((w) => w.id === S.open) : -1;
  const openGone = S.open && openIdx < 0 && work(S.open) ? `<div class="open-gone">수정 중인 「${esc(work(S.open).title)}」이(가) 지금 보는 목록의 조건에서 빠졌습니다. <button class="btn sm" data-act="nav" data-v="all">전체 문헌 보기</button></div>` : '';
  if (!list.length) { S.openPos = null; c.innerHTML = openGone + '<div class="empty"><div class="big">조건에 맞는 문헌이 없습니다</div><p>검색어나 필터를 바꿔 보세요.</p></div>'; return; }
  // 수정 중인 책(오른쪽에 열린 책)이 정렬·검색 때문에 밀려나도 목록에서 계속 보이게 한다
  if (openIdx >= S.limit) S.limit = openIdx + 1;
  const shown = list.slice(0, S.limit);
  c.innerHTML = openGone + (S.view === 'list'
    ? `<table class="ltable"><thead><tr><th></th><th></th><th>제목</th><th>저자</th><th>분류</th><th>상태</th><th>진행</th><th>PDF</th><th></th></tr></thead><tbody>${shown.map(row).join('')}</tbody></table>`
    : `<div class="grid ${S.checked.size ? 'sel-mode' : ''}">${shown.map(card).join('')}</div>`) + `
    ${list.length > shown.length ? `<button class="btn more" data-act="more">더 보기 (${num(list.length - shown.length)}개 남음)</button>` : ''}`;
  document.querySelectorAll('.viewseg button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  const prev = S.openPos; S.openPos = S.open ? { id: S.open, idx: openIdx } : null;
  if (S.open && openIdx >= 0 && prev && prev.id === S.open && prev.idx !== openIdx) {     // 같은 책인데 순서가 바뀐 경우에만 따라가 준다
    const el = c.querySelector(`[data-act="open"][data-v="${CSS.escape(S.open)}"]`);
    if (el) { const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect(); if (r.top < cr.top + 4 || r.bottom > cr.bottom - 4) el.scrollIntoView({ block: 'center' }); }
  }
}

function ago(iso) {
  const t = Date.parse(iso); if (!t) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '방금'; if (m < 60) return m + '분 전'; if (m < 1440) return Math.floor(m / 60) + '시간 전';
  if (m < 43200) return Math.floor(m / 1440) + '일 전'; return new Date(t).toLocaleDateString('ko-KR');
}
// ---------- 책의 원본 위치 ----------
const normP = (s) => String(s || '').replace(/\\/g, '/');
const dirOf = (p) => normP(p).replace(/\/[^/]*$/, '');
function locLabel(filePath) {
  const dir = dirOf(filePath), low = dir.toLowerCase(); let best = null;
  for (const f of (S.lib.folders || [])) { const r = normP(f.path).replace(/\/$/, ''); if ((low === r.toLowerCase() || low.startsWith(r.toLowerCase() + '/')) && (!best || r.length > best.length)) best = r; }
  if (best) { const parts = [best.split('/').pop() || best, ...dir.slice(best.length).split('/').filter(Boolean)]; return parts.join(' › '); }
  return dir.split('/').filter(Boolean).slice(-3).join(' › ');
}
function locInfo(w) {
  const files = filesOf(w); if (!files.length) return null;
  const primary = files.find((f) => !f.missing) || files[0];
  const groups = new Map(); for (const f of files) { const d = dirOf(f.path).toLowerCase(); if (!groups.has(d)) groups.set(d, { file: f, label: locLabel(f.path), dir: dirOf(f.path) }); }
  const list = [...groups.values()]; const n = list.length;
  return { primary, list, text: list[0].label + (n > 1 ? ` 외 ${n - 1}곳` : ''), full: normP(primary.path), allMissing: files.every((f) => f.missing) };
}
function locBtn(w, cls) {
  const L = locInfo(w); if (!L) return '';
  return `<button class="loc ${cls || ''} ${L.allMissing ? 'warn' : ''}" data-act="show-pdf" data-v="${L.primary.id}" title="${esc(L.full)}&#10;눌러서 위치 보기">📁 <span>${esc(L.allMissing ? L.text + ' · 파일 없음' : L.text)}</span></button>`;
}
function resumeFile(w) {
  const fs = filesOf(w).filter((f) => !f.missing && f.lastPage > 0 && f.lastReadAt);
  if (!fs.length) return null;
  const done = (f) => f.pages > 0 && f.lastPage >= f.pages;
  const open = fs.filter((f) => !done(f)); const pool = open.length ? open : fs;
  return pool.sort((a, b) => String(b.lastReadAt).localeCompare(String(a.lastReadAt)))[0];
}
// 목록·카드에서 바로 읽기: 이어 읽을 파일이 있으면 거기서, 없으면 첫 파일을 연다
function readTarget(w) { const files = filesOf(w).filter((f) => !f.missing); if (!files.length) return null; const rf = resumeFile(w); return { file: rf || files[0], resume: !!rf }; }
function readBtn(w, cls) {
  const t = readTarget(w); if (!t) return `<button class="btn sm ${cls}" disabled title="열 수 있는 파일이 없습니다">읽기</button>`;
  return `<button class="btn sm primary ${cls}" data-act="read" data-v="${t.file.id}" title="${t.resume ? 'p.' + t.file.lastPage + '부터 이어 읽기' : '읽기 시작'}">${t.resume ? '이어 읽기' : '읽기'}</button>`;
}
function resumeBtn(w) {
  const files = filesOf(w).filter((f) => !f.missing); if (!files.length) return '';
  const rf = resumeFile(w);
  if (rf) return `<button class="btn primary resume-btn" data-act="read" data-v="${rf.id}">이어 읽기 · ${files.length > 1 ? esc(rf.name) + ' ' : ''}p.${rf.lastPage}</button>`;
  return `<button class="btn primary resume-btn" data-act="read" data-v="${files[0].id}">읽기 시작</button>`;
}
function renderDrawer() {
  const dr = $('#drawer'), w = S.open && work(S.open);
  if (!w) { dr.hidden = true; dr.innerHTML = ''; return; }
  dr.hidden = false;
  const files = filesOf(w), missing = files.filter((f) => f.missing).length;
  if (window.TLReader) setTimeout(() => window.TLReader.measure(files), 200);
  const catNames = [...new Set([...S.ref.categories.map((c) => c.name), ...S.lib.works.map((x) => x.category).filter(Boolean)])];
  dr.innerHTML = `
  <div class="d-head"><span id="savestate">${esc(S.saveState)}</span><span class="d-actions"><button class="btn sm primary" data-act="save-now" title="지금 저장 (Ctrl+S)">저장</button><button class="icon-btn" data-act="close" title="닫기 (Esc)">✕</button></span></div>
  <div class="d-body" data-id="${w.id}">
    <input class="d-title" data-f="title" value="${esc(w.title)}" aria-label="제목" />
    ${w.review ? `<div class="note-warn">파일 이름이 비슷해서 자동으로 묶었습니다. 같은 책이 맞는지 아래 파일을 확인해 주세요.<br><button class="btn sm" style="margin-top:6px" data-act="ok-review">맞습니다</button></div>` : ''}
    ${missing ? `<div class="note-warn">${missing}개 파일을 찾을 수 없습니다. 이동하거나 삭제됐을 수 있습니다. 폴더를 다시 스캔하면 새 위치의 파일이 새로 등록됩니다.</div>` : ''}
    <div class="sec"><button class="btn ${w.inList ? '' : 'primary'}" data-act="toggle-list" data-v="${w.id}">${w.inList ? '★ 읽기 목록에서 빼기' : '☆ 읽기 목록에 넣기'}</button></div>
    <div class="sec"><div class="seg">${Object.entries(STATUS).map(([k, v]) => `<button class="${w.status === k ? 'on' : ''}" data-act="status" data-v="${k}">${v}</button>`).join('')}</div></div>
    <div class="sec"><h5>읽은 쪽</h5>${w.autoProgress ? `
      <div class="resume">${w.totalPages > 0 ? `<div class="prog big"><i style="width:${pct(w)}%"></i></div>` : ''}
        <div class="rtxt">${w.totalPages > 0 ? `${num(w.currentPage)} / ${num(w.totalPages)}쪽 · ${pct(w)}%${w.progressPartial ? ' (쪽수 확인 중)' : ''}` : '읽은 기록이 자동으로 쌓입니다'}${w.lastReadAt ? `<small>마지막 ${esc(ago(w.lastReadAt))}</small>` : ''}</div>
        ${resumeBtn(w)}</div>` : `<div class="pages">
      <input type="number" min="0" data-f="currentPage" value="${w.currentPage || ''}" placeholder="현재" /> <span>/</span>
      <input type="number" min="0" data-f="totalPages" value="${w.totalPages || ''}" placeholder="전체 쪽" />
      <span class="pct" id="pct">${w.totalPages > 0 ? pct(w) + '%' : ''}</span></div>${resumeBtn(w)}`}</div>
    <div class="sec"><h5>서지 정보</h5>
      <div class="field"><label>저자</label><input data-f="author" value="${esc(w.author)}" /></div>
      <div class="field"><label>출판사</label><input data-f="publisher" value="${esc(w.publisher)}" /></div>
      <div class="field"><label>출판연도</label><input data-f="year" value="${esc(w.year)}" /></div>
      <div class="field"><label>ISBN</label><input data-f="isbn" value="${esc(w.isbn)}" placeholder="978… (하이픈 있어도 됩니다)" /></div>
      <div class="isbnbar"><button class="btn sm" data-act="fill-isbn">ISBN으로 채우기</button><button class="btn sm" data-act="find-isbn">PDF에서 ISBN 찾기</button></div>
      <div class="field"><label>분류</label><input data-f="category" list="cats" value="${esc(w.category)}" placeholder="예: 조직신학" /><datalist id="cats">${catNames.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      ${w.classSource === 'auto' && w.category ? `<div class="clsnote ${w.classConf === 'low' ? 'low' : ''}"><span>자동 분류 · 확신 ${w.classConf === 'low' ? '낮음' : '높음'}${w.classReason ? ' · ' + esc(w.classReason) : ''}</span><button class="btn sm" data-act="confirm-class">맞아요</button></div>` : w.classSource === 'manual' ? '<div class="clsnote ok"><span>직접 지정한 분류</span></div>' : ''}
      <button class="btn sm" data-act="bookstore">서점 정보로 채우기</button>
      ${w.fillState === 'nomatch' ? '<p class="help" style="margin-top:6px">자동으로 같은 책을 확실히 찾지 못했습니다. 위 버튼으로 직접 골라 주세요.</p>' : ''}
    </div>
    <div class="sec"><h5>성경 연결 <button class="btn sm" data-act="bible">편집</button></h5>
      <div class="tags">${w.bibleBooks.length ? w.bibleBooks.map((b) => `<span class="tag">${esc(b)}</span>`).join('') : '<span style="color:var(--faint)">연결된 성경 책이 없습니다</span>'}</div></div>
    <div class="sec"><h5>태그</h5><div class="tags" id="tags">${tagsHtml(w)}</div></div>
    <div class="sec"><h5>노트 ${S.settings && S.settings.notesDir ? '<button class="btn sm" data-act="note-open" data-v="' + esc(w.id) + '">책 노트 열기</button>' : ''}</h5>${S.settings && S.settings.notesDir ? '<p class="help">이 책의 노트를 노트 폴더에 md 파일로 씁니다. <code>[[주제]]</code>로 다른 노트와 이어집니다.</p>' : '<p class="help">설정에서 노트 폴더를 정하면 책마다 노트를 쓰고 <code>[[ ]]</code>로 이을 수 있습니다.</p>'}</div>
    <div class="sec"><h5>메모 <small style="font-weight:400;color:var(--muted)">짧은 기록 · 길게 쓸 때는 위의 책 노트</small></h5><textarea data-f="note" placeholder="읽은 소감, 인용할 쪽, 참고할 점…">${esc(w.note)}</textarea></div>
    <div class="sec"><h5>위치</h5>${(locInfo(w) ? locInfo(w).list : []).map((g) => `
      <div class="locrow"><button class="loc ${g.file.missing ? 'warn' : ''}" data-act="show-pdf" data-v="${g.file.id}" title="눌러서 위치 보기">📁 <span>${esc(g.label)}</span></button>
        <div class="path">${esc(g.dir)}</div>
        <div class="btns"><button class="btn sm" data-act="show-pdf" data-v="${g.file.id}">위치 보기</button><button class="btn sm" data-act="copy-path" data-v="${g.file.id}">경로 복사</button></div></div>`).join('')}</div>
    <div class="sec"><h5>PDF 파일 ${files.length}개</h5>${files.map((f) => `
      <div class="file ${f.missing ? 'gone' : ''}">
        <div class="fn"><b title="${esc(f.name)}">${esc(f.name)}</b><small title="${esc(f.path)}">${f.missing ? '파일 없음 · ' : ''}${fmtSize(f.size)}${/\.(?:md|markdown)$/i.test(f.path) ? ` · MD${f.lastPage > 0 ? ` · ${Math.round(f.lastPage / 10)}% 읽음` : ''}` : /\.epub$/i.test(f.path) ? ` · EPUB${f.lastPage > 0 ? ` · ${Math.round(f.lastPage / 10)}% 읽음` : ''}` : f.pages > 0 ? ` · ${num(f.pages)}쪽${f.lastPage > 0 ? ` · ${f.lastPage}쪽까지 읽음` : ''}` : ''}</small></div>
        <div class="acts">
          <button class="btn sm primary" data-act="read" data-v="${f.id}" ${f.missing ? 'disabled' : ''}>${f.lastPage > 0 ? `이어 읽기 p.${f.lastPage}` : '읽기'}</button>
          <button class="icon-btn" data-act="open-pdf" data-v="${f.id}" title="기본 PDF 뷰어로 열기" ${f.missing ? 'disabled' : ''}>↗</button>
          <button class="icon-btn" data-act="show-pdf" data-v="${f.id}" title="위치 보기">📂</button>
          ${files.length > 1 ? `<button class="icon-btn" data-act="detach" data-v="${f.id}" title="이 파일을 별도 작품으로 분리">⤴</button>` : ''}
        </div></div>`).join('')}</div>
    <div class="d-actions"><button class="btn danger sm" data-act="del-work">서재에서 제거</button></div>
  </div>`;
}
const tagsHtml = (w) => w.tags.map((t, i) => `<span class="tag">${esc(t)}<button data-act="rm-tag" data-v="${i}" title="삭제">✕</button></span>`).join('') + '<button class="tag-add" data-act="add-tag">＋ 태그</button>';

// ---------- 저장 ----------
const pending = new Map(); let saveTimer = null;
function queueSave(id, patch) {
  const w = work(id); if (!w) return;
  Object.assign(w, patch);
  pending.set(id, { ...(pending.get(id) || {}), ...patch });
  setSave('저장 중…'); clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  const jobs = [...pending.entries()]; pending.clear();
  try { for (const [id, patch] of jobs) await api('/api/library/works/' + encodeURIComponent(id), 'PATCH', patch); setSave('저장됨'); }
  catch (e) { setSave(''); toast('저장하지 못했습니다: ' + e.message, true); }
}
function setSave(t) { S.saveState = t; const el = $('#savestate'); if (el) el.textContent = t; }
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'b') { e.preventDefault(); setSide(!S.sideOff); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') { e.preventDefault(); const b = document.querySelector('[data-act=save-now]'); if (b) b.click(); else if (pending.size) { clearTimeout(saveTimer); flushSave().then(() => toast('저장했습니다.')); } } });
window.addEventListener('beforeunload', () => { if (pending.size) { for (const [id, p] of pending) navigator.sendBeacon && fetch('/api/library/works/' + id, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); } });

// ---------- 모달 ----------
function modal(title, bodyHtml, buttons, onMount) {
  closeModal();
  const m = document.createElement('div'); m.className = 'scrim'; m.id = 'modal';
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><header><h2>${esc(title)}</h2><button class="icon-btn" data-m="close">✕</button></header><div class="mb">${bodyHtml}</div>
    <footer>${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-m="${i}">${esc(b.label)}</button>`).join('')}</footer></div>`;
  m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(); });
  m.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-m]'); if (!t) return;
    if (t.dataset.m === 'close') return closeModal();
    const b = buttons[+t.dataset.m]; if (!b) return; const keep = b.fn ? await b.fn(m) : false; if (!keep) closeModal();
  });
  document.body.appendChild(m); if (onMount) onMount(m); return m;
}
const closeModal = () => { if (typeof NT !== 'undefined' && NT) { const n = NT; if (n.dirty) ntSave(true); clearTimeout(n.timer); NT = null; } const m = $('#modal'); if (m) m.remove(); };

function bibleModal(w) {
  const grp = (t) => S.ref.bibleBooks.filter((b) => b.testament === t).map((b) => `<label><input type="checkbox" value="${esc(b.name)}" ${w.bibleBooks.includes(b.name) ? 'checked' : ''}/>${esc(b.name)}</label>`).join('');
  modal('성경 연결', `<p class="help">이 문헌이 다루는 성경 책을 고르세요. 상단의 성경 필터로 모아 볼 수 있습니다.</p>
    <h5 style="margin:6px 0">구약</h5><div class="bible-grid">${grp('old')}</div><h5 style="margin:14px 0 6px">신약</h5><div class="bible-grid">${grp('new')}</div>`,
    [{ label: '취소' }, { label: '저장', cls: 'primary', fn: (m) => { const v = [...m.querySelectorAll('input:checked')].map((i) => i.value); queueSave(w.id, { bibleBooks: v }); renderDrawer(); renderList(); } }]);
}

function mergeModal() {
  const ws = [...S.checked].map(work).filter(Boolean).sort((a, b) => (parseInt(a.id.slice(1), 10) || 0) - (parseInt(b.id.slice(1), 10) || 0));
  modal('작품 합치기', `<p class="help">선택한 ${ws.length}개 작품의 PDF를 하나로 모읍니다. 남길 작품의 제목과 서지 정보를 고르세요.</p>
    ${ws.map((w, i) => `<label class="cand" style="cursor:pointer"><input type="radio" name="into" value="${w.id}" ${i === 0 ? 'checked' : ''}/><div class="ci"><b>${esc(w.title)}</b><small>${esc(w.author || '저자 미상')} · PDF ${filesOf(w).length}개</small></div></label>`).join('')}`,
    [{ label: '취소' }, { label: '합치기', cls: 'primary', fn: async (m) => {
      const into = m.querySelector('input:checked').value;
      try { setLib(await api('/api/library/works/merge', 'POST', { ids: ws.map((w) => w.id), into })); S.checked.clear(); S.open = into; renderAll(); toast('하나의 작품으로 합쳤습니다.'); }
      catch (e) { toast(e.message, true); }
    } }]);
}

// ISBN 하나로 비어 있는 서지 정보(저자·출판사·연도·표지·소개)를 채운다. 이미 적어 둔 값과 제목은 그대로 둔다.
async function fillByIsbn(wid, isbnArg) {
  const w = work(wid); if (!w) return;
  const inp = document.querySelector('#drawer [data-f="isbn"]');
  const isbn = (isbnArg || (inp ? inp.value : w.isbn) || '').trim();
  if (!isbn) { toast('ISBN을 먼저 입력해 주세요.', true); return; }
  busy('ISBN으로 찾는 중…');
  try {
    const r = await api(`/api/library/works/${encodeURIComponent(wid)}/fill-isbn`, 'POST', { isbn });
    Object.assign(work(wid), r.work);
    if (r.found) {
      const names = { author: '저자', publisher: '출판사', year: '출판연도', coverUrl: '표지', blurb: '소개' };
      const got = (r.filled || []).map((k) => names[k]).filter(Boolean);
      toast(`${r.candidate.providerLabel}에서 찾았습니다: ${r.candidate.title}${got.length ? ' · 채운 항목: ' + got.join(', ') : ' · 이미 채워져 있어 바꾼 항목은 없습니다'}`);
    } else {
      toast((r.errors && r.errors[0]) || '서점에서 이 ISBN을 찾지 못했습니다. ISBN은 저장했습니다. 전자책 ISBN은 종이책과 달라 검색되지 않는 경우가 많으니, “서점 정보로 채우기”에서 제목으로 찾아 보세요.', true);
    }
    renderAll();
  } catch (e) { toast(e.message, true); } finally { busy(''); }
}
// PDF 앞뒤 쪽(판권지)의 글자에서 ISBN을 찾아 넣는다. 스캔본이라 글자가 없으면 찾지 못한다.
async function findIsbnInPdf(wid) {
  const w = work(wid); if (!w) return;
  const fs_ = filesOf(w).filter((f) => !f.missing); if (!fs_.length) { toast('열 수 있는 PDF 파일이 없습니다.', true); return; }
  busy('PDF에서 ISBN을 찾는 중…');
  try {
    let found = [], textual = false;
    for (const f of fs_.slice(0, 3)) {
      let t; try { t = await window.TLReader.isbnTexts(f.id); } catch { continue; }
      if (t.texts.some((x) => x.trim().length > 20)) textual = true;
      const r = await api('/api/isbn/find', 'POST', { texts: t.texts });
      for (const i of r.isbns) if (!found.includes(i)) found.push(i);
      if (found.length) break;
    }
    busy('');
    if (!found.length) { toast(textual ? '앞뒤 쪽에서 ISBN을 찾지 못했습니다. 직접 입력해 주세요.' : '이 PDF는 글자가 없는 스캔본이라 ISBN을 읽을 수 없습니다. 직접 입력해 주세요.', true); return; }
    if (found.length === 1) { const inp = document.querySelector('#drawer [data-f="isbn"]'); if (inp) inp.value = found[0]; await fillByIsbn(wid, found[0]); return; }
    const m = modal('ISBN 고르기', `<p class="help">PDF에서 ISBN 후보를 ${found.length}개 찾았습니다. 이 책의 것을 고르세요. (세트 ISBN이 섞여 있을 수 있습니다)</p>${found.map((i, k) => `<div class="cand"><div class="ci"><b>${esc(i)}</b></div><button class="btn sm primary" data-i="${k}">이 ISBN으로 채우기</button></div>`).join('')}`, [{ label: '닫기' }]);
    m.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { const v = found[+b.dataset.i]; closeModal(); fillByIsbn(wid, v); }));
  } catch (e) { busy(''); toast(e.message, true); }
}

async function bookstoreModal(w) {
  const m = modal('서점 정보 검색', `<div class="bs-q" style="display:grid;grid-template-columns:52px 1fr auto;gap:6px 8px;align-items:center;margin-bottom:8px">
      <label for="bs-title">제목</label><input id="bs-title" type="text" value="${esc(w.title)}" style="grid-column:2/4">
      <label for="bs-isbn">ISBN</label><input id="bs-isbn" type="text" inputmode="numeric" value="${esc(w.isbn || '')}" placeholder="ISBN을 붙여넣거나 입력 (예: 9788912345678)"><button class="btn sm primary" id="bs-go" type="button">검색</button>
    </div><div id="bs-res"><p class="help">검색 중…</p></div>`, [{ label: '닫기' }]);
  const titleEl = m.querySelector('#bs-title'), isbnEl = m.querySelector('#bs-isbn'), box = m.querySelector('#bs-res');
  let seq = 0;
  async function run() {
    const my = ++seq; const title = titleEl.value.trim(), isbn = isbnEl.value.replace(/[^0-9Xx]/g, '');
    if (!title && !isbn) { box.innerHTML = '<p class="help">제목이나 ISBN을 입력해 주세요.</p>'; return; }
    box.innerHTML = '<p class="help">검색 중…</p>';
    const q = new URLSearchParams({ query: title || isbn }); if (isbn) q.set('isbn', isbn);
    let r; try { r = await api('/api/bookstores/search?' + q); } catch (e) { r = { candidates: [], errors: [e.message] }; }
    if (my !== seq || !$('#modal')) return;
    const real = r.candidates.filter((c) => c.sourceStatus === 'live'), links = r.candidates.filter((c) => c.sourceStatus === 'search-link'), unconf = r.candidates.filter((c) => c.sourceStatus === 'unconfigured');
    box.innerHTML = `
      <p class="help">서점 검색 페이지에서 복사한 ISBN을 위 ISBN 칸에 붙여넣으면 바로 검색됩니다. 책이 나오면 “적용”을 누르세요.</p>
      ${isbn ? `<div class="cand"><div class="ci"><b>ISBN ${esc(isbn)}</b><small>찾은 책이 없거나 정보를 따로 채우고 싶을 때, 이 ISBN을 작품에 저장하고 서점에서 빈 항목만 채웁니다.</small></div><button class="btn sm" id="bs-save-isbn" type="button">이 ISBN 저장</button></div>` : ''}
      ${unconf.length ? `<div class="note-warn">${unconf.map((c) => esc(c.providerLabel)).join('·')} 검색을 쓰려면 설정에서 API 키를 입력해 주세요.</div>` : ''}
      ${(r.errors || []).map((e) => `<div class="note-warn">${esc(e)}</div>`).join('')}
      ${real.length ? real.map((c, i) => `<div class="cand">${c.coverUrl ? `<img src="${esc(c.coverUrl)}" alt="">` : '<img alt="">'}<div class="ci"><b>${esc(c.title)}</b><small>${esc(c.author || '')} · ${esc(c.publisher || '')} ${c.publishedAt ? '· ' + esc(String(c.publishedAt).slice(0, 10)) : ''}</small><small>${esc(c.providerLabel)}${c.isbn ? ' · ISBN ' + esc(c.isbn) : ''}</small></div><button class="btn sm primary" data-c="${i}">적용</button></div>`).join('') : '<p class="help">검색된 도서가 없습니다.</p>'}
      ${links.map((c) => `<div class="cand"><div class="ci"><b>${esc(c.providerLabel)}</b><small>공식 검색 API가 없어 검색 페이지로 연결합니다.</small></div><a class="btn sm" href="${esc(c.productUrl)}" target="tlstore" rel="noopener">검색 페이지 열기</a></div>`).join('')}`;
    const sv = box.querySelector('#bs-save-isbn'); if (sv) sv.addEventListener('click', () => { closeModal(); fillByIsbn(w.id, isbn); });
    box.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', async () => {
      try { const c = { ...real[+b.dataset.c] }; if (isbn && !c.isbn) c.isbn = isbn; const out = await api(`/api/library/works/${encodeURIComponent(w.id)}/apply-candidate`, 'POST', { candidate: c }); Object.assign(work(w.id), out.work); closeModal(); renderAll(); toast(`${c.providerLabel} 정보를 반영했습니다.`); }
      catch (e) { toast(e.message, true); }
    }));
  }
  m.querySelector('#bs-go').addEventListener('click', run);
  isbnEl.addEventListener('paste', () => setTimeout(() => { if (isbnEl.value.replace(/[^0-9Xx]/g, '').length >= 10) run(); }, 60));
  [titleEl, isbnEl].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } }));
  run();
}

async function settingsModal() {
  try { S.settings = await api('/api/settings'); } catch {}
  let sx = null; try { sx = await api('/api/search/status'); } catch {}
  const sxLine = !sx ? '' : sx.available
    ? `연결됨 · 색인 ${num(sx.books)}권 중 이 서재의 파일 ${num(sx.mapped)}개와 짝이 맞음${sx.byName ? ` (그중 ${num(sx.byName)}개는 이름·크기로 맞춤)` : ''}<br><small>${esc(sx.dbPath || '')}</small>`
    : esc(sx.error || '연결되지 않음');
  modal('설정', `<p class="help">카카오(다음) 책 검색 REST API 키입니다. 키가 있으면 제목·저자·출판사·표지를 자동으로 채웁니다. 이 컴퓨터의 앱 폴더(data/settings.json)에만 저장됩니다. 비워 두고 저장하면 키가 지워집니다.</p>
    <div class="field" style="grid-template-columns:110px 1fr"><label>카카오 REST 키</label><input id="k-kakao" type="password" placeholder="${S.settings.kakao ? '설정됨 (바꾸려면 새로 입력)' : '입력하지 않음'}" autocomplete="off"></div>
    <div class="field" style="grid-template-columns:110px 1fr;margin-top:10px"><label>국립중앙도서관 키</label><input id="k-nl" type="password" placeholder="${S.settings.nl ? '설정됨 (바꾸려면 새로 입력)' : '입력하지 않음 (선택)'}" autocomplete="off"></div>
    <p class="help" style="margin:2px 0 0 120px">ISBN으로 찾을 때 카카오에 없는 책을 국립중앙도서관 ISBN 서지정보로 한 번 더 찾습니다. 키는 nl.go.kr 로그인 후 Open API 인증키 신청에서 받습니다.</p>
    <div class="field" style="grid-template-columns:110px 1fr;margin-top:14px"><label>본문 검색 색인</label><input id="k-index" type="text" value="${esc(S.settings.searchIndex || '')}" placeholder="비워 두면 PDF 폴더 옆 _서재색인을 자동으로 찾습니다"></div>
    <p class="help" style="margin:2px 0 0 120px">${sxLine}<br>다른 곳에 둔 색인을 쓰려면 서재색인.db 파일 또는 그것이 든 폴더의 경로를 적으세요. 색인은 읽기만 하며 바꾸지 않습니다. 책 짝은 폴더 기준 경로로 찾고, 안 맞으면 파일 이름과 크기로 찾습니다.</p>
${fillStatsHtml()}
    <h5 style="margin:18px 0 6px">노트 폴더</h5>
    <div class="field" style="grid-template-columns:110px 1fr auto"><label>노트 폴더</label><input id="k-notes" type="text" value="${esc(S.settings.notesDir || '')}" placeholder="비워 두면 노트 기능은 꺼집니다">${window.theologiaDesktop && window.theologiaDesktop.selectFolder ? '<button class="btn sm" id="k-notes-pick" type="button">고르기…</button>' : ''}</div>
    <p class="help" style="margin:2px 0 0 120px">책 노트와 주제 노트를 일반 md 파일로 저장하는 폴더입니다. 옵시디언에서 이 폴더를 열면 그대로 보입니다. 구글 드라이브를 쓰려면 ‘내 파일 미러링’ 폴더 안에 만드세요. 폴더를 바꾸면 기존 노트는 옮겨지지 않으니 파일을 직접 옮겨 주세요.</p>
    <h5 style="margin:18px 0 6px">백업과 되돌리기</h5>
    <p class="help">분류·메모·읽은 위치 같은 서재 기록을 파일 하나로 저장합니다. 책 파일(PDF·EPUB)은 들어 있지 않고, API 키도 담기지 않습니다. 다른 컴퓨터로 옮길 때도 이 파일을 쓰면 됩니다.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><a class="btn sm" id="bk-export" href="/api/backup/export" download>백업 파일 만들기</a><button class="btn sm" id="bk-import" type="button">백업에서 되돌리기…</button><input type="file" id="bk-file" accept=".json,application/json" hidden></div>
    <p class="help" style="margin-top:6px;color:#8a8e84">서재 기록 위치: ${esc(S.settings.dataDir || '')}</p>
    <p class="help" style="margin-top:14px">키가 없어도 서재는 모두 쓸 수 있습니다. 교보문고는 검색 페이지 링크만 제공합니다.</p><p class="help" style="margin-top:6px;color:#8a8e84">앱 버전 ver${esc(S.settings.version || '')} · ${esc(S.settings.build || '확인 안 됨(오래된 버전)')} <button class="btn sm" id="upd-check" style="margin-left:8px">업데이트 확인</button> <span id="upd-msg"></span></p><p class="help" style="margin-top:6px;color:#8a8e84">제작: 좋은군사 · MIT 라이선스 · <a href="https://github.com/acts1615/theologia-library" target="_blank" rel="noopener">github.com/acts1615/theologia-library</a> · <a href="https://github.com/acts1615/theologia-library/issues" target="_blank" rel="noopener">문제 알리기</a></p>`,
    [{ label: '닫기' }, { label: '자동 분류 다시 실행', fn: async () => { busy('분류하는 중…'); try { const r = await api('/api/library/classify', 'POST', { force: true }); setLib(r.library); renderAll(); renderSide(); toast(`자동 분류를 다시 실행했습니다. 분류 ${num(r.cat)}권, 성경 연결 ${num(r.bible)}권 (직접 지정한 값은 그대로 두었습니다).`); } catch (e) { toast(e.message, true); } finally { busy(''); } } }, { label: '서점 정보 자동 채우기', fn: async (m) => { const k = m.querySelector('#k-kakao').value; if (k) { try { S.settings = await api('/api/settings', 'PUT', { KAKAO_REST_API_KEY: k }); } catch (e) { toast(e.message, true); return true; } } if (!S.settings.kakao) { toast('먼저 카카오 REST API 키를 입력해 주세요.', true); return true; } setTimeout(() => autoFillAll(true), 200); } }, { label: '저장', cls: 'primary', fn: async (m) => {
      const body = {}; const k = m.querySelector('#k-kakao').value;
      if (k) body.KAKAO_REST_API_KEY = k;
      const nlk = m.querySelector('#k-nl').value; if (nlk) body.NL_CERT_KEY = nlk;
      const ix = m.querySelector('#k-index').value.trim(); const indexChanged = ix !== (S.settings.searchIndex || '');
      if (indexChanged) body.SEARCH_INDEX_PATH = ix;
      const nd = m.querySelector('#k-notes').value.trim(); if (nd !== (S.settings.notesDir || '')) body.NOTES_DIR = nd;
      if (!Object.keys(body).length) return false;
      try { S.settings = await api('/api/settings', 'PUT', body); toast('저장했습니다.'); if (indexChanged) { try { await api('/api/search/reload', 'POST', {}); } catch {} loadSearchStatus(); } if (body.KAKAO_REST_API_KEY) setTimeout(() => autoFillAll(), 300); } catch (e) { toast(e.message, true); return true; }
    } }]);
}

// ---------- 노트 (노트 폴더의 md 파일) ----------
var NT = null;
async function ntSave(force) {
  if (!NT || !NT.dirty) return true; clearTimeout(NT.timer); const n = NT;
  try { const r = await api('/api/notes/note', 'PUT', { name: n.name, text: n.text, baseMtime: n.exists ? n.mtime : null }); n.mtime = r.mtimeMs; n.exists = true; n.dirty = false; const s = $('#nt-save'); if (s && NT === n) s.textContent = '저장됨'; ntRefreshSide(); return true; }
  catch (e) { const s = $('#nt-save'); if (s) { s.textContent = '저장 안 됨: ' + e.message; s.style.color = '#b3402a'; } if (force) toast(e.message, true); return false; }
}
function ntSideHtml(info) {
  const lst = (arr, f) => arr.length ? arr.map(f).join('') : '<span class="help">없습니다</span>';
  return `<h5>이 노트에서 이어진 곳</h5><div class="nt-chips">${lst(info.links || [], (l) => `<button class="chip-s ${l.exists || l.work ? '' : 'new'}" data-nt="${esc(l.name)}">${esc(l.name)}${l.work ? ' 📖' : l.exists ? '' : ' ＋'}</button>`)}</div>
    <h5>이 노트를 언급한 노트 (백링크)</h5><div class="nt-back">${lst(info.backlinks || [], (b) => `<button class="bl" data-nt="${esc(b.name)}"><b>${esc(b.name)}</b><small>${esc(b.snippet)}</small></button>`)}</div>`;
}
async function ntRefreshSide() { const n = NT; if (!n) return; try { const info = await api('/api/notes/note?name=' + encodeURIComponent(n.name)); const s = $('#modal .nt-side'); if (NT === n && s) s.innerHTML = ntSideHtml(info); } catch {} }
function ntRender(info) {
  const n = NT; const wk = (info.links || []);
  const m = $('#modal'); if (!m) return;
  const lst = (arr, f) => arr.length ? arr.map(f).join('') : '<span class="help">없습니다</span>';
  $('.mb', m).innerHTML = `<div class="nt-top"><button class="btn sm" id="nt-mode">${n.mode === 'edit' ? '미리보기' : '쓰기'}</button>${n.workId ? '<button class="btn sm" id="nt-lib">서재에서 책 보기</button>' : ''}<span id="nt-save" class="help"></span></div>
    ${n.mode === 'edit' ? `<textarea id="nt-text" class="nt-text" spellcheck="false" placeholder="읽은 내용, 인용, 내 생각… [[주제]]로 다른 노트와 이을 수 있습니다.">${esc(n.text)}</textarea>` : `<article class="md-art nt-prev" id="nt-prev"></article>`}
    <div class="nt-side">${ntSideHtml(info)}</div>`;
  if (n.mode !== 'edit') $('#nt-prev').innerHTML = window.TLMd.render(n.text || '_아직 비어 있습니다._', true, { note: n.name });
  const ta = $('#nt-text', m); if (ta) ta.addEventListener('input', () => { n.text = ta.value; n.dirty = true; clearTimeout(n.timer); const s = $('#nt-save'); if (s) { s.textContent = '쓰는 중…'; s.style.color = ''; } n.timer = setTimeout(() => ntSave(false), 1500); });
}
async function openNote(name, workId) {
  if (NT && NT.dirty && !(await ntSave(true))) return;
  name = String(name || '').trim(); if (!name) return;
  let info; try { info = await api('/api/notes/note?name=' + encodeURIComponent(name)); } catch (e) { toast(e.message, true); return; }
  const w = workId ? work(workId) : S.lib.works.find((x) => x.title.replace(/[\\/:*?"<>|]/g, '').trim().toLowerCase() === name.replace(/[\\/:*?"<>|]/g, '').trim().toLowerCase());
  const tpl = w ? `# ${w.title}\n\n- 저자: ${w.author || ''}\n- 출판: ${[w.publisher, w.year].filter(Boolean).join(' ')}\n\n## 핵심\n\n\n## 인용 (쪽수)\n\n\n## 내 생각\n\n` : `# ${name}\n\n`;
  const first = !info.exists;
  const mm = modal(name, '', [{ label: '닫기' }], null);
  NT = { name, workId: w ? w.id : '', text: first ? tpl : info.text, mtime: info.mtimeMs, exists: !first, dirty: false, mode: first ? 'edit' : 'view', timer: 0 };
  mm.querySelector('.modal').classList.add('note-modal'); ntRender(info);
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('#k-notes-pick')) { const r = await window.theologiaDesktop.selectFolder('노트 폴더 선택'); if (r && !r.canceled) $('#k-notes').value = r.folder; return; }
  if (!NT) return; const t = e.target.closest('[data-nt], #nt-mode, #nt-lib, a.wl, a.pg'); if (!t) return;
  e.preventDefault();
  if (t.matches('a.pg')) { jumpPage(t.dataset.pgKind, parseInt(t.dataset.pgN, 10)); return; }
  if (t.id === 'nt-mode') { const ta = $('#nt-text'); if (ta) NT.text = ta.value; NT.mode = NT.mode === 'edit' ? 'view' : 'edit'; await ntSave(true); const info = await api('/api/notes/note?name=' + encodeURIComponent(NT.name)).catch(() => ({ links: [], backlinks: [] })); ntRender(info); return; }
  if (t.id === 'nt-lib') { const id = NT.workId; await ntSave(true); NT = null; closeModal(); S.open = id; renderAll(); return; }
  const nm = t.dataset.nt || t.dataset.note; if (nm) openNote(nm).then(() => { const m = $('#modal h2'); if (m && NT) m.textContent = NT.name; });
}, true);

// ---------- 노트 검색 · 쪽으로 가기 ----------
function noteSearchModal() {
  const m = modal('노트 검색', `<input id="ns-q" type="search" placeholder="노트 안의 글자·이름을 찾습니다 (띄어쓰기로 여러 낱말)" autocomplete="off" style="width:100%"><div id="ns-res" style="margin-top:10px"><p class="help">낱말을 입력하면 노트 폴더의 모든 노트에서 찾습니다. 결과를 누르면 그 노트가 열립니다.</p></div>`, [{ label: '닫기' }]);
  const q = m.querySelector('#ns-q'), box = m.querySelector('#ns-res'); let tm = 0, seq = 0;
  q.focus();
  const hl = (s, terms) => { let r = esc(s); for (const t of terms) { if (!t) continue; r = r.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`); } return r; };
  async function run() {
    const v = q.value.trim(); const my = ++seq; if (!v) { box.innerHTML = '<p class="help">낱말을 입력하면 노트 폴더의 모든 노트에서 찾습니다.</p>'; return; }
    box.innerHTML = '<p class="help">찾는 중…</p>';
    let r; try { r = await api('/api/notes/search?q=' + encodeURIComponent(v)); } catch (e) { if (my === seq) box.innerHTML = `<div class="note-warn">${esc(e.message)}</div>`; return; }
    if (my !== seq) return; const terms = v.split(/\s+/);
    box.innerHTML = r.results.length ? `<p class="help">${r.results.length}개 노트${r.results.length >= 100 ? ' (처음 100개)' : ''}</p>` + r.results.map((x) => `<button class="bl" data-ns="${esc(x.name)}"><b>${hl(x.name, terms)}</b>${x.snippets.map((s) => `<small>${hl(s, terms)}</small>`).join('')}</button>`).join('') : '<p class="help">찾은 노트가 없습니다.</p>';
  }
  q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(run, 250); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(tm); run(); } });
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-ns]'); if (b) openNote(b.dataset.ns); });
}
function fmOf(text) { const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text || ''); const o = {}; if (m) for (const l of m[1].split(/\r?\n/)) { const k = /^([A-Za-z가-힣_]+):\s*(.*)$/.exec(l); if (k) o[k[1]] = k[2].replace(/^["']|["']$/g, '').trim(); } return o; }
function workForNote() {
  if (!NT) return null; if (NT.workId && work(NT.workId)) return work(NT.workId);
  const fm = fmOf(NT.text); const kf = (s) => String(s || '').replace(/[\s·.,:;\-—_'"“”‘’()『』]/g, '').toLowerCase();
  for (const f of [fm.book, fm.title]) { if (!f) continue; const k = kf(f); if (k.length < 3) continue; const w = S.lib.works.find((x) => kf(x.title) === k) || S.lib.works.find((x) => kf(x.title).includes(k)); if (w) return w; }
  return null;
}
async function jumpPage(kind, n) {
  const w = workForNote(); if (!w) { toast('이 노트와 이어진 책을 찾지 못했습니다. 책 노트이거나, 노트 맨 위 정보 블록에 book: 책 제목 이 있어야 합니다.', true); return; }
  const pdfs = filesOf(w).filter((f) => !f.missing && /\.pdf$/i.test(f.path || f.name || ''));
  if (!pdfs.length) { toast('쪽으로 열 수 있는 PDF가 없습니다. (EPUB은 쪽 번호가 없습니다)', true); return; }
  let fileId = pdfs[0].id, page = n;
  if (kind === 'printed') {
    let hit = null;
    for (const f of pdfs) { try { const j = await api('/api/search/pnum?fileId=' + encodeURIComponent(f.id)); for (const [a, b, d] of j.pnum || []) if (a <= n - d && n - d <= b) { hit = { f, page: n - d + 1 }; break; } } catch {} if (hit) break; }
    if (!hit) { toast(`이 책은 인쇄 쪽 정보가 없어 p.${n}로 갈 수 없습니다. 본문 색인을 만든 책이어야 합니다. PDF 쪽은 (PDF ${n}쪽)처럼 적으면 갈 수 있습니다.`, true); return; }
    fileId = hit.f.id; page = hit.page;
  }
  closeModal(); await window.TLReader.open({ fileId, page });
}

// ---------- 폴더 동작 ----------
function busy(msg) {
  S.busy = msg; let o = $('.overlay-busy');
  if (!msg) { if (o) o.remove(); return; }
  if (!o) { o = document.createElement('div'); o.className = 'overlay-busy'; document.body.appendChild(o); }
  o.textContent = msg;
}
async function ingest(folder, files, unavailable) {
  const r = await api('/api/library/scan', 'POST', { folderPath: folder, files, unavailable: !!unavailable });
  setLib(r.library); return r.summary;
}
async function addFolder() {
  if (!D) return toast('폴더 연결은 데스크톱 앱에서만 사용할 수 있습니다.', true);
  const r = await D.selectPdfFolder();
  if (!r || r.canceled) return;
  busy('PDF를 정리하는 중…');
  try {
    const s = await ingest(r.folder, r.files);
    renderAll();
    if (!r.files.length) toast('이 폴더에서 PDF를 찾지 못했습니다.', true);
    else { toast(`PDF ${num(r.files.length)}개 중 새 파일 ${num(s.added)}개, 새 작품 ${num(s.newWorks)}개를 서재에 추가했습니다.`); setTimeout(() => autoFillAll(), 400); }
  } catch (e) { toast('폴더를 등록하지 못했습니다: ' + e.message, true); }
  finally { busy(''); }
}
async function rescan(folder, silent) {
  if (!D) return;
  try {
    const r = await D.scanFolder(folder);
    const s = r.ok ? await ingest(folder, r.files) : await ingest(folder, [], true);
    if (!silent) { renderAll(); toast(!r.ok ? '폴더를 찾을 수 없습니다. 드라이브 연결을 확인해 주세요.' : s.added || s.missing ? `새 파일 ${num(s.added)}개, 사라진 파일 ${num(s.missing)}개를 반영했습니다.` : '변경된 내용이 없습니다.', !r.ok); }
    return s;
  } catch (e) { if (!silent) toast('스캔하지 못했습니다: ' + e.message, true); }
}
function fillStats() {
  const w = S.lib.works; let ok = 0, miss = 0, wait = 0, skip = 0;
  for (const x of w) { if (x.isbn || x.fillState === 'done') ok++; else if (x.fillState === 'skip') skip++; else if (x.fillState === 'nomatch') miss++; else wait++; }
  return { total: w.length - skip, ok, miss, wait, skip };
}
function fillStatsHtml() {
  const t = fillStats(); if (!t.total) return '';
  const p = Math.round((t.ok / t.total) * 100);
  return `<div class="fillstat"><div class="prog big"><i style="width:${p}%"></i></div>
    <div class="rtxt">서점 정보 매칭 <b>${num(t.ok)}</b> / ${num(t.total)}권 (${p}%)<small>못 찾음 ${num(t.miss)}권${t.wait ? ` · 아직 조회 전 ${num(t.wait)}권` : ''}${t.skip ? ` · 월간지 ${num(t.skip)}권은 조회 제외` : ''}</small></div></div>`;
}
let fillJob = { running: false, total: 0, done: 0, filled: 0, nomatch: 0, error: '' }, fillPoll = null;
async function syncFill(final) {
  try {
    const j = await api('/api/library/autofill/status'); const was = fillJob.running; fillJob = j;
    if (j.running || was) {
      if (!pending.size && !saveTimer) { setLib(await api('/api/library')); renderList(); if (S.open && !(document.activeElement && $('#drawer').contains(document.activeElement))) renderDrawer(); }
      else renderSide();
    }
    if (!j.running) {
      clearInterval(fillPoll); fillPoll = null;
      if (was || final) {
        if (j.error) toast(j.error, true);
        else if (j.total) { const t = fillStats(); toast(`서점 정보 가져오기를 마쳤습니다. 이번에 ${num(j.filled)}권을 채웠고, 전체 ${num(t.ok)} / ${num(t.total)}권이 매칭되었습니다.`); }
      }
    }
  } catch (e) { clearInterval(fillPoll); fillPoll = null; }
}
async function autoFillAll(force) {
  if (!S.settings.kakao || fillJob.running) return;
  const j = await api('/api/library/autofill/start', 'POST', { force: !!force }).catch((e) => ({ error: e.message }));
  if (j.error) { toast(j.error, true); return; }
  if (!j.total && !j.running) { if (force) toast('채울 작품이 없습니다.'); return; }
  fillJob = j; renderSide(); toast('서점 정보를 백그라운드에서 가져옵니다. 다른 작업은 그대로 하셔도 됩니다.');
  if (!fillPoll) fillPoll = setInterval(() => syncFill(), 2500);
}
function fillJobHtml() {
  if (!fillJob.running) return '';
  const pc = fillJob.total ? Math.round((fillJob.done / fillJob.total) * 100) : 0;
  return `<div class="fillrun"><div class="prog"><i style="width:${pc}%"></i></div><div class="rtxt">가져오는 중 ${num(fillJob.done)} / ${num(fillJob.total)} · 채움 ${num(fillJob.filled)}</div><button class="btn sm" data-act="fill-stop">중지</button></div>`;
}
async function refreshAll() {
  if (!D || !S.lib.folders.length) return;
  S.refreshing = true; renderSide();
  let added = 0;
  for (const f of [...S.lib.folders]) { const s = await rescan(f.path, true); if (s) added += s.added; }
  S.refreshing = false; renderAll();
  if (added) toast(`폴더를 확인해서 새 PDF ${num(added)}개를 찾았습니다.`);
  autoFillAll();
}

// ---------- 이벤트 ----------
function renderAll() { renderList(); renderDrawer(); }
const fileById = (id) => S.lib.files.find((f) => f.id === id);

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]'); if (!t || $('#modal')?.contains(t)) return;
  const act = t.dataset.act, v = t.dataset.v;
  // 글자를 드래그해서 선택한 뒤 손을 뗀 것이면 카드 열기 등으로 처리하지 않는다(선택이 사라지지 않게)
  if ((act === 'open' || act === 'view') && !e.target.closest('button, input, a')) { const sel = window.getSelection(); if (sel && !sel.isCollapsed && String(sel).trim() && t.contains(sel.anchorNode)) return; }
  // 읽는 화면에서 왼쪽 목록을 누르면 읽는 화면을 닫고 그 목록으로 간다
  if (window.TLReader && window.TLReader.isOpen() && ['nav', 'cat', 'bbook'].includes(act) && t.closest('.side')) await window.TLReader.close();
  if (act === 'check') { e.stopPropagation(); v && (t.checked ? S.checked.add(v) : S.checked.delete(v)); renderList(); return; }
  switch (act) {
    case 'side-toggle': setSide(!S.sideOff); break;
    case 'nav': S.nav = v; S.category = ''; S.bible = ''; S.limit = 120; renderList(); renderSide(); break;
    case 'cat': S.category = v; S.nav = 'all'; S.bible = ''; S.limit = 120; renderList(); renderSide(); break;
    case 'bbook': S.bible = S.bible === v ? '' : v; S.nav = 'all'; S.category = ''; S.limit = 120; renderBibleSelect(); renderList(); renderSide(); break;
    case 'btoggle': S.bibleOpen[v] = !isBibleOpen(v); renderSide(); break;
    case 'confirm-class': { const r = await api(`/api/library/works/${encodeURIComponent(S.open)}/confirm-class`, 'POST', {}); const k = S.lib.works.findIndex((x) => x.id === r.work.id); if (k >= 0) S.lib.works[k] = r.work; renderAll(); renderSide(); break; }
    case 'mode': setMode(v); break;
    case 'view': S.view = v; try { localStorage.setItem('tl.view', v); } catch (e) {} renderList(); break;
    case 'toggle-list': { e.stopPropagation(); const w = work(v); if (w) { queueSave(w.id, { inList: !w.inList }); renderList(); if (S.open === w.id) renderDrawer(); toast(w.inList ? '읽기 목록에 넣었습니다.' : '읽기 목록에서 뺐습니다.'); } break; }
    case 'bulk-list': { const on = v === '1'; for (const id of S.checked) queueSave(id, { inList: on }); toast(`${S.checked.size}권을 읽기 목록${on ? '에 넣었습니다' : '에서 뺐습니다. (읽는 중·읽을 예정 같은 읽기 상태는 그대로입니다)'}.`); S.checked.clear(); renderList(); renderSide(); break; }
    case 'bulk-cat': {
      const ids = [...S.checked]; if (!ids.length) break;
      const names = [...new Set([...S.ref.categories.map((c) => c.name), ...S.lib.works.map((x) => x.category).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'ko'));
      modal('분류 바꾸기', `<p>선택한 ${num(ids.length)}권의 분류를 한꺼번에 바꿉니다.</p><div class="field" style="grid-template-columns:70px 1fr"><label>분류</label><input id="bc-in" list="bc-list" placeholder="목록에서 고르거나 직접 입력" autocomplete="off"><datalist id="bc-list">${names.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div><p class="help">직접 지정한 분류는 자동 분류를 다시 돌려도 바뀌지 않습니다. 비워 두고 누르면 분류를 지웁니다.</p>`,
        [{ label: '취소' }, { label: '바꾸기', cls: 'primary', fn: (m) => { const v = m.querySelector('#bc-in').value.trim(); for (const id of ids) queueSave(id, { category: v }); toast(`${num(ids.length)}권의 분류를 ${v ? `'${v}'(으)로` : '비우는 것으로'} 바꿨습니다.`); S.checked.clear(); renderList(); renderSide(); } }]);
      break;
    }
    case 'bulk-status': { const n = S.checked.size; const label = { unread: '읽을 예정', reading: '읽는 중', finished: '완독' }[v]; for (const id of S.checked) queueSave(id, { status: v }); toast(`${n}권을 '${label}'(으)로 옮겼습니다.`); S.checked.clear(); renderList(); renderSide(); break; }
    case 'save-now': { clearTimeout(saveTimer); if (pending.size) { setSave('저장 중…'); await flushSave(); } else setSave('저장됨'); if (S.saveState === '저장됨') toast('저장했습니다.'); break; }
    case 'fill-stop': await api('/api/library/autofill/stop', 'POST', {}); toast('중지합니다. 지금까지 가져온 정보는 그대로 저장됩니다.'); break;
    case 'more': S.limit += 120; renderList(); break;
    case 'open': S.open = v; renderAll(); break;
    case 'close': S.open = null; renderAll(); break;
    case 'uncheck': S.checked.clear(); renderList(); break;
    case 'merge': mergeModal(); break;
    case 'add-folder': addFolder(); break;
    case 'rescan': busy('폴더를 확인하는 중…'); await rescan(v); busy(''); break;
    case 'rm-folder':
      modal('폴더 빼기', `<p>“${esc(base(v))}” 폴더를 서재에서 뺄까요?</p><p class="help">서재에 기록된 이 폴더의 작품 정보(메모·분류·성경 연결 포함)가 함께 사라집니다. PDF 파일 자체는 지워지지 않습니다.</p>`,
        [{ label: '취소' }, { label: '폴더 빼기', cls: 'danger', fn: async () => { try { setLib(await api('/api/library/folders', 'DELETE', { path: v })); renderAll(); toast('서재에서 뺐습니다.'); } catch (er) { toast(er.message, true); } } }]);
      break;
    case 'settings': settingsModal(); break;
    case 'status': { const w = work(S.open); queueSave(w.id, { status: v }); renderDrawer(); renderList(); break; }
    case 'ok-review': queueSave(S.open, { review: false }); renderAll(); break;
    case 'bible': bibleModal(work(S.open)); break;
    case 'note-search': noteSearchModal(); break;
    case 'note-open': openNote(work(v) ? work(v).title : '', v); break;
    case 'bookstore': bookstoreModal(work(S.open)); break;
    case 'fill-isbn': fillByIsbn(S.open); break;
    case 'find-isbn': findIsbnInPdf(S.open); break;
    case 'add-tag': {
      t.outerHTML = '<input class="tag-in" id="tagin" placeholder="태그 입력 후 Enter" />';
      const inp = $('#tagin'); inp.focus();
      const commit = () => { const val = inp.value.trim(); const w = work(S.open); if (val && w && !w.tags.includes(val)) queueSave(w.id, { tags: [...w.tags, val] }); renderDrawer(); renderList(); };
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } if (ev.key === 'Escape') renderDrawer(); });
      inp.addEventListener('blur', commit); break;
    }
    case 'rm-tag': { const w = work(S.open); queueSave(w.id, { tags: w.tags.filter((_, i) => i !== +v) }); renderDrawer(); renderList(); break; }
    case 'read': if (window.TLReader) window.TLReader.open({ fileId: v }); break;
    case 'open-pdf': { const f = fileById(v); const r = D && await D.openPdf(f.path); if (!r || !r.ok) toast('파일을 열 수 없습니다. 이동되었거나 삭제되었을 수 있습니다.', true); break; }
    case 'show-pdf': { const f = fileById(v); if (D && D.showInFolder) { const r = await D.showInFolder(f.path); if (r && !r.ok) toast('폴더를 찾을 수 없습니다. 이동되었거나 드라이브가 연결되어 있지 않을 수 있습니다.', true); else if (r && r.folderOnly) toast('파일은 없어서 폴더만 보여 드립니다.'); } else { try { await navigator.clipboard.writeText(f.path); toast('이 환경에서는 폴더를 열 수 없어 경로를 복사했습니다.'); } catch {} } break; }
    case 'copy-path': { const f = fileById(v); try { await navigator.clipboard.writeText(dirOf(f.path).replace(/\//g, /^[A-Za-z]:/.test(f.path) ? '\\' : '/')); toast('폴더 경로를 복사했습니다.'); } catch { toast('복사하지 못했습니다.', true); } break; }
    case 'detach':
      try { setLib(await api(`/api/library/files/${encodeURIComponent(v)}/detach`, 'POST')); renderAll(); toast('별도 작품으로 분리했습니다.'); } catch (er) { toast(er.message, true); } break;
    case 'del-work': { const w = work(S.open);
      modal('서재에서 제거', `<p>“${esc(w.title)}”을(를) 서재에서 제거할까요?</p><p class="help">서재의 기록만 지워지고 PDF 파일은 그대로 남습니다. 폴더를 다시 스캔하면 새 작품으로 다시 등록됩니다.</p>`,
        [{ label: '취소' }, { label: '제거', cls: 'danger', fn: async () => { try { setLib(await api('/api/library/works/' + encodeURIComponent(w.id), 'DELETE')); S.open = null; renderAll(); } catch (er) { toast(er.message, true); } } }]);
      break; }
  }
});
document.addEventListener('input', (e) => {
  const f = e.target.dataset && e.target.dataset.f; if (!f || !S.open) return;
  const w = work(S.open); let val = e.target.value;
  if (f === 'currentPage' || f === 'totalPages') {
    val = Math.max(0, parseInt(val, 10) || 0);
    queueSave(w.id, { [f]: val });
    if (w.totalPages > 0 && w.currentPage > w.totalPages) { w.currentPage = w.totalPages; }
    const p = $('#pct'); if (p) p.textContent = w.totalPages > 0 ? pct(w) + '%' : '';
    if (w.totalPages > 0 && w.currentPage >= w.totalPages && w.status !== 'finished') { queueSave(w.id, { status: 'finished' }); renderDrawer(); }
    else if (f === 'currentPage' && val > 0 && w.status === 'unread') { queueSave(w.id, { status: 'reading' }); renderDrawer(); }
  } else queueSave(w.id, { [f]: val });
  clearTimeout(window.__lt); window.__lt = setTimeout(renderList, 300);
});
document.addEventListener('keydown', (e) => {
  const typing = /input|textarea|select/i.test(document.activeElement && document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape' && !(window.TLReader && window.TLReader.isOpen())) { if ($('#modal')) closeModal(); else if (S.open && !typing) { S.open = null; renderAll(); } }
});

// ---------- 리더 연동 ----------
window.TL = {
  api, esc, D, work, filesOf, fileById, toast,
  applyRecord(out) {
    if (!out || !out.work) return;
    const i = S.lib.works.findIndex((w) => w.id === out.work.id); if (i >= 0) S.lib.works[i] = out.work;
    if (out.file) { const j = S.lib.files.findIndex((f) => f.id === out.file.id); if (j >= 0) S.lib.files[j] = out.file; }
    reindex();
    if (window.TLReader && window.TLReader.isOpen()) return;
    const ae = document.activeElement;
    if (ae && /input|textarea/i.test(ae.tagName) && $('#drawer').contains(ae)) renderList(); else renderAll();
  },
  afterReader() { renderAll(); },
};

// ---------- 시작 ----------
// ---------- 온라인 업데이트 (알림·진행 모두 사이드바 안에서) ----------
function updCard(html, cls) {
  let el = document.querySelector('.upd');
  if (!el) { el = document.createElement('div'); el.className = 'upd'; document.body.appendChild(el); }
  el.className = 'upd ' + (cls || ''); el.innerHTML = html; return el;
}
async function checkUpdate(force, quiet) {
  let c; try { c = await api('/api/update/check' + (force ? '?force=1' : '')); } catch { c = { available: false, error: '확인하지 못했습니다.' }; }
  if (S.updating) return c;
  document.querySelector('.upd')?.remove();
  if (c.available && c.latest) {
    const el = updCard(`<b>새 버전 ver${esc(c.latest.version)}</b><small>지금은 ver${esc((c.current || {}).version || '')}${c.latest.notes ? ' · ' + esc(c.latest.notes.split('\n')[0].slice(0, 60)) : ''}</small><div><button class="btn sm primary" data-upd="go">업데이트</button><button class="btn sm" data-upd="later">나중에</button></div>`);
    el.onclick = (e) => { const b = e.target.closest('[data-upd]'); if (!b) return; if (b.dataset.upd === 'later') el.remove(); else startUpdate(c); };
  }
  return c;
}
async function startUpdate(c) {
  S.updating = true; const ver = esc(c.latest.version);
  const show = (msg, pct) => updCard(`<b>ver${ver} 업데이트</b><small>${msg}</small>${pct != null ? `<div class="upd-bar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}`, 'busy');
  show('내려받는 중…', 0);
  try {
    let st = await api('/api/update/apply', 'POST', {});
    while (st.state === 'downloading') { await new Promise((r) => setTimeout(r, 600)); st = await api('/api/update/status'); show(`내려받는 중… ${Math.round((st.progress || 0) * 100)}%`, st.progress || 0); }
    if (st.state === 'ready') { show(c.canRestart ? '잠시 후 앱이 다시 시작됩니다.' : '내려받았습니다. 앱을 끄고 다시 실행해 주세요.', 1); return; }
    S.updating = false;
    const el = updCard(`<b>업데이트하지 못했습니다</b><small>${esc(st.error || '잠시 후 다시 시도해 주세요.')}</small><div><button class="btn sm primary" data-upd="go">다시 시도</button><button class="btn sm" data-upd="later">닫기</button></div>`, 'err');
    el.onclick = (e) => { const b = e.target.closest('[data-upd]'); if (!b) return; if (b.dataset.upd === 'later') el.remove(); else startUpdate(c); };
  } catch { show('앱이 다시 시작되는 중입니다…', 1); }   // 앱이 닫히면서 연결이 끊긴 경우
}
document.addEventListener('click', async (e) => {
  const bi = e.target.closest('#bk-import'); if (bi) { const f = document.getElementById('bk-file'); if (f) f.click(); return; }
  const b = e.target.closest('#upd-check'); if (!b) return; b.disabled = true; const msg = document.getElementById('upd-msg'); if (msg) msg.textContent = '확인하는 중…';
  const c = await checkUpdate(true); b.disabled = false;
  if (msg) msg.textContent = c.error ? c.error : c.available ? `새 버전 ver${c.latest.version}이 있습니다. 왼쪽 아래에서 업데이트하세요.` : '최신 버전입니다.';
});
(async function init() {
  renderShell();
  try {
    const [lib, ref, st] = await Promise.all([api('/api/library'), api('/api/catalog/reference'), api('/api/settings').catch(() => ({}))]);
    S.ref = ref; S.settings = st; setLib(lib);
    { const v = document.querySelector('.brand .ver'); if (v) v.textContent = 'ver' + (st.version || ''); }
  } catch (e) { $('#content').innerHTML = `<div class="empty"><div class="big">서재를 불러오지 못했습니다</div><p>${esc(e.message)}</p></div>`; return; }
  renderAll();
  refreshAll(); // 앱을 켤 때 연결된 폴더의 변경 사항을 조용히 반영
  setTimeout(loadSearchStatus, 1500);
  setTimeout(() => checkUpdate(false, true), 4000);
  syncFill().then(() => { if (fillJob.running && !fillPoll) fillPoll = setInterval(() => syncFill(), 2500); });
})();

// ---------- 백업에서 되돌리기 ----------
document.addEventListener('change', async (e) => {
  const f = e.target; if (!f || f.id !== 'bk-file' || !f.files || !f.files[0]) return;
  const file = f.files[0]; let obj;
  try { obj = JSON.parse(await file.text()); } catch { toast('백업 파일을 읽지 못했습니다. 올바른 파일인지 확인해 주세요.', true); return; }
  const n = obj && obj.library && Array.isArray(obj.library.works) ? obj.library.works.length : -1;
  if (!obj || obj.app !== 'theologia-library' || n < 0) { toast('이 앱에서 만든 백업 파일이 아닙니다.', true); return; }
  modal('백업에서 되돌리기', `<p>“${esc(file.name)}”의 서재 기록(작품 ${num(n)}권)으로 되돌릴까요?</p><p class="help">지금의 기록은 데이터 폴더에 <b>library.before-restore.json</b>으로 한 번 남겨 둡니다. 책 파일은 건드리지 않습니다.</p>`,
    [{ label: '취소' }, { label: '되돌리기', cls: 'primary', fn: async () => {
      busy('되돌리는 중…');
      try { const r = await api('/api/backup/import', 'POST', obj); setLib(r.library); S.checked.clear(); S.open = null; renderAll(); renderSide(); toast(`백업에서 되돌렸습니다. 작품 ${num(r.library.works.length)}권.`); }
      catch (err) { toast(err.message, true); } finally { busy(''); }
    } }]);
});
})();
