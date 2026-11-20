'use strict';
// 노트 폴더: 일반 .md 파일로만 저장한다(옵시디언에서 그대로 열 수 있다). [[이름]] 연결과 백링크를 계산한다.
const fs = require('fs');
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAP = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜' };
function safeName(s) {
  let n = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, (c) => MAP[c]).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
  if (!n) n = '제목 없음';
  if (RESERVED.test(n)) n += '_';
  return n;
}
const key = (s) => safeName(s).normalize('NFC').toLowerCase();
const LINK = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;
function linksOf(text) { const out = []; const seen = new Set(); let m; LINK.lastIndex = 0; while ((m = LINK.exec(text))) { const n = m[1].trim().split('/').pop().trim(); if (n && !seen.has(key(n))) { seen.add(key(n)); out.push(n); } } return out; }

function createNotes(getDir, titleKeyOf) {
  const dir = () => String(getDir() || '').trim();
  const fileFor = (name) => { const d = dir(); if (!d) throw new Error('노트 폴더가 정해지지 않았습니다.'); const f = path.resolve(d, safeName(name) + '.md'); if (path.dirname(f) !== path.resolve(d)) throw new Error('이름이 올바르지 않습니다.'); return f; };
  async function walk() {
    const d = dir(); const out = []; if (!d) return out;
    const stack = [[d, 0]];
    while (stack.length && out.length < 5000) {
      const [cur, depth] = stack.pop(); let es; try { es = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of es) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { if (depth < 3) stack.push([full, depth + 1]); }
        else if (e.isFile() && /\.md$/i.test(e.name)) out.push({ name: e.name.replace(/\.md$/i, ''), path: full });
      }
    }
    return out;
  }
  // 이름으로 파일 찾기: 노트 폴더 맨 위에 있으면 그것, 하위 폴더에 있으면 그곳의 것, 없으면 맨 위에 새로 만들 자리
  async function locate(name) {
    const f = fileFor(name);
    try { await fs.promises.stat(f); return f; } catch {}
    const k = key(name); const hit = (await walk()).find((x) => key(x.name) === k);
    return hit ? hit.path : f;
  }
  async function read(name) {
    const f = await locate(name);
    try { const st = await fs.promises.stat(f); if (st.size > 2 * 1024 * 1024) throw new Error('노트가 너무 큽니다(2MB 초과).'); let t = await fs.promises.readFile(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return { exists: true, text: t, mtimeMs: st.mtimeMs }; }
    catch (e) { if (e && e.code === 'ENOENT') return { exists: false, text: '', mtimeMs: 0 }; throw e; }
  }
  async function write(name, text, baseMtime) {
    const f = await locate(name); text = String(text == null ? '' : text); if (text.length > 1500000) throw Object.assign(new Error('노트가 너무 큽니다.'), { status: 413 });
    let st = null; try { st = await fs.promises.stat(f); } catch {}
    if (st && baseMtime != null && Math.abs(st.mtimeMs - Number(baseMtime)) > 2) throw Object.assign(new Error('다른 곳(옵시디언이나 드라이브 동기화)에서 이 노트가 바뀌었습니다. 노트를 닫았다가 다시 열어 최신 내용을 확인해 주세요.'), { status: 409 });
    if (!st && baseMtime && Number(baseMtime) > 0) throw Object.assign(new Error('노트 파일이 사라졌습니다. 다시 열어 확인해 주세요.'), { status: 409 });
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = f + '.tl-tmp'; await fs.promises.writeFile(tmp, text, 'utf8'); await fs.promises.rename(tmp, f);
    return { mtimeMs: (await fs.promises.stat(f)).mtimeMs };
  }
  async function info(name, workKeys) {
    const cur = await read(name); const files = await walk(); const have = new Set(files.map((x) => key(x.name)));
    const links = linksOf(cur.text).map((n) => ({ name: n, work: workKeys(n) || '', exists: have.has(key(n)) }));
    const me = key(name); const backlinks = [];
    for (const x of files) {
      if (key(x.name) === me || backlinks.length >= 200) continue;
      let t; try { const st = await fs.promises.stat(x.path); if (st.size > 1024 * 1024) continue; t = await fs.promises.readFile(x.path, 'utf8'); } catch { continue; }
      if (!linksOf(t).some((n) => key(n) === me)) continue;
      const i = t.search(new RegExp('\\[\\[' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[#|][^\\]\\n]*)?\\]\\]', 'i'));
      const snip = i >= 0 ? t.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ') : '';
      backlinks.push({ name: x.name, snippet: snip });
    }
    return { name, ...cur, links, backlinks };
  }
  async function search(q) {
    const nq = String(q || '').normalize('NFC').toLowerCase().trim(); if (!nq) return [];
    const terms = nq.split(/\s+/).filter(Boolean); const out = [];
    for (const x of await walk()) {
      if (out.length >= 100) break;
      let t; try { const st = await fs.promises.stat(x.path); if (st.size > 2 * 1024 * 1024) continue; t = await fs.promises.readFile(x.path, 'utf8'); } catch { continue; }
      const low = t.normalize('NFC').toLowerCase(); const nameLow = x.name.normalize('NFC').toLowerCase();
      if (!terms.every((w) => low.includes(w) || nameLow.includes(w))) continue;
      const snippets = []; const lines = t.split(/\r?\n/);
      for (let i = 0; i < lines.length && snippets.length < 3; i++) { const l = lines[i].normalize('NFC').toLowerCase(); if (terms.some((w) => l.includes(w))) snippets.push(lines[i].replace(/\s+/g, ' ').trim().slice(0, 160)); }
      out.push({ name: x.name, nameHit: terms.some((w) => nameLow.includes(w)), snippets });
    }
    out.sort((a, b) => (b.nameHit - a.nameHit) || a.name.localeCompare(b.name, 'ko'));
    return out;
  }
  // 노트에 들어 있는 그림 파일 경로(노트 폴더 안으로 한정). 노트 옆 상대 경로를 먼저, 없으면 폴더 전체에서 같은 이름을 찾는다.
  const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;
  async function image(noteName, src) {
    const root = path.resolve(dir()); const np = await locate(noteName);
    let rel; try { rel = decodeURIComponent(String(src)); } catch { rel = String(src); }
    if (!IMG.test(rel) || /^[a-z]+:/i.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return null;
    const inside = (p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
    const first = path.resolve(path.dirname(np), rel);
    if (inside(first)) { try { const st = await fs.promises.stat(first); if (st.isFile() && st.size < 12 * 1024 * 1024) return first; } catch {} }
    const base = path.basename(rel).toLowerCase(); const stack = [[root, 0]];
    while (stack.length) { const [cur, d] = stack.pop(); let es; try { es = await fs.promises.readdir(cur, { withFileTypes: true }); } catch { continue; } for (const e of es) { if (e.name.startsWith('.')) continue; const full = path.join(cur, e.name); if (e.isDirectory()) { if (d < 4) stack.push([full, d + 1]); } else if (e.name.toLowerCase() === base) { try { const st = await fs.promises.stat(full); if (st.size < 12 * 1024 * 1024) return full; } catch {} } } }
    return null;
  }
  return { safeName, key, read, write, info, walk, dir, fileFor, search, image };
}
module.exports = { createNotes, safeName, linksOf };
