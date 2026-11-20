// 읽으면서 쓰는 노트: 읽는 화면(PDF·EPUB·md) 오른쪽에 책 노트를 붙여 놓고 쓴다.
// 노트 폴더가 정해져 있어야 하며, 서재의 '책 노트'와 같은 파일(책 제목.md)에 저장한다.
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
let P = null;   // { workId, name, text, mtime, exists, dirty, timer, el }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TL = () => window.TL;
const enabled = () => !!(window.__tlNotesDir);

async function ensureSettings() { try { const s = await TL().api('/api/settings'); window.__tlNotesDir = s.notesDir || ''; } catch {} }
function template(w) { return `# ${w.title}\n\n- 저자: ${w.author || ''}\n- 출판: ${[w.publisher, w.year].filter(Boolean).join(' ')}\n\n## 핵심\n\n\n## 인용 (쪽수)\n\n\n## 내 생각\n\n`; }
function pageNow() { const i = $('#r-page'); const p = i ? parseInt(i.value, 10) : 0; const pr = $('#r-print'); const printed = pr && pr.textContent ? pr.textContent.replace(/[^0-9ivxlcdm]/gi, '') : ''; return { pdf: p > 0 ? p : 0, printed }; }
function selectedText() {
  let t = String(window.getSelection() || '').trim();
  if (!t) { const f = $('#e-frame'); try { t = String(f && f.contentWindow.getSelection() || '').trim(); } catch {} }
  return t.replace(/\s+/g, ' ');
}
function insert(text) {
  const ta = $('#rn-text'); if (!ta) return; const a = ta.selectionStart, b = ta.selectionEnd;
  const pre = ta.value.slice(0, a), post = ta.value.slice(b);
  const lead = pre && !pre.endsWith('\n') ? '\n' : '';
  ta.value = pre + lead + text + post; const pos = (pre + lead + text).length; ta.setSelectionRange(pos, pos); ta.focus();
  ta.dispatchEvent(new Event('input'));
}
function pageTag() { const p = pageNow(); return p.pdf ? (p.printed ? `p.${p.printed}` : `PDF ${p.pdf}쪽`) : ''; }
async function save(force) {
  if (!P || !P.dirty) return true; clearTimeout(P.timer); const n = P;
  try { const r = await TL().api('/api/notes/note', 'PUT', { name: n.name, text: n.text, baseMtime: n.exists ? n.mtime : null }); n.mtime = r.mtimeMs; n.exists = true; n.dirty = false; const s = $('#rn-save'); if (s && P === n) { s.textContent = '저장됨'; s.style.color = ''; } return true; }
  catch (e) { const s = $('#rn-save'); if (s) { s.textContent = '저장 안 됨: ' + e.message; s.style.color = '#e8a090'; } if (force) TL().toast(e.message, true); return false; }
}
async function openPanel() {
  const t = TL(); const w = t.work(window.__tlReadWork); if (!w) return;
  await ensureSettings(); if (!enabled()) { t.toast('설정에서 노트 폴더를 먼저 정해 주세요.', true); return; }
  let info; try { info = await t.api('/api/notes/note?name=' + encodeURIComponent(w.title)); } catch (e) { t.toast(e.message, true); return; }
  const first = !info.exists;
  const el = document.createElement('aside'); el.id = 'rn-panel'; el.className = 'rn-panel';
  el.innerHTML = `<div class="rn-head"><b>✎ ${esc(w.title)}</b><span id="rn-save" class="rn-save"></span><button class="btn sm" data-rn="close" title="노트 닫기">✕</button></div>
    <div class="rn-tools"><button class="btn sm" data-rn="page" title="지금 쪽 표시를 넣습니다">지금 쪽 넣기</button><button class="btn sm" data-rn="quote" title="읽는 화면에서 드래그해 선택한 글을 인용으로 넣습니다">선택한 글 인용</button></div>
    <textarea id="rn-text" class="rn-text" spellcheck="false" placeholder="읽으면서 적습니다. [[주제]]로 다른 노트와 이을 수 있습니다."></textarea>
    <div class="rn-foot">책 노트 파일에 자동 저장됩니다. 서재에서 ‘책 노트 열기’로 다시 볼 수 있습니다.</div>`;
  document.body.appendChild(el); document.body.classList.add('rn-open');
  P = { workId: w.id, name: w.title, text: first ? template(w) : info.text, mtime: info.mtimeMs, exists: !first, dirty: false, timer: 0, el };
  const ta = $('#rn-text', el); ta.value = P.text; ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('input', () => { P.text = ta.value; P.dirty = true; clearTimeout(P.timer); const s = $('#rn-save'); if (s) { s.textContent = '쓰는 중…'; s.style.color = ''; } P.timer = setTimeout(() => save(false), 1500); });
  el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-rn=page],[data-rn=quote]')) e.preventDefault(); });   // 읽는 화면의 선택을 풀지 않게
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rn]'); if (!b) return;
    if (b.dataset.rn === 'close') closePanel();
    if (b.dataset.rn === 'page') { const g = pageTag(); if (!g) { t.toast('이 책은 쪽 번호가 없습니다. 인용 버튼으로 글을 넣어 보세요.'); return; } insert(`- (${g}) `); }
    if (b.dataset.rn === 'quote') { const s = selectedText(); if (!s) { t.toast('읽는 화면에서 인용할 글을 먼저 드래그해 선택해 주세요.'); return; } const g = pageTag(); insert(`> ${s}${g ? ` (${g})` : ''}\n\n`); }
  });
  window.dispatchEvent(new Event('resize')); ta.focus();
}
async function closePanel() {
  if (!P) return; const p = P; if (p.dirty) await save(true);
  clearTimeout(p.timer); p.el.remove(); P = null; document.body.classList.remove('rn-open'); window.dispatchEvent(new Event('resize'));
}
function toggle() { if (P) closePanel(); else openPanel(); }

// 읽는 화면의 위쪽 막대에 '노트' 버튼을 붙인다
function decorate() {
  const bar = $('.reader .r-bar'); if (!bar) { if (P) closePanel(); return; }
  if (bar.querySelector('.rn-btn')) return;
  const b = document.createElement('button'); b.className = 'btn sm rn-btn'; b.type = 'button'; b.title = '읽으면서 노트 쓰기 (Ctrl+E)'; b.textContent = '✎ 노트';
  b.addEventListener('click', toggle);
  const sv = bar.querySelector('.r-save'); bar.insertBefore(b, sv || null);
}
new MutationObserver(decorate).observe(document.body, { childList: true });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'e' && $('.reader .r-bar')) { e.preventDefault(); toggle(); } }, true);
window.TLReadNote = { toggle, isOpen: () => !!P };
})();
