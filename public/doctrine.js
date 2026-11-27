// 교리·신조: 하이델베르크 요리문답 같은 문서를 주일/장별로 펼쳐 놓고, 문답마다 메모를 쓴다.
// 문서는 data\교리\ 에 JSON 으로 두고(t9hb 저장소와 같은 형식 — 소요리문답·도르트·벨직도 같은 형식), 메모는 data\교리메모.json 에 따로 저장된다. (서버: doctrine.js)
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TL = () => window.TL;
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let ov = null, ST = null;   // ST: { docs, cur, data, unit, mode, hits, q }

const lines = (ls, notes) => (ls || []).map((l) => `<div class="dc-ln" style="padding-left:${(l.i || 0) * 1.1}em">${(l.s || []).map((x) => typeof x === 'number' ? `<sup class="dc-fn" title="${esc((notes || {})[x] || '')}">${x}</sup>` : esc(x)).join('')}</div>`).join('');
const plain = (ls) => (ls || []).map((l) => (l.s || []).filter((x) => typeof x === 'string').join('')).join(' ');
const label = (e, it) => `제${it.no}${e.itemLabel}`;
const entry = () => ST.docs.find((d) => d.id === ST.cur);

async function open() {
  if (ov) return;
  ov = document.createElement('div'); ov.id = 'doc-ov';
  ov.innerHTML = '<div class="dc-top"><button class="btn sm" data-d="close">← 서재로</button><div class="dc-tabs" id="dc-tabs"></div><input id="dc-q" type="search" placeholder="본문·성구·메모 검색" autocomplete="off"><button class="btn sm" data-d="memos">메모 모아보기</button><button class="btn sm" data-d="src" title="문서 받기·가져오기">자료 ⋯</button></div><div class="dc-body"><nav id="dc-nav"></nav><main id="dc-main"></main></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', onClick); ov.addEventListener('input', onInput); ov.addEventListener('focusout', onBlur);
  document.addEventListener('keydown', onKey, true);
  ST = { docs: [], cur: LS.get('tl-doc', {}).doc || '', data: null, unit: LS.get('tl-doc', {}).unit || 0, mode: 'read', hits: [], q: '' };
  await reload();
}
function close() { if (!ov) return; flushAll(); document.removeEventListener('keydown', onKey, true); ov.remove(); ov = null; ST = null; }
function onKey(e) { if (e.key === 'Escape' && ov && !$('.modal-bg, .modal')) { e.stopPropagation(); close(); } }

async function reload() {
  try { ST.docs = (await TL().api('/api/doctrine')).docs; } catch (e) { TL().toast(e.message, true); ST.docs = []; }
  if (!ST.docs.length) { renderTabs(); $('#dc-nav').innerHTML = ''; $('#dc-main').innerHTML = emptyHtml(); return; }
  if (!ST.docs.some((d) => d.id === ST.cur)) ST.cur = ST.docs[0].id;
  await pick(ST.cur, ST.unit);
}
function emptyHtml() {
  return '<div class="dc-empty"><h3>교리·신조</h3><p>아직 넣어 둔 문서가 없습니다. 하이델베르크 요리문답 같은 문서를 넣으면 주일(장)별로 펼쳐 보고, 문답마다 메모를 쓸 수 있습니다. 소요리문답·도르트 신조·벨직 신앙고백서도 같은 형식으로 계속 넣을 수 있습니다.</p><p><button class="btn primary" data-d="fetch">t9hb 저장소에서 받기</button> <button class="btn" data-d="file">JSON 파일로 가져오기</button></p><p class="help">문서는 <code>data\\교리\\</code> 폴더에 JSON 으로 저장되고, 메모는 <code>data\\교리메모.json</code> 에 따로 모입니다. 메모는 문서를 다시 받아도 지워지지 않습니다.</p></div>';
}
function renderTabs() {
  $('#dc-tabs').innerHTML = ST.docs.map((d) => `<button class="dc-tab${d.id === ST.cur ? ' on' : ''}" data-d="doc" data-id="${esc(d.id)}" title="${esc(d.title)}">${esc(d.short)}${d.memos ? ` <span>${d.memos}</span>` : ''}</button>`).join('');
}
async function pick(id, unit) {
  ST.cur = id; ST.mode = 'read';
  try { ST.data = await TL().api('/api/doctrine/' + encodeURIComponent(id)); } catch (e) { TL().toast(e.message, true); return; }
  const us = ST.data.doc.units; if (!us.some((u) => u.no === unit)) unit = us[0].no;
  ST.unit = unit; save(); renderTabs(); renderNav(); renderUnit();
}
const save = () => LS.set('tl-doc', { doc: ST.cur, unit: ST.unit });
function renderNav() {
  const d = ST.data.doc, m = ST.data.memos; let h = '', part = null;
  const partOf = new Map(); for (const p of d.parts || []) for (const n of p.units) partOf.set(n, p.title);
  for (const u of d.units) {
    const pt = partOf.get(u.no) || u.part || '';
    if (pt && pt !== part) { part = pt; h += `<div class="dc-part">${esc(pt)}</div>`; }
    const n = u.items.filter((it) => m[u.no + ':' + it.no]).length;
    h += `<button class="dc-u${u.no === ST.unit && ST.mode === 'read' ? ' on' : ''}" data-d="unit" data-u="${u.no}">${esc(u.title || u.no)}${n ? ` <span>${n}</span>` : ''}</button>`;
  }
  $('#dc-nav').innerHTML = h;
}
function renderUnit(focusItem) {
  const d = ST.data.doc, e = entry(), m = ST.data.memos; const u = d.units.find((x) => x.no === ST.unit); if (!u) return;
  const idx = d.units.indexOf(u);
  let h = `<div class="dc-uh"><h2>${esc(u.title || u.no)}</h2>${u.part ? `<small>${esc(u.part)}</small>` : ''}</div>`;
  for (const it of u.items) {
    const key = u.no + ':' + it.no, notes = it.notes || {}, ks = Object.keys(notes).sort((a, b) => a - b);
    h += `<section class="dc-it" id="dc-i${it.no}" data-n="${it.no}">${it.heading ? `<div class="dc-hd">${esc(it.heading)}</div>` : ''}
      <div class="dc-q"><b class="dc-no">${label(e, it)}</b>${lines(it.q, notes)}</div>
      <div class="dc-a"><b class="dc-no">답</b>${lines(it.a, notes)}</div>
      ${ks.length ? `<details class="dc-refs"><summary>성구 ${ks.length}</summary>${ks.map((k) => `<div><sup>${k}</sup> ${esc(notes[k])}</div>`).join('')}</details>` : ''}
      <div class="dc-memo"><textarea data-u="${u.no}" data-n="${it.no}" rows="${m[key] ? Math.min(12, 2 + String(m[key].t).split('\n').length) : 2}" placeholder="이 ${esc(e.itemLabel)}에 대한 메모">${esc(m[key] ? m[key].t : '')}</textarea><small class="dc-st"></small></div>
    </section>`;
  }
  h += `<div class="dc-pn"><button class="btn sm" data-d="prev" ${idx ? '' : 'disabled'}>← 이전</button><button class="btn sm" data-d="next" ${idx < d.units.length - 1 ? '' : 'disabled'}>다음 →</button></div>`;
  if (d.credit) h += `<p class="dc-credit">${esc(d.credit)}</p>`;
  const main = $('#dc-main'); main.innerHTML = h; main.scrollTop = 0;
  if (focusItem) { const el = $('#dc-i' + focusItem); if (el) { el.scrollIntoView({ block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800); } }
}

// ----- 메모 저장 -----
const timers = new Map();
function onInput(e) {
  const t = e.target;
  if (t.id === 'dc-q') { clearTimeout(timers.get('q')); timers.set('q', setTimeout(runSearch, 250)); return; }
  if (!t.matches || !t.matches('.dc-memo textarea')) return;
  const k = t.dataset.u + ':' + t.dataset.n; $('.dc-st', t.parentNode).textContent = '…';
  clearTimeout(timers.get(k)); timers.set(k, setTimeout(() => saveMemo(t), 700));
}
function onBlur(e) { const t = e.target; if (t.matches && t.matches('.dc-memo textarea')) { const k = t.dataset.u + ':' + t.dataset.n; if (timers.has(k)) { clearTimeout(timers.get(k)); timers.delete(k); saveMemo(t); } } }
async function saveMemo(t) {
  const st = ST; if (!st) return; const id = st.cur, u = +t.dataset.u, n = +t.dataset.n, key = u + ':' + n, text = t.value;
  try {
    await TL().api('/api/doctrine/' + encodeURIComponent(id) + '/memo', 'PUT', { u, n, text });
    if (text.trim()) st.data.memos[key] = { t: text, at: new Date().toISOString() }; else delete st.data.memos[key];
    const e = st.docs.find((x) => x.id === id); if (e) e.memos = Object.keys(st.data.memos).length;
    if (ST === st) { const s = $('.dc-st', t.parentNode); if (s) s.textContent = text.trim() ? '저장됨' : ''; renderTabs(); renderNav(); }
  } catch (er) { TL().toast('메모를 저장하지 못했습니다: ' + er.message, true); }
}
function flushAll() { if (!ov) return; ov.querySelectorAll('.dc-memo textarea').forEach((t) => { const k = t.dataset.u + ':' + t.dataset.n; if (timers.has(k)) { clearTimeout(timers.get(k)); timers.delete(k); saveMemo(t); } }); }

// ----- 검색 · 메모 모아보기 -----
async function runSearch() {
  const q = $('#dc-q').value.trim(); ST.q = q;
  if (!q) { if (ST.mode === 'search') { ST.mode = 'read'; renderNav(); renderUnit(); } return; }
  flushAll();
  let r; try { r = await TL().api('/api/doctrine/search?q=' + encodeURIComponent(q)); } catch (e) { TL().toast(e.message, true); return; }
  if ($('#dc-q').value.trim() !== q) return;
  ST.mode = 'search'; ST.hits = r.items; renderNav();
  $('#dc-main').innerHTML = `<div class="dc-uh"><h2>검색 결과</h2><small>${r.items.length}건</small></div>` + (r.items.length ? r.items.map((x, i) => `<button class="dc-hit" data-d="hit" data-i="${i}"><b>${esc(x.short)} · ${esc(x.unitTitle)} · 제${x.item}${esc(x.itemLabel)}</b><span>${esc(x.q.slice(0, 120))}</span>${x.memo ? `<em>${esc(x.memo.slice(0, 160))}</em>` : ''}</button>`).join('') : '<p class="help">찾지 못했습니다.</p>');
}
async function showMemos() {
  flushAll(); $('#dc-q').value = ''; ST.mode = 'memos';
  let r; try { r = await TL().api('/api/doctrine/search?memo=1'); } catch (e) { TL().toast(e.message, true); return; }
  ST.hits = r.items; renderNav();
  const by = new Map(); r.items.forEach((x, i) => { if (!by.has(x.doc)) by.set(x.doc, []); by.get(x.doc).push([x, i]); });
  let h = `<div class="dc-uh"><h2>메모 모아보기</h2><small>${r.items.length}건</small> <button class="btn sm" data-d="copy">마크다운으로 복사</button></div>`;
  if (!r.items.length) h += '<p class="help">아직 쓴 메모가 없습니다. 문답 아래 메모 칸에 쓰면 여기에 모입니다.</p>';
  for (const list of by.values()) { h += `<h3 class="dc-bk">${esc(list[0][0].docTitle)}</h3>`; for (const [x, i] of list) h += `<button class="dc-hit" data-d="hit" data-i="${i}"><b>${esc(x.unitTitle)} · 제${x.item}${esc(x.itemLabel)}</b><span>${esc(x.q.slice(0, 100))}</span><em>${esc(x.memo)}</em></button>`; }
  $('#dc-main').innerHTML = h;
}
function memosMd() {
  let md = '', cur = '';
  for (const x of ST.hits) { if (x.docTitle !== cur) { cur = x.docTitle; md += `\n## ${cur}\n`; } md += `\n### ${x.unitTitle} 제${x.item}${x.itemLabel}\n> ${x.q}\n\n${x.memo}\n`; }
  return md.trim() + '\n';
}

// ----- 자료 받기·가져오기 -----
async function fetchRemote() {
  const t = TL(); t.toast('t9hb 저장소에서 받는 중…');
  try { const r = await t.api('/api/doctrine/fetch', 'POST', {}); t.toast(`${r.got.length}개 문서를 받았습니다.${r.failed.length ? ' 실패: ' + r.failed.join(', ') : ''}`, !!r.failed.length); await reload(); }
  catch (e) { t.toast('받지 못했습니다: ' + e.message, true); }
}
function fromFile() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json'; inp.multiple = true;
  inp.onchange = async () => {
    const docs = []; for (const f of inp.files) { try { docs.push(JSON.parse(await f.text())); } catch { TL().toast(f.name + ': JSON 이 아닙니다.', true); return; } }
    if (!docs.length) return;
    try { const r = await TL().api('/api/doctrine/import', 'POST', docs); TL().toast(`${r.got.length}개 문서를 넣었습니다.`); await reload(); } catch (e) { TL().toast(e.message, true); }
  };
  inp.click();
}
function srcMenu(btn) {
  const old = $('.dc-menu'); if (old) { old.remove(); return; }
  const m = document.createElement('div'); m.className = 'dc-menu';
  m.innerHTML = '<button data-d="fetch">t9hb 저장소에서 문서 받기·갱신</button><button data-d="file">JSON 파일로 가져오기</button><small>문서를 새로 받아도 메모는 그대로 남습니다.</small>';
  btn.after(m);
}

function onClick(e) {
  const b = e.target.closest('[data-d]'); if (!b) { const m = $('.dc-menu'); if (m && !e.target.closest('.dc-menu')) m.remove(); return; }
  const a = b.dataset.d;
  if (a !== 'src') { const m = $('.dc-menu'); if (m) m.remove(); }
  switch (a) {
    case 'close': close(); break;
    case 'doc': flushAll(); $('#dc-q').value = ''; pick(b.dataset.id, 0); break;
    case 'unit': flushAll(); $('#dc-q').value = ''; ST.mode = 'read'; ST.unit = +b.dataset.u; save(); renderNav(); renderUnit(); break;
    case 'prev': case 'next': { flushAll(); const us = ST.data.doc.units, i = us.findIndex((u) => u.no === ST.unit) + (a === 'next' ? 1 : -1); if (us[i]) { ST.unit = us[i].no; save(); renderNav(); renderUnit(); } break; }
    case 'hit': { const x = ST.hits[+b.dataset.i]; if (!x) break; flushAll(); const go = async () => { $('#dc-q').value = ''; if (ST.cur !== x.doc) await pick(x.doc, x.unit); ST.mode = 'read'; ST.unit = x.unit; save(); renderNav(); renderUnit(x.item); }; go(); break; }
    case 'memos': showMemos(); break;
    case 'copy': navigator.clipboard.writeText(memosMd()).then(() => TL().toast('메모를 복사했습니다.'), () => TL().toast('복사하지 못했습니다.', true)); break;
    case 'src': srcMenu(b); break;
    case 'fetch': fetchRemote(); break;
    case 'file': fromFile(); break;
  }
}
window.TLDoctrine = { open, close };
})();
