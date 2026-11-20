'use strict';
// Theologia Library 로컬 서버. 외부 패키지 없이 Node 내장 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const L = require('./logic');
const { createStore } = require('./store');
const EPUB = require('./epub');
const { createNotes } = require('./notes');
const { createUpdater } = require('./updater');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.mjs': 'application/javascript; charset=utf-8', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.icc': 'application/octet-stream' };

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// 서점 API 키: data/settings.json (exe 옆 settings.json 도 읽음)
function createSettings(dataDir, extraDirs = []) {
  const file = path.join(dataDir, 'settings.json');
  const KEYS = ['KAKAO_REST_API_KEY', 'SEARCH_INDEX_PATH', 'NL_CERT_KEY', 'NOTES_DIR'];
  const apply = (obj) => { for (const k of KEYS) if (obj && typeof obj[k] === 'string' && obj[k].trim()) process.env[k] = obj[k].trim(); };
  for (const d of [...extraDirs, dataDir]) { try { apply(JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'))); } catch {} }
  return {
    status: () => ({ dataDir, build: (() => { try { return require('./build.json').build; } catch { return ''; } })(), version: versionOf((() => { try { return require('./build.json').seq; } catch { return 0; } })()), kakao: !!process.env.KAKAO_REST_API_KEY, nl: !!process.env.NL_CERT_KEY, searchIndex: process.env.SEARCH_INDEX_PATH || '', notesDir: process.env.NOTES_DIR || '' }),
    save(input) {
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      for (const k of KEYS) if (typeof input[k] === 'string') {
        const v = input[k].trim();
        if (v && k === 'NOTES_DIR') { try { fs.mkdirSync(v, { recursive: true }); if (!fs.statSync(v).isDirectory()) throw new Error('x'); } catch { throw new Error('노트 폴더를 만들거나 열 수 없습니다. 경로를 확인해 주세요.'); } }
        if (v) { cur[k] = v; process.env[k] = v; } else { delete cur[k]; delete process.env[k]; }
      }
      fs.writeFileSync(file, JSON.stringify(cur, null, 2));
    },
  };
}

const { versionOf } = require('./version');

function createServer({ publicDir, dataDir, settingsDirs = [], restart = null }) {
  const store = createStore(dataDir);
  try { store.classifyAll(); } catch (e) { console.error('classify failed', e.message); }
  // 월간지(묵상과 설교·생명의삶플러스)는 이름에서 출판사와 연도를 채운다. 비어 있는 칸만 채우고, 직접 쓴 값은 건드리지 않는다.
  function fillMagazines() {
    let n = 0;
    for (const w of store.snapshot().works) {
      const mg = L.magazineInfo(w.title, store.filesOfWork(w.id).map((f) => f.name)); if (!mg) continue;
      const patch = {};
      if (mg.publisher && !w.publisher) patch.publisher = mg.publisher;
      if (mg.year && !w.year) patch.year = mg.year;
      if (Object.keys(patch).length) { store.updateWork(w.id, patch); n++; }
    }
    return n;
  }
  try { const n = fillMagazines(); if (n) console.log('월간지 정보 채움:', n); } catch (e) { console.error('magazine fill failed', e.message); }
  const settings = createSettings(dataDir, settingsDirs);
  const notes = createNotes(() => process.env.NOTES_DIR);
  const cur = (() => { try { const b = require('./build.json'); return { seq: Number(b.seq) || 0, version: versionOf(b.seq) }; } catch { return { seq: 0, version: versionOf(0) }; } })();
  const updater = createUpdater({ dataDir, current: cur, restart });
  const search = require('./searchsvc.js').createSearch({ store, dataDir });
  const indexHtml = path.join(publicDir, 'index.html');
  async function autofillOne(wid, force) {
    const w = store.workById(wid); if (!w) return { status: 'missing' };
        { const mg = L.magazineInfo(w.title, store.filesOfWork(wid).map((f) => f.name)); if (mg && !w.isbn) return ({ status: 'skipped', work: store.markSkip(wid, mg) }); }
        if (!process.env.KAKAO_REST_API_KEY && !(w.isbn && process.env.NL_CERT_KEY)) return ({ status: 'nokey', work: w });
        if (w.fillState && !force && !(w.fillState === 'nomatch' && (w.fillVer || 1) < 4)) return ({ status: 'skipped', work: w });
        try {
          let hit = null;
          // 제목으로 찾기: ISBN이 없거나, ISBN으로 서점에서 못 찾았을 때 쓴다.
          const byTitle = async () => {
            const fnames = store.filesOfWork(wid).map((f) => f.name);
            const hint0 = L.fileHint(fnames);
            const sh = [...L.seriesHints(w.title, fnames, hint0 || w), ...L.commentaryHints(w.title, fnames)];
            const hints = [...sh, ...(hint0 ? [hint0] : []), ...(hint0 && hint0.alt ? [hint0.alt] : [])];
            const plan = hints.length ? hints.flatMap((h) => h.queries.map((q) => ({ q, h }))) : L.queryVariants(w.title).map((q) => ({ q, h: null }));
            for (const { q, h } of plan) {
              const found = await L.searchBookstores({ query: { query: q } });
              if (found.errors.length && !found.candidates.some((c) => c.sourceStatus === 'live')) return { error: found.errors[0] };
              const kc = found.candidates.filter((c) => c.provider === 'kakao');
              const m = (h && (h.series ? L.pickMatchSeries(h, kc) : L.pickMatchHint(h, kc))) || L.pickMatch(w.title, kc, 0.9);
              if (m) return { hit: m };
            }
            return {};
          };
          if (w.isbn) {
            const found = await L.lookupIsbn(w.isbn);
            const c = found.candidate; if (c) hit = { cand: c, score: 1 };
            if (found.errors.length && !c) return ({ status: 'error', message: found.errors[0], work: w });
            // 전자책 ISBN은 종이책과 달라 서점에 없는 경우가 많다. 그럴 땐 제목으로 한 번 더 찾는다(ISBN은 그대로 둔다).
            if (!hit && process.env.KAKAO_REST_API_KEY) { const t = await byTitle(); if (t.error) return ({ status: 'error', message: t.error, work: w }); if (t.hit) hit = t.hit; }
          } else {
            const t = await byTitle(); if (t.error) return ({ status: 'error', message: t.error, work: w }); if (t.hit) hit = t.hit;
          }
          const out = store.fillEmpty(wid, hit && hit.cand);
          return ({ status: hit ? 'filled' : 'nomatch', work: out });
        } catch (e) { return ({ status: 'error', message: e.message, work: w }); }
  }
  const job = { running: false, total: 0, done: 0, filled: 0, nomatch: 0, error: '', stop: false };
  function startJob(force) {
    if (job.running) return;
    const todo = store.snapshot().works.filter((w) => (!w.isbn || (!w.fillState && !(w.coverUrl && w.author && w.publisher))) && (force || !w.fillState || (w.fillState === 'nomatch' && (w.fillVer || 1) < 4))).map((w) => w.id);
    Object.assign(job, { running: true, total: todo.length, done: 0, filled: 0, nomatch: 0, error: '', stop: false });
    (async () => {
      for (const id of todo) {
        if (job.stop) break;
        const r = await autofillOne(id, force).catch((e) => ({ status: 'error', message: e.message }));
        if (r.status === 'error') { job.error = r.message || '서점 검색에 실패했습니다.'; break; }
        if (r.status === 'nokey') { job.error = '카카오 REST API 키가 필요합니다.'; break; }
        job.done++; if (r.status === 'filled') job.filled++; else if (r.status === 'nomatch') job.nomatch++;
        await new Promise((res) => setTimeout(res, 120));
      }
      job.running = false;
    })();
  }
  // 새로 들어온 EPUB 의 서지 정보(제목·저자·출판사·연도·ISBN·소개·표지)를 비어 있는 칸에만 채운다
  function epubMeta() {
    for (const f of store.snapshot().files) {
      if (!/\.epub$/i.test(f.path) || f.epubMeta || f.missing) continue;
      const rec = store.fileById(f.id); if (!rec) continue; rec.epubMeta = true;
      let md; try { md = EPUB.meta(rec.path); } catch { continue; }
      const w = store.workById(rec.workId); if (!w) continue;
      const keep = { fillState: w.fillState, fillVer: w.fillVer, fillAt: w.fillAt, source: w.source };
      store.fillEmpty(w.id, { ...md, coverUrl: md.hasCover ? `/api/epub/${encodeURIComponent(rec.id)}/cover` : '', providerLabel: 'EPUB 정보' });
      w.fillState = keep.fillState; w.fillVer = keep.fillVer; w.fillAt = keep.fillAt; if (keep.source) w.source = keep.source;
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      const m = req.method;
      let r;

      if (p === '/api/health') return sendJson(res, 200, { status: 'ok' });
      if (p === '/api/catalog/reference') return sendJson(res, 200, { bibleBooks: L.bibleSeed, categories: L.categorySeed }, { 'Cache-Control': 'public, max-age=3600' });

      if (p === '/api/library' && m === 'GET') return sendJson(res, 200, store.snapshot());

      if (p === '/api/library/scan' && m === 'POST') {
        const b = await readBody(req);
        const folderPath = typeof b.folderPath === 'string' ? b.folderPath : '';
        const files = Array.isArray(b.files) ? b.files.filter((f) => f && typeof f.path === 'string' && typeof f.name === 'string') : [];
        if (!folderPath) return sendJson(res, 400, { error: 'folderPath가 필요합니다.' });
        const summary = store.scan(folderPath, files, { unavailable: b.unavailable === true }); try { store.classifyAll(); } catch {} try { fillMagazines(); } catch {}
        try { epubMeta(); } catch {}
        return sendJson(res, 200, { summary, library: store.snapshot() });
      }
      if (p === '/api/library/folders' && m === 'DELETE') {
        const b = await readBody(req);
        if (typeof b.path !== 'string') return sendJson(res, 400, { error: 'path가 필요합니다.' });
        store.removeFolder(b.path);
        return sendJson(res, 200, store.snapshot());
      }
      if (p === '/api/library/works/merge' && m === 'POST') {
        const b = await readBody(req);
        if (!Array.isArray(b.ids) || typeof b.into !== 'string') return sendJson(res, 400, { error: 'ids와 into가 필요합니다.' });
        if (!store.mergeWorks(b.ids, b.into)) return sendJson(res, 404, { error: '대상 작품이 없습니다.' });
        return sendJson(res, 200, store.snapshot());
      }
      if ((r = p.match(/^\/api\/library\/works\/([^/]+)$/))) {
        const id = decodeURIComponent(r[1]);
        if (m === 'PATCH') {
          const b = await readBody(req);
          const w = store.updateWork(id, b);
          return w ? sendJson(res, 200, { work: w }) : sendJson(res, 404, { error: '작품을 찾을 수 없습니다.' });
        }
        if (m === 'DELETE') { store.deleteWork(id); return sendJson(res, 200, store.snapshot()); }
      }
      if ((r = p.match(/^\/api\/library\/works\/([^/]+)\/apply-candidate$/)) && m === 'POST') {
        const b = await readBody(req);
        if (!b.candidate || typeof b.candidate.title !== 'string') return sendJson(res, 400, { error: 'candidate가 필요합니다.' });
        const w = store.applyCandidate(decodeURIComponent(r[1]), b.candidate);
        return w ? sendJson(res, 200, { work: w }) : sendJson(res, 404, { error: '작품을 찾을 수 없습니다.' });
      }

      // ISBN 하나로 서지 정보 채우기: 비어 있는 항목만 채우고 입력해 둔 값은 건드리지 않는다(제목도 그대로).
      if ((r = p.match(/^\/api\/library\/works\/([^/]+)\/fill-isbn$/)) && m === 'POST') {
        const b = await readBody(req); const wid = decodeURIComponent(r[1]);
        const w0 = store.workById(wid); if (!w0) return sendJson(res, 404, { error: '작품을 찾을 수 없습니다.' });
        const found = await L.lookupIsbn(b.isbn);
        if (!found.isbn) return sendJson(res, 400, { error: found.errors[0] });
        store.updateWork(wid, { isbn: found.isbn });
        if (!found.candidate) return sendJson(res, 200, { found: false, work: store.workById(wid), errors: found.errors, tried: found.tried });
        const before = store.workById(wid), had = { author: before.author, publisher: before.publisher, year: before.year, coverUrl: before.coverUrl, blurb: before.blurb };
        const w = store.fillEmpty(wid, found.candidate);
        const filled = Object.keys(had).filter((k) => !had[k] && w[k]);
        return sendJson(res, 200, { found: true, work: w, filled, candidate: { title: found.candidate.title, author: found.candidate.author, publisher: found.candidate.publisher, providerLabel: found.candidate.providerLabel }, tried: found.tried });
      }

      // PDF 본문 글자에서 ISBN 찾기(글자는 앱 화면이 pdf.js로 꺼내 보낸다)
      if (p === '/api/isbn/find' && m === 'POST') {
        const b = await readBody(req); const texts = Array.isArray(b.texts) ? b.texts.map(String).slice(0, 60) : [];
        return sendJson(res, 200, { isbns: L.findIsbns(texts.join('\n')).slice(0, 8) });
      }

      // EPUB: 압축 안의 장·그림·목차를 꺼내 준다(스크립트는 CSP로 차단)
      if ((r = p.match(/^\/api\/epub\/([^/]+)\/(info|cover|search|r\/.+)$/)) && m === 'GET') {
        const host = String(req.headers.host || ''); const port = server.address().port;
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
        const f = store.fileById(decodeURIComponent(r[1]));
        if (!f || !/\.epub$/i.test(f.path)) return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
        try {
          if (r[2] === 'info') { const b = EPUB.open(f.path); return sendJson(res, 200, b.info()); }
          if (r[2] === 'search') return sendJson(res, 200, EPUB.open(f.path).search(url.searchParams.get('q') || ''));
          if (r[2] === 'cover') { const c = EPUB.cover(f.path); if (!c) return sendJson(res, 404, { error: '표지 없음' }); res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=3600', 'Content-Security-Policy': EPUB.CSP }); return res.end(c.data); }
          const rel = decodeURIComponent(r[2].slice(2)); const x = EPUB.resource(f.path, rel, { html: url.searchParams.get('h') === '1' });
          if (!x) return sendJson(res, 404, { error: '없는 자원' });
          res.writeHead(200, { 'Content-Type': x.type, 'Cache-Control': 'no-store', 'Content-Security-Policy': x.csp, 'X-Content-Type-Options': 'nosniff' }); return res.end(x.data);
        } catch (e) { return sendJson(res, 500, { error: 'EPUB을 열 수 없습니다: ' + String(e && e.message || e) }); }
      }

      // 노트 폴더(.md): 책 노트·주제 노트, [[이름]] 연결, 백링크
      if (p.startsWith('/api/notes/')) {
        const host = String(req.headers.host || ''); const port = server.address().port;
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
        if (!notes.dir()) return sendJson(res, 400, { error: '설정에서 노트 폴더를 먼저 정해 주세요.' });
        try {
          if (p === '/api/notes/note' && m === 'GET') {
            const name = String(url.searchParams.get('name') || '').trim(); if (!name) return sendJson(res, 400, { error: '이름이 필요합니다.' });
            const wk = (n) => { const k = L.normalized(notes.safeName(n)); const w = store.snapshot().works.find((x) => L.normalized(notes.safeName(x.title)) === k); return w ? w.id : ''; };
            return sendJson(res, 200, await notes.info(name, wk));
          }
          if (p === '/api/notes/note' && m === 'PUT') {
            const b = await readBody(req, 4 * 1024 * 1024); const name = String(b.name || '').trim(); if (!name) return sendJson(res, 400, { error: '이름이 필요합니다.' });
            return sendJson(res, 200, await notes.write(name, b.text, b.baseMtime));
          }
          if (p === '/api/notes/list' && m === 'GET') return sendJson(res, 200, { notes: (await notes.walk()).map((x) => x.name).sort((a, b) => a.localeCompare(b, 'ko')) });
        } catch (e) { return sendJson(res, e && e.status || 500, { error: String((e && e.message) || e) }); }
      }

      // 마크다운(.md): 본문 글자를 그대로 전달(화면에서 안전하게 변환)
      if ((r = p.match(/^\/api\/md\/([^/]+)$/)) && m === 'GET') {
        const host = String(req.headers.host || '');
        const port = server.address().port;
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
        const f = store.fileById(decodeURIComponent(r[1]));
        if (!f || !/\.(?:md|markdown)$/i.test(f.path)) return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
        try {
          const st = await fs.promises.stat(f.path);
          if (st.size > 8 * 1024 * 1024) return sendJson(res, 413, { error: '파일이 너무 큽니다(8MB 초과).' });
          let t = await fs.promises.readFile(f.path, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
          return sendJson(res, 200, { text: t });
        } catch { return sendJson(res, 404, { error: '파일이 없습니다. 이동되었거나 삭제되었을 수 있습니다.' }); }
      }

      // 등록된 PDF를 쪽 단위(Range)로 전달 — 앱 안의 리더가 사용
      if ((r = p.match(/^\/api\/pdf\/([^/]+)$/)) && (m === 'GET' || m === 'HEAD')) {
        const host = String(req.headers.host || '');
        const port = server.address().port;
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
        const f = store.fileById(decodeURIComponent(r[1]));
        if (!f || !/\.pdf$/i.test(f.path)) return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
        const fpath = url.searchParams.get('best') ? search.bestPath(f) : f.path;
        let st; try { st = await fs.promises.stat(fpath); } catch { return sendJson(res, 404, { error: '파일이 없습니다. 이동되었거나 삭제되었을 수 있습니다.' }); }
        if (!st.isFile()) return sendJson(res, 404, { error: '파일이 아닙니다.' });
        const size = st.size;
        const head = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' };
        let start = 0, end = size - 1, status = 200;
        const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (rg && (rg[1] !== '' || rg[2] !== '')) {
          if (rg[1] === '') { start = Math.max(0, size - Number(rg[2])); }
          else { start = Number(rg[1]); if (rg[2] !== '') end = Math.min(end, Number(rg[2])); }
          if (!(start <= end) || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          status = 206; head['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
        head['Content-Length'] = end - start + 1;
        res.writeHead(status, head);
        if (m === 'HEAD' || size === 0) return res.end();
        const rs = fs.createReadStream(fpath, { start, end });
        rs.on('error', () => res.destroy());
        res.on('close', () => rs.destroy());
        return rs.pipe(res);
      }
      if (p === '/api/library/classify' && m === 'POST') {
        const b = await readBody(req).catch(() => ({})); const out = store.classifyAll({ force: !!b.force });
        return sendJson(res, 200, { ...out, library: store.snapshot() });
      }
      if ((r = p.match(/^\/api\/library\/works\/([^/]+)\/confirm-class$/)) && m === 'POST') {
        const w = store.confirmClass(decodeURIComponent(r[1])); return w ? sendJson(res, 200, { work: w }) : sendJson(res, 404, { error: '작품을 찾을 수 없습니다.' });
      }
      if ((r = p.match(/^\/api\/library\/works\/([^/]+)\/autofill$/)) && m === 'POST') {
        const wid = decodeURIComponent(r[1]); const b = await readBody(req).catch(() => ({}));
        const out = await autofillOne(wid, !!b.force);
        return out.status === 'missing' ? sendJson(res, 404, { error: '작품을 찾을 수 없습니다.' }) : sendJson(res, 200, out);
      }
      if (p === '/api/library/autofill/status' && m === 'GET') return sendJson(res, 200, job);
      if (p === '/api/library/autofill/stop' && m === 'POST') { job.stop = true; return sendJson(res, 200, job); }
      if (p === '/api/library/autofill/start' && m === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        if (!process.env.KAKAO_REST_API_KEY) return sendJson(res, 200, { ...job, error: '카카오 REST API 키가 필요합니다.' });
        startJob(!!b.force); return sendJson(res, 200, job);
      }
      if ((r = p.match(/^\/api\/library\/files\/([^/]+)\/(progress|pages)$/)) && m === 'POST') {
        const b = await readBody(req); const fid = decodeURIComponent(r[1]);
        const out = r[2] === 'progress' ? store.setFileProgress(fid, b.page, b.pages) : store.setFilePages(fid, b.pages);
        return out ? sendJson(res, 200, out) : sendJson(res, 400, { error: '기록하지 못했습니다.' });
      }
      if ((r = p.match(/^\/api\/library\/files\/([^/]+)\/marks$/)) && m === 'PUT') {
        const b = await readBody(req); const out = store.setFileMarks(decodeURIComponent(r[1]), b.marks);
        return out ? sendJson(res, 200, out) : sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
      }
      if (p === '/api/toc/parse' && m === 'POST') {
        const b = await readBody(req); return sendJson(res, 200, { items: L.parseTocText(String(b.text || '').slice(0, 200000)) });
      }
      if ((r = p.match(/^\/api\/library\/files\/([^/]+)\/(detach|move)$/)) && m === 'POST') {
        const fid = decodeURIComponent(r[1]);
        let out;
        if (r[2] === 'detach') out = store.detachFile(fid);
        else { const b = await readBody(req); out = typeof b.workId === 'string' ? store.moveFile(fid, b.workId) : null; }
        return out ? sendJson(res, 200, store.snapshot()) : sendJson(res, 404, { error: '파일 또는 작품을 찾을 수 없습니다.' });
      }

      if (p === '/api/search/status' && m === 'GET') { try { return sendJson(res, 200, await search.status()); } catch (e) { return sendJson(res, 200, { available: false, error: e.message }); } }
      if (p === '/api/search/pnum' && m === 'GET') { try { return sendJson(res, 200, { pnum: await search.pnum(url.searchParams.get('fileId') || '') }); } catch { return sendJson(res, 200, { pnum: [] }); } }
      if (p === '/api/search/reload' && m === 'POST') { try { await search.reload(); return sendJson(res, 200, await search.status()); } catch (e) { return sendJson(res, 200, { available: false, error: e.message }); } }
      if (p === '/api/search' && m === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        try { return sendJson(res, 200, await search.search({ q: b.q, workIds: Array.isArray(b.workIds) ? b.workIds.filter((x) => typeof x === 'string') : null, limit: 1500 })); }
        catch (e) { return sendJson(res, 200, { error: '검색 중 오류가 났습니다: ' + e.message }); }
      }
      // 온라인 업데이트
      if (p === '/api/update/check' && m === 'GET') {
        try { const c = await updater.check(url.searchParams.get('force') === '1'); const { url: _u, sha256: _h, ...latest } = c.latest || {}; return sendJson(res, 200, { current: c.current, available: !!c.available, latest: c.latest ? latest : null, canRestart: updater.canRestart, note: c.note || '' }); }
        catch (e) { return sendJson(res, 200, { available: false, error: '업데이트를 확인하지 못했습니다(인터넷 연결을 확인해 주세요).' }); }
      }
      if (p === '/api/update/apply' && m === 'POST') { try { return sendJson(res, 200, await updater.apply()); } catch (e) { return sendJson(res, 200, { state: 'error', error: String((e && e.message) || e) }); } }
      if (p === '/api/update/status' && m === 'GET') return sendJson(res, 200, updater.status());
      if (p === '/api/backup/export' && m === 'GET') {
        store.flush();
        const d = new Date(), z = (n) => String(n).padStart(2, '0');
        const name = `theologia-backup-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.json`;
        const body = JSON.stringify({ app: 'theologia-library', exportedAt: d.toISOString(), build: (() => { try { return require('./build.json').build; } catch { return ''; } })(), library: store.raw() });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      if (p === '/api/backup/import' && m === 'POST') {
        const b = await readBody(req);
        if (!b || b.app !== 'theologia-library' || !b.library) return sendJson(res, 400, { error: '이 앱의 백업 파일이 아닙니다.' });
        try { return sendJson(res, 200, { library: store.restore(b.library) }); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, settings.status());
      if (p === '/api/settings' && m === 'PUT') { settings.save(await readBody(req)); return sendJson(res, 200, settings.status()); }

      if (p === '/api/bookstores/search' && m === 'GET') {
        try { return sendJson(res, 200, await L.searchBookstores({ query: Object.fromEntries(url.searchParams) })); }
        catch { return sendJson(res, 502, { query: url.searchParams.get('query') ?? '', candidates: [], errors: ['서점 검색 중 오류가 발생했습니다.'] }); }
      }

      if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

      // 정적 파일 + SPA 폴백
      let target = path.join(publicDir, decodeURIComponent(p));
      if (!target.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
      let stat = null; try { stat = fs.statSync(target); } catch {}
      if (!stat || !stat.isFile()) target = indexHtml;
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했습니다.' }); else res.end();
    }
  });
  server.on('close', () => { store.flush(); search.close(); });
  server.flushStore = () => store.flush();
  return server;
}

module.exports = { createServer };
