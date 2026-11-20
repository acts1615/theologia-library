'use strict';
// 서재 저장소: data/library.json 에 폴더·작품·파일을 저장합니다 (MySQL 대체).
const fs = require('fs');
const path = require('path');
const CLS = require('./classify.js');
const L = require('./logic');

const VERSION = 2;
const STATUSES = ['unread', 'reading', 'finished'];
const key = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const isUnder = (file, folder) => key(file).startsWith(key(folder) + '/');

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'library.json');
  let state = { version: VERSION, nextId: 1, folders: [], works: [], files: [] };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.version === VERSION) state = raw;
    else { try { fs.copyFileSync(file, path.join(dataDir, 'library.v1.json')); } catch {} }
  } catch {}

  let dirty = false, timer = null, backedUp = false;
  function flush() {
    if (!dirty) return;
    try {
      if (!backedUp && fs.existsSync(file)) { try { fs.copyFileSync(file, path.join(dataDir, 'library.bak.json')); } catch {} backedUp = true; }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (e) { console.error('library save failed:', e); }
  }
  function touch() { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 250); }
  const nid = (p) => `${p}${state.nextId++}`;
  const workById = (id) => state.works.find((w) => w.id === id);
  const filesOf = (wid) => state.files.filter((f) => f.workId === wid);

  function newWork(title, firstFile, extra = {}) {
    const w = {
      id: nid('w'), title, titleKey: L.normalized(title), author: '', publisher: '', year: '', isbn: '',
      category: '', bibleBooks: [], tags: [], status: 'unread', currentPage: 0, totalPages: 0,
      note: '', coverUrl: '', storeUrl: '', source: '', review: false, inList: false, createdAt: new Date().toISOString(), ...extra,
    };
    state.works.push(w);
    return w;
  }

  function scan(folderPath, scanned, opts = {}) {
    const now = new Date().toISOString();
    let folder = state.folders.find((f) => key(f.path) === key(folderPath));
    if (!folder) { folder = { path: folderPath, addedAt: now }; state.folders.push(folder); }
    if (opts.unavailable) { // 폴더/드라이브를 지금 읽을 수 없음: 파일은 '없음'으로만 표시하고 기록은 보존
      folder.missing = true;
      let miss = 0; for (const f of state.files) if (isUnder(f.path, folderPath) && !f.missing) { f.missing = true; miss++; }
      touch(); return { added: 0, newWorks: 0, grouped: 0, missing: miss, total: 0 };
    }
    folder.lastScanAt = now; folder.missing = false;

    const byPath = new Map(state.files.map((f) => [key(f.path), f]));
    const seen = new Set();
    const fresh = [];
    for (const f of scanned) {
      const k = key(f.path); seen.add(k);
      const ex = byPath.get(k);
      if (ex) { ex.size = f.size; ex.modifiedAt = f.modifiedAt; ex.missing = false; ex.path = f.path; }
      else fresh.push(f);
    }
    let missing = 0;
    for (const f of state.files) if (isUnder(f.path, folderPath) && !seen.has(key(f.path)) && !f.missing) { f.missing = true; missing++; }

    let addedWorks = 0, grouped = 0;
    if (fresh.length) {
      const canon = fresh.map((f) => ({ ...f, origName: f.name, name: L.canonName(f.name) }));
      const byTitleKey = new Map(); for (const x of state.works) if (!byTitleKey.has(x.titleKey)) byTitleKey.set(x.titleKey, x);
      for (const g of L.groupPdfFiles(canon)) {
        const first = g.files[0];
        const title = L.displayTitle(first.origName);
        const tkey = L.normalized(g.title) || L.normalized(title);
        let w = byTitleKey.get(tkey);
        if (!w) { w = newWork(title, first, { review: g.files.length > 1 }); w.titleKey = tkey; byTitleKey.set(tkey, w); addedWorks++; }
        else if (g.files.length > 0 && filesOf(w.id).length > 0) w.review = w.review || false;
        for (const gf of g.files) {
          state.files.push({
            id: nid('f'), workId: w.id, path: gf.path, name: gf.origName, size: gf.size ?? null,
            modifiedAt: gf.modifiedAt ?? null, partNumber: gf.partNumber ?? null, missing: false, addedAt: now,
            kind: /\.epub$/i.test(gf.path) ? 'epub' : /\.(?:md|markdown)$/i.test(gf.path) ? 'md' : 'pdf',
            pages: /\.(?:epub|md|markdown)$/i.test(gf.path) ? 1000 : null, lastPage: 0, lastReadAt: null,   // EPUB 은 책 전체를 0~1000 의 가상 '쪽'으로 본다
          });
        }
        if (g.files.length > 1) grouped += g.files.length;
      }
    }
    for (const w of state.works) if (w.autoProgress) recompute(w);
    folder.fileCount = state.files.filter((f) => isUnder(f.path, folderPath) && !f.missing).length;
    touch();
    return { added: fresh.length, newWorks: addedWorks, grouped, missing, total: scanned.length };
  }

  // ---- 읽기 기록: 파일별 쪽수/마지막 쪽 → 작품 진행률 자동 계산 ----
  function recompute(w) {
    if (!w) return;
    const fs_ = filesOf(w.id);
    const known = fs_.filter((f) => f.pages > 0);
    w.lastReadAt = fs_.reduce((m, f) => (f.lastReadAt && (!m || f.lastReadAt > m) ? f.lastReadAt : m), null);
    if (!known.length) { w.autoProgress = false; return; }
    w.autoProgress = true;
    w.progressPartial = known.length < fs_.length; // 아직 쪽수를 모르는 파일이 있음
    w.totalPages = known.reduce((a, f) => a + f.pages, 0);
    w.currentPage = known.reduce((a, f) => a + Math.min(f.lastPage || 0, f.pages), 0);
  }
  function setFilePages(fid, pages) {
    const f = state.files.find((x) => x.id === fid); const n = Math.round(Number(pages));
    if (!f || !(n > 0) || n > 100000) return null;
    f.pages = n; const w = workById(f.workId); recompute(w); touch(); return { file: f, work: w };
  }
  function setFileProgress(fid, page, pages) {
    const f = state.files.find((x) => x.id === fid); if (!f) return null;
    const total = Math.round(Number(pages)); if (total > 0 && total <= 100000) f.pages = total;
    let p = Math.round(Number(page)); if (!(p >= 1)) return null;
    if (f.pages > 0) p = Math.min(p, f.pages);
    f.lastPage = p; f.lastReadAt = new Date().toISOString();
    const w = workById(f.workId); recompute(w);
    if (w) {
      if (w.status === 'unread') w.status = 'reading';
      const all = filesOf(w.id);
      if (w.status === 'reading' && all.every((x) => x.pages > 0) && all.every((x) => x.lastPage >= x.pages)) w.status = 'finished';
    }
    touch(); return { file: f, work: w };
  }
  // 책갈피(목차): 파일별 [{id,page,title,level}]. PDF 쪽(1부터) 기준이라 파일이 바뀌면 따로 가진다.
  function cleanMarks(list, pages) {
    const out = []; const seen = new Set(); const max = pages > 0 ? pages : 100000;
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || typeof m !== 'object') continue;
      const page = Math.round(Number(m.page)); if (!(page >= 1) || page > max) continue;
      let id = typeof m.id === 'string' && /^[\w-]{1,24}$/.test(m.id) ? m.id : ''; if (!id || seen.has(id)) id = 'm' + Math.random().toString(36).slice(2, 9);
      seen.add(id);
      const level = Math.min(3, Math.max(0, Math.round(Number(m.level)) || 0));
      out.push({ id, page, title: String(m.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), level });
      if (out.length >= 1500) break;
    }
    return out.sort((a, b) => a.page - b.page);   // 같은 쪽은 입력한 순서를 유지(안정 정렬)
  }
  function setFileMarks(fid, marks) {
    const f = state.files.find((x) => x.id === fid); if (!f) return null;
    const m = cleanMarks(marks, f.pages);
    if (m.length) f.marks = m; else delete f.marks;
    touch(); return { file: f, work: workById(f.workId) };
  }
  const fileById = (id) => state.files.find((f) => f.id === id);

  const EDITABLE = {
    title: 's', author: 's', publisher: 's', year: 's', isbn: 's', category: 's', note: 's', coverUrl: 's', storeUrl: 's', source: 's',
    status: 'status', currentPage: 'n', totalPages: 'n', review: 'b', inList: 'b', bibleBooks: 'a', tags: 'a',
  };
  function updateWork(id, patch) {
    const w = workById(id); if (!w) return null;
    for (const [k, v] of Object.entries(patch || {})) {
      const t = EDITABLE[k]; if (!t) continue;
      if (t === 's' && typeof v === 'string') w[k] = v.slice(0, k === 'note' ? 20000 : 1000);
      else if (t === 'status' && STATUSES.includes(v)) w.status = v;
      else if (t === 'n' && Number.isFinite(Number(v))) { if (!w.autoProgress) w[k] = Math.max(0, Math.min(1e6, Math.round(Number(v)))); }
      else if (t === 'b') w[k] = !!v;
      else if (t === 'a' && Array.isArray(v)) w[k] = v.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 100);
    }
    if ('category' in patch) { w.classSource = 'manual'; w.classConf = ''; w.classReason = ''; }
    if ('bibleBooks' in patch) w.bibleSource = 'manual';
    if (typeof patch.title === 'string') w.titleKey = L.normalized(w.title);
    if (w.totalPages > 0 && w.currentPage > w.totalPages) w.currentPage = w.totalPages;
    if (w.totalPages > 0 && w.currentPage >= w.totalPages && w.status !== 'finished' && 'currentPage' in patch) w.status = 'finished';
    touch();
    return w;
  }

  function mergeWorks(ids, intoId) {
    const target = workById(intoId); if (!target) return null;
    for (const id of ids) {
      if (id === intoId) continue;
      const w = workById(id); if (!w) continue;
      for (const f of state.files) if (f.workId === id) f.workId = intoId;
      target.bibleBooks = [...new Set([...target.bibleBooks, ...w.bibleBooks])];
      target.tags = [...new Set([...target.tags, ...w.tags])];
      if (!target.author && w.author) target.author = w.author;
      if (!target.note && w.note) target.note = w.note;
      state.works = state.works.filter((x) => x.id !== id);
    }
    target.review = false;
    recompute(target);
    touch();
    return target;
  }

  function dropIfEmpty(wid) {
    if (!filesOf(wid).length) state.works = state.works.filter((w) => w.id !== wid);
  }
  function detachFile(fid) {
    const f = state.files.find((x) => x.id === fid); if (!f) return null;
    const old = f.workId;
    const w = newWork(L.displayTitle(f.name), f);
    f.workId = w.id; dropIfEmpty(old);
    const src = workById(old); if (src) { src.review = false; recompute(src); }
    recompute(w);
    touch();
    return w;
  }
  function moveFile(fid, wid) {
    const f = state.files.find((x) => x.id === fid); if (!f || !workById(wid)) return null;
    const old = f.workId; f.workId = wid; dropIfEmpty(old);
    recompute(workById(old)); recompute(workById(wid)); touch();
    return workById(wid);
  }
  function deleteWork(id) {
    state.files = state.files.filter((f) => f.workId !== id);
    state.works = state.works.filter((w) => w.id !== id);
    touch();
  }
  function removeFolder(p) {
    state.folders = state.folders.filter((f) => key(f.path) !== key(p));
    const gone = state.files.filter((f) => isUnder(f.path, p));
    const ids = new Set(gone.map((f) => f.workId));
    state.files = state.files.filter((f) => !isUnder(f.path, p));
    for (const wid of ids) dropIfEmpty(wid);
    touch();
  }
  function applyCandidate(wid, c) {
    return updateWork(wid, {
      title: c.title, author: c.author || '', publisher: c.publisher || '', isbn: c.isbn || '', coverUrl: c.coverUrl || '',
      storeUrl: c.productUrl || '', source: c.providerLabel || c.provider || '', year: c.publishedAt ? String(c.publishedAt).slice(0, 4) : undefined,
    });
  }
  // 서점 자동 채우기: 비어 있는 항목만 채우고, 이미 입력된 값은 건드리지 않는다.
  function fillEmpty(wid, c) {
    const w = workById(wid); if (!w) return null;
    w.fillState = c ? 'done' : 'nomatch'; w.fillVer = 4; w.fillAt = new Date().toISOString();
    if (c) {
      if (!w.author && c.author && c.author !== '저자 미상') w.author = c.author;
      if (!w.publisher && c.publisher) w.publisher = c.publisher;
      if (!w.isbn && c.isbn) w.isbn = c.isbn;
      if (!w.year && c.publishedAt) w.year = String(c.publishedAt).slice(0, 4);
      if (!w.coverUrl && c.coverUrl) w.coverUrl = c.coverUrl;
      if (!w.storeUrl && c.productUrl) w.storeUrl = c.productUrl;
      if (!w.source) w.source = c.providerLabel || c.provider || '';
      if (!w.blurb && c.description) w.blurb = String(c.description).slice(0, 400);
    }
    touch(); return w;
  }
  function filesOfWork(wid) { return state.files.filter((f) => f.workId === wid); }
  // 자동 분류: 사용자가 직접 지정한 값(classSource/bibleSource === 'manual')은 건드리지 않는다.
  const CLS_VER = 8;
  function classifyAll(opts = {}) {
    let changed = 0, cat = 0, bible = 0;
    const byWork = new Map(); for (const f of state.files) { let a = byWork.get(f.workId); if (!a) byWork.set(f.workId, (a = [])); a.push(f.name); }
    // 폴더 신호: [서재 폴더 이름, 하위 폴더…] — 파일이 들어 있는 폴더 이름도 분류 근거로 쓴다
    const firstFile = new Map(); for (const x of state.files) { const c = firstFile.get(x.workId); if (!c || (c.missing && !x.missing)) firstFile.set(x.workId, x); }
    const dirsOf = (wid) => {
      const f = firstFile.get(wid);
      if (!f) return [];
      const fp = key(f.path); let best = null;
      for (const fo of state.folders) { const k = key(fo.path); if (fp.startsWith(k + '/') && (!best || k.length > key(best.path).length)) best = fo; }
      if (!best) return [];
      const root = String(best.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      const rel = f.path.replace(/\\/g, '/').slice(String(best.path).replace(/\\/g, '/').replace(/\/+$/, '').length + 1).split('/');
      rel.pop();
      return [root, ...rel.filter(Boolean)];
    };
    for (const w of state.works) {
      if (!w.seriesTagged) {   // 시리즈 이름(올재·WBC·LAB·HOW·EM·BST)을 태그로 한 번만 붙인다. 지운 태그는 다시 붙이지 않는다.
        const st = L.seriesTags(w.title, byWork.get(w.id) || []); w.seriesTagged = true; changed++;
        if (st.length) w.tags = [...new Set([...(w.tags || []), ...st])];
      }
      if (!opts.force && w.classVer === CLS_VER) continue;
      if (w.category && !w.classSource) w.classSource = 'manual';
      if (w.bibleBooks && w.bibleBooks.length && !w.bibleSource) w.bibleSource = 'manual';
      // 마크다운(.md) 파일만으로 된 작품은 제목·폴더와 상관없이 'MD 파일' 분류 하나로 모은다 (직접 고른 분류는 그대로 둔다)
      { const ns = byWork.get(w.id) || [];
        if (ns.length && ns.every((n) => /\.(?:md|markdown)$/i.test(n))) {
          if (w.classSource !== 'manual') { w.category = 'MD 파일'; w.classSource = 'auto'; w.classConf = 100; w.classReason = 'md 파일'; cat++; }
          w.classVer = CLS_VER; changed++; continue;
        } }
      // EPUB 파일만으로 된 작품은 'EPUB' 분류 하나로 모은다 (직접 고른 분류는 그대로 둔다)
      { const ns = byWork.get(w.id) || [];
        if (ns.length && ns.every((n) => /\.epub$/i.test(n))) {
          if (w.classSource !== 'manual') { w.category = 'EPUB'; w.classSource = 'auto'; w.classConf = 100; w.classReason = 'epub 파일'; cat++; }
          w.classVer = CLS_VER; changed++; continue;
        } }
      const mg = L.magazineInfo(w.title, byWork.get(w.id) || []);
      if (mg && !w.isbn && w.fillState !== 'skip') { w.fillState = 'skip'; w.fillVer = 4; if (!w.year && mg.year) w.year = mg.year; }
      const hint = L.fileHint(byWork.get(w.id) || []);
      const r = CLS.classify({ title: hint ? hint.title : w.title, author: (hint && hint.author) || w.author, extra: w.blurb, dirs: dirsOf(w.id) });
      w.classVer = CLS_VER; changed++;
      if (w.classSource !== 'manual') {
        if (r.category) { w.category = r.category; w.classSource = 'auto'; w.classConf = r.confidence; w.classReason = r.reasons.join(' / '); cat++; }
        else if (w.classSource === 'auto') { w.category = ''; w.classSource = ''; w.classConf = ''; w.classReason = ''; }
      }
      if (w.bibleSource !== 'manual') { w.bibleBooks = r.bibleBooks; if (r.bibleBooks.length) bible++; }
    }
    if (changed) touch();
    return { changed, cat, bible };
  }
  // 서점 도서가 아닌 작품(월간지 등): 조회 대상에서 빼고, 연도가 비어 있으면 이름에서 채운다
  function markSkip(wid, info) {
    const w = workById(wid); if (!w) return null;
    w.fillState = 'skip'; w.fillVer = 4; w.fillAt = new Date().toISOString();
    if (info && info.year && !w.year) w.year = info.year;
    touch(); return w;
  }
  function confirmClass(wid) { const w = workById(wid); if (!w) return null; w.classSource = 'manual'; w.classConf = ''; touch(); return w; }
  function raw() { return state; }
  function restore(obj) {
    if (!obj || obj.version !== VERSION || !Array.isArray(obj.works) || !Array.isArray(obj.files) || !Array.isArray(obj.folders)) throw new Error('이 앱의 백업 파일이 아니거나 버전이 맞지 않습니다.');
    flush();
    try { if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dataDir, 'library.before-restore.json')); } catch {}
    state = { version: VERSION, nextId: Math.max(+obj.nextId || 1, 1), folders: obj.folders, works: obj.works, files: obj.files };
    dirty = true; flush();
    return snapshot();
  }
  function snapshot() { return { version: VERSION, folders: state.folders, works: state.works, files: state.files }; }

  return { fileById, setFilePages, setFileProgress, setFileMarks, scan, updateWork, mergeWorks, detachFile, moveFile, deleteWork, removeFolder, applyCandidate, fillEmpty, markSkip, classifyAll, confirmClass, filesOfWork, snapshot, raw, restore, flush, workById };
}

module.exports = { createStore };
