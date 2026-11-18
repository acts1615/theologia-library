// 본문 검색 작업 스레드: 이전 '한국어OCR' 앱이 만든 서재 색인(서재색인.db)을 읽기 전용으로 열어 찾는다.
// 무거운 질의가 화면을 멈추게 하지 않도록 별도 스레드에서 돈다. 이 파일은 외부 모듈 없이 혼자 동작해야 한다.
'use strict';
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const PAGE_MUL = 100000; // 찾아보기 표의 칸 번호 = 책번호 * PAGE_MUL + 쪽(0부터)
let db = null, openedHow = '';

function openDb(file) {
  if (db) { try { db.close(); } catch {} db = null; }
  const tries = [
    ['readOnly', () => new DatabaseSync(file, { readOnly: true })],
    ['immutable', () => new DatabaseSync('file:' + file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:').replace(/\?/g, '%3f').replace(/#/g, '%23') + '?immutable=1', { readOnly: true })],
  ];
  let lastErr = '';
  for (const [how, fn] of tries) {
    try { const d = fn(); d.prepare('SELECT COUNT(*) c FROM books').get(); d.prepare('SELECT rowid FROM pg LIMIT 1').all(); db = d; openedHow = how; return { ok: true, how }; }
    catch (e) { lastErr = String(e && e.message || e); }
  }
  return { ok: false, error: lastErr };
}
const all = (sql, ...a) => db.prepare(sql).all(...a);
const q3 = (t) => '"' + t.replace(/"/g, '""') + '"';

// 한 낱말(공백 뺀 글자)이 들어 있는 쪽 칸 번호들. 세 글자 이상은 세 글자 조각이 모두 있는 쪽, 두 글자는 그 두 글자가 든 조각을 모두 모아서.
function candidates(qf, cap, deadline) {
  if (qf.length >= 3) {
    const grams = [...new Set(Array.from({ length: qf.length - 2 }, (_, i) => qf.slice(i, i + 3)))];
    const rows = all('SELECT rowid FROM pg WHERE pg MATCH ? LIMIT ?', grams.map(q3).join(' AND '), cap);
    return { ids: rows.map((r) => r.rowid), partial: rows.length >= cap };
  }
  if (qf.length === 2) {
    // 그 두 글자로 '시작하는' 세 글자 조각을 모두 모은다 (낱말 뒤에 글자가 이어지면 항상 이런 조각이 생긴다).
    // 끝 글자 쪽 조각까지 훑으면 어휘 전체를 읽느라 수 분이 걸려서 뺐다. 쪽의 맨 끝에 오는 경우만 놓친다.
    const hi = qf.slice(0, -1) + String.fromCharCode(qf.charCodeAt(1) + 1);
    const terms = all('SELECT term FROM pgv WHERE term >= ? AND term < ?', qf, hi).map((r) => r.term);
    const out = new Set(); let partial = false;
    for (let i = 0; i < terms.length; i += 500) {
      if (Date.now() > deadline) { partial = true; break; }
      for (const r of all('SELECT rowid FROM pg WHERE pg MATCH ? LIMIT ?', terms.slice(i, i + 500).map(q3).join(' OR '), cap)) out.add(r.rowid);
      if (out.size >= cap) { partial = true; break; }
    }
    return { ids: [...out], partial };
  }
  return { ids: [], partial: false };
}

// 질의: {or:[{and:[낱말…], not:[낱말…]}, …]} (낱말은 공백을 뺀 글자)
function wordSearch({ query, bookIds, cap = 300000, budgetMs = 8000 }) {
  const deadline = Date.now() + budgetMs; let partial = false;
  const allow = bookIds ? new Set(bookIds) : null;
  const keep = (ids) => allow ? ids.filter((x) => allow.has(Math.floor(x / PAGE_MUL))) : ids;
  const cache = new Map();
  const get = (t) => {
    if (!cache.has(t)) {
      const r = candidates(t, cap, deadline); if (r.partial) partial = true;
      cache.set(t, new Set(keep(r.ids)));
    }
    return cache.get(t);
  };
  const result = new Set();
  for (const g of query.or) {
    if (!g.and.length) continue;
    const sets = g.and.map(get).sort((a, b) => a.size - b.size);
    let cur = sets[0];
    for (let i = 1; i < sets.length && cur.size; i++) { const o = sets[i]; cur = new Set([...cur].filter((x) => o.has(x))); }
    for (const n of g.not) { if (!cur.size) break; const o = get(n); cur = new Set([...cur].filter((x) => !o.has(x))); }
    for (const x of cur) result.add(x);
  }
  return { ids: [...result], partial };
}

function refSearch({ bid, s, e, bookIds, cap = 400000 }) {
  const rows = all('SELECT book, page, raw FROM refs WHERE bid = ? AND s <= ? AND e >= ? LIMIT ?', bid, e, s, cap);
  const allow = bookIds ? new Set(bookIds) : null;
  const out = []; for (const r of rows) if (!allow || allow.has(r.book)) out.push([r.book, r.page, r.raw]);
  return { rows: out, partial: rows.length >= cap };
}

const OPS = {
  open: ({ file }) => openDb(file),
  stats: () => {
    const by = {}; for (const r of all("SELECT status, COUNT(*) n, COALESCE(SUM(pages),0) p FROM books WHERE live = 1 GROUP BY status")) by[r.status] = { books: r.n, pages: r.p };
    return { by, refs: all('SELECT COUNT(*) c FROM refs')[0].c, how: openedHow };
  },
  books: () => all('SELECT id, rel, size, pages, status, quality, text_pages, pnum FROM books WHERE live = 1').map((b) => ({ ...b, pnum: b.pnum || '' })),
  word: wordSearch,
  ref: refSearch,
  toc: ({ book }) => all('SELECT level, title, page, printed, src FROM toc WHERE book = ? ORDER BY ord', book),
};

parentPort.on('message', ({ id, op, args }) => {
  try {
    if (op !== 'open' && !db) throw new Error('색인이 열려 있지 않습니다.');
    parentPort.postMessage({ id, ok: true, value: OPS[op](args || {}) });
  } catch (e) { parentPort.postMessage({ id, ok: false, error: String(e && e.message || e) }); }
});
