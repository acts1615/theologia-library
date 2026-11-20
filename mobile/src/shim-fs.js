// store.js 가 쓰는 fs 를 메모리 + IndexedDB 로 흉내 낸다 (브라우저용 번들).
// 시작할 때 initFs()로 IndexedDB 의 내용을 메모리로 읽어 오고, 쓰기는 메모리에 바로 반영한 뒤 IndexedDB 에 비동기로 저장한다.
const mem = new Map();
const DB = 'theologia-fs', ST = 'files';
let db = null; const pending = new Map(); let timer = null;
const skip = (p) => /\.(tmp|bak\.json)$|\.before-restore\.json$|library\.v1\.json$/.test(p);
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function initFs() {
  try {
    db = await open();
    await new Promise((res) => {
      const tx = db.transaction(ST, 'readonly'); const cur = tx.objectStore(ST).openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { mem.set(c.key, c.value); c.continue(); } else res(); };
      cur.onerror = () => res();
    });
  } catch (e) { console.warn('IndexedDB 를 열지 못했습니다. 이번 실행 동안만 기록합니다.', e); }
}
function persist(p, v) {
  if (!db || skip(p)) return;
  pending.set(p, v); clearTimeout(timer);
  timer = setTimeout(flushFs, 150);
}
function flushFs() {
  if (!db || !pending.size) return Promise.resolve();
  const items = [...pending]; pending.clear();
  return new Promise((res) => {
    try {
      const tx = db.transaction(ST, 'readwrite'); const s = tx.objectStore(ST);
      for (const [k, v] of items) { if (v === null) s.delete(k); else s.put(v, k); }
      tx.oncomplete = () => res(); tx.onerror = () => res(); tx.onabort = () => res();
    } catch { res(); }
  });
}
const enoent = (p) => Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
module.exports = {
  initFs, flushFs,
  mkdirSync() {},
  existsSync: (p) => mem.has(p),
  readFileSync(p) { if (!mem.has(p)) throw enoent(p); return mem.get(p); },
  writeFileSync(p, d) { mem.set(p, String(d)); persist(p, String(d)); },
  renameSync(a, b) { if (!mem.has(a)) throw enoent(a); const v = mem.get(a); mem.delete(a); mem.set(b, v); persist(a, null); persist(b, v); },
  copyFileSync(a, b) { if (!mem.has(a)) throw enoent(a); mem.set(b, mem.get(a)); persist(b, mem.get(a)); },
};
