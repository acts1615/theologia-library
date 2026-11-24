// 본문 색인 만들기: 앱이 켜져 있는 동안 조금씩 PDF의 글자층을 읽어 색인(서재색인.db)에 보탠다.
// 색인할 대상은 '색인에 아직 없는 책' 중에서 최근 추가한 책 / 폴더 / 분류 / 전체 가운데 하나를 고른다.
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function createIndexer({ store, search, dataDir, publicDir }) {
  const jobFile = path.join(dataDir, 'index-job.json');
  let job = { mode: '', days: 30, folderPath: '', category: '', level: 'light', auto: false };
  try { job = { ...job, ...JSON.parse(fs.readFileSync(jobFile, 'utf8')) }; } catch {}
  const S = { state: 'idle', total: 0, done: 0, added: 0, have: 0, skipped: 0, failed: 0, current: '', startedAt: 0, error: '', skippedList: [], byStatus: {}, lastReload: 0 };
  let worker = null, autoTimer = null;

  const saveJob = () => { try { fs.writeFileSync(jobFile, JSON.stringify(job, null, 2)); } catch {} };

  // 스레드가 쓸 실제 파일: asar 안이 아니라 데이터 폴더에 풀어 둔다 (pdf.js 폴더 포함)
  function prepareFiles() {
    const seq = (() => { try { return String(require('./build.json').seq); } catch { return '0'; } })();
    const dir = path.join(dataDir, '_pdfjs-node'); const mark = path.join(dir, '.ver');
    let ok = false; try { ok = fs.readFileSync(mark, 'utf8') === seq && fs.existsSync(path.join(dir, 'pdf.min.mjs')); } catch {}
    if (!ok) {
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const src = path.join(publicDir, 'vendor', 'pdfjs');
      for (const n of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(path.join(src, n), path.join(dir, n));
      const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a)) { const x = path.join(a, n), y = path.join(b, n); if (fs.statSync(x).isDirectory()) copyDir(x, y); else fs.copyFileSync(x, y); } };   // asar 안에서도 되도록 직접 복사
      for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) { try { copyDir(path.join(src, d), path.join(dir, d)); } catch {} }
      fs.writeFileSync(mark, seq);
    }
    const code = fs.readFileSync(path.join(__dirname, 'indexworker.js'), 'utf8');
    const real = path.join(dataDir, '.indexworker.js');
    try { if (!fs.existsSync(real) || fs.readFileSync(real, 'utf8') !== code) fs.writeFileSync(real, code); } catch {}
    return { script: fs.existsSync(real) ? real : path.join(__dirname, 'indexworker.js'), vendor: dir };
  }

  const inFolder = (f, folder) => { const a = path.resolve(f.path).toLowerCase(), b = path.resolve(folder).toLowerCase(); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };

  // 대상 고르기: 색인에 아직 없는 PDF 중 조건에 맞는 것, 최근 추가한 것부터
  async function plan(j) {
    const snap = store.snapshot();
    const works = new Map(snap.works.map((w) => [w.id, w]));
    const have = await search.indexedFileIds();
    const since = j.mode === 'new' ? new Date(Date.now() - Math.max(1, Number(j.days) || 30) * 86400000).toISOString() : '';
    const out = snap.files.filter((f) => {
      if (f.missing || f.kind === 'epub' || f.kind === 'md' || !/\.pdf$/i.test(f.path || f.name || '')) return false;
      if (have.has(f.id)) return false;
      if (j.mode === 'new') return String(f.addedAt || '') >= since;
      if (j.mode === 'folder') return !!j.folderPath && inFolder(f, j.folderPath);
      if (j.mode === 'category') { const w = works.get(f.workId); return !!w && !!j.category && (w.category === j.category || (w.categories || []).includes(j.category)); }
      return j.mode === 'all';
    });
    out.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
    return out;
  }

  async function count(j) { return (await plan(j)).length; }

  function reloadSoon(force) {
    const now = Date.now();
    if (!force && now - S.lastReload < 60000) return;
    S.lastReload = now; search.reload().catch(() => {});
  }

  async function start(j) {
    if (S.state !== 'idle') throw new Error('이미 색인 중입니다.');
    job = { ...job, ...j, level: ['light', 'normal', 'fast'].includes(j.level) ? j.level : job.level };
    if (!['new', 'folder', 'category', 'all'].includes(job.mode)) throw new Error('색인할 범위를 골라 주세요.');
    saveJob();
    const files = await plan(job);
    Object.assign(S, { state: 'running', total: files.length, done: 0, added: 0, have: 0, skipped: 0, failed: 0, current: '', startedAt: Date.now(), error: '', skippedList: [], byStatus: {} });
    if (!files.length) { S.state = 'idle'; return status(); }
    let tgt, prep;
    try { tgt = search.target(); prep = prepareFiles(); } catch (e) { S.state = 'idle'; S.error = '준비하지 못했습니다: ' + e.message; throw new Error(S.error); }
    const items = files.map((f) => ({ fileId: f.id, path: f.path, name: f.name, rel: search.relFor(f, tgt.root) }));
    worker = new Worker(prep.script, { workerData: { vendor: prep.vendor } });
    worker.on('message', (m) => {
      if (m.type === 'opened') { worker.postMessage({ op: 'run', items, level: job.level }); }
      else if (m.type === 'progress') { Object.assign(S, { done: m.done, current: m.current, added: m.added, have: m.have, skipped: m.skipped, failed: m.failed }); }
      else if (m.type === 'book') { S.byStatus[m.status] = (S.byStatus[m.status] || 0) + 1; reloadSoon(false); }
      else if (m.type === 'skip') { if (S.skippedList.length < 30) S.skippedList.push({ name: m.name, why: m.why }); }
      else if (m.type === 'finish') { Object.assign(S, { done: m.done, added: m.added, have: m.have, skipped: m.skipped, failed: m.failed, current: '' }); end(); }
      else if (m.type === 'error') { S.error = m.error; end(); }
    });
    const dead = (e) => { if (S.state !== 'idle') { S.error = S.error || String((e && e.message) || '색인 스레드가 멈췄습니다.'); end(); } };
    worker.on('error', dead); worker.on('exit', () => dead());
    worker.postMessage({ op: 'open', dbPath: tgt.dbPath });
    return status();
  }

  function end() {
    const w = worker; worker = null; S.state = 'idle'; S.current = '';
    try { w && w.terminate(); } catch {}
    reloadSoon(true);
  }

  function pause() { if (S.state === 'running' && worker) { worker.postMessage({ op: 'pause' }); S.state = 'paused'; } return status(); }
  function resume() { if (S.state === 'paused' && worker) { worker.postMessage({ op: 'resume' }); S.state = 'running'; } return status(); }
  function stop() { if (worker) { worker.postMessage({ op: 'stop' }); } return status(); }
  function setLevel(level) { if (!['light', 'normal', 'fast'].includes(level)) return status(); job.level = level; saveJob(); if (worker) worker.postMessage({ op: 'level', level }); return status(); }
  function setAuto(on) { job.auto = !!on; saveJob(); return status(); }

  // 앱이 켜지거나 서재가 갱신된 뒤: 자동 색인이 켜져 있으면 같은 범위로 이어서 한다
  function kick(delayMs) {
    clearTimeout(autoTimer);
    if (!job.auto || !job.mode || S.state !== 'idle') return;
    autoTimer = setTimeout(() => { if (job.auto && S.state === 'idle') start({}).catch(() => {}); }, delayMs == null ? 30000 : delayMs);
    if (autoTimer.unref) autoTimer.unref();
  }

  function status() {
    const tgt = search.target();
    return { ...S, job: { mode: job.mode, days: job.days, folderPath: job.folderPath, category: job.category, level: job.level, auto: job.auto }, dbPath: tgt.dbPath, dbExists: tgt.exists, folders: store.snapshot().folders.map((f) => f.path) };
  }

  function close() { clearTimeout(autoTimer); try { worker && worker.postMessage({ op: 'stop' }); } catch {} setTimeout(() => { try { worker && worker.terminate(); } catch {} }, 1500).unref?.(); }

  return { status, start, pause, resume, stop, count, setLevel, setAuto, kick, close };
}

module.exports = { createIndexer };
