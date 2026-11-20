'use strict';
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createServer } = require('./server');

const L = (m) => { try { global.__theologiaLog && global.__theologiaLog(m); } catch {} };
const PREFERRED_PORT = 38417; // 고정 포트: 브라우저 저장소(읽기 진행 상황)가 실행마다 유지되도록
const EXE_DIR = path.dirname(process.execPath);

// ---- 저장 위치 (포터블) -------------------------------------------------
// 실행 파일 옆 data 폴더에 쓸 수 있으면 거기에 저장합니다. 폴더째 복사해 다른 PC로 옮기면
// 서재 데이터도 함께 따라갑니다. 쓸 수 없는 위치(예: Program Files)면 사용자 데이터 폴더를 씁니다.
// userData는 app이 ready 되기 전에 지정해야 하므로 여기서 바로 처리합니다.
function resolveDataDir() {
  // 맥: 앱 번들 안은 쓰면 서명이 깨지므로 항상 사용자 폴더(~/Library/Application Support)를 씁니다.
  if (process.platform === 'darwin') return path.join(app.getPath('appData'), 'Theologia Library', 'data');
  // 설치형(설치 프로그램으로 깔린 경우): 제거·재설치해도 서재가 남도록 사용자 폴더를 쓴다.
  if (fs.existsSync(path.join(EXE_DIR, 'Uninstall Theologia Library.exe'))) return path.join(app.getPath('appData'), 'Theologia Library', 'data');
  const portable = path.join(EXE_DIR, 'data');
  try { fs.mkdirSync(portable, { recursive: true }); fs.accessSync(portable, fs.constants.W_OK); return portable; }
  catch { return path.join(app.getPath('appData'), 'Theologia Library', 'data'); }
}
const DATA_DIR = resolveDataDir();
L('main: DATA_DIR=' + DATA_DIR);
app.setPath('userData', path.join(DATA_DIR, 'browser'));

let mainWindow = null;
let server = null;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

// ---- 바탕화면 바로가기 --------------------------------------------------
// 압축형(설치하지 않은 exe)을 실행할 때마다 바탕화면에 바로가기가 없으면 다시 만듭니다.
// (지웠던 바로가기도 다음 실행 때 되살아납니다. 이미 있는 바로가기는 그대로 둡니다. 설치형은 설치 프로그램이 따로 만들므로 건드리지 않습니다.)
function ensureDesktopShortcut() {
  if (process.platform !== 'win32') return;
  try {
    if (fs.existsSync(path.join(EXE_DIR, 'Uninstall Theologia Library.exe'))) return;
    const link = path.join(app.getPath('desktop'), 'Theologia Library.lnk');
    if (fs.existsSync(link)) return; // 이미 있으면 (다른 위치를 가리켜도) 건드리지 않는다
    shell.writeShortcutLink(link, 'create', {
      target: process.execPath, cwd: EXE_DIR,
      description: 'Theologia Library · 개인 신학 서재', icon: process.execPath, iconIndex: 0,
    });
  } catch {}
}

// ---- PDF 폴더 선택 ------------------------------------------------------
async function collectPdfs(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < 100000) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /\.(pdf|epub)$/i.test(e.name)) {
        try { const st = await fs.promises.stat(full); files.push({ path: full, name: e.name, size: st.size, modifiedAt: st.mtime.toISOString() }); } catch {}
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'ko'));
  return files;
}
ipcMain.handle('theologia:select-pdf-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { title: 'PDF 폴더 선택', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true, folder: '', files: [] };
  const folder = r.filePaths[0];
  return { canceled: false, folder, files: await collectPdfs(folder) };
});

ipcMain.handle('theologia:select-folder', async (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { title: typeof title === 'string' && title ? title.slice(0, 60) : '폴더 선택', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? { canceled: true, folder: '' } : { canceled: false, folder: r.filePaths[0] };
});
ipcMain.handle('theologia:scan-folder', async (_event, folder) => {
  if (typeof folder !== 'string' || !folder) return { ok: false, files: [] };
  try {
    const st = await fs.promises.stat(folder);
    if (!st.isDirectory()) return { ok: false, files: [] };
    return { ok: true, files: await collectPdfs(folder) };
  } catch { return { ok: false, files: [] }; }
});
ipcMain.handle('theologia:show-in-folder', (_event, filePath) => {
  if (typeof filePath !== 'string' || !/\.(pdf|epub)$/i.test(filePath)) return { ok: false };
  if (fs.existsSync(filePath)) { shell.showItemInFolder(filePath); return { ok: true }; }
  const dir = path.dirname(filePath);                     // 파일이 없어도 폴더가 남아 있으면 폴더를 연다
  if (fs.existsSync(dir)) { shell.openPath(dir); return { ok: true, folderOnly: true }; }
  return { ok: false };
});
ipcMain.handle('theologia:open-pdf', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !/\.(pdf|epub)$/i.test(filePath)) return { ok: false };
  const err = await shell.openPath(filePath);
  return { ok: !err };
});

// ---- 서버 + 창 ----------------------------------------------------------
function listen(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => { srv.removeListener('error', reject); resolve(srv.address().port); });
  });
}



// Electron은 오른쪽 클릭 메뉴(복사·붙여넣기)가 기본으로 없다. 직접 만들어 준다.
function attachContextMenu(wc) {
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) {
      items.push({ label: '잘라내기', role: 'cut', enabled: p.editFlags.canCut }, { label: '복사', role: 'copy', enabled: p.editFlags.canCopy }, { label: '붙여넣기', role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { label: '모두 선택', role: 'selectAll' });
    } else if (p.selectionText && p.selectionText.trim()) {
      items.push({ label: '복사', role: 'copy' }, { label: '모두 선택', role: 'selectAll' });
    } else if (p.linkURL) {
      items.push({ label: '링크 주소 복사', click: () => require('electron').clipboard.writeText(p.linkURL) });
    } else {
      items.push({ label: '모두 선택', role: 'selectAll' });
    }
    Menu.buildFromTemplate(items).popup();
  });
}

// 서점 검색 페이지를 앱 안 창으로 연다. 사이트가 글자 복사를 막아도 ISBN을 복사할 수 있다.
let storeWin = null;
function openStoreWindow(url) {
  try {
    if (storeWin && !storeWin.isDestroyed()) { storeWin.loadURL(url); storeWin.focus(); return; }
    storeWin = new BrowserWindow({
      width: 1100, height: 860, autoHideMenuBar: true, title: '서점 검색 — 글자를 드래그해 복사할 수 있습니다',
      webPreferences: { preload: path.join(__dirname, 'storepreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:tl-store' },
    });
    const wc = storeWin.webContents; attachContextMenu(wc);
    wc.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) storeWin.loadURL(u); return { action: 'deny' }; });
    wc.on('will-navigate', (e, u) => { if (!/^https?:/i.test(u)) e.preventDefault(); });
    storeWin.on('closed', () => { storeWin = null; });
    storeWin.loadURL(url);
  } catch (e) { shell.openExternal(url); }
}

async function start() {
  L('main: whenReady');
  server = createServer({ publicDir: path.join(__dirname, 'public'), dataDir: DATA_DIR, settingsDirs: [EXE_DIR], restart: () => { try { server && server.close(); } catch {} app.relaunch(); app.exit(0); } });
  let port;
  try { port = await listen(server, PREFERRED_PORT); } catch { port = await listen(server, 0); }

  L('main: server port=' + port);
  // 메뉴 막대는 숨기되, 복사·붙여넣기 단축키(특히 맥)가 동작하도록 편집 메뉴만 둔다
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  mainWindow = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600,
    title: 'Theologia Library', backgroundColor: '#f6f6f1', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  attachContextMenu(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    if (frameName === 'tlstore') { openStoreWindow(url); return { action: 'deny' }; }   // 서점 검색 페이지: 복사 금지를 풀어 주는 앱 안 창
    shell.openExternal(url); return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  L('main: window loaded');
  try { global.__theologiaConfirm && global.__theologiaConfirm(); } catch {}
  ensureDesktopShortcut();
  L('main: shortcut step done');
}

app.whenReady().then(start).catch((err) => {
  dialog.showErrorBox('Theologia Library 시작 실패', String((err && err.stack) || err));
  app.quit();
});
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
