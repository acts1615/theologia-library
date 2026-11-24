// 본문 색인 작업 스레드: PDF의 글자층을 읽어 서재색인.db(한국어OCR 앱과 같은 형식)에 쪽 단위로 넣는다.
// 컴퓨터에 부담을 주지 않도록 한 번에 한 쪽씩만 읽고, 일한 시간의 몇 배만큼 쉰다. 이 파일은 외부 모듈 없이 혼자 동작한다.
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

// pdf.js가 Node에서 요구하는 몇 가지 기능 (없는 환경에서만 채운다)
Promise.try = Promise.try || function (f, ...a) { return new Promise((r) => r(f(...a))); };
globalThis.DOMMatrix = globalThis.DOMMatrix || class DOMMatrix { constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; } };
globalThis.Path2D = globalThis.Path2D || class Path2D {};
globalThis.ImageData = globalThis.ImageData || class ImageData {};
if (!Uint8Array.prototype.toHex) Uint8Array.prototype.toHex = function () { let s = ''; for (const b of this) s += b.toString(16).padStart(2, '0'); return s; };
if (!Uint8Array.fromHex) Uint8Array.fromHex = function (h) { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
if (!Math.sumPrecise) Math.sumPrecise = (a) => { let s = 0; for (const x of a) s += x; return s; };

const PAGE_MUL = 100000;
const MAX_BYTES = 500 * 1024 * 1024;      // 이보다 큰 PDF는 건너뛴다
const PAGE_TIMEOUT = 20000;
const SCAN_V = 3;
const VENDOR = workerData.vendor;         // pdf.js 파일이 든 실제 폴더 (asar 밖)

let db = null, pdfjs = null;
let paused = false, stopped = false, ratio = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (m) => parentPort.postMessage(m);

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000; PRAGMA synchronous=NORMAL;');
  // 한국어OCR 앱이 만든 색인과 같은 구조
  d.exec(`CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY, rel TEXT, size INTEGER, mtime REAL, pages INTEGER,
    status TEXT, quality REAL, text_pages INTEGER, source TEXT, live INTEGER DEFAULT 1, at TEXT, scan_v INTEGER DEFAULT 0, pnum TEXT);
    CREATE INDEX IF NOT EXISTS books_rel ON books(rel, live);
    CREATE VIRTUAL TABLE IF NOT EXISTS pg USING fts5(t, content='', tokenize='trigram', detail='none');
    CREATE VIRTUAL TABLE IF NOT EXISTS pgv USING fts5vocab(pg, 'row');
    CREATE TABLE IF NOT EXISTS refs(book INTEGER, page INTEGER, bid INTEGER, s INTEGER, e INTEGER, raw TEXT);
    CREATE INDEX IF NOT EXISTS refs_q ON refs(bid, s, e);
    CREATE INDEX IF NOT EXISTS refs_b ON refs(book);
    CREATE TABLE IF NOT EXISTS wants(id INTEGER PRIMARY KEY, rel TEXT UNIQUE, at TEXT);
    CREATE TABLE IF NOT EXISTS toc(book INTEGER, ord INTEGER, level INTEGER, title TEXT, tflat TEXT, page INTEGER, printed INTEGER, src TEXT);
    CREATE INDEX IF NOT EXISTS toc_b ON toc(book);`);
  db = d;
}

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const m = await import(pathToFileURL(path.join(VENDOR, 'pdf.min.mjs')).href);
  m.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(VENDOR, 'pdf.worker.min.mjs')).href;
  pdfjs = m; return m;
}

const nowStr = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const flat = (s) => String(s || '').normalize('NFC').replace(/[\s​-‍⁠﻿]+/g, '');
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function waitIfPaused() { while (paused && !stopped) await sleep(300); }

// 한 권을 읽어 색인에 넣는다. 반환: {status, pages, textPages, quality} 또는 {skip:'이유'}
async function indexOne(item) {
  let st; try { st = fs.statSync(item.path); } catch { return { skip: '파일을 열 수 없음' }; }
  if (!st.isFile()) return { skip: '파일이 아님' };
  if (st.size > MAX_BYTES) return { skip: '너무 큰 파일' };
  const old = db.prepare('SELECT id, size FROM books WHERE rel = ? AND live = 1').get(item.rel);
  if (old && old.size === st.size) return { have: true };
  let data; try { data = new Uint8Array(fs.readFileSync(item.path)); } catch (e) { return { skip: '읽을 수 없음(' + (e.code || e.message) + ')' }; }
  const lib = await loadPdfjs();
  let doc;
  const book = { status: '글자층', pages: 0, textPages: 0, quality: 0 };
  const rows = []; let bad = 0, total = 0;
  try {
    doc = await withTimeout(lib.getDocument({ data, cMapUrl: VENDOR + path.sep + 'cmaps' + path.sep, cMapPacked: true, standardFontDataUrl: VENDOR + path.sep + 'standard_fonts' + path.sep, isEvalSupported: false, enableXfa: false, useSystemFonts: false, verbosity: 0 }).promise, 60000);
  } catch (e) {
    const m = String((e && (e.name || e.message)) || e);
    if (/Password|InvalidPDF|Format|Missing/i.test(m)) { book.status = '오류'; return { rec: book, rows: [], size: st.size, mtime: st.mtimeMs }; }
    return { skip: '열지 못함(' + m.slice(0, 40) + ')' };
  }
  book.pages = doc.numPages;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      if (stopped) { await doc.destroy().catch(() => {}); return { stopped: true }; }
      await waitIfPaused();
      const t0 = Date.now();
      try {
        const page = await withTimeout(doc.getPage(i), PAGE_TIMEOUT);
        const tc = await withTimeout(page.getTextContent(), PAGE_TIMEOUT);
        const raw = tc.items.map((x) => x.str).join(' ');
        page.cleanup();
        const t = flat(raw);
        if (t.length >= 30) {
          book.textPages++;
          rows.push([i - 1, t]); total += t.length;
          for (const ch of t) { const c = ch.charCodeAt(0); if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff) || c < 32) bad++; }
          const cid = t.split('(cid:').length - 1; bad += cid * 6;
        }
      } catch (e) { /* 이 쪽만 건너뜀 */ }
      const spent = Date.now() - t0;
      await sleep(Math.max(4, Math.round(spent * ratio)));
    }
  } finally { try { await doc.destroy(); } catch {} }
  book.quality = total ? Math.round((bad / total) * 1000) / 1000 : 0;
  if (book.textPages / Math.max(1, book.pages) < 0.1) book.status = '없음';
  else if (book.quality > 0.2) book.status = '깨짐';
  return { rec: book, rows, size: st.size, mtime: st.mtimeMs, oldId: old ? old.id : 0 };
}

function save(item, r) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (r.oldId) db.prepare('UPDATE books SET live = 0 WHERE id = ?').run(r.oldId);
    const id = (db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM books').get().n);
    const ins = db.prepare('INSERT INTO pg(rowid, t) VALUES(?, ?)');
    for (const [p, t] of r.rows) ins.run(id * PAGE_MUL + p, t);
    db.prepare('INSERT INTO books(id, rel, size, mtime, pages, status, quality, text_pages, source, live, at, scan_v, pnum) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)')
      .run(id, item.rel, r.size, Math.floor(r.mtime / 1000), r.rec.pages, r.rec.status, r.rec.quality, r.rec.textPages, '글자층', nowStr(), SCAN_V, '[]');
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

async function run({ items, level }) {
  ratio = level === 'fast' ? 0.3 : level === 'normal' ? 1 : 2.5;
  stopped = false; paused = false;
  let done = 0, added = 0, have = 0, skipped = 0, failed = 0;
  const total = items.length;
  post({ type: 'start', total });
  for (const item of items) {
    if (stopped) break;
    await waitIfPaused();
    if (stopped) break;
    post({ type: 'progress', done, total, current: item.name, added, have, skipped, failed });
    let r;
    try { r = await indexOne(item); } catch (e) { r = { skip: String((e && e.message) || e).slice(0, 60) }; }
    if (r.stopped) break;
    if (r.have) { have++; }
    else if (r.skip) { skipped++; post({ type: 'skip', fileId: item.fileId, name: item.name, why: r.skip }); }
    else {
      try { save(item, r); added++; post({ type: 'book', fileId: item.fileId, status: r.rec.status, pages: r.rec.pages }); }
      catch (e) { failed++; post({ type: 'skip', fileId: item.fileId, name: item.name, why: '저장 실패: ' + String(e.message).slice(0, 50) }); }
    }
    done++;
    await sleep(120);
  }
  post({ type: 'finish', done, total, added, have, skipped, failed, stopped });
}

parentPort.on('message', async (m) => {
  try {
    if (m.op === 'open') { openDb(m.dbPath); post({ type: 'opened', id: m.id }); }
    else if (m.op === 'run') await run(m);
    else if (m.op === 'pause') paused = true;
    else if (m.op === 'resume') paused = false;
    else if (m.op === 'level') ratio = m.level === 'fast' ? 0.3 : m.level === 'normal' ? 1 : 2.5;
    else if (m.op === 'stop') { stopped = true; paused = false; }
  } catch (e) { post({ type: 'error', error: String((e && e.message) || e) }); }
});
