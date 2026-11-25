// 노트성경: 읽는 화면 오른쪽(사이드)에 붙는 패널. 한 장을 절 순서로 펼쳐 놓고, 절마다 메모 카드를 붙여 가며 쓴다.
// 메모는 노트 폴더의 '그 장 파일'(예: 로마서 03장.md)에 카드로 저장된다. 파일이 없으면 새로 만들고, 있으면 기존 내용은 그대로 두고 덧붙인다.
// 구절 본문은 장 파일의 글, 없으면 앱에 들어 있는 개역한글(공개 도메인)을 보여 준다. (서버: biblenote.js)
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TL = () => window.TL;
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const W = 460;
let META = null, EL = null, ST = null;     // ST: { book, ch, data }

function pageTag() {
  const i = $('#r-page'); const p = i ? parseInt(i.value, 10) : 0; const pr = $('#r-print');
  const printed = pr && pr.textContent ? pr.textContent.replace(/[^0-9ivxlcdm]/gi, '') : '';
  return p > 0 ? (printed ? `p.${printed}` : `PDF ${p}쪽`) : '';
}
function selectedText() {
  let t = String(window.getSelection() || '').trim();
  if (!t) { const f = $('#e-frame'); try { t = String(f && f.contentWindow.getSelection() || '').trim(); } catch {} }
  return t.replace(/\s+/g, ' ');
}
function readingContext() {
  const t = TL(); const id = window.__tlReadWork; const w = id && t && t.work ? t.work(id) : null;
  if (!w || !$('.reader .r-bar')) return null;
  const pg = pageTag();
  return { title: w.title, source: w.title + (pg ? ' · ' + pg : ''), books: w.bibleBooks || [] };
}
async function loadMeta() { if (!META) META = await TL().api('/api/notes/bible/meta'); return META; }
const rich = (s) => esc(s).replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '<span class="wl">$2</span>').replace(/\[\[([^\]]*)\]\]/g, '<span class="wl">$1</span>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const paras = (t) => String(t || '').split('\n').filter((x) => x.trim()).map((x) => `<p>${rich(x)}</p>`).join('');
const legacyHtml = (t) => String(t || '').split('\n').filter((x) => x.trim()).map((x) => { const m = /^>\s*\[!([a-z]+)\]-?\s*(.*)$/i.exec(x); if (m) return `<div class="lt">${esc(m[2] || m[1])}</div>`; return `<p>${rich(x.replace(/^>\s?/, ''))}</p>`; }).join('');
const plain = (s) => String(s || '').replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');

function style() {
  if ($('#bn-style')) return;
  const s = document.createElement('style'); s.id = 'bn-style';
  s.textContent = `#bn-panel{width:${W}px}body.bn-open #app{margin-right:${W}px}body.bn-open .reader{right:${W}px}
#bn-panel .bn-top{padding:8px 12px;border-bottom:1px solid #0002;display:flex;flex-direction:column;gap:6px}
#bn-panel .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}#bn-panel label{font-size:12px;color:#777}
#bn-panel input[type=number]{width:62px}#bn-panel select{max-width:150px}#bn-panel input[type=text]{flex:1;min-width:110px}
#bn-panel .bn-list{flex:1;min-height:0;overflow:auto;padding:4px 12px 40px}
#bn-panel .bv{padding:8px 0;border-bottom:1px solid #0001}#bn-panel .hd{font-weight:700;margin:12px 0 2px;color:#006199}
#bn-panel .vt{line-height:1.7}#bn-panel .vt b.n{color:#006199;margin-right:5px}
#bn-panel .mc{margin:6px 0 0 14px;border:1px dashed #0003;border-radius:10px;padding:4px 10px;background:#fffdf5}
#bn-panel .mc>summary{cursor:pointer;display:flex;gap:6px;align-items:center;font-size:12px;list-style:none}
#bn-panel .mc>summary::-webkit-details-marker{display:none}#bn-panel .mc>summary::before{content:"▾";color:#006199}#bn-panel .mc:not([open])>summary::before{content:"▸"}
#bn-panel .lb{font-size:11px;font-weight:700;color:#fff;background:#006199;border-radius:8px;padding:0 7px}#bn-panel .rg{font-size:11px;border:1px solid #006199;color:#006199;border-radius:8px;padding:0 6px}
#bn-panel .mc .ac{margin-left:auto;display:flex;gap:2px}#bn-panel .mc .ac button{font-size:12px;padding:0 5px;opacity:.6}#bn-panel .mc .ac button:hover{opacity:1}
#bn-panel .mb2{font-size:13.5px;line-height:1.65}#bn-panel .mb2 p{margin:.3em 0}#bn-panel .wl{color:#006199;text-decoration:underline dotted}
#bn-panel .lg{margin:6px 0 0 14px;font-size:12px}#bn-panel .lg>summary{cursor:pointer;color:#777}
#bn-panel .add{margin:6px 0 0 14px}#bn-panel .add>button{font-size:12px;opacity:.75}
#bn-panel .ef{margin:6px 0 0 14px;border:1px solid #006199;border-radius:10px;padding:8px;background:#fff}
#bn-panel .ef textarea{width:100%;min-height:110px;box-sizing:border-box;font:13.5px/1.6 "Noto Sans KR",sans-serif;resize:vertical;margin:6px 0;color:#222;background:#fff;-webkit-text-fill-color:#222}
#bn-panel .lg2{border-style:solid;border-color:#0002;background:#f6f6f6}#bn-panel .lg2 .lb{background:#888}#bn-panel .lt{font-weight:700;font-size:12px;color:#666;margin-top:4px}
#bn-panel .mn{margin:6px 0 0 14px;font-size:12px}#bn-panel .mn>summary{cursor:pointer;color:#777}#bn-panel .mi{padding:3px 0 3px 8px;border-left:3px solid #00619955;margin:3px 0;cursor:default}#bn-panel .mi[data-go]{cursor:pointer}#bn-panel .mi[data-go]:hover{background:#00619912}#bn-panel .mi b{color:#006199}
#bn-panel .vt b.n{cursor:pointer}#bn-panel .bv.hl{background:#fff6c8;transition:background 2s}#bn-panel .src{font-size:11px;color:#888;padding:6px 0 2px}#bn-panel .only{font-size:12px;padding:6px 0;color:#006199}#bn-panel .only a{cursor:pointer;text-decoration:underline}
#bn-panel .res{font-size:12px;color:#555}#bn-panel .hint{font-size:12px;color:#888;padding:10px 0}`;
  document.head.appendChild(s);
}
function close() { if (!EL) return; EL.remove(); EL = null; ST = null; document.body.classList.remove('bn-open'); if (!$('#rn-panel')) document.body.classList.remove('rn-open'); window.dispatchEvent(new Event('resize')); }

async function open(opts = {}) {
  const t = TL(); if (!t || EL) return;
  let meta; try { meta = await loadMeta(); } catch (e) { t.toast(e.message, true); return; }
  style();
  if (window.TLReadNote && window.TLReadNote.isOpen()) window.TLReadNote.toggle();
  const ctx = readingContext();
  const last = LS.get('tl.bn.last', { book: 45, chapter: 1 });
  const byName = ctx ? meta.books.find((b) => (ctx.books || []).includes(b.name)) : null;
  const sel0 = byName ? { book: byName.id, chapter: (last.book === byName.id ? last.chapter : 1) } : last;
  const el = document.createElement('aside'); el.id = 'bn-panel'; el.className = 'rn-panel';
  el.innerHTML = `<div class="rn-head"><b>✎ 성경 노트</b><span id="bn-tag" style="font-size:11px;color:#888;margin-left:6px"></span><span class="rn-save"></span><button class="btn sm" data-bn="dir" title="성경 노트 저장 폴더">📁</button><button class="btn sm" data-bn="close" title="닫기 (Ctrl+Shift+E)">✕</button></div>`;
  document.body.appendChild(el); EL = el; document.body.classList.add('rn-open', 'bn-open'); window.dispatchEvent(new Event('resize'));

  if (!meta.notesDir || opts.picker) {                     // 처음 쓸 때(또는 📁): 성경 노트를 저장할 폴더 고르기
    const box = document.createElement('div'); box.className = 'bn-top';
    box.innerHTML = `<p style="margin:4px 0">성경 노트를 저장할 <b>폴더</b>를 ${meta.notesDir ? '바꿀 수 있습니다' : '먼저 정해 주세요'}.</p>
      <p style="font-size:12px;color:#777;margin:0">장마다 .md 파일이 이 폴더 안에 만들어집니다. 옵시디언에서 이 폴더를 열면 그대로 보입니다. 이 폴더는 앱의 일반 노트 폴더(설정)와 별개이고, 서로 영향을 주지 않습니다. 이미 성경 66권 노트 폴더가 있으면 그 폴더를 고르세요. 기존 파일은 지우거나 고치지 않고 메모만 덧붙입니다.</p>
      <div class="row"><input id="bn-dir" type="text" placeholder="성경 노트 폴더 경로" value="${esc(meta.notesDir || '')}"><button class="btn sm" data-bn="pick">고르기…</button></div>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#555"><input id="bn-fill" type="checkbox" ${LS.get('tl.bn.fill', true) ? 'checked' : ''}> 새 장 파일을 만들 때 개역한글 본문도 함께 써 넣기</label>
      <div class="row"><button class="btn primary" data-bn="setdir">이 폴더로 정하기</button>${meta.notesDir ? '<button class="btn" data-bn="cancel">취소</button>' : ''}</div><div class="res" id="bn-res"></div>`;
    el.appendChild(box);
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-bn]'); if (!b) return; const k = b.dataset.bn;
      if (k === 'close') close();
      if (k === 'cancel') { close(); open(); }
      if (k === 'pick') { try { const r = await window.theologiaDesktop.selectFolder('노트 폴더 선택'); if (r && !r.canceled) $('#bn-dir', el).value = r.folder; } catch { t.toast('폴더 선택 창을 열 수 없습니다. 경로를 직접 적어 주세요.', true); } }
      if (k === 'setdir') {
        LS.set('tl.bn.fill', $('#bn-fill', el).checked);
        const v = $('#bn-dir', el).value.trim(); if (!v) { $('#bn-res', el).textContent = '폴더 경로를 적어 주세요.'; return; }
        try { await t.api('/api/settings', 'PUT', { BIBLE_NOTES_DIR: v }); META = null; close(); open(); } catch (er) { $('#bn-res', el).textContent = er.message; }
      }
    });
    return;
  }

  const srcs = LS.get('tl.bn.src', []);
  const top = document.createElement('div'); top.className = 'bn-top';
  top.innerHTML = `<div class="row"><button class="btn sm" data-bn="prev" title="이전 장">◀</button><select id="bn-book">${meta.books.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
      <input id="bn-ch" type="number" min="1" value="${sel0.chapter}"><label id="bn-unit">장</label><button class="btn sm" data-bn="next" title="다음 장">▶</button><span class="res" id="bn-info" style="margin-left:auto"></span></div>
    <div class="row"><label>출처</label><input id="bn-src" type="text" list="bn-srcl" value="${esc(opts.source != null ? opts.source : (ctx ? ctx.source : ''))}" placeholder="새 메모의 출처 · 예: 로마서 주석 · p.123"><datalist id="bn-srcl">${srcs.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <button class="btn sm" data-bn="page" title="출처에 지금 보는 쪽을 넣습니다">지금 쪽</button><button class="btn sm" data-bn="quote" title="읽는 화면에서 드래그한 글을 열린 메모 칸에 인용으로 넣습니다">선택 글 인용</button></div>
    <div class="row"><label>본문</label><select id="bn-tx"><option value="auto">노트 파일 글 우선</option><option value="krv">개역한글</option></select><input id="bn-find" type="text" placeholder="구절 이동 · 예: 롬 3:24" style="max-width:160px"></div>`;
  const list = document.createElement('div'); list.className = 'bn-list'; el.append(top, list);
  $('#bn-book', el).value = String(sel0.book);
  
  const chI = $('#bn-ch', el), bk = $('#bn-book', el), srcI = $('#bn-src', el), info = $('#bn-info', el);
  const TX = () => $('#bn-tx', el).value;
  const vtext = (v) => { const x = TX(); if (x === 'krv') return v.krv || v.text; if (x.startsWith('t:')) return (v.trans && v.trans[x.slice(2)]) || v.text || v.krv; return v.text || v.krv; };
  function txOptions(d) {                       // 파일의 '다른 번역' 칸에 있는 번역 이름을 본문 선택에 더함
    const sel = $('#bn-tx', el), want = LS.get('tl.bn.tx', 'auto');
    const own = d.verses.some((v) => v.text);       // 파일에 본문이 있으면 개역한글 선택은 감춘다
    sel.innerHTML = '<option value="auto">노트 파일 본문' + (own ? '' : ' (없으면 개역한글)') + '</option>' + (own ? '' : '<option value="krv">개역한글</option>') + (d.translations || []).map((n) => `<option value="t:${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === want) ? want : 'auto';
  }
  const book = () => meta.books.find((b) => b.id === +bk.value);
  let busy = 0, want = 0;
  async function jump(b, c, v) { bk.value = String(b); chI.value = c; if (ST) ST.only = 0; want = v || 0; await load(); }

  async function load(keepScroll) {
    const b = book(), ch = +chI.value; $('#bn-unit', el).textContent = b.unit; chI.max = b.chapters;
    if (!(ch >= 1 && ch <= b.chapters)) { list.innerHTML = `<div class="hint">${esc(b.name)}은(는) ${b.chapters}${b.unit}까지 있습니다.</div>`; return; }
    const my = ++busy; let d; try { d = await t.api(`/api/notes/bible/view?book=${b.id}&chapter=${ch}`); } catch (e) { list.innerHTML = `<div class="hint">${esc(e.message)}</div>`; return; }
    if (my !== busy || !EL) return;
    LS.set('tl.bn.last', { book: b.id, chapter: ch }); ST = { book: b.id, ch, data: d, only: (ST && ST.book === b.id && ST.ch === ch) ? ST.only : 0 };
    const n = d.verses.reduce((a, v) => a + v.cards.length, 0) + d.chapter.cards.length;
    info.textContent = d.exists ? `${d.name} · 메모 ${n}개` : '파일 없음 (저장하면 새로 만듦)';
    txOptions(d); const sc = list.scrollTop; list.innerHTML = render(d); { const g = $('#bn-tag', el); if (g) g.textContent = d.verses.some((v) => v.text) ? '' : '개역한글'; } list.scrollTop = keepScroll ? sc : 0;
    if (want) { const e = $('#bv-' + want, list); want = 0; if (e) { e.scrollIntoView({ block: 'start' }); e.classList.add('hl'); setTimeout(() => e.classList.remove('hl'), 2200); } }
  }
  function card(v, c, i) {
    const range = v && c.end ? `${v}-${c.end}절` : '';
    return `<details class="mc" open data-v="${v}" data-i="${i}"><summary><span class="lb">${esc(c.source || '메모')}</span>${range ? `<span class="rg">${range}</span>` : ''}<span class="ac"><button data-bn="edit" title="고치기">✎</button><button data-bn="del" title="삭제">🗑</button></span></summary><div class="mb2">${paras(c.body)}</div></details>`;
  }
  function render(d) {
    const chunk = (v, o) => (o.legacy ? `<details class="mc lg2" open><summary><span class="lb">기존 메모</span><span class="res">옵시디언·웹 보기에서 고칩니다</span></summary><div class="mb2">${legacyHtml(o.legacy)}</div></details>` : '') + o.cards.map((c, i) => card(v, c, i)).join('') + (o.mentions && o.mentions.length ? `<details class="mn"><summary>이 절을 언급한 곳 (${o.mentions.length})</summary>${o.mentions.map((m) => `<div class="mi"${m.go ? ` data-go="${m.go.book},${m.go.chapter},${m.go.verse}"` : ''}><b>${esc(m.file)}</b> ${esc(m.text)}</div>`).join('')}</details>` : '') + `<div class="add" data-v="${v}"><button class="btn sm" data-bn="add">＋ ${v ? v + '절' : '장 전체'} 메모</button></div>`;
    const onlyV = ST && ST.only;
    const anyT = d.verses.some((v) => v.text), X = TX(), tx = X === 'krv' ? '개역한글' : X.startsWith('t:') ? X.slice(2) + ' (노트 파일의 다른 번역 칸)' : !anyT ? '개역한글' : '노트 파일 본문 (파일에 없는 절은 개역한글)';
    let h = `<div class="src">본문 · ${tx}</div>` + (d.exists ? '' : `<label class="src" style="display:flex;gap:6px;align-items:center;color:#006199"><input type="checkbox" id="bn-fill2" ${LS.get('tl.bn.fill', true) ? 'checked' : ''}> 이 장 파일을 새로 만들 때 개역한글 본문도 함께 저장</label>`) + (onlyV ? `<div class="only">${onlyV}절만 보는 중 · <a data-bn="all">전체 보기</a></div>` : '') + (onlyV ? '' : `<div class="bv"><div class="vt"><b class="n">장 전체</b></div>${chunk(0, d.chapter)}</div>`);
    if (!d.verses.length) h += `<div class="hint">${d.exists ? '이 장 파일에는 절 구역(### N절)이 아직 없습니다.' : `${esc(d.name)} 파일이 아직 없습니다.`} 아래에 절 번호를 적고 메모를 추가하면 만들어집니다.</div><div class="row" style="padding:0 0 12px"><input id="bn-nv" type="number" min="1" placeholder="절" style="width:70px"><button class="btn sm" data-bn="newv">＋ 이 절에 메모</button></div>`;
    for (const v of d.verses.filter((x) => !onlyV || x.n === onlyV)) h += `${v.head ? `<div class="hd">${rich(v.head)}</div>` : ''}<div class="bv" id="bv-${v.n}"><div class="vt"><b class="n" title="이 절만 보기">${v.n}</b>${esc(vtext(v))}</div>${chunk(v.n, v)}</div>`;
    return h;
  }
  const closeEditors = () => el.querySelectorAll('[data-ed="1"]').forEach((x) => x.remove());
  function editor(host, v, init, onsave) {
    closeEditors();
    const f = document.createElement('div'); f.className = 'ef'; f.dataset.ed = '1';
    f.innerHTML = `<div class="row"><label>출처</label><input class="s" type="text" list="bn-srcl" value="${esc(init.source)}">${v ? `<label>범위 끝 절</label><input class="e" type="number" min="${v + 1}" value="${init.end || ''}" placeholder="없음">` : ''}</div><textarea spellcheck="false" placeholder="이 구절에 대해 쓸 내용. 구절 표기(롬 3:23, 5:12)는 자동으로 링크됩니다. (Ctrl+Enter 저장)">${esc(init.text)}</textarea>
      <div class="row"><button class="btn primary sm" data-ed="save">저장</button><button class="btn sm" data-ed="cancel">취소</button><label style="margin-left:auto"><input class="lk" type="checkbox" checked> 구절 자동 링크</label></div><div class="res"></div>`;
    host.after(f); const ta = $('textarea', f); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const go = async () => {
      const text = ta.value.trim(); const res = $('.res', f); if (!text) { res.textContent = '메모 내용을 적어 주세요.'; return; }
      const fields = { source: $('.s', f).value.trim(), end: $('.e', f) && $('.e', f).value ? +$('.e', f).value : 0, text, link: $('.lk', f).checked };
      res.textContent = '저장 중…';
      try {
        const r = await onsave(fields);
        if (fields.source) LS.set('tl.bn.src', [fields.source, ...LS.get('tl.bn.src', []).filter((x) => x !== fields.source)].slice(0, 20));
        f.remove(); await load(true); if (r && r.added && r.added.length) info.textContent = '링크: ' + r.added.join(' · ');
      } catch (er) { res.textContent = '저장 안 됨: ' + er.message; }
    };
    f.addEventListener('click', (e) => { const b = e.target.closest('button[data-ed]'); if (!b) return; if (b.dataset.ed === 'save') go(); else f.remove(); });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  const post = (m, body) => t.api('/api/notes/bible', m, body);

  el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-bn=page],[data-bn=quote]')) e.preventDefault(); });   // 읽는 화면의 선택을 풀지 않게
  el.addEventListener('click', (ev) => {
    const mi = ev.target.closest('.mi[data-go]'); if (mi) { const [gb, gc, gv] = mi.dataset.go.split(',').map(Number); jump(gb, gc, gv); return; }
    const vn = ev.target.closest('.vt b.n'); if (vn && !vn.textContent.includes('장')) { const n = +vn.textContent; ST.only = ST.only === n ? 0 : n; list.innerHTML = render(ST.data); if (ST.only) list.scrollTop = 0; return; }
    const b = ev.target.closest('[data-bn]'); if (!b) return; const k = b.dataset.bn; const bkId = +bk.value, ch = +chI.value;
    if (k === 'close') { close(); return; }
    if (k === 'dir') { close(); META = null; open({ picker: true }); return; }
    if (k === 'page') { const c = readingContext(); if (!c) { t.toast('책을 읽는 화면에서 쓸 수 있습니다.'); return; } srcI.value = c.source; return; }
    if (k === 'quote') {
      const ta = el.querySelector('[data-ed="1"] textarea'); if (!ta) { t.toast('먼저 ＋ 메모 칸을 열어 주세요.'); return; }
      const s = selectedText(); if (!s) { t.toast('읽는 화면에서 인용할 글을 먼저 드래그해 선택해 주세요.'); return; }
      const g = pageTag(); const pre = ta.value.slice(0, ta.selectionStart), post2 = ta.value.slice(ta.selectionEnd);
      const ins = `${pre && !pre.endsWith('\n') ? '\n' : ''}> ${s}${g ? ` (${g})` : ''}\n\n`; ta.value = pre + ins + post2; ta.focus(); ta.setSelectionRange((pre + ins).length, (pre + ins).length); return;
    }
    if (k === 'prev' || k === 'next') {
      let c2 = ch + (k === 'next' ? 1 : -1), bi = meta.books.findIndex((x) => x.id === bkId);
      if (c2 < 1) { if (bi > 0) { bi--; c2 = meta.books[bi].chapters; } else c2 = 1; } else if (c2 > meta.books[bi].chapters) { if (bi < meta.books.length - 1) { bi++; c2 = 1; } else c2 = meta.books[bi].chapters; }
      bk.value = String(meta.books[bi].id); chI.value = c2; load(); return;
    }
    if (k === 'add') { const host = b.closest('.add'); const v = +host.dataset.v; editor(host, v, { source: srcI.value.trim(), end: 0, text: '' }, (f) => post('POST', { book: bkId, chapter: ch, verse: v, fill: LS.get('tl.bn.fill', true), ...f })); return; }
    if (k === 'newv') { const v = +($('#bn-nv', el).value) || 0; if (!v) { t.toast('절 번호를 적어 주세요.'); return; } editor(b.parentElement, v, { source: srcI.value.trim(), end: 0, text: '' }, (f) => post('POST', { book: bkId, chapter: ch, verse: v, fill: LS.get('tl.bn.fill', true), ...f })); return; }
    if (k === 'all') { ST.only = 0; list.innerHTML = render(ST.data); return; }
    const mc = b.closest('.mc');
    if (k === 'edit' && mc) {
      ev.preventDefault(); const v = +mc.dataset.v, i = +mc.dataset.i; const c = (v ? ST.data.verses.find((x) => x.n === v) : ST.data.chapter).cards[i];
      editor(mc, v, { source: c.source, end: c.end, text: plain(c.body) }, (f) => post('PUT', { book: bkId, chapter: ch, verse: v, index: i, ...f })); return;
    }
    if (k === 'del' && mc) {
      ev.preventDefault(); if (!confirm('이 메모를 삭제할까요?')) return;
      post('DELETE', { book: bkId, chapter: ch, verse: +mc.dataset.v, index: +mc.dataset.i }).then(() => load(true)).catch((e) => t.toast(e.message, true));
    }
  });
  $('#bn-find', el).addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return; const q = e.target.value.trim(); if (!q) return;
    try { const r = await t.api('/api/notes/bible/find?q=' + encodeURIComponent(q)); if (!r.ok) { t.toast('구절을 알아보지 못했습니다. 예: 롬 3:24, 로마서 3장 24절', true); return; } e.target.value = ''; await jump(r.book, r.chapter, r.verse); } catch (er) { t.toast(er.message, true); }
  });
  el.addEventListener('change', (e) => { if (e.target.id === 'bn-fill2') LS.set('tl.bn.fill', e.target.checked); });
  $('#bn-tx', el).addEventListener('change', () => { LS.set('tl.bn.tx', TX()); load(true); });
  bk.addEventListener('change', () => { chI.value = 1; load(); }); chI.addEventListener('change', () => { if (ST && ST.book === +bk.value && ST.ch === +chI.value) return; load(); });   // 같은 장이면 다시 그리지 않음(열어 둔 메모 칸이 닫히지 않게)
  load();
}
function toggle() { if (EL) close(); else open(); }

// 읽는 화면 위쪽 막대에 '성경노트' 버튼
function decorate() {
  const bar = $('.reader .r-bar'); if (!bar || bar.querySelector('.bn-btn')) return;
  const b = document.createElement('button'); b.className = 'btn sm bn-btn'; b.type = 'button'; b.textContent = '✎ 성경노트';
  b.title = '읽으면서 성경 구절에 메모 (Ctrl+Shift+E)';
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', toggle);
  const anchor = bar.querySelector('.rn-btn'); const sv = bar.querySelector('.r-save');
  bar.insertBefore(b, anchor ? anchor.nextSibling : (sv || null));
}
new MutationObserver(() => { if (EL && $('#rn-panel')) close(); decorate(); }).observe(document.body, { childList: true });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'e') { e.preventDefault(); toggle(); } }, true);
window.TLBibleNote = { open, close, toggle, isOpen: () => !!EL };
})();
