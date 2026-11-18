'use strict';
// 시작 진입점: 실행 기록을 파일로 남기고, 오류가 나면 화면에 보여줍니다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const stamp = () => new Date().toISOString();
const candidates = [path.join(path.dirname(process.execPath), 'startup.log'), path.join(os.tmpdir(), 'theologia-startup.log')];
let logFile = null;
function log(msg) {
  const line = `[${stamp()}] ${msg}\n`;
  if (logFile) { try { fs.appendFileSync(logFile, line); } catch {} return; }
  for (const f of candidates) { // 첫 줄은 파일을 새로 만들어 기록(실행마다 초기화)
    try { fs.writeFileSync(f, line); logFile = f; return; } catch {}
  }
}
global.__theologiaLog = log;

log(`boot: electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform} exe=${process.execPath}`);
log(`boot: __dirname=${__dirname}`);

function fatal(title, err) {
  const detail = String((err && err.stack) || err);
  log(`FATAL ${title}: ${detail}`);
  try {
    const { dialog, app } = require('electron');
    dialog.showErrorBox('Theologia Library 시작 오류', `${title}\n\n${detail}\n\n기록 파일: ${logFile || candidates[0]}`);
    app.quit();
  } catch {}
}
process.on('uncaughtException', (e) => fatal('예기치 못한 오류', e));
process.on('unhandledRejection', (e) => fatal('처리되지 않은 오류', e));

// ---- 온라인 업데이트 적용 ------------------------------------------------
// 내려받아 검증해 둔 새 app.asar(updates/)가 지금 내장된 것보다 새 버전이면 그것으로 시작한다.
// 새 버전이 두 번 연속 '정상 시작 확인' 없이 끝나거나 불러오다 실패하면 버리고 내장 버전으로 돌아간다.
function updatesDir() {
  const { app } = require('electron');
  if (process.platform === 'darwin') return path.join(app.getPath('appData'), 'Theologia Library', 'data', 'updates');
  const portable = path.join(path.dirname(process.execPath), 'data');
  try { fs.mkdirSync(portable, { recursive: true }); fs.accessSync(portable, fs.constants.W_OK); return path.join(portable, 'updates'); }
  catch { return path.join(app.getPath('appData'), 'Theologia Library', 'data', 'updates'); }
}
function pickUpdate() {
  let dir, st, sf;
  try {
    dir = updatesDir(); sf = path.join(dir, 'state.json'); if (!fs.existsSync(sf)) return null;
    st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    const file = path.join(dir, String(st.file || '')); if (!/^app-\d+\.asar$/.test(String(st.file || '')) || !fs.existsSync(file)) return null;
    let bundled = 0; try { bundled = Number(require('./build.json').seq) || 0; } catch {}
    if (!(Number(st.seq) > bundled)) { log('update: 내장 버전이 같거나 더 새롭습니다. 업데이트 파일은 쓰지 않습니다.'); return null; }
    if (!st.confirmed && (st.tries || 0) >= 2) { log('update: 새 버전이 정상 시작을 확인하지 못해 이전 버전으로 돌아갑니다.'); fs.unlinkSync(sf); return null; }
    if (!st.confirmed) { st.tries = (st.tries || 0) + 1; fs.writeFileSync(sf, JSON.stringify(st)); }
    global.__theologiaConfirm = () => { try { const c = JSON.parse(fs.readFileSync(sf, 'utf8')); if (!c.confirmed) { c.confirmed = true; c.tries = 0; fs.writeFileSync(sf, JSON.stringify(c)); } } catch {} };
    return { file, st, sf };
  } catch (e) { log('update: 확인 실패 ' + e); return null; }
}
const upd = pickUpdate();
let loaded = false;
if (upd) {
  try { require(path.join(upd.file, 'main.js')); loaded = true; log(`boot: 업데이트 버전 ${upd.st.version} 로드 완료`); }
  catch (e) { log('update: 새 버전 로드 실패, 내장 버전으로 시작합니다: ' + ((e && e.stack) || e)); try { fs.unlinkSync(upd.sf); } catch {} }
}
if (!loaded) {
  try {
    require('./main.js');
    log('boot: main.js 로드 완료');
  } catch (e) {
    fatal('main.js 로드 실패', e);
  }
}
