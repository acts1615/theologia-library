'use strict';
// EPUB 읽기: 압축 해제(fflate) + OPF/목차 해석(fast-xml-parser). DRM이 걸린 EPUB은 지원하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const { unzipSync } = require('fflate');
const { XMLParser } = require('fast-xml-parser');

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, trimValues: true, parseTagValue: false, parseAttributeValue: false, isArray: (n) => ['item', 'itemref', 'creator', 'identifier', 'subject', 'meta', 'navPoint', 'li', 'a', 'ol', 'nav', 'rootfile', 'contributor', 'publisher', 'title', 'language', 'date', 'description'].includes(n) });
const MIME = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'application/xhtml+xml; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', ncx: 'application/xml', opf: 'application/xml', xml: 'application/xml', mp3: 'audio/mpeg', mp4: 'video/mp4' };
const mimeOf = (p) => MIME[String(p).split('.').pop().toLowerCase()] || 'application/octet-stream';

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(txt).filter(Boolean)[0] || '';
  if (typeof x === 'object') return txt(x['#text'] ?? '');
  return String(x);
};
const decode = (b) => new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');
// 압축 안의 경로(zip 항목 이름)를 정리한다: 상대경로·퍼센트 인코딩·./ ../ 처리
function joinZip(base, rel) {
  let r = String(rel || '').split('#')[0].split('?')[0];
  try { r = decodeURIComponent(r); } catch {}
  const parts = (r.startsWith('/') ? r.slice(1) : (base ? base + '/' + r : r)).split('/'); const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

const cache = new Map();   // 경로 → { mtime, size, book }   (최근 6권)
class Book {
  constructor(file, buf) {
    this.file = file; this.buf = new Uint8Array(buf); this.names = new Set(); this.nameLower = new Map();
    unzipSync(this.buf, { filter: (f) => { this.names.add(f.name); this.nameLower.set(f.name.toLowerCase(), f.name); return false; } });
    this.textCache = new Map();
    this.parse();
  }
  has(n) { return this.names.has(n) || this.nameLower.has(String(n).toLowerCase()); }
  real(n) { return this.names.has(n) ? n : this.nameLower.get(String(n).toLowerCase()); }
  read(name) {
    const real = this.real(name); if (!real) return null;
    const out = unzipSync(this.buf, { filter: (f) => f.name === real });
    return out[real] || null;
  }
  parse() {
    if (this.has('META-INF/encryption.xml')) {   // 글꼴만 난독화한 것은 허용, 그 밖의 암호화는 DRM 으로 본다
      const enc = decode(this.read('META-INF/encryption.xml') || new Uint8Array());
      const algs = [...enc.matchAll(/Algorithm\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
      if (algs.some((a) => a !== 'http://www.idpf.org/2008/embedding' && a !== 'http://ns.adobe.com/pdf/enc#RC')) this.drm = true;
    }
    const cont = this.read('META-INF/container.xml'); if (!cont) throw new Error('EPUB 형식이 아닙니다(container.xml 없음).');
    const rf = arr(arr(xml.parse(decode(cont)).container?.rootfiles?.rootfile)); const opfPath = rf[0] && rf[0]['@full-path'];
    if (!opfPath) throw new Error('EPUB 패키지 파일을 찾지 못했습니다.');
    this.opfPath = opfPath; this.base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const opfRaw = this.read(opfPath); if (!opfRaw) throw new Error('EPUB 패키지 파일을 읽지 못했습니다.');
    const pkg = xml.parse(decode(opfRaw)).package || {};
    const md = pkg.metadata || {};
    this.meta = {
      title: txt(md.title), creators: arr(md.creator).map((c) => txt(c)).filter(Boolean), publisher: txt(md.publisher), date: txt(md.date),
      language: txt(md.language), description: txt(md.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      subjects: arr(md.subject).map(txt).filter(Boolean), identifiers: arr(md.identifier).map(txt).filter(Boolean),
    };
    const metas = arr(md.meta);
    this.manifest = new Map();
    for (const it of arr(pkg.manifest?.item)) this.manifest.set(it['@id'], { id: it['@id'], href: it['@href'], type: it['@media-type'] || '', props: String(it['@properties'] || '') });
    this.spine = arr(pkg.spine?.itemref).map((r) => this.manifest.get(r['@idref'])).filter((x) => x && /html|xml/i.test(x.type) && !/\.(jpe?g|png|gif)$/i.test(x.href))
      .map((x, i) => ({ i, id: x.id, href: x.href, path: joinZip(this.base, x.href) }));
    this.spine.forEach((s, i) => { s.i = i; });
    this.ncxId = pkg.spine?.['@toc'];
    const coverMeta = metas.find((m) => m['@name'] === 'cover'); let cover = null;
    for (const it of this.manifest.values()) if (/(^|\s)cover-image(\s|$)/.test(it.props)) cover = it;
    if (!cover && coverMeta) cover = this.manifest.get(coverMeta['@content']);
    if (!cover) cover = [...this.manifest.values()].find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + ' ' + m.href));
    this.coverPath = cover ? joinZip(this.base, cover.href) : '';
    this.dir = String(pkg['@dir'] || '').toLowerCase() === 'rtl' || String(pkg.spine?.['@page-progression-direction'] || '') === 'rtl' ? 'rtl' : 'ltr';
    this.isbn = (() => { for (const id of this.meta.identifiers) { const d = String(id).replace(/[^0-9Xx]/g, ''); if (/^97[89]\d{10}$/.test(d)) return d; } return ''; })();
    this.buildToc(pkg);
    this.weights();
  }
  weights() {   // 장별 글자 수 → 책 전체 위치(0~1)를 장 번호와 장 안의 비율로 바꾸는 데 쓴다
    const want = new Set(this.spine.map((s) => s.path)); const all = unzipSync(this.buf, { filter: (f) => want.has(f.name) });
    let total = 0; this.spine.forEach((s) => { const e = all[s.path]; s.len = e ? Math.max(200, e.length) : 200; total += s.len; });
    let cum = 0; this.spine.forEach((s) => { s.start = cum / total; cum += s.len; s.end = cum / total; });
  }
  tocTarget(href, from) {
    const base = from || this.base; const clean = String(href || '').split('#')[0]; const anchor = String(href || '').includes('#') ? String(href).split('#').slice(1).join('#') : '';
    const p = joinZip(base, clean); const s = this.spine.find((x) => x.path === p) || this.spine.find((x) => x.path.toLowerCase() === p.toLowerCase());
    return s ? { spine: s.i, anchor } : null;
  }
  buildToc(pkg) {
    const toc = [];
    const nav = [...this.manifest.values()].find((m) => /(^|\s)nav(\s|$)/.test(m.props));
    const walkOl = (ol, level, from) => {
      for (const o of arr(ol)) for (const li of arr(o.li)) {
        const a = arr(li.a)[0] || (li.span && { '#text': txt(li.span) }); const label = a ? txt(a['#text'] ?? a).replace(/\s+/g, ' ').trim() : '';
        const href = a && a['@href']; const t = href ? this.tocTarget(href, from) : null;
        if (label && t) toc.push({ title: label.slice(0, 200), level: Math.min(level, 3), ...t });
        walkOl(li.ol, level + 1, from);
      }
    };
    if (nav) {
      const raw = this.read(joinZip(this.base, nav.href));
      if (raw) {
        try {
          const doc = xml.parse(decode(raw)); const from = joinZip(this.base, nav.href).split('/').slice(0, -1).join('/');
          const find = (node) => { // epub:type="toc" 인 nav 를 찾는다
            if (!node || typeof node !== 'object') return null;
            if (Array.isArray(node)) { for (const n of node) { const r = find(n); if (r) return r; } return null; }
            for (const [k, v] of Object.entries(node)) {
              if (k === 'nav') { const list = arr(v); const t = list.find((n) => /(^|\s)toc(\s|$)/.test(String(n['@type'] || n['@role'] || ''))) || list[0]; if (t) return t; }
              const r = find(v); if (r) return r;
            }
            return null;
          };
          const navEl = find(doc); if (navEl) walkOl(navEl.ol, 0, from);
        } catch { /* ncx 로 대체 */ }
      }
    }
    if (!toc.length) {
      const ncx = (this.ncxId && this.manifest.get(this.ncxId)) || [...this.manifest.values()].find((m) => /ncx/i.test(m.type));
      if (ncx) {
        const raw = this.read(joinZip(this.base, ncx.href));
        if (raw) {
          try {
            const from = joinZip(this.base, ncx.href).split('/').slice(0, -1).join('/');
            const walk = (pts, level) => { for (const n of arr(pts)) {
              const label = txt(n.navLabel?.text ?? n.navLabel).replace(/\s+/g, ' ').trim(); const src = n.content && (arr(n.content)[0]['@src']); const t = src ? this.tocTarget(src, from) : null;
              if (label && t) toc.push({ title: label.slice(0, 200), level: Math.min(level, 3), ...t });
              walk(n.navPoint, level + 1);
            } };
            walk(xml.parse(decode(raw)).ncx?.navMap?.navPoint, 0);
          } catch { /* 목차 없음 */ }
        }
      }
    }
    this.toc = toc;
  }
  info() {
    return {
      title: this.meta.title, creators: this.meta.creators, publisher: this.meta.publisher, date: this.meta.date, language: this.meta.language, isbn: this.isbn,
      dir: this.dir, drm: !!this.drm, hasCover: !!this.coverPath,
      spine: this.spine.map((s) => ({ i: s.i, path: s.path, start: s.start, end: s.end })),
      toc: this.toc.map((t) => ({ ...t, pos: this.spine[t.spine] ? this.spine[t.spine].start : 0 })),
    };
  }
  // 장 본문을 글자만 뽑는다(검색용). 태그를 지우고 문자 참조를 풀어 한 줄로 만든다.
  text(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    const s = this.spine[i]; const raw = s && this.read(s.path); let t = '';
    if (raw) {
      t = decode(raw).replace(/<head[\s\S]*?<\/head>/gi, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|li|h[1-6]|tr|br|section|blockquote)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
        .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
        .replace(/&amp;/g, '&');
    }
    if (this.textCache.size > 400) this.textCache.clear();
    this.textCache.set(i, t); return t;
  }
  search(q, max = 3000) {
    const flatQ = String(q || '').replace(/\s+/g, '').toLowerCase(); const out = []; let pages = 0;
    if (flatQ.length < 2) return { results: out, total: 0, pages: 0 };
    for (const s of this.spine) {
      const o = this.text(s.i); if (!o) continue;
      let f = ''; const idx = []; for (let k = 0; k < o.length; k++) { const ch = o[k]; if (/\s/.test(ch)) continue; f += ch.toLowerCase(); idx.push(k); }
      let at = 0, k = 0, hit = false;
      while ((at = f.indexOf(flatQ, at)) >= 0) {
        const a = idx[at], b = idx[at + flatQ.length - 1] + 1;
        const pre = o.slice(Math.max(0, a - 34), a).replace(/\s+/g, ' '), mid = o.slice(a, b).replace(/\s+/g, ' '), post = o.slice(b, b + 60).replace(/\s+/g, ' ');
        out.push({ spine: s.i, k: k++, pre: pre.length >= 34 ? '…' + pre.slice(-32) : pre, hit: mid, post, pos: s.start + (s.end - s.start) * (a / Math.max(1, o.length)) }); hit = true;
        at += flatQ.length; if (out.length >= max) break;
      }
      if (hit) pages++; if (out.length >= max) break;
    }
    return { results: out, total: out.length, pages };
  }
}

function open(file) {
  const st = fs.statSync(file); const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) { cache.delete(file); cache.set(file, c); return c.book; }
  const book = new Book(file, fs.readFileSync(file));
  cache.set(file, { mtime: st.mtimeMs, size: st.size, book });
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return book;
}
// 서재에 채울 서지 정보(카카오 후보와 같은 모양)
function meta(file) {
  const b = open(file); const m = b.meta;
  const ymd = (m.date.match(/(\d{4})(?:[-/.]?(\d{2}))?(?:[-/.]?(\d{2}))?/) || []);
  return { title: m.title, author: m.creators.join(', '), publisher: m.publisher, isbn: b.isbn, publishedAt: ymd[1] ? [ymd[1], ymd[2], ymd[3]].filter(Boolean).join('-') : undefined, description: m.description, hasCover: !!b.coverPath, drm: !!b.drm, subjects: m.subjects };
}
// 안전하게 내보낼 자원: 압축 안의 파일만. 스크립트는 CSP 로 막고, 외부 접속도 막는다.
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'";
function resource(file, rel, { html = false } = {}) {
  const b = open(file); let name = joinZip('', rel); const real = b.real(name); if (!real) return null;
  const data = b.read(real); if (!data) return null;
  let type = mimeOf(real);
  if (/\.(xhtml|html|htm)$/i.test(real)) {
    let s = decode(data);
    if (html || !/^\s*(<\?xml|<html[^>]*xmlns)/i.test(s)) {
      s = s.replace(/^\s*<\?xml[^>]*\?>/i, '').replace(/<(a|div|span|p|b|i|em|strong|section|title|script|style|h[1-6]|ul|ol|li|table|tr|td|th|body|head|nav|aside|figure|figcaption|label|button|iframe|textarea)\b([^>]*?)\s*\/>/gi, '<$1$2></$1>');
      type = MIME.html; return { data: Buffer.from(s, 'utf8'), type, csp: CSP };
    }
    type = MIME.xhtml; return { data: Buffer.from(data), type, csp: CSP };
  }
  if (/\.svg$/i.test(real)) return { data: Buffer.from(data), type, csp: CSP };
  return { data: Buffer.from(data), type, csp: CSP };
}
function cover(file) { const b = open(file); if (!b.coverPath) return null; const d = b.read(b.coverPath); return d ? { data: Buffer.from(d), type: mimeOf(b.coverPath) } : null; }

module.exports = { open, meta, resource, cover, joinZip, CSP };
