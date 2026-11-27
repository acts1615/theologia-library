'use strict';
// 교리·신조: 하이델베르크 요리문답처럼 '주일/장 → 문답/조항' 구조의 문서를 data/교리/<id>.json 으로 두고,
// 문답(조항)마다 메모를 data/교리메모.json 에 따로 모은다. 문서는 t9hb 저장소(client/public/confessions)와 같은 형식이라
// 소요리문답·도르트 신조·벨직 신앙고백서 등을 같은 형식으로 계속 넣을 수 있다.
const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/acts1615/t9hb/main/client/public/confessions/';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function plain(lines) { return (lines || []).map((l) => (l.s || []).filter((x) => typeof x === 'string').join('')).join(' ').replace(/\s+/g, ' ').trim(); }

function validate(d) {
  if (!d || typeof d !== 'object') throw Object.assign(new Error('문서 형식이 아닙니다.'), { status: 400 });
  if (!ID_RE.test(String(d.id || ''))) throw Object.assign(new Error('문서 id는 영문·숫자·_- 로 40자까지입니다.'), { status: 400 });
  if (!d.title || !Array.isArray(d.units) || !d.units.length) throw Object.assign(new Error('제목과 units 가 있어야 합니다.'), { status: 400 });
  for (const u of d.units) {
    if (!Number.isFinite(+u.no) || !Array.isArray(u.items)) throw Object.assign(new Error('units 의 모양이 맞지 않습니다.'), { status: 400 });
    for (const it of u.items) if (!Number.isFinite(+it.no) || !Array.isArray(it.q) || !Array.isArray(it.a)) throw Object.assign(new Error('문답(items)의 모양이 맞지 않습니다.'), { status: 400 });
  }
  return d;
}

function createDoctrine({ dataDir }) {
  const dir = path.join(dataDir, '교리');
  const memoFile = path.join(dataDir, '교리메모.json');
  let memos = { docs: {} };
  try { const j = JSON.parse(fs.readFileSync(memoFile, 'utf8')); if (j && j.docs) memos = j; } catch {}
  let timer = null, dirty = false;
  const cache = new Map();   // id → { mtime, doc, text }

  function flush() {
    clearTimeout(timer); timer = null; if (!dirty) return; dirty = false;
    try { const tmp = memoFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(memos)); fs.renameSync(tmp, memoFile); } catch {}
  }
  function touch() { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 400); }

  function load(id) {
    if (!ID_RE.test(id)) return null;
    const f = path.join(dir, id + '.json');
    let st; try { st = fs.statSync(f); } catch { return null; }
    const c = cache.get(id); if (c && c.mtime === st.mtimeMs) return c;
    let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); validate(doc); } catch { return null; }
    const text = new Map();   // 'u:n' → 검색용 글
    for (const u of doc.units) for (const it of u.items) text.set(u.no + ':' + it.no, [it.heading || '', plain(it.q), plain(it.a), Object.values(it.notes || {}).join(' ')].join(' '));
    const v = { mtime: st.mtimeMs, doc, text }; cache.set(id, v); return v;
  }
  function list() {
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch {}
    const out = [];
    for (const id of names) {
      const c = load(id); if (!c) continue; const d = c.doc;
      const m = memos.docs[id] || {};
      out.push({ id, title: d.title, subtitle: d.subtitle || '', short: d.short || d.title, unitLabel: d.unitLabel || '장', itemLabel: d.itemLabel || '문', credit: d.credit || '', units: d.units.length, items: d.units.reduce((n, u) => n + u.items.length, 0), memos: Object.values(m).filter((x) => x.t).length });
    }
    out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title, 'ko'));
    return out;
  }
  function get(id) {
    const c = load(id); if (!c) throw Object.assign(new Error('그 문서가 없습니다.'), { status: 404 });
    return { doc: c.doc, memos: memos.docs[id] || {} };
  }
  function putDoc(d) {
    validate(d); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, d.id + '.json'); const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, f); cache.delete(d.id);
    return { id: d.id, title: d.title };
  }
  function setMemo(id, u, n, text) {
    const c = load(id); if (!c) throw Object.assign(new Error('그 문서가 없습니다.'), { status: 404 });
    const key = `${+u}:${+n}`; if (!c.text.has(key)) throw Object.assign(new Error('그 문답이 없습니다.'), { status: 400 });
    const t = String(text == null ? '' : text).slice(0, 20000);
    const m = memos.docs[id] || (memos.docs[id] = {});
    if (t.trim()) m[key] = { t, at: new Date().toISOString() }; else delete m[key];
    touch(); return { ok: true, count: Object.keys(m).length };
  }
  // 검색: 본문·주석 구절·메모에서 모든 낱말이 들어 있는 문답. 메모만 모아 보려면 memoOnly.
  function search({ q = '', docId = '', memoOnly = false } = {}) {
    const terms = String(q).normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean); const out = [];
    for (const e of list()) {
      if (docId && e.id !== docId) continue;
      const c = load(e.id); const m = memos.docs[e.id] || {};
      for (const u of c.doc.units) for (const it of u.items) {
        const k = u.no + ':' + it.no, memo = m[k] ? m[k].t : '';
        if (memoOnly && !memo) continue;
        const hay = (c.text.get(k) + ' ' + memo).normalize('NFC').toLowerCase();
        if (terms.every((t) => hay.includes(t))) out.push({ doc: e.id, docTitle: e.title, short: e.short, unit: u.no, unitTitle: u.title || (u.no + e.unitLabel), item: it.no, itemLabel: e.itemLabel, q: plain(it.q), memo, at: m[k] ? m[k].at : '' });
        if (out.length >= 500) return out;
      }
    }
    return out;
  }
  // t9hb 저장소에서 문서 목록과 문서를 받아 data/교리/ 에 넣는다 (이미 있으면 덮어쓴다 — 메모는 따로라 그대로)
  async function fetchRemote(base = BASE) {
    if (!/^https:\/\//.test(base)) throw Object.assign(new Error('https 주소만 쓸 수 있습니다.'), { status: 400 });
    const get = async (u) => { const r = await fetch(u, { redirect: 'follow' }); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); };
    const idx = await get(base + 'index.json'); if (!Array.isArray(idx)) throw new Error('목록 형식이 맞지 않습니다.');
    const got = [], failed = [];
    for (const e of idx) {
      if (!e || !ID_RE.test(String(e.id || ''))) continue;
      try { const d = await get(base + e.id + '.json'); got.push(putDoc(d)); } catch (er) { failed.push(`${e.id}: ${er.message}`); }
    }
    return { got, failed };
  }
  return { list, get, putDoc, setMemo, search, fetchRemote, flush, dir: () => dir };
}

module.exports = { createDoctrine };
