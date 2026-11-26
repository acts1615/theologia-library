// 형광펜: PDF에서 드래그해 칠한 글을 책과 상관없이 한곳(data/highlights.json)에 차곡차곡 모은다.
// 위치는 쪽 크기에 대한 비율(0~1)로 적어서 확대·축소·창 크기와 상관없이 같은 자리에 칠해진다.
'use strict';
const fs = require('fs');
const path = require('path');

const COLORS = ['yellow', 'green', 'pink', 'blue'];

function createHighlights({ dataDir, store }) {
  const file = path.join(dataDir, 'highlights.json');
  let state = { nextId: 1, items: [] };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.items)) state = { nextId: Number(j.nextId) || j.items.length + 1, items: j.items }; } catch {}
  let timer = null;
  function flush() {
    clearTimeout(timer); timer = null;
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file); } catch (e) { console.error('highlights save failed:', e.message); }
  }
  const touch = () => { clearTimeout(timer); timer = setTimeout(flush, 400); };

  const num = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  function cleanRects(rs) {
    return (Array.isArray(rs) ? rs : []).slice(0, 400).map((r) => [num(r[0]), num(r[1]), num(r[2]), num(r[3])]).filter((r) => r[2] > 0.002 && r[3] > 0.002);
  }
  const live = (it) => { const f = store.fileById(it.fileId); return f && !f.missing ? f : null; };
  const view = (it) => {
    const f = store.fileById(it.fileId); const w = f ? store.workById(f.workId) : null;
    return { ...it, title: w ? w.title : it.title, author: w ? w.author || '' : it.author || '', fileName: f ? f.name : it.fileName, exists: !!(f && !f.missing) };
  };

  function add(b) {
    const f = store.fileById(String(b.fileId || '')); if (!f) throw new Error('책을 찾을 수 없습니다.');
    const w = store.workById(f.workId);
    const rects = cleanRects(b.rects); if (!rects.length) throw new Error('칠할 자리가 없습니다.');
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const it = { id: 'h' + state.nextId++, fileId: f.id, page: Math.max(1, Math.floor(Number(b.page) || 1)), rects, text, color: COLORS.includes(b.color) ? b.color : 'yellow', note: '', title: w ? w.title : f.name, author: w ? w.author || '' : '', fileName: f.name, at: new Date().toISOString() };
    state.items.push(it); touch(); return view(it);
  }
  function update(id, b) {
    const it = state.items.find((x) => x.id === id); if (!it) throw new Error('없는 형광펜입니다.');
    if (b.color && COLORS.includes(b.color)) it.color = b.color;
    if (typeof b.note === 'string') it.note = b.note.slice(0, 4000);
    touch(); return view(it);
  }
  function remove(id) { const n = state.items.length; state.items = state.items.filter((x) => x.id !== id); if (state.items.length !== n) touch(); return { ok: true }; }
  const forFile = (fileId) => state.items.filter((x) => x.fileId === fileId).map(view);
  function all({ q, color, fileId } = {}) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    let out = state.items.filter((x) => (!color || x.color === color) && (!fileId || x.fileId === fileId));
    if (terms.length) out = out.filter((x) => { const hay = `${x.text} ${x.note} ${x.title} ${x.author}`.toLowerCase(); return terms.every((t) => hay.includes(t)); });
    return out.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).map(view);
  }
  return { add, update, remove, forFile, all, flush, COLORS };
}

module.exports = { createHighlights };
