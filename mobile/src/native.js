// 안드로이드 쪽 기능(폴더 선택·목록·파일 복사) 다리. 브라우저 시험에서는 window.__MOCK_FOLDER 를 대신 쓴다.
import { Capacitor, registerPlugin } from '@capacitor/core';

let folder = null;
export function plugin() {
  if (window.__MOCK_FOLDER) return window.__MOCK_FOLDER;
  if (!Capacitor.isNativePlatform()) return null;
  if (!folder) folder = registerPlugin('Folder');
  return folder;
}
export const isNative = () => !!(window.__MOCK_FOLDER || Capacitor.isNativePlatform());
export function fileUrl(p) { return Capacitor.isNativePlatform() ? Capacitor.convertFileSrc(p) : p; }
export function appPlugin() { try { return Capacitor.isNativePlatform() ? registerPlugin('App') : null; } catch { return null; } }
