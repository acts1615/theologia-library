// 본문 검색 서비스: '한국어OCR' 앱이 PDF 폴더 안(_서재색인)에 만들어 둔 색인을 읽기 전용으로 연결한다.
// 색인은 이 앱이 바꾸지 않는다. 책 위치는 PDF 폴더 기준 상대 경로라서 이 서재의 파일과 경로로 짝을 맞춘다.
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const Bible = require('./bible.js');

const DIRNAME = '_서재색인', DBNAME = '서재색인.db', OCRDIR = '_새OCR', PAGE_MUL = 100000;
const nk = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\\/g, '/');
const flat = (s) => String(s || '').replace(/\s+/g, '');

// 검색어 → 질의. 공백=그리고(같은 쪽), OR 또는 |=또는, -낱말·NOT 낱말=제외, "…"=그대로 한 덩어리
function parseWords(q) {
  const toks = []; const re = /(-?)"([^"]+)"|(\S+)/g; let m;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) toks.push({ t: m[2], neg: m[1] === '-' });
    else { const w = m[3]; if (w === '|' || w === 'OR') toks.push({ op: 'or' }); else if (w === 'NOT') toks.push({ op: 'not' }); else if (/^-.+/.test(w)) toks.push({ t: w.slice(1), neg: true }); else toks.push({ t: w.replace(/^\|+|\|+$/g, ''), pipe: w.includes('|') }); }
  }
  const or = [{ and: [], not: [] }]; const terms = []; let negNext = false;
  for (const k of toks) {
    if (k.op === 'or') { or.push({ and: [], not: [] }); continue; }
    if (k.op === 'not') { negNext = true; continue; }
    const parts = k.pipe ? k.t.split('|') : [k.t];
    parts.forEach((p, i) => {
      const f = flat(p); if (!f) return;
      if (i > 0) or.push({ and: [], not: [] });
      const g = or[or.length - 1];
      if (k.neg || negNext) g.not.push(f); else { g.and.push(f); terms.push(p.trim()); }
    });
    negNext = false;
  }
  const bad = or.flatMap((g) => [...g.and, ...g.not]).find((f) => [...f].length < 2);
  return { query: { or: or.filter((g) => g.and.length) }, terms: [...new Set(terms)], short: !!bad, empty: !or.some((g) => g.and.length) };
}

function createSearch({ store, dataDir }) {
  let worker = null, seq = 0; const waits = new Map();
  let st = { available: false, root: '', dbPath: '', error: '', how: '', loadedAt: 0, mtime: 0, books: new Map(), relMap: new Map(), fileOfBook: new Map(), loading: null };

  function startWorker() {
    if (worker) return;
    const src = fs.readFileSync(path.join(__dirname, 'searchworker.js'), 'utf8');
    const real = path.join(dataDir, '.searchworker.js');          // asar 안이 아니라 실제 파일로 둬서 스레드가 확실히 읽게 함
    try { if (!fs.existsSync(real) || fs.readFileSync(real, 'utf8') !== src) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(real, src); } } catch {}
    worker = new Worker(fs.existsSync(real) ? real : path.join(__dirname, 'searchworker.js'));
    worker.on('message', ({ id, ok, value, error }) => { const w = waits.get(id); if (!w) return; waits.delete(id); ok ? w.res(value) : w.rej(new Error(error)); });
    const dead = (e) => { for (const w of waits.values()) w.rej(e instanceof Error ? e : new Error('검색 스레드가 멈췄습니다.')); waits.clear(); worker = null; st.available = false; };
    worker.on('error', dead); worker.on('exit', () => dead(new Error('검색 스레드가 끝났습니다.')));
    worker.unref();
  }
  const call = (op, args) => new Promise((res, rej) => { startWorker(); const id = ++seq; waits.set(id, { res, rej }); worker.postMessage({ id, op, args }); });

  // 색인 위치를 직접 지정한 경우(설정): 색인 파일(.db) 또는 그것이 든 폴더. 책 경로의 기준 폴더는 _서재색인의 한 단계 위.
  function manual() {
    const v = String(process.env.SEARCH_INDEX_PATH || '').trim().replace(/^"|"$/g, '');
    if (!v) return null;
    let p = path.resolve(v);
    try {
      const sx = fs.statSync(p);
      if (sx.isDirectory()) { const a = path.join(p, DBNAME), b = path.join(p, DIRNAME, DBNAME); p = fs.existsSync(a) ? a : b; }
      if (!fs.statSync(p).isFile()) return null;
    } catch { return null; }
    const dir = path.dirname(p);
    return { root: path.basename(dir) === DIRNAME ? path.dirname(dir) : dir, dbPath: p, manual: true };
  }
  function detect() {
    const mn = manual(); if (mn) return mn;
    const seen = new Set();
    for (const f of store.snapshot().folders) {
      let dir = path.resolve(f.path);
      for (let i = 0; i < 4; i++) {
        if (seen.has(dir)) break; seen.add(dir);
        const p = path.join(dir, DIRNAME, DBNAME);
        try { if (fs.statSync(p).isFile()) return { root: dir, dbPath: p }; } catch {}
        const up = path.dirname(dir); if (up === dir) break; dir = up;
      }
    }
    return null;
  }
  const mtimeOf = (p) => { let m = 0; for (const s of ['', '-wal']) { try { m = Math.max(m, fs.statSync(p + s).mtimeMs); } catch {} } return m; };
  const relOf = (file) => { const r = path.relative(st.root, file.path); return r.startsWith('..') || path.isAbsolute(r) ? null : nk(r); };

  function remap() {
    st.fileOfBook = new Map(); let mapped = 0, byName = 0; const files = store.snapshot().files;
    const byRel = new Map(); for (const f of files) { const r = relOf(f); if (r) byRel.set(r, f); }
    const left = [];
    for (const [bid, b] of st.books) { const f = byRel.get(nk(b.rel)); if (f) { st.fileOfBook.set(bid, f.id); mapped++; } else left.push([bid, b]); }
    // 경로가 달라진 책(폴더 이름·위치가 다른 컴퓨터/외장하드): 파일 이름 + 크기가 같으면 같은 책으로 본다. 후보가 하나일 때만.
    if (left.length) {
      const used = new Set(st.fileOfBook.values()); const idx = new Map();
      for (const f of files) { if (used.has(f.id) || !(f.size > 0)) continue; const k = nk(path.basename(String(f.path).replace(/\\/g, '/'))) + '|' + f.size; const a = idx.get(k); if (a) a.push(f); else idx.set(k, [f]); }
      for (const [bid, b] of left) {
        if (!(b.size > 0)) continue;
        const a = idx.get(nk(path.basename(String(b.rel))) + '|' + b.size);
        if (a && a.length === 1 && !used.has(a[0].id)) { st.fileOfBook.set(bid, a[0].id); used.add(a[0].id); mapped++; byName++; }
      }
    }
    st.mapped = mapped; st.byName = byName; st.fileCount = files.length;
  }

  async function load(force) {
    if (st.loading) return st.loading;
    const found = detect();
    if (!found) { st.available = false; st.error = 'index-not-found'; return st; }
    const m = mtimeOf(found.dbPath);
    if (!force && st.available && st.dbPath === found.dbPath && m === st.mtime) { remap(); return st; }
    st.loading = (async () => {
      try {
        const o = await call('open', { file: found.dbPath });
        if (!o.ok) { st.available = false; st.error = o.error || '색인을 열 수 없습니다.'; return st; }
        const rows = await call('books');
        st.books = new Map(rows.map((b) => { let seg = []; try { seg = JSON.parse(b.pnum) || []; } catch {} return [b.id, { ...b, pnum: seg }]; }));
        st.root = found.root; st.dbPath = found.dbPath; st.mtime = m; st.how = o.how; st.available = true; st.error = ''; st.loadedAt = Date.now();
        st.stats = await call('stats'); remap();
      } catch (e) { st.available = false; st.error = String(e.message || e); }
      finally { st.loading = null; }
      return st;
    })();
    return st.loading;
  }

  async function status() {
    await load();
    if (!st.available) return { available: false, error: st.error };
    const works = store.snapshot().works, files = store.snapshot().files;
    const fileBook = new Map(); for (const [bid, fid] of st.fileOfBook) fileBook.set(fid, bid);
    const noText = [], noIndex = [];
    for (const w of works) {
      const fs_ = files.filter((f) => f.workId === w.id && !f.missing);
      const bs = fs_.map((f) => st.books.get(fileBook.get(f.id))).filter(Boolean);
      if (!bs.length) noIndex.push(w.id);
      else if (!bs.some((b) => b.status === '글자층')) noText.push(w.id);
    }
    return { available: true, root: st.root, dbPath: st.dbPath, manual: !!String(process.env.SEARCH_INDEX_PATH || '').trim(), books: st.books.size, mapped: st.mapped, byName: st.byName || 0, files: st.fileCount, by: (st.stats || {}).by || {}, refs: (st.stats || {}).refs || 0, noText, noIndex, how: st.how };
  }

  function titleOf(rel) { return path.basename(rel).replace(/\.pdf$/i, ''); }

  async function search({ q, workIds, limit }) {
    q = String(q || '').trim();
    if (!q) return { error: '검색어를 입력해 주세요.' };
    await load();
    if (!st.available) return { error: st.error === 'index-not-found' ? (String(process.env.SEARCH_INDEX_PATH || '').trim() ? '설정에서 지정한 색인 위치에서 색인 파일(서재색인.db)을 찾지 못했습니다. 경로를 확인해 주세요.' : '서재 색인을 찾지 못했습니다. PDF 폴더 옆에 _서재색인 폴더가 있어야 합니다. 다른 곳에 있으면 설정에서 위치를 지정할 수 있습니다.') : st.error, unavailable: true };
    const files = store.snapshot().files, fileById = new Map(files.map((f) => [f.id, f]));
    const bookOfFile = new Map(); for (const [bid, fid] of st.fileOfBook) bookOfFile.set(fid, bid);
    let bookIds;
    if (Array.isArray(workIds)) {
      const ws = new Set(workIds); bookIds = [];
      for (const f of files) if (ws.has(f.workId) && bookOfFile.has(f.id)) bookIds.push(bookOfFile.get(f.id));
    } else bookIds = [...st.fileOfBook.keys()];
    if (!bookIds.length) return { kind: 'word', what: q, terms: [], works: [], pages: 0, books: 0, scopeBooks: 0 };

    const ref = Bible.parseQuery(q);
    let kind, what, terms, partial = false, hits = new Map(), refKey = null; // 책번호 → Map(쪽 → raw)
    if (ref) {
      kind = 'ref'; what = Bible.label(...ref); terms = []; refKey = ref;
      const r = await call('ref', { bid: ref[0], s: ref[1], e: ref[2], bookIds });
      partial = r.partial;
      for (const [book, page, raw] of r.rows) { let m = hits.get(book); if (!m) hits.set(book, m = new Map()); if (!m.has(page)) m.set(page, raw); }
    } else {
      const pw = parseWords(q);
      if (pw.empty) return { error: '검색어를 입력해 주세요.' };
      if (pw.short) return { error: '낱말은 두 글자 이상으로 적어 주세요.' };
      kind = 'word'; what = q; terms = pw.terms;
      const r = await call('word', { query: pw.query, bookIds, budgetMs: 8000 });
      partial = r.partial;
      for (const id of r.ids) { const book = Math.floor(id / PAGE_MUL); let m = hits.get(book); if (!m) hits.set(book, m = new Map()); m.set(id % PAGE_MUL, null); }
    }
    // 책 → 파일 → 작품으로 묶기
    const byWork = new Map(); let totalPages = 0;
    for (const [book, pm] of hits) {
      const fid = st.fileOfBook.get(book); const f = fid && fileById.get(fid); if (!f) continue;
      const info = st.books.get(book);
      const pages = [...pm.keys()].sort((a, b) => a - b);
      totalPages += pages.length;
      const raws = {}; if (kind === 'ref') for (const p of pages) if (pm.get(p)) raws[p] = pm.get(p);
      let wk = byWork.get(f.workId); if (!wk) byWork.set(f.workId, wk = { workId: f.workId, files: [], pages: 0 });
      wk.files.push({ fileId: f.id, book, name: f.name, status: info.status, total: info.pages, pnum: info.pnum, pages: pages.slice(0, limit || 1500), count: pages.length, raws });
      wk.pages += pages.length;
    }
    const works = [...byWork.values()].map((w) => { const x = store.workById(w.workId) || {}; return { ...w, title: x.title || '', author: x.author || '', category: x.category || '', bibleBooks: x.bibleBooks || [] }; })
      .sort((a, b) => b.pages - a.pages);
    return { kind, what, terms, ref: refKey, works, pages: totalPages, books: works.reduce((n, w) => n + w.files.length, 0), scopeBooks: bookIds.length, partial };
  }

  // 색인을 만들 때 쓴 글자 층이 더 정확한 '새 OCR' PDF가 있으면 그 경로
  function bestPath(file) {
    if (!st.available || !st.root) return file.path;
    const r = relOf(file); if (!r) return file.path;
    const rel = path.relative(st.root, file.path);
    const p = path.join(st.root, OCRDIR, rel);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
    return file.path;
  }
  async function pnum(fileId) {
    await load(); if (!st.available) return [];
    for (const [bid, fid] of st.fileOfBook) if (fid === fileId) { const b = st.books.get(bid); return (b && b.pnum) || []; }
    return [];
  }
  function close() { try { worker && worker.terminate(); } catch {} worker = null; }

  return { status, search, bestPath, pnum, reload: () => load(true), close, parseWords };
}

module.exports = { createSearch, parseWords };
