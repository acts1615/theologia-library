// 안드로이드 쪽 기능(폴더 선택·목록·파일 복사) 다리. 브라우저 시험에서는 window.__MOCK_FOLDER 를 대신 쓴다.
export function plugin() {
  if (window.__MOCK_FOLDER) return window.__MOCK_FOLDER;
  const C = window.Capacitor;
  if (C && C.registerPlugin) return C.registerPlugin('Folder');
  return null;
}
export const isNative = () => !!(window.__MOCK_FOLDER || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()));
export function fileUrl(p) {
  const C = window.Capacitor;
  return C && C.convertFileSrc ? C.convertFileSrc(p) : p;
}
