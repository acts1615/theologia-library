'use strict';
// 온라인 업데이트: GitHub 릴리스의 update.json 으로 새 버전을 확인하고, app.asar 를 내려받아 검증한 뒤 교체 대기 상태로 둔다.
// 실제 교체는 다음 시작 때 boot.js 가 한다(새 버전이 켜지지 않으면 자동으로 이전 버전으로 돌아간다).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'acts1615/theologia-library';
const API = process.env.THEOLOGIA_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const HOUR = 3600 * 1000;

function createUpdater({ dataDir, current, restart }) {
  const dir = path.join(dataDir, 'updates');
  let last = null, lastAt = 0, job = { state: 'idle' };

  const get = async (url, opt = {}) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opt.timeout || 15000);
    try { const r = await fetch(url, { headers: { 'User-Agent': 'theologia-library-updater', Accept: 'application/vnd.github+json' }, redirect: 'follow', signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
    finally { clearTimeout(t); }
  };

  async function check(force) {
    if (!force && last && Date.now() - lastAt < 6 * HOUR) return last;
    const rel = await (await get(API)).json();
    const assets = new Map((rel.assets || []).map((a) => [a.name, a]));
    const meta = assets.get('update.json'), pack = assets.get('app.asar');
    if (!meta || !pack) { last = { current, available: false, note: '공개된 업데이트가 없습니다.' }; lastAt = Date.now(); return last; }
    const info = await (await get(meta.browser_download_url)).json();
    const seq = Number(info.seq);
    if (!Number.isFinite(seq) || !/^[0-9a-f]{64}$/i.test(String(info.sha256 || ''))) throw new Error('업데이트 정보가 올바르지 않습니다.');
    last = { current, available: seq > current.seq, latest: { seq, version: String(info.version || ''), notes: String(info.notes || '').slice(0, 2000), size: pack.size, sha256: String(info.sha256).toLowerCase(), url: pack.browser_download_url } };
    lastAt = Date.now(); return last;
  }

  async function download(info) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `app-${info.seq}.asar`, part = path.join(dir, name + '.part'), file = path.join(dir, name);
    const r = await get(info.url, { timeout: 120000 }); const h = crypto.createHash('sha256'); let n = 0;
    const out = fs.createWriteStream(part);
    const reader = r.body.getReader(); const total = Number(r.headers.get('content-length')) || info.size || 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; h.update(value); n += value.length; if (!out.write(value)) await new Promise((res) => out.once('drain', res)); job.progress = total ? Math.min(0.99, n / total) : 0; }
    } finally { await new Promise((res) => out.end(res)); }
    if (h.digest('hex') !== info.sha256) { try { fs.unlinkSync(part); } catch {} throw new Error('내려받은 파일이 손상되었습니다(검증 실패). 잠시 후 다시 시도해 주세요.'); }
    fs.renameSync(part, file);
    // 교체 대기: 다음 시작에서 boot.js 가 이 파일을 쓴다
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ seq: info.seq, version: info.version, file: name, tries: 0, confirmed: false, at: new Date().toISOString() }));
    for (const f of fs.readdirSync(dir)) if (/^app-\d+\.asar(\.part)?$/.test(f) && f !== name) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  }

  async function apply() {
    if (job.state === 'downloading') return job;
    const c = await check(true); if (!c.available) { job = { state: 'idle' }; return { ...job, error: '이미 최신 버전입니다.' }; }
    job = { state: 'downloading', progress: 0, version: c.latest.version };
    (async () => {
      try { await download(c.latest); job = { state: 'ready', version: c.latest.version }; if (restart) setTimeout(() => restart(), 800); }
      catch (e) { job = { state: 'error', error: String((e && e.message) || e) }; }
    })();
    return job;
  }
  return { check, apply, status: () => job, canRestart: !!restart };
}
module.exports = { createUpdater, REPO };
