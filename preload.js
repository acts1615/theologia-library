'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 화면(프론트엔드)이 호출하는 데스크톱 연동 API
contextBridge.exposeInMainWorld('theologiaDesktop', {
  platform: process.platform,
  // 폴더 선택 창 → 하위 폴더까지 PDF를 찾아 { canceled, folder, files:[{path,name,size,modifiedAt}] }
  selectPdfFolder: () => ipcRenderer.invoke('theologia:select-pdf-folder'),
  // 폴더만 고르기(노트 폴더용) → { canceled, folder }
  selectFolder: (title) => ipcRenderer.invoke('theologia:select-folder', title),
  // 이미 연결한 폴더를 다시 스캔 → { ok, files } (폴더를 읽을 수 없으면 ok:false)
  scanFolder: (folder) => ipcRenderer.invoke('theologia:scan-folder', folder),
  // PDF를 기본 PDF 뷰어로 열기 → { ok }
  openPdf: (filePath) => ipcRenderer.invoke('theologia:open-pdf', filePath),
  // 탐색기에서 파일 위치 보기
  showInFolder: (filePath) => ipcRenderer.invoke('theologia:show-in-folder', filePath),
});
