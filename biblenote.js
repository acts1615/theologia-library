'use strict';
// 성경 노트: 책·장·절을 골라 메모를 쓰면 노트 폴더 안의 '그 장 파일'(예: 로마서 03장.md)에 카드로 넣는다.
// - 그 장 파일이 없으면 새로 만들고, 있으면(이름이 '로마서 3장'이든 '로마서 03장'이든, 하위 폴더에 있든) 그 파일에 끼워 넣기만 한다.
// - 기존 내용은 지우거나 바꾸지 않는다. 같은 절의 기존 메모 아래에 카드를 덧붙인다.
// - 카드 모양(옵시디언에서 접었다 펼 수 있음):   > [!memo]- 출처 · 3-5절
const fs = require('fs');
const path = require('path');
const { BOOKS, NAME, bookId } = require('./bible');

// 개역한글(저작권 만료, 공개 도메인) 본문: bible-krv.json = [책 순서][장 순서][절 순서]
let KRV = null;
function krvChapter(bid, ch) {
  if (!KRV) { try { KRV = JSON.parse(fs.readFileSync(path.join(__dirname, 'bible-krv.json'), 'utf8')); } catch { KRV = []; } }
  return (KRV[bid - 1] && KRV[bid - 1][ch - 1]) || [];
}
const CH = {}; for (const b of BOOKS) CH[b[0]] = b[4];
const pad = (bid, ch) => String(ch).padStart(bid === 19 ? 3 : 2, '0');
const chapterName = (bid, ch) => `${NAME[bid]} ${pad(bid, ch)}장`;
const bookDir = (bid) => `${String(bid).padStart(2, '0')} ${NAME[bid]}`;
const NAME_RE = /^(.+?)\s*0*(\d+)\s*(?:장|편)$/;
const VERSE_H = /^###\s*(\d+)\s*절\s*$/;
const SEC_H = /^##(?!#)\s/;

// ---- 구절 자동 링크 ([[로마서 03장#5절|롬 3:5]]) ----
const NAMES = []; for (const b of BOOKS) for (const n of [b[1], ...b[2]]) NAMES.push(n);
NAMES.sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REF = new RegExp(
  '(?<![가-힣A-Za-z0-9])(?<book>' + [...new Set(NAMES)].map(esc).join('|') + ')\\s*(?<ch>\\d{1,3})\\s*(?:(?<jang>[장편])\\s*(?:(?<v1>\\d{1,3})(?:\\s*[-–~]\\s*(?<v2>\\d{1,3}))?\\s*절?)?|:\\s*(?<v1b>\\d{1,3})(?:\\s*[-–~]\\s*(?<v2b>\\d{1,3}))?)' +
  '|(?<![\\d:가-힣A-Za-z])(?<bch>\\d{1,3}):(?<bv1>\\d{1,3})(?:[-–~](?<bv2>\\d{1,3}))?(?!\\d)', 'g');

function linkRefs(text, curBid, nameOf) {
  const added = [];
  const out = String(text).split('\n').map((line) => {
    if (/^\s*!?\[\[/.test(line) && !/\s/.test(line.trim())) return line;
    const spans = [...line.matchAll(/\[\[.*?\]\]/g)].map((m) => [m.index, m.index + m[0].length]);
    let res = '', pos = 0, last = curBid; REF.lastIndex = 0; let m;
    while ((m = REF.exec(line))) {
      const st = m.index, en = st + m[0].length;
      if (spans.some(([a, b]) => st < b && en > a)) continue;
      const g = m.groups; let bid, ch, v1;
      if (g.book) { bid = bookId(g.book); ch = +g.ch; v1 = g.v1 || g.v1b; }
      else {
        const pre = line.slice(0, st);
        if (!pre.replace(/[ \-*>•·#]/g, '')) continue;                              // 줄머리 숫자(구절 번호)
        if (/[0-9\-/:]$/.test(pre) || /\d{4}-\d{1,2}-\d{1,2}\s*$/.test(pre) || line[en] === ':') continue;   // 날짜·시각
        bid = last; ch = +g.bch; v1 = g.bv1;
      }
      if (!bid || ch < 1 || ch > CH[bid]) continue;
      res += line.slice(pos, st); pos = en; last = bid;
      const nm = nameOf(bid, ch), raw = m[0];
      res += v1 ? `[[${nm}#${+v1}절|${raw}]]` : `[[${nm}|${raw}]]`;
      added.push(`${raw} → ${NAME[bid]} ${ch}${bid === 19 ? '편' : '장'}${v1 ? ' ' + (+v1) + '절' : ''}`);
    }
    return res + line.slice(pos);
  });
  return { text: out.join('\n'), added };
}

// ---- 카드 넣기 (순수 함수: 파일 내용을 받아 새 내용을 돌려준다) ----
function cardLines(v, end, source, body) {
  const title = (String(source || '').trim().replace(/\s+/g, ' ') || '메모') + (v && end && end > v ? ` · ${v}-${end}절` : '');
  return [`> [!memo]- ${title}`, ...String(body).replace(/\r/g, '').split('\n').map((l) => (l.trim() ? '> ' + l : '>'))];
}
function insertCard(text, { v, end, source, body, vtext }) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const card = cardLines(v, end, source, body);
  const heads = []; lines.forEach((l, i) => { const m = VERSE_H.exec(l); if (m) heads.push({ i, n: +m[1] }); });
  const place = (at, block) => {               // 앞뒤에 이미 빈 줄이 있으면 겹치지 않게
    if (at > 0 && !lines[at - 1].trim() && block[0] === '') block = block.slice(1);
    if (at < lines.length && !lines[at].trim() && block[block.length - 1] === '') block = block.slice(0, -1);
    lines.splice(at, 0, ...block);
  };
  const trimEnd = () => { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); };
  if (!v) {                                    // 장 전체 메모: 첫 소제목/절 앞(없으면 맨 끝)
    const first = lines.findIndex((l) => SEC_H.test(l) || VERSE_H.test(l));
    if (first < 0) { trimEnd(); lines.push('', ...card, ''); }
    else { let k = first; while (k > 0 && !lines[k - 1].trim()) k--; place(k, ['', ...card, '']); }
    return lines.join(eol);
  }
  const mine = heads.find((h) => h.n === v);
  if (mine) {                                  // 그 절 구역의 맨 끝(다음 절/소제목 바로 앞)에 덧붙임
    let j = lines.length;
    for (let k = mine.i + 1; k < lines.length; k++) if (SEC_H.test(lines[k]) || VERSE_H.test(lines[k])) { j = k; break; }
    if (j === lines.length) { trimEnd(); lines.push('', ...card, ''); return lines.join(eol); }
    let k = j; while (k > mine.i + 1 && !lines[k - 1].trim()) k--;
    place(k, ['', ...card, '']); return lines.join(eol);
  }
  const block = [`### ${v}절`, '', ...(vtext ? [`**${vtext}**`, ''] : []), ...card, ''];
  const next = heads.find((h) => h.n > v);
  if (next) {                                  // 다음 절 앞(그 절 위에 소제목이 있으면 그 소제목 앞)에 새 절 구역
    let p = next.i, q = p - 1; while (q >= 0 && !lines[q].trim()) q--;
    if (q >= 0 && SEC_H.test(lines[q])) p = q;
    place(p, block); return lines.join(eol);
  }
  trimEnd(); lines.push('', ...block); return lines.join(eol);
}
function newFile(bid, ch, fill = true) {
  const head = `---\n책: ${NAME[bid]}\n장: ${ch}\n분류: ${bid <= 39 ? '구약' : '신약'}\ntags: [성경연구, ${NAME[bid]}]\n---\n# ${chapterName(bid, ch)}\n`;
  if (!fill) return head;
  return head + krvChapter(bid, ch).map((t, i) => `\n### ${i + 1}절\n\n**${t}**\n`).join('');   // 개역한글 본문을 절 구역으로 깔아 둔다
}

// ---- 그 장의 메모 카드 읽기 ----
function readCards(text) {
  const lines = String(text).split(/\r?\n/); const out = []; let v = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = VERSE_H.exec(lines[i]); if (h) { v = +h[1]; continue; }
    const m = /^> \[!memo\]-?\s*(.*)$/.exec(lines[i]); if (!m) continue;
    const t = m[1].trim(), r = /^(.*?)\s*·\s*(\d+)-(\d+)절$/.exec(t); const body = [];
    while (i + 1 < lines.length && /^>/.test(lines[i + 1]) && !/^> \[!/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ''));
    out.push({ v, source: r ? r[1] : t, end: r ? +r[3] : 0, body: body.join('\n').trim() });
  }
  return out;
}


// ---- 노트성경: 한 장을 절 단위로 읽고(본문은 장 파일에 있는 글), 절마다 메모 카드를 보고/고친다 ----
function locateRegion(lines, v) {
  let start;
  if (!v) { const i = lines.findIndex((l) => /목차\]\]/.test(l) || /^#\s/.test(l)); start = i < 0 ? 0 : i + 1; }
  else {
    const i = lines.findIndex((l) => { const m = VERSE_H.exec(l); return m && +m[1] === v; }); if (i < 0) return null;
    let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
    if (lines[j] && lines[j].startsWith('**')) j++;
    while (j < lines.length && !lines[j].trim()) j++;
    if (lines[j] && /^> \[!note\]-\s*다른 번역/.test(lines[j])) while (j < lines.length && lines[j].startsWith('>')) j++;
    start = j;
  }
  let end = start; while (end < lines.length && !(SEC_H.test(lines[end]) || VERSE_H.test(lines[end]))) end++;
  return [start, end];
}
function parseRegion(txt) {
  const L = String(txt).split(/\r?\n/), leg = [], cards = []; let i = 0;
  while (i < L.length) {
    const m = /^> \[!memo\]-?\s*(.*)$/.exec(L[i]);
    if (m) {
      const t = m[1].trim(), r = /^(.*?)\s*·\s*(\d+)-(\d+)절$/.exec(t), body = []; i++;
      while (i < L.length && L[i].startsWith('>') && !/^> \[!/.test(L[i])) { body.push(L[i].replace(/^>\s?/, '')); i++; }
      cards.push({ source: r ? r[1] : t, end: r ? +r[3] : 0, body: body.join('\n').trim() }); continue;
    }
    leg.push(L[i]); i++;
  }
  return { legacy: leg.join('\n').trim(), cards };
}
function buildRegion(p, v) {
  const parts = []; if (p.legacy) parts.push(p.legacy);
  for (const c of p.cards) parts.push(cardLines(v, c.end, c.source, c.body).join('\n'));
  return parts.join('\n\n');
}
// '> [!note]- 다른 번역' 칸: '> **새번역** 글' 줄들 → { 새번역: '글', ... }
function transOf(L, hi) {
  let j = hi + 1; while (j < L.length && !L[j].trim()) j++;
  if (L[j] && L[j].startsWith('**')) j++;
  while (j < L.length && !L[j].trim()) j++;
  const out = {}; if (!(L[j] && /^> \[!note\]-?\s*다른 번역/.test(L[j]))) return out;
  let cur = ''; for (j++; j < L.length && L[j].startsWith('>'); j++) {
    const t = L[j].replace(/^>\s?/, ''); const m = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(t);
    if (m) { cur = m[1].trim(); out[cur] = m[2].trim(); } else if (cur && t.trim()) out[cur] += ' ' + t.trim();
  }
  return out;
}
function viewOf(text, krv = []) {
  const L = String(text).split(/\r?\n/); const heads = []; L.forEach((l, i) => { const m = VERSE_H.exec(l); if (m) heads.push({ i, n: +m[1] }); });
  const chap = parseRegion(L.slice(...(locateRegion(L, 0) || [0, 0])).join('\n'));
  const firstH = L.findIndex((l) => SEC_H.test(l) || VERSE_H.test(l));
  if (!heads.length) return { chapter: parseRegion(L.join('\n')), verses: fillVerses([], krv) };
  const cr = locateRegion(L, 0); const cb = parseRegion(L.slice(cr[0], firstH < 0 ? L.length : firstH).join('\n'));
  const verses = heads.map((h, k) => {
    let j = h.i + 1; while (j < L.length && !L[j].trim()) j++;
    const vt = L[j] && L[j].startsWith('**') ? L[j].replace(/^\*\*|\*\*$/g, '').trim() : '';
    let hd = ''; { let q = h.i - 1; while (q >= 0 && !L[q].trim()) q--; if (q >= 0 && SEC_H.test(L[q])) hd = L[q].replace(/^##\s*/, '').trim(); }
    const r = locateRegion(L, h.n); const p = parseRegion(L.slice(r[0], r[1]).join('\n'));
    return { n: h.n, head: hd, text: vt, trans: transOf(L, h.i), legacy: p.legacy, cards: p.cards };
  });
  const names = []; for (const v of verses) for (const k of Object.keys(v.trans || {})) if (!names.includes(k)) names.push(k);
  return { chapter: cb, verses: fillVerses(verses, krv), translations: names };
}
function fillVerses(verses, krv) {               // 파일에 없는 절도 개역한글로 채워 1절부터 끝 절까지 보여 준다
  const m = new Map(verses.map((v) => [v.n, v]));
  for (let n = 1; n <= krv.length; n++) if (!m.has(n)) m.set(n, { n, head: '', text: '', legacy: '', cards: [] });
  return [...m.values()].sort((a, b) => a.n - b.n).map((v) => ({ ...v, krv: krv[v.n - 1] || '' }));
}

// ---- 다른 곳에서 이 절을 언급한 글 찾기 (링크 [[로마서 05장#12절]] 와 본문 속 '롬 3:24' 표기 모두) ----
function scanMentions(text, ownBid, ownCh) {
  const out = []; let ctxV = 0, inFm = false, k = 0;
  const lines = String(text).split(/\r?\n/);
  if (lines[0] === '---') { inFm = true; k = 1; }
  for (; k < lines.length; k++) {
    const line = lines[k];
    if (inFm) { if (line === '---') inFm = false; continue; }
    const h = VERSE_H.exec(line); if (h) { ctxV = +h[1]; continue; }
    if (/^\*\*/.test(line) && !/^> /.test(line)) continue;               // 본문 줄은 건너뜀
    if (!line.includes('[[') && !/[가-힣]\s*\d|\d+:\d/.test(line)) continue;
    const found = [];
    // 위키링크
    for (const m of line.matchAll(/\[\[([^\]|#]+)#(\d+)절(?:\|[^\]]*)?\]\]/g)) {
      const nm = NAME_RE.exec(m[1].trim().normalize('NFC')); if (!nm) continue; const bid = bookId(nm[1].trim()); if (!bid) continue;
      found.push({ bid, ch: +nm[2], v1: +m[2], v2: +m[2] });
    }
    // 본문 속 표기 (링크 안은 제외)
    const bare = line.replace(/\[\[.*?\]\]/g, ' ');
    let last = ownBid; REF.lastIndex = 0; let m;
    while ((m = REF.exec(bare))) {
      const g = m.groups; let bid, ch, v1, v2;
      if (g.book) { bid = bookId(g.book); ch = +g.ch; v1 = g.v1 || g.v1b; v2 = g.v2 || g.v2b; }
      else {
        const pre = bare.slice(0, m.index);
        if (!pre.replace(/[ \-*>•·#]/g, '')) continue;
        if (/[0-9\-/:]$/.test(pre) || bare[m.index + m[0].length] === ':') continue;
        bid = last; ch = +g.bch; v1 = g.bv1; v2 = g.bv2;
      }
      if (!bid || ch < 1 || ch > CH[bid]) continue; last = bid;
      if (v1) found.push({ bid, ch, v1: +v1, v2: v2 ? Math.max(+v1, +v2) : +v1 });
    }
    if (!found.length) continue;
    const snip = line.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/^[>\s]*(\[![a-z]+\]-?\s*)?/i, '').replace(/\*\*/g, '').trim().slice(0, 160);
    for (const f of found) {
      if (f.bid === ownBid && f.ch === ownCh && ctxV >= f.v1 && ctxV <= f.v2) continue;   // 자기 자신 구역은 제외
      out.push({ ...f, ctxV, text: snip });
    }
  }
  return out;
}

function createBibleNotes(notes) {
  const MC = new Map();                            // 파일 경로 → { sig, refs } (바뀐 파일만 다시 읽음)
  async function mentionsFor(bid, ch, idx) {
    const files = (await notes.walk()).filter((x) => !/^00[ _]/.test(x.name)); const res = [], live = new Set();
    for (const x of files) {
      live.add(x.path); let st; try { st = await fs.promises.stat(x.path); } catch { continue; }
      if (st.size > 2 * 1024 * 1024) continue;
      const sig = st.mtimeMs + ':' + st.size; let c = MC.get(x.path);
      if (!c || c.sig !== sig) {
        let t = ''; try { t = await fs.promises.readFile(x.path, 'utf8'); } catch { continue; }
        const nm = NAME_RE.exec(x.name.normalize('NFC')); const ob = nm ? bookId(nm[1].trim()) : 0, oc = nm ? +nm[2] : 0;
        c = { sig, own: ob ? [ob, oc] : null, refs: t.includes('[[') || /\d/.test(t) ? scanMentions(t, ob || 0, oc) : [] }; MC.set(x.path, c);
      }
      for (const r of c.refs) if (r.bid === bid && r.ch === ch) res.push({ ...r, file: x.name, own: c.own });
    }
    for (const k of [...MC.keys()]) if (!live.has(k)) MC.delete(k);
    return res;
  }
  async function chapterIndex() {                // '책|장' → { name, path }
    const idx = new Map();
    for (const x of await notes.walk()) {
      const m = NAME_RE.exec(x.name.normalize('NFC')); if (!m) continue;
      const bid = bookId(m[1].trim()); if (!bid) continue;
      const k = bid + ':' + (+m[2]); if (!idx.has(k)) idx.set(k, x);
    }
    return idx;
  }
  async function newPath(bid, ch) {
    const root = path.resolve(notes.dir());
    const base = fs.existsSync(path.join(root, bookDir(bid))) ? root : path.join(root, '성경노트');
    return path.join(base, bookDir(bid), chapterName(bid, ch) + '.md');
  }
  async function add({ book, chapter, verse = 0, end = 0, source = '', text = '', link = true, fill = true }) {
    const bid = Number(book), ch = Number(chapter), v = Number(verse) || 0, e = Number(end) || 0;
    if (!NAME[bid]) throw Object.assign(new Error('성경 책을 골라 주세요.'), { status: 400 });
    if (!(ch >= 1 && ch <= CH[bid])) throw Object.assign(new Error(`${NAME[bid]}은(는) ${CH[bid]}${bid === 19 ? '편' : '장'}까지 있습니다.`), { status: 400 });
    if (v < 0 || v > 200 || (e && e < v)) throw Object.assign(new Error('절 번호를 확인해 주세요.'), { status: 400 });
    if (!String(text).trim()) throw Object.assign(new Error('메모 내용을 적어 주세요.'), { status: 400 });
    const idx = await chapterIndex();
    const nameOf = (b, c) => { const x = idx.get(b + ':' + c); return x ? x.name : chapterName(b, c); };
    let body = String(text).trim(), added = [];
    if (link) { const r = linkRefs(body, bid, nameOf); body = r.text; added = r.added; }
    const hit = idx.get(bid + ':' + ch);
    let file = hit ? hit.path : await newPath(bid, ch), created = !hit, cur = '';
    if (hit) { const st = await fs.promises.stat(file); if (st.size > 2 * 1024 * 1024) throw new Error('이 장 노트가 너무 큽니다(2MB 초과).'); cur = await fs.promises.readFile(file, 'utf8'); if (cur.charCodeAt(0) === 0xFEFF) cur = cur.slice(1); }
    else cur = newFile(bid, ch, fill !== false);
    const next = insertCard(cur, { v, end: e, source, body, vtext: !hit && v && fill !== false ? krvChapter(bid, ch)[v - 1] : '' });   // 이미 있는 파일에는 다른 번역을 섞어 넣지 않는다
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tl-tmp'; await fs.promises.writeFile(tmp, next.endsWith('\n') ? next : next + '\n', 'utf8'); await fs.promises.rename(tmp, file);
    return { name: path.basename(file).replace(/\.md$/i, ''), created, added };
  }
  async function fileOf(bid, ch) { const hit = (await chapterIndex()).get(bid + ':' + ch); return hit || null; }
  async function view(book, ch) {
    const bid = Number(book), c = Number(ch); const hit = await fileOf(bid, c);
    const krv = krvChapter(bid, c);
    const ments = await mentionsFor(bid, c);
    const attach = (d) => { for (const v of d.verses) v.mentions = ments.filter((r) => v.n >= r.v1 && v.n <= r.v2).slice(0, 30).map((r) => ({ file: r.file, text: r.text, go: r.own ? { book: r.own[0], chapter: r.own[1], verse: r.ctxV } : null })); return d; };
    if (!hit) return attach({ exists: false, name: chapterName(bid, c), chapter: { legacy: '', cards: [] }, verses: fillVerses([], krv) });
    const t = (await fs.promises.readFile(hit.path, 'utf8')).replace(/^﻿/, '');
    return attach({ exists: true, name: hit.name, ...viewOf(t, krv) });
  }
  // 한 구역(절 또는 장 전체)의 카드를 고치거나 지운다.  action: 'edit' | 'delete'
  async function changeCard({ book, chapter, verse = 0, index, action, source = '', end = 0, text = '', link = true }) {
    const bid = Number(book), ch = Number(chapter), v = Number(verse) || 0, i = Number(index);
    const hit = await fileOf(bid, ch); if (!hit) throw Object.assign(new Error('이 장 노트 파일을 찾지 못했습니다.'), { status: 404 });
    let cur = (await fs.promises.readFile(hit.path, 'utf8')).replace(/^﻿/, '');
    const eol = /\r\n/.test(cur) ? '\r\n' : '\n'; const L = cur.split(/\r?\n/); const r = locateRegion(L, v);
    if (!r) throw Object.assign(new Error('이 절의 위치를 찾지 못했습니다.'), { status: 404 });
    const p = parseRegion(L.slice(r[0], r[1]).join('\n'));
    if (!(i >= 0 && i < p.cards.length)) throw Object.assign(new Error('메모를 찾지 못했습니다. 다시 열어 확인해 주세요.'), { status: 409 });
    if (action === 'delete') p.cards.splice(i, 1);
    else {
      if (!String(text).trim()) throw Object.assign(new Error('메모 내용을 적어 주세요.'), { status: 400 });
      let body = String(text).trim(), added = [];
      if (link) { const idx = await chapterIndex(); const x = linkRefs(body, bid, (b, c) => { const h = idx.get(b + ':' + c); return h ? h.name : chapterName(b, c); }); body = x.text; added = x.added; }
      p.cards[i] = { source: String(source).trim(), end: Number(end) || 0, body };
    }
    const reg = buildRegion(p, v); L.splice(r[0], r[1] - r[0], ...(reg ? ['', ...reg.split('\n'), ''] : ['']));
    const out = L.join(eol); const tmp = hit.path + '.tl-tmp'; await fs.promises.writeFile(tmp, out.endsWith('\n') ? out : out + '\n', 'utf8'); await fs.promises.rename(tmp, hit.path);
    return { name: hit.name };
  }
  async function chapter(book, ch) {
    const bid = Number(book), c = Number(ch); const hit = (await chapterIndex()).get(bid + ':' + c);
    if (!hit) return { exists: false, name: chapterName(bid, c), cards: [] };
    let t = ''; try { t = await fs.promises.readFile(hit.path, 'utf8'); } catch {}
    return { exists: true, name: hit.name, cards: readCards(t) };
  }
  const meta = () => BOOKS.map((b) => ({ id: b[0], name: b[1], chapters: b[4], unit: b[0] === 19 ? '편' : '장' }));
  return { add, chapter, view, changeCard, meta };
}
module.exports = { scanMentions, createBibleNotes, insertCard, linkRefs, readCards, chapterName, viewOf, parseRegion, buildRegion };
