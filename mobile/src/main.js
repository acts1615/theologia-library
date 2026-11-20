import { plugin, isNative, fileUrl, appPlugin, updaterPlugin } from './native.js';
import { marked } from 'marked';
const fs = require('fs');
const { createStore } = require('../../store.js');
const CLS = require('../../classify.js');

marked.use({ gfm: true, breaks: false, renderer: {
  html({ text }) { return esc(text); },            // 글 속의 HTML 태그는 그대로 글자로 보여 준다
  image({ text }) { return text ? `<em>[그림: ${esc(text)}]</em>` : ''; },
} });
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n).toLocaleString('ko-KR');
const VER = '0.1.5';
let store, trees = {}, uris = {};
const S = { cat: '', q: '', sort: 'name', shown: 80 };

function saveMaps() { fs.writeFileSync('trees.json', JSON.stringify(trees)); fs.writeFileSync('uris.json', JSON.stringify(uris)); }
function loadMaps() {
  try { trees = JSON.parse(fs.readFileSync('trees.json')); } catch { trees = {}; }
  try { uris = JSON.parse(fs.readFileSync('uris.json')); } catch { uris = {}; }
}

// ---------- 작은 도구 ----------
let toastT;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2600);
}
function busy(msg) { const b = $('#busy'); if (msg) { b.textContent = msg; b.hidden = false; } else b.hidden = true; }
const tick = () => new Promise((r) => setTimeout(r, 30));

// ---------- 자료 ----------
function data() {
  const snap = store.snapshot();
  const files = new Map();
  for (const f of snap.files) { let a = files.get(f.workId); if (!a) files.set(f.workId, (a = [])); a.push(f); }
  return { works: snap.works, files, folders: snap.folders };
}
function pct(w) { return w.autoProgress && w.totalPages > 0 ? Math.min(100, Math.round((w.currentPage / w.totalPages) * 100)) : null; }
const sortKey = (w) => String(w.title || '').normalize('NFC');

function filtered() {
  const { works, files } = data();
  const q = S.q.trim().toLowerCase();
  let out = works.filter((w) => {
    const fl = files.get(w.id) || [];
    if (!fl.length || fl.every((f) => f.missing)) return false;
    if (S.cat === '__reading') { if (w.status !== 'reading') return false; }
    else if (S.cat === '__none') { if (w.category) return false; }
    else if (S.cat && w.category !== S.cat) return false;
    if (q) {
      const hay = (w.title + ' ' + (w.author || '') + ' ' + (w.publisher || '') + ' ' + (w.category || '') + ' ' + (w.tags || []).join(' ') + ' ' + fl.map((f) => f.name).join(' ')).toLowerCase();
      for (const part of q.split(/\s+/)) if (!hay.includes(part)) return false;
    }
    return true;
  });
  if (S.sort === 'recent') out.sort((a, b) => String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')) || sortKey(a).localeCompare(sortKey(b), 'ko'));
  else out.sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'ko', { numeric: true }));
  return out;
}

// ---------- 화면 ----------
function renderChips() {
  const { works, files } = data();
  const live = works.filter((w) => (files.get(w.id) || []).some((f) => !f.missing));
  const cnt = new Map(); let none = 0, reading = 0;
  for (const w of live) { if (w.category) cnt.set(w.category, (cnt.get(w.category) || 0) + 1); else none++; if (w.status === 'reading') reading++; }
  const cats = [...cnt].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  const chip = (id, label, n) => `<button class="chip${S.cat === id ? ' on' : ''}" data-cat="${esc(id)}">${esc(label)}<i>${num(n)}</i></button>`;
  $('#chips').innerHTML = chip('', '전체', live.length) + (reading ? chip('__reading', '읽는 중', reading) : '') + cats.map(([c, n]) => chip(c, c, n)).join('') + (none ? chip('__none', '분류 없음', none) : '');
}

function renderList() {
  const list = filtered(); const { files } = data();
  const box = $('#list');
  $('#count').textContent = `${num(list.length)}권`;
  if (!list.length) {
    const has = data().folders.length > 0;
    box.innerHTML = has
      ? `<div class="empty"><p>조건에 맞는 책이 없습니다.</p></div>`
      : `<div class="empty"><h2>폰에 있는 책을 불러오세요</h2><p>책(PDF·EPUB)이 들어 있는 폴더를 고르면, 안에 있는 책을 한꺼번에 찾아 분류합니다.</p><button class="btn pri" id="empty-add">폴더 고르기</button><ol class="steps"><li>‘폴더 고르기’를 누릅니다.</li><li>폰의 폴더 선택 창에서 책 폴더로 이동해 <b>“이 폴더 사용”</b>을 누릅니다.</li><li>잠시 기다리면 목록이 나옵니다.</li></ol></div>`;
    return;
  }
  const part = list.slice(0, S.shown);
  box.innerHTML = part.map((w) => {
    const fl = files.get(w.id) || []; const p = pct(w);
    const meta = [w.category, w.author, fl.length > 1 ? `${fl.length}개 파일` : (fl[0] && fl[0].kind === 'epub' ? 'EPUB' : fl[0] && fl[0].kind === 'md' ? 'MD' : '')].filter(Boolean).join(' · ');
    return `<button class="item" data-id="${esc(w.id)}"><span class="t">${esc(w.title)}</span><span class="m">${esc(meta)}</span>${p != null ? `<span class="bar"><b style="width:${p}%"></b></span>` : ''}</button>`;
  }).join('') + (list.length > part.length ? `<button class="more" id="more">더 보기 (${num(list.length - part.length)}권 남음)</button>` : '');
}
function render() { renderChips(); renderList(); }

// ---------- 폴더 불러오기 ----------
async function addFolder() {
  const P = plugin();
  if (!P) { toast('폴더 선택 기능을 찾지 못했습니다. 앱을 완전히 닫았다가 다시 열어 주세요.', true); return; }
  let tree;
  try { tree = await P.pick(); } catch (e) { if (!/cancel/i.test(String(e && e.message || e))) toast('폴더를 고르지 못했습니다.', true); return; }
  trees[tree.name] = tree.uri; saveMaps();
  await scanFolder(tree.name);
}
async function scanFolder(name) {
  const P = plugin(); const uri = trees[name]; if (!P || !uri) return;
  busy(`“${name}” 폴더에서 책을 찾는 중…`); await tick();
  try {
    const r = await P.list({ uri });
    const found = (r.files || []).map((f) => ({ path: `${name}/${f.path}`, name: f.path.split('/').pop(), size: f.size || 0, modifiedAt: f.modified ? new Date(f.modified).toISOString() : null, uri: f.uri }));
    for (const f of found) uris[f.path] = f.uri;
    saveMaps();
    busy(`${num(found.length)}개를 정리하는 중…`); await tick();
    const sum = store.scan(name, found.map(({ uri: _u, ...rest }) => rest));
    store.classifyAll(); store.flush();
    await (require('fs').flushFs || (async () => {}))();
    toast(found.length ? `${num(found.length)}개 파일을 찾았습니다. 새 작품 ${num(sum.newWorks || 0)}권.` : '이 폴더에서 PDF·EPUB 파일을 찾지 못했습니다.', !found.length);
  } catch (e) { toast('불러오지 못했습니다: ' + (e && e.message || e), true); }
  finally { busy(''); render(); }
}

// ---------- 상세 ----------
function openDetail(id) {
  const { works, files } = data(); const w = works.find((x) => x.id === id); if (!w) return;
  const fl = (files.get(id) || []).filter((f) => !f.missing);
  const cats = [...new Set(works.map((x) => x.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  const p = pct(w);
  $('#sheet-body').innerHTML = `
    <h2>${esc(w.title)}</h2>
    <p class="sub">${esc([w.author, w.publisher, w.year].filter(Boolean).join(' · '))}</p>
    ${p != null ? `<div class="bar big"><b style="width:${p}%"></b></div><p class="sub">${p}% 읽음</p>` : ''}
    <label class="fld"><span>분류</span><input id="d-cat" list="d-cats" value="${esc(w.category || '')}" placeholder="분류 없음" autocomplete="off"><datalist id="d-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
    <label class="fld"><span>상태</span><select id="d-status">${[['unread', '읽기 전'], ['reading', '읽는 중'], ['finished', '다 읽음']].map(([v, l]) => `<option value="${v}"${w.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <h3>파일</h3>
    ${fl.map((f) => `<div class="file"><div class="fn">${esc(f.name)}<small>${f.kind === 'epub' ? 'EPUB' : f.kind === 'md' ? 'MD' : 'PDF'}${f.kind === 'md' ? (f.lastPage > 0 ? ` · ${Math.round(f.lastPage / 10)}% 읽음` : '') : f.pages > 0 && f.kind !== 'epub' ? ` · ${f.lastPage || 0}/${f.pages}쪽` : ''}${f.size ? ` · ${(f.size / 1048576).toFixed(1)}MB` : ''}</small></div><button class="btn pri" data-read="${esc(f.id)}">${f.lastPage > 1 && f.kind !== 'epub' ? '이어 읽기' : '읽기'}</button></div>`).join('')}
    <button class="btn full" id="d-close">닫기</button>`;
  $('#sheet').hidden = false; $('#sheet').dataset.id = id;
}
function closeDetail() { $('#sheet').hidden = true; }
document.addEventListener('change', (e) => {
  const id = $('#sheet') && $('#sheet').dataset.id; if (!id) return;
  if (e.target.id === 'd-cat') { store.updateWork(id, { category: e.target.value.trim() }); store.flush(); render(); }
  if (e.target.id === 'd-status') { store.updateWork(id, { status: e.target.value }); store.flush(); render(); }
});

// ---------- PDF 읽기 ----------
let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) { const u = new URL('./pdfjs/pdf.min.js', location.href).href; pdfjsP = import(u).then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.js', location.href).href; return m; }); }
  return pdfjsP;
}
const R = { mode: 'pdf', doc: null, fid: null, page: 1, zoom: 1, token: 0, task: null };
async function openFile(fid) {
  const f = store.fileById(fid);
  if (!f) return;
  if (f.kind === 'epub') { toast('EPUB 읽기는 다음 버전에서 넣겠습니다. 지금은 PC 앱에서 읽어 주세요.', true); return; }
  const P = plugin(); const uri = uris[f.path];
  if (f.kind === 'md') return openMarkdown(f, P, uri);
  if (!P || !uri) { toast('이 파일의 위치를 알 수 없습니다. 폴더를 다시 읽어 주세요.', true); return; }
  busy('책을 여는 중…'); await tick();
  try {
    const pdfjs = await loadPdfjs();
    const c = await P.copy({ uri, name: f.name, size: f.size || 0 });
    const buf = await (await fetch(fileUrl(c.path))).arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf, cMapUrl: './pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './pdfjs/standard_fonts/' }).promise;
    R.mode = 'pdf'; $('#reader').classList.remove('md-mode'); $('#md-view').hidden = true; $('#rd-canvas').hidden = false;
    R.doc = doc; R.fid = fid; R.zoom = 1; R.page = Math.min(Math.max(f.lastPage || 1, 1), doc.numPages);
    store.setFilePages(fid, doc.numPages);
    $('#rd-title').textContent = f.name.replace(/\.pdf$/i, '');
    $('#reader').hidden = false; closeDetail();
    await showPage();
  } catch (e) { toast('책을 열지 못했습니다: ' + (e && e.message || e), true); }
  finally { busy(''); }
}
async function showPage() {
  if (!R.doc) return;
  const my = ++R.token;
  const page = await R.doc.getPage(R.page);
  if (my !== R.token) return;
  const box = $('#rd-view'); const cv = $('#rd-canvas');
  const base = page.getViewport({ scale: 1 });
  const fit = (box.clientWidth - 8) / base.width;
  const vp = page.getViewport({ scale: fit * R.zoom });
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
  cv.style.width = Math.floor(vp.width) + 'px'; cv.style.height = Math.floor(vp.height) + 'px';
  if (R.task) { try { R.task.cancel(); } catch {} }
  R.task = page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
  try { await R.task.promise; } catch { return; }
  if (my !== R.token) return;
  $('#rd-page').value = R.page; $('#rd-total').textContent = '/ ' + R.doc.numPages;
  box.scrollTop = 0;
  store.setFileProgress(R.fid, R.page, R.doc.numPages); store.flush();
}
function go(n) { if (!R.doc) return; const p = Math.min(Math.max(n, 1), R.doc.numPages); if (p !== R.page) { R.page = p; showPage(); } }
function closeReader() { if (R.mode === 'md') { const fr = mdFrac(); clearTimeout(MD.timer); if (MD.fid) { store.setFileProgress(MD.fid, Math.round(fr * 1000), 1000); store.flush(); } } $('#reader').hidden = true; R.token++; if (R.doc) { try { R.doc.destroy(); } catch {} } R.doc = null; render(); const id = $('#sheet').dataset.id; if (id) openDetail(id); }

// ---------- 마크다운(.md) 읽기 ----------
const MD = { fid: null, size: 17, timer: null };
async function openMarkdown(f, P, uri) {
  if (!P || !uri) { toast('이 파일의 위치를 알 수 없습니다. 폴더를 다시 읽어 주세요.', true); return; }
  busy('글을 여는 중…'); await tick();
  try {
    const c = await P.copy({ uri, name: f.name, size: f.size || 0 });
    const text = await (await fetch(fileUrl(c.path))).text();
    const view = $('#md-view');
    view.innerHTML = marked.parse(text.replace(/^\uFEFF/, ''));
    view.querySelectorAll('a').forEach((a) => { const h = a.getAttribute('href') || ''; if (!/^(https?:|mailto:|tel:)/i.test(h)) { a.removeAttribute('href'); a.classList.add('dead'); } });
    MD.fid = f.id; MD.size = Number(localStorage.getItem('mdsize')) || 17; view.style.fontSize = MD.size + 'px';
    R.mode = 'md'; R.doc = null;
    const rd = $('#reader'); rd.classList.add('md-mode'); $('#rd-canvas').hidden = true; view.hidden = false;
    $('#rd-title').textContent = f.name.replace(/\.(?:md|markdown)$/i, '');
    rd.hidden = false; closeDetail();
    const box = $('#rd-view'); await tick();
    const frac = Math.min(Math.max((f.lastPage || 0) / 1000, 0), 1);
    box.scrollTop = frac * Math.max(0, box.scrollHeight - box.clientHeight);
    store.setFilePages(f.id, 1000); mdProgress();
  } catch (e) { toast('글을 열지 못했습니다: ' + (e && e.message || e), true); }
  finally { busy(''); }
}
function mdFrac() { const b = $('#rd-view'); const max = b.scrollHeight - b.clientHeight; return max > 0 ? Math.min(1, Math.max(0, b.scrollTop / max)) : 1; }
function mdProgress() {
  if (R.mode !== 'md' || !MD.fid) return;
  const fr = mdFrac(); $('#rd-pct').textContent = Math.round(fr * 100) + '%';
  clearTimeout(MD.timer); MD.timer = setTimeout(() => { store.setFileProgress(MD.fid, Math.round(fr * 1000), 1000); store.flush(); }, 600);
}
function mdSize(d) { MD.size = Math.min(30, Math.max(12, MD.size + d)); localStorage.setItem('mdsize', String(MD.size)); $('#md-view').style.fontSize = MD.size + 'px'; mdProgress(); }
document.addEventListener('DOMContentLoaded', () => { $('#rd-view').addEventListener('scroll', mdProgress, { passive: true }); });

// ---------- 새 버전 확인 (깃허브 최신 릴리스) ----------
const REPO = 'acts1615/theologia-library';
let UPD = null;
const vnum = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(manual) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const a = (j.assets || []).find((x) => x.name === 'Theologia-Mobile.apk');
    const m = a && /mobile-(\d+\.\d+\.\d+)/.exec(a.label || '');
    if (a && m && newer(m[1], VER)) { UPD = { v: m[1], url: a.browser_download_url }; toast(`새 버전 ${m[1]}이 있습니다. 설정에서 받을 수 있습니다.`); }
    else { UPD = null; if (manual) toast('최신 버전입니다.'); }
  } catch { if (manual) toast('새 버전을 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.', true); }
  showUpdBar();
  if (!$('#sheet').hidden && !$('#sheet').dataset.id) openSettings();
}

async function applyUpdate() {
  if (!UPD) return;
  const up = updaterPlugin();
  if (!up) { window.open(UPD.url, '_blank'); return; }
  toast('새 버전을 내려받는 중입니다… (약 6MB)');
  try { await up.install({ url: UPD.url }); toast('설치 화면에서 “설치”를 눌러 주세요.'); }
  catch (e) {
    const m = String((e && e.message) || e);
    if (/need-permission/.test(m)) toast('이 앱이 새 버전을 설치할 수 있게 “허용”을 켠 뒤, 돌아와서 다시 눌러 주세요.', true);
    else toast('내려받지 못했습니다. 인터넷 연결을 확인하거나, 설정의 “브라우저로 받기”를 써 주세요.', true);
  }
}
function showUpdBar() {
  const bar = $('#updbar'); if (!bar) return;
  if (UPD) { bar.hidden = false; bar.innerHTML = `<span>새 버전 ${esc(UPD.v)}이 나왔습니다</span><button class="btn pri" id="upd-go">업데이트</button>`; } else { bar.hidden = true; bar.innerHTML = ''; }
}
// ---------- 설정 ----------
function openSettings() {
  const { folders, files } = data();
  const cnt = (p) => store.snapshot().files.filter((f) => !f.missing && String(f.path).startsWith(p + '/')).length;
  $('#sheet-body').innerHTML = `<h2>설정</h2><h3>불러온 폴더</h3>
    ${folders.length ? folders.map((f) => `<div class="file"><div class="fn">${esc(f.path)}<small>${num(cnt(f.path))}개 파일</small></div><button class="btn" data-rescan="${esc(f.path)}">다시 읽기</button><button class="btn warn" data-rmfolder="${esc(f.path)}">제거</button></div>`).join('') : '<p class="sub">아직 없습니다.</p>'}
    <button class="btn pri full" id="s-add">폴더 추가</button>
    <h3>업데이트</h3>${UPD ? `<p class="sub">새 버전 ${UPD.v}이 있습니다. 누르면 내려받고 설치 화면이 열립니다. 설치 화면에서 “설치”만 누르면 책 기록은 그대로 유지됩니다.</p><button class="btn pri full" id="s-apply">새 버전 ${UPD.v} 설치하기</button><a class="sub" href="${esc(UPD.url)}" target="_blank" rel="noopener">안 되면 브라우저로 받기</a>` : `<button class="btn full" id="s-upd">새 버전 확인</button>`}
    <h3>정보</h3><p class="sub">Theologia Library 모바일 ${VER} · 좋은군사 · MIT 라이선스<br>폴더를 제거해도 폰의 책 파일은 지워지지 않습니다.<br>책을 열면 앱 임시 저장 공간에 복사본이 잠시 생깁니다.</p>
    <button class="btn full" id="s-cache">임시 복사본 지우기</button><button class="btn full" id="d-close">닫기</button>`;
  $('#sheet').hidden = false; $('#sheet').dataset.id = '';
}

// ---------- 이벤트 ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a'); if (!t) return;
  if (t.dataset.cat !== undefined && t.classList.contains('chip')) { S.cat = t.dataset.cat; S.shown = 80; render(); t.scrollIntoView({ inline: 'center', block: 'nearest' }); return; }
  if (t.classList.contains('item')) return openDetail(t.dataset.id);
  if (t.id === 'more') { S.shown += 120; return renderList(); }
  if (t.id === 'd-close') return closeDetail();
  if (t.dataset.read) return openFile(t.dataset.read);
  if (t.id === 'btn-add' || t.id === 'empty-add' || t.id === 's-add') { closeDetail(); return addFolder(); }
  if (t.id === 'btn-settings') { openSettings(); return; }
  if (t.id === 'btn-sort') { S.sort = S.sort === 'name' ? 'recent' : 'name'; t.textContent = S.sort === 'name' ? '이름순' : '최근 읽음순'; return renderList(); }
  if (t.dataset.rescan) { closeDetail(); return scanFolder(t.dataset.rescan); }
  if (t.dataset.rmfolder) { store.removeFolder(t.dataset.rmfolder); for (const k of Object.keys(uris)) if (k.startsWith(t.dataset.rmfolder + '/')) delete uris[k]; delete trees[t.dataset.rmfolder]; saveMaps(); store.flush(); closeDetail(); render(); toast('목록에서 제거했습니다. 폰의 파일은 그대로입니다.'); return; }
  if (t.id === 's-apply' || t.id === 'upd-go') { applyUpdate(); return; }
  if (t.id === 's-upd') { toast('확인하는 중…'); return checkUpdate(true); }
  if (t.id === 's-cache') { try { await plugin().clearCache(); toast('임시 복사본을 지웠습니다.'); } catch { toast('지우지 못했습니다.', true); } return; }
  if (t.id === 'rd-prev') return go(R.page - 1);
  if (t.id === 'rd-next') return go(R.page + 1);
  if (t.id === 'rd-zin' && R.mode === 'md') return mdSize(1);
  if (t.id === 'rd-zout' && R.mode === 'md') return mdSize(-1);
  if (t.id === 'rd-zin') { R.zoom = Math.min(R.zoom * 1.25, 4); return showPage(); }
  if (t.id === 'rd-zout') { R.zoom = Math.max(R.zoom / 1.25, 0.6); return showPage(); }
  if (t.id === 'rd-back') return closeReader();
});
document.addEventListener('input', (e) => { if (e.target.id === 'q') { S.q = e.target.value; S.shown = 80; renderList(); } });
document.addEventListener('keydown', (e) => { if (e.target.id === 'rd-page' && e.key === 'Enter') { go(parseInt(e.target.value, 10) || R.page); e.target.blur(); } });
// 쪽 넘기기: 좌우로 밀기
let sx = null, sy = null;
document.addEventListener('touchstart', (e) => { if (!e.target.closest('#rd-view')) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (sx == null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6 && R.zoom <= 1.01) go(R.page + (dx < 0 ? 1 : -1));
}, { passive: true });
// 안드로이드 뒤로 가기
document.addEventListener('DOMContentLoaded', () => {
  const A = appPlugin();
  if (A && A.addListener) A.addListener('backButton', () => { if (!$('#reader').hidden) closeReader(); else if (!$('#sheet').hidden) closeDetail(); else A.minimizeApp && A.minimizeApp(); });
});

// ---------- 시작 ----------
(async () => {
  try { await fs.initFs(); } catch {}
  store = createStore('lib'); loadMaps();
  try { store.classifyAll(); } catch {}
  $('#ver').textContent = VER;
  render();
  setTimeout(() => checkUpdate(false), 1500);
  window.__app = { store, S, scanFolder, addFolder, openFile, render };
})();
