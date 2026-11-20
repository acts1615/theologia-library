'use strict';
// 원본 앱(Manus 빌드)에서 가져온 순수 로직: 서점 검색, 성경/분류 체계, PDF 파일명 그룹화.
function text2(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.replace(/<[^>]+>/g, "").trim();
  return trimmed || void 0;
}
function firstIsbn(value) {
  const found = text2(value)?.match(/(?:97[89])?\d{9,13}/);
  return found?.[0];
}
function queryOf(req) {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const isbn = typeof req.query.isbn === "string" ? req.query.isbn.trim() : "";
  return { query: query || isbn, isbn };
}
async function kakaoSearch(query, isbn) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return [{ provider: "kakao", providerLabel: "\uCE74\uCE74\uC624(\uB2E4\uC74C)", title: "", author: "", sourceStatus: "unconfigured", message: "\uCE74\uCE74\uC624 REST API \uD0A4\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4." }];
  const url = new URL("https://dapi.kakao.com/v3/search/book");
  url.searchParams.set("query", query);
  if (isbn) url.searchParams.set("target", "isbn");
  url.searchParams.set("size", "10");
  const response = await fetch(url, { headers: { Authorization: "KakaoAK " + key, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (response.status === 401) throw new Error("\uCE74\uCE74\uC624 \uD0A4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. REST API \uD0A4\uC778\uC9C0 \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
  if (response.status === 429) throw new Error("\uCE74\uCE74\uC624 \uC77C\uC77C \uD638\uCD9C \uD55C\uB3C4\uB97C \uB118\uC5C8\uC2B5\uB2C8\uB2E4. \uB0B4\uC77C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.");
  if (!response.ok) throw new Error("\uCE74\uCE74\uC624 " + response.status);
  const payload = await response.json();
  return (payload.documents ?? []).map((d) => {
    const isbns = String(d.isbn || "").split(/\s+/).filter(Boolean);
    const authors = (d.authors || []).join(", ");
    const tr = (d.translators || []).join(", ");
    return {
      provider: "kakao",
      providerLabel: "\uCE74\uCE74\uC624(\uB2E4\uC74C)",
      title: text2(d.title) ?? "\uC81C\uBAA9 \uC5C6\uC74C",
      author: (authors + (tr ? (authors ? " / " : "") + tr + " \uC62E\uAE40" : "")) || "\uC800\uC790 \uBBF8\uC0C1",
      publisher: text2(d.publisher),
      isbn: isbns.find((x) => x.length === 13) ?? isbns[0],
      publishedAt: text2(d.datetime) ? String(d.datetime).slice(0, 10) : void 0,
      coverUrl: text2(d.thumbnail),
      productUrl: text2(d.url),
      description: text2(d.contents),
      sourceStatus: "live"
    };
  });
}
function kyoboSearch(query) {
  const url = `https://search.kyobobook.co.kr/search?keyword=${encodeURIComponent(query)}`;
  return [{
    provider: "kyobo",
    providerLabel: "\uAD50\uBCF4\uBB38\uACE0",
    title: query,
    author: "",
    productUrl: url,
    sourceStatus: "search-link",
    message: "\uACF5\uAC1C \uACF5\uC2DD \uB3C4\uC11C API\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD574 \uAD50\uBCF4\uBB38\uACE0 \uAC80\uC0C9 \uB9C1\uD06C\uB97C \uC81C\uACF5\uD569\uB2C8\uB2E4. \uBB34\uB2E8 \uD06C\uB864\uB9C1\uC740 \uC0AC\uC6A9\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
  }];
}

// ---- ISBN: 정규화·검증, 본문에서 찾기, 서점/국립중앙도서관 조회 ----
function isbn13Check(d) { let t = 0; for (let i = 0; i < 12; i++) t += (+d[i]) * (i % 2 ? 3 : 1); return String((10 - (t % 10)) % 10) === d[12]; }
function isbn10Check(d) { let t = 0; for (let i = 0; i < 9; i++) t += (+d[i]) * (10 - i); t += d[9] === "X" ? 10 : +d[9]; return t % 11 === 0; }
// 하이픈·공백·'ISBN' 글자를 지우고 13자리로 맞춘다(10자리는 13자리로 변환). 검사 숫자가 틀리면 ''.
function normIsbn(value) {
  const d = String(value ?? "").toUpperCase().replace(/ISBN(?:-?1[03])?/g, "").replace(/[^0-9X]/g, "");
  if (d.length === 13 && /^97[89]\d{10}$/.test(d)) return isbn13Check(d) ? d : "";
  if (d.length === 10 && /^\d{9}[\dX]$/.test(d)) {
    if (!isbn10Check(d)) return "";
    const b = "978" + d.slice(0, 9); let t = 0; for (let i = 0; i < 12; i++) t += (+b[i]) * (i % 2 ? 3 : 1);
    return b + String((10 - (t % 10)) % 10);
  }
  return "";
}
// 글 속에서 ISBN 후보를 찾는다. 'ISBN' 표시가 붙은 것을 먼저, 그다음 978/979로 시작하는 번호. 검사 숫자가 맞는 것만.
function findIsbns(text) {
  const out = []; const seen = new Set(); const t = String(text ?? "").replace(/[‐-―−]/g, "-");
  const push = (raw) => { const n = normIsbn(raw); if (n && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const m of t.matchAll(/ISBN(?:-?1[03])?\s*[:：]?\s*((?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx])/gi)) push(m[1]);
  for (const m of t.matchAll(/\b(97[89][-\s]?\d{1,5}[-\s]?\d{2,7}[-\s]?\d{1,7}[-\s]?\d)\b/g)) push(m[1]);
  return out;
}
function nlPick(payload) {
  // 응답 모양을 확인하지 못해, 'EA_ISBN' 항목이 든 첫 객체 배열을 찾는다.
  const seen = new Set(); const q = [payload];
  while (q.length) {
    const x = q.shift(); if (!x || typeof x !== "object" || seen.has(x)) continue; seen.add(x);
    if (Array.isArray(x)) { const f = x.find((r) => r && typeof r === "object" && ("EA_ISBN" in r || "TITLE" in r)); if (f) return x; }
    for (const v of Object.values(x)) q.push(v);
  }
  return [];
}
async function nlSearchIsbn(isbn) {
  const key = process.env.NL_CERT_KEY;
  if (!key) return { configured: false, candidates: [] };
  const url = new URL("https://www.nl.go.kr/seoji/SearchApi.do");
  url.searchParams.set("cert_key", key); url.searchParams.set("result_style", "json");
  url.searchParams.set("page_no", "1"); url.searchParams.set("page_size", "5"); url.searchParams.set("isbn", isbn);
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("국립중앙도서관 " + response.status);
  let payload; try { payload = await response.json(); } catch { throw new Error("국립중앙도서관 응답을 읽을 수 없습니다. 인증키를 확인해 주세요."); }
  const rows = nlPick(payload).filter((r) => String(r.EA_ISBN || "").replace(/\D/g, "") === isbn);
  const ymd = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8) : (d.length >= 4 ? d.slice(0, 4) : void 0); };
  return { configured: true, candidates: rows.map((r) => ({
    provider: "nl", providerLabel: "국립중앙도서관", sourceStatus: "live",
    title: text2(r.TITLE) ?? "", author: text2(r.AUTHOR) ?? "", publisher: text2(r.PUBLISHER), isbn,
    publishedAt: ymd(r.PUBLISH_PREDATE), coverUrl: text2(r.TITLE_URL), productUrl: void 0,
    description: text2(r.BOOK_INTRODUCTION), kdc: text2(r.KDC), volume: text2(r.VOL),
  })) };
}
// ISBN 하나로 조회: 카카오(다음) → 없으면 국립중앙도서관. {candidate, errors, tried}
async function lookupIsbn(raw) {
  const isbn = normIsbn(raw);
  if (!isbn) return { candidate: null, errors: ["올바른 ISBN이 아닙니다. 숫자 10자리 또는 13자리(978/979로 시작)인지, 마지막 숫자가 맞는지 확인해 주세요."], tried: [], isbn: "" };
  const errors = [], tried = [];
  try {
    const k = await kakaoSearch(isbn, true);
    if (k.length && k[0].sourceStatus === "unconfigured") { /* 키 없음: 아래 국립중앙도서관으로 */ }
    else { tried.push("kakao"); const hit = k.filter((c) => c.sourceStatus === "live"); if (hit.length) return { candidate: { ...hit[0], isbn }, errors, tried, isbn }; }
  } catch (e) { errors.push(e.message); }
  try {
    const n = await nlSearchIsbn(isbn);
    if (n.configured) { tried.push("nl"); if (n.candidates.length) return { candidate: n.candidates[0], errors, tried, isbn }; }
  } catch (e) { errors.push(e.message); }
  if (!tried.length && !errors.length) errors.push("카카오 키 또는 국립중앙도서관 인증키가 설정되지 않았습니다. 설정에서 키를 입력해 주세요.");
  return { candidate: null, errors, tried, isbn };
}

// ---- 목차 글 읽기: "제1장 서론 ..... 23" 같은 줄을 [{title, printed, level}]로 바꾼다 ----
const TOC_LEAD = /[\s.·•․‥…⋯・─-╿_\-~‐-―]+$/;
function tocLevel(raw, title) {
  const indent = (raw.match(/^[\t ]*/)[0].replace(/\t/g, "    ")).length;
  let lv = Math.min(2, Math.floor(indent / 2));
  const num = title.match(/^(\d+(?:\.\d+)+)[.\s)]/);
  if (/^(제\s*\d+\s*[부편장]|part\s+\d+|chapter\s+\d+|[ivx]+\.)/i.test(title)) lv = Math.min(lv, 0);
  else if (num) lv = Math.max(lv, Math.min(2, num[1].split(".").length - 1));
  else if (/^제\s*\d+\s*절|^\(\d+\)|^[가-힣]\.\s/.test(title)) lv = Math.max(lv, 1);
  return lv;
}
const TOC_START = /^(제\s*\d+\s*[부편장절]|part\s+\d+|chapter\s+\d+|\d+(?:\.\d+)*[.)\s]|\(\d+\)|[ivx]+\.\s|[가-힣]\.\s)/i;
function parseTocText(text) {
  const items = []; let pending = ""; let heads = [];
  for (const raw0 of String(text || "").replace(/\r/g, "").split("\n")) {
    const raw = raw0.replace(/ /g, " ");
    const line = raw.trim(); if (!line) { pending = ""; continue; }
    if (/^(목\s*차|차\s*례|contents?|table of contents)$/i.test(line.replace(/\s+/g, " "))) continue;
    const m = line.match(/^(.*?)[\s.·•․‥…⋯・_\-~‐-―]*\s(\d{1,4})$/) || line.match(/^(.*?[^\d\s])\s*[.·․‥…⋯]{2,}\s*(\d{1,4})$/);
    if (m) {
      let title = m[1].replace(TOC_LEAD, "").trim();
      if (!title) continue;
      if (pending && !TOC_START.test(title)) title = pending + " " + title;
      pending = "";
      const printed = Number(m[2]); if (!(printed >= 1)) continue;
      if (printed >= 1800 && printed <= 2100 && !/[.\u00b7\u2024\u2025\u2026\u22ef]{2,}/.test(line)) { pending = ""; continue; }   // 연도로 보이는 번호는 건너뜀
      const level = tocLevel(raw, title);
      for (const h of heads) items.push({ title: h.title, printed, level: h.level });
      heads = [];
      items.push({ title: title.slice(0, 200), printed, level });
    } else if (/^(제\s*\d+\s*[부편]|part\s+\d+)/i.test(line) && line.length <= 60) {
      heads.push({ title: line.replace(TOC_LEAD, "").trim(), level: 0 }); pending = "";   // 쪽 번호 없는 '부' 제목은 다음 항목의 쪽에 붙인다
    } else if (line.length <= 90 && !/^[\d\s\p{P}\p{S}]+$/u.test(line)) {
      pending = pending ? (pending + " " + line).slice(0, 160) : line;
    }
  }
  return items.slice(0, 1500);
}
async function searchBookstores(req) {
  const { query, isbn } = queryOf(req);
  if (!query) return { query: "", candidates: [], errors: ["\uAC80\uC0C9\uC5B4 \uB610\uB294 ISBN\uC744 \uC785\uB825\uD558\uC138\uC694."] };
  const searchQuery = isbn || query;
  const results = await Promise.allSettled([kakaoSearch(searchQuery, !!isbn)]);
  const candidates = [];
  const errors = [];
  for (const result of results) {
    if (result.status === "fulfilled") candidates.push(...result.value);
    else errors.push(result.reason instanceof Error ? result.reason.message : "\uC11C\uC810 API \uC624\uB958");
  }
  candidates.push(...kyoboSearch(searchQuery));
  return { query: searchQuery, candidates, errors };
}

var oldNames = ["\uCC3D\uC138\uAE30", "\uCD9C\uC560\uAD7D\uAE30", "\uB808\uC704\uAE30", "\uBBFC\uC218\uAE30", "\uC2E0\uBA85\uAE30", "\uC5EC\uD638\uC218\uC544", "\uC0AC\uC0AC\uAE30", "\uB8FB\uAE30", "\uC0AC\uBB34\uC5D8\uC0C1", "\uC0AC\uBB34\uC5D8\uD558", "\uC5F4\uC655\uAE30\uC0C1", "\uC5F4\uC655\uAE30\uD558", "\uC5ED\uB300\uC0C1", "\uC5ED\uB300\uD558", "\uC5D0\uC2A4\uB77C", "\uB290\uD5E4\uBBF8\uC57C", "\uC5D0\uC2A4\uB354", "\uC6A5\uAE30", "\uC2DC\uD3B8", "\uC7A0\uC5B8", "\uC804\uB3C4\uC11C", "\uC544\uAC00", "\uC774\uC0AC\uC57C", "\uC608\uB808\uBBF8\uC57C", "\uC608\uB808\uBBF8\uC57C\uC560\uAC00", "\uC5D0\uC2A4\uAC94", "\uB2E4\uB2C8\uC5D8", "\uD638\uC138\uC544", "\uC694\uC5D8", "\uC544\uBAA8\uC2A4", "\uC624\uBC14\uB31C", "\uC694\uB098", "\uBBF8\uAC00", "\uB098\uD6D4", "\uD558\uBC15\uAD6D", "\uC2A4\uBC14\uB0D0", "\uD559\uAC1C", "\uC2A4\uAC00\uB7B4", "\uB9D0\uB77C\uAE30"];
var newNames = ["\uB9C8\uD0DC\uBCF5\uC74C", "\uB9C8\uAC00\uBCF5\uC74C", "\uB204\uAC00\uBCF5\uC74C", "\uC694\uD55C\uBCF5\uC74C", "\uC0AC\uB3C4\uD589\uC804", "\uB85C\uB9C8\uC11C", "\uACE0\uB9B0\uB3C4\uC804\uC11C", "\uACE0\uB9B0\uB3C4\uD6C4\uC11C", "\uAC08\uB77C\uB514\uC544\uC11C", "\uC5D0\uBCA0\uC18C\uC11C", "\uBE4C\uB9BD\uBCF4\uC11C", "\uACE8\uB85C\uC0C8\uC11C", "\uB370\uC0B4\uB85C\uB2C8\uAC00\uC804\uC11C", "\uB370\uC0B4\uB85C\uB2C8\uAC00\uD6C4\uC11C", "\uB514\uBAA8\uB370\uC804\uC11C", "\uB514\uBAA8\uB370\uD6C4\uC11C", "\uB514\uB3C4\uC11C", "\uBE4C\uB808\uBAAC\uC11C", "\uD788\uBE0C\uB9AC\uC11C", "\uC57C\uACE0\uBCF4\uC11C", "\uBCA0\uB4DC\uB85C\uC804\uC11C", "\uBCA0\uB4DC\uB85C\uD6C4\uC11C", "\uC694\uD55C\uC77C\uC11C", "\uC694\uD55C\uC774\uC11C", "\uC694\uD55C\uC0BC\uC11C", "\uC720\uB2E4\uC11C", "\uC694\uD55C\uACC4\uC2DC\uB85D"];
var slugify = (value) => value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
var bibleSeed = [...oldNames, ...newNames].map((name, index2) => ({
  slug: slugify(name),
  name,
  testament: index2 < 39 ? "old" : "new",
  ordinal: index2 + 1,
  aliases: [name, name.replace("\uBCF5\uC74C", ""), name.replace("\uC11C", "")].filter((value, i, all) => all.indexOf(value) === i)
}));
var theologyRoots = [
  ["\uC131\uC11C\uC2E0\uD559", "\uC131\uC11C\uC2E0\uD559"],
  ["\uAD6C\uC57D\uD559", "\uAD6C\uC57D\uD559"],
  ["\uC2E0\uC57D\uD559", "\uC2E0\uC57D\uD559"],
  ["\uC131\uACBD\uC8FC\uC11D", "\uC131\uACBD \uC8FC\uC11D"],
  ["\uC870\uC9C1\uC2E0\uD559", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uC5ED\uC0AC\uC2E0\uD559", "\uC5ED\uC0AC\uC2E0\uD559"],
  ["\uAD50\uD68C\uC0AC", "\uAD50\uD68C\uC0AC"],
  ["\uC2E4\uCC9C\uC2E0\uD559", "\uC2E4\uCC9C\uC2E0\uD559"],
  ["\uC120\uAD50\uD559", "\uC120\uAD50\uD559"],
  ["\uBCC0\uC99D\uD559", "\uBCC0\uC99D\uD559"],
  ["\uAE30\uB3C5\uAD50\uC724\uB9AC", "\uAE30\uB3C5\uAD50 \uC724\uB9AC"],
  ["\uBE44\uAD50\uC885\uAD50", "\uBE44\uAD50\uC885\uAD50"],
  ["\uAD50\uBD80\uD559", "\uAD50\uBD80\uD559"],
  ["\uC885\uAD50\uAC1C\uD601", "\uC885\uAD50\uAC1C\uD601"],
  ["\uC2E0\uD559\uC0AC\uC804", "\uC2E0\uD559 \uC0AC\uC804\xB7\uBC31\uACFC\uC0AC\uC804"]
].map(([slug, name], index2) => ({ slug, name, kind: "theology", sortOrder: index2 }));
var subCategories = [
  ["\uC2E0\uB860", "\uC2E0\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uAE30\uB3C5\uB860", "\uAE30\uB3C5\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uC131\uB839\uB860", "\uC131\uB839\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uC778\uAC04\uB860", "\uC778\uAC04\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uC8C4\uB860", "\uC8C4\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uAD6C\uC6D0\uB860", "\uAD6C\uC6D0\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uAD50\uD68C\uB860", "\uAD50\uD68C\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uC885\uB9D0\uB860", "\uC885\uB9D0\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uACC4\uC2DC\uB860", "\uACC4\uC2DC\uB860\xB7\uC131\uACBD\uB860", "\uC870\uC9C1\uC2E0\uD559"],
  ["\uAD6C\uC57D\uAC1C\uB860", "\uAD6C\uC57D\uAC1C\uB860", "\uAD6C\uC57D\uD559"],
  ["\uC624\uACBD", "\uC624\uACBD", "\uAD6C\uC57D\uD559"],
  ["\uC608\uC5B8\uC11C", "\uC608\uC5B8\uC11C", "\uAD6C\uC57D\uD559"],
  ["\uC9C0\uD61C\uBB38\uD559", "\uC9C0\uD61C\uBB38\uD559", "\uAD6C\uC57D\uD559"],
  ["\uBCF5\uC74C\uC11C", "\uBCF5\uC74C\uC11C \uC5F0\uAD6C", "\uC2E0\uC57D\uD559"],
  ["\uBC14\uC6B8\uC11C\uC2E0", "\uBC14\uC6B8\uC11C\uC2E0 \uC5F0\uAD6C", "\uC2E0\uC57D\uD559"],
  ["\uC77C\uBC18\uC11C\uC2E0", "\uC77C\uBC18\uC11C\uC2E0 \uC5F0\uAD6C", "\uC2E0\uC57D\uD559"],
  ["\uC694\uD55C\uBB38\uD5CC", "\uC694\uD55C\uBB38\uD5CC \uC5F0\uAD6C", "\uC2E0\uC57D\uD559"],
  ["\uC124\uAD50\uD559", "\uC124\uAD50\uD559", "\uC2E4\uCC9C\uC2E0\uD559"],
  ["\uBAA9\uD68C\uD559", "\uBAA9\uD68C\uD559", "\uC2E4\uCC9C\uC2E0\uD559"],
  ["\uC608\uBC30\uD559", "\uC608\uBC30\uD559", "\uC2E4\uCC9C\uC2E0\uD559"],
  ["\uC0C1\uB2F4\uD559", "\uC0C1\uB2F4\uD559", "\uC2E4\uCC9C\uC2E0\uD559"],
  ["\uAE30\uB3C5\uAD50\uAD50\uC721", "\uAE30\uB3C5\uAD50 \uAD50\uC721\uD559", "\uC2E4\uCC9C\uC2E0\uD559"],
  ["\uC120\uAD50\uC5ED\uC0AC", "\uC120\uAD50 \uC5ED\uC0AC", "\uC120\uAD50\uD559"],
  ["\uC120\uAD50\uC804\uB7B5", "\uC120\uAD50 \uC804\uB7B5", "\uC120\uAD50\uD559"],
  ["\uACF5\uACF5\uC2E0\uD559", "\uACF5\uACF5\uC2E0\uD559", "\uC120\uAD50\uD559"]
].map(([slug, name, parentSlug], index2) => ({ slug, name, parentSlug, kind: "theology", sortOrder: index2 + 20 }));
var categorySeed = [
  ...theologyRoots,
  ...subCategories,
  { slug: "\uAE30\uB3C5\uAD50\uAD50\uC591", name: "\uAE30\uB3C5\uAD50 \uAD50\uC591", kind: "general", sortOrder: 100 },
  { slug: "\uC2E0\uD559\uB17C\uBB38", name: "\uC2E0\uD559 \uB17C\uBB38", kind: "theology", sortOrder: 99 },
  { slug: "\uD559\uC704\uB17C\uBB38", name: "\uD559\uC704 \uB17C\uBB38", kind: "general", sortOrder: 99 },
  { slug: "\uD559\uC220\uC9C0", name: "\uD559\uC220\uC9C0\xB7\uC800\uB110", kind: "general", sortOrder: 99 },
  { slug: "\uC5F0\uAD6C\uBCF4\uACE0\uC11C", name: "\uC5F0\uAD6C \uBCF4\uACE0\uC11C", kind: "general", sortOrder: 99 },
  { slug: "english", name: "\uC601\uC5B4", kind: "general", sortOrder: 104 },
  { slug: "dev-it", name: "\uAC1C\uBC1C\xB7IT", kind: "general", sortOrder: 105 },
  { slug: "exam", name: "\uC218\uD5D8\uC11C", kind: "general", sortOrder: 106 },
  { slug: "\uC778\uBB38\uC0AC\uD68C", name: "\uC778\uBB38\xB7\uC0AC\uD68C", kind: "general", sortOrder: 101 },
  { slug: "\uC18C\uC124\uBB38\uD559", name: "\uC18C\uC124\xB7\uBB38\uD559", kind: "fiction", sortOrder: 102 },
  { slug: "\uC5ED\uC0AC", name: "\uC5ED\uC0AC", kind: "general", sortOrder: 103 },
  { slug: "\uC790\uAE30\uACC4\uBC1C", name: "\uC790\uAE30\uACC4\uBC1C", kind: "general", sortOrder: 104 },
  { slug: "\uAE30\uD0C0", name: "\uAE30\uD0C0", kind: "general", sortOrder: 105 }
];

function inferDocumentType(value) {
  const normalized2 = value.toLocaleLowerCase("ko-KR");
  if (/(학위논문|thesis|dissertation|doctoral|석사|박사)/i.test(normalized2)) return "thesis";
  if (/(연구보고서|research report|working paper|보고서)/i.test(normalized2)) return "report";
  if (/(학술지|journal|논문|article|paper|proceedings)/i.test(normalized2)) return "paper";
  if (/(magazine|잡지|저널)/i.test(normalized2)) return "magazine";
  if (/(소설|novel|fiction)/i.test(normalized2)) return "fiction";
  return "book";
}
var PART_PATTERNS = [
  /(?:^|[\s._-])(?:part|pt|volume|vol|book|권|편|부|상권|하권)\s*[-_. ]*([0-9]+|[ivxlcdm]+)(?:$|[\s._-])/i,
  /(?:^|[\s._-])([ivxlcdm]+)[-_. ]*([0-9]+)(?:$|[\s._-])/i,
  /(?:^|[\s._-])([0-9]+)\s*(?:권|부|편)(?:$|[\s._-])/i,
  /(?:^|[\s._-])([0-9]+)\s*(?:of|중|\/|-)\s*[0-9]+(?:$|[\s._-])/i
];
var NOISE = /(?:scan|scanned|ebook|e-book|pdf|final|edited|ocr|본문|스캔본|완역|개정판|copy|복사본|\[[^\]]*\]|\([^)]*\))/gi;
function normalizePdfTitle(value) {
  return value.normalize("NFKC").replace(/\.(?:pdf|epub)$/i, "").replace(NOISE, " ").replace(/[“”"'‘’]/g, "").replace(/[,:;·|]+/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}
function extractPartNumber(value) {
  const normalized2 = normalizePdfTitle(value);
  for (const pattern of PART_PATTERNS) {
    const match = normalized2.match(pattern);
    if (!match) continue;
    const token = match[1]?.toLowerCase();
    if (!token) return void 0;
    if (match[2] && /^[ivxlcdm]+$/i.test(token)) return romanToNumber(token) * 10 + Number.parseInt(match[2], 10);
    if (/^[ivxlcdm]+$/.test(token)) return romanToNumber(token);
    const parsed = Number.parseInt(token, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 100) return parsed;
  }
  return void 0;
}
function romanToNumber(value) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1e3 };
  let total = 0;
  for (let index2 = 0; index2 < value.length; index2 += 1) {
    const current = map[value[index2]] ?? 0;
    const next = map[value[index2 + 1]] ?? 0;
    total += current < next ? -current : current;
  }
  return total;
}
function tokens(value) {
  return new Set(value.split(/[^a-z0-9가-힣]+/).filter((token) => token.length > 1));
}
function jaccard(left, right) {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = (/* @__PURE__ */ new Set([...left, ...right])).size;
  return union === 0 ? 0 : intersection / union;
}
function removePartMarker(value) {
  return normalizePdfTitle(value).replace(/(?:^|\s)(?:part|pt|volume|vol|book|권|편|부|상권|하권)\s*[-_. ]*(?:[0-9]+|[ivxlcdm]+)(?=$|\s)/gi, " ").replace(/(?:^|\s)[0-9]+\s*(?:권|부|편)(?=$|\s)/gi, " ").replace(/(?:^|\s)[ivxlcdm]+[-_. ]*[0-9]+(?=$|\s)/gi, " ").replace(/\s+/g, " ").trim();
}
function groupPdfFiles(files) {
  const prepared = files.map((file) => ({
    ...file,
    normalizedTitle: removePartMarker(file.name),
    partNumber: extractPartNumber(file.name)
  }));
  // 성능: 4000개 이상에서도 빠르도록 토큰·폴더를 한 번만 계산하고, 같은 제목은 Map 으로 찾는다. (결과는 이전 방식과 같다)
  const groups = [];
  const byKey = new Map();
  const dirOf = (p) => p.split(/[\\/]/).slice(0, -1).join("/");
  for (const file of prepared) {
    const sameKey = byKey.get(file.normalizedTitle);
    if (sameKey) {
      sameKey.files.push(file);
      continue;
    }
    const ft = tokens(file.normalizedTitle); const fdir = dirOf(file.path);
    let candidate = null;
    for (const group of groups) {
      const a = group.seedTokens.size, b = ft.size;
      // 자카드 유사도는 (작은 쪽 / 큰 쪽) 을 넘을 수 없다: 0.72 에 못 미치면 건너뛴다
      if (Math.min(a, b) < 0.72 * Math.max(a, b)) continue;
      const similarity = jaccard(group.seedTokens, ft);
      if (similarity >= 0.72 && (group.seedDir === fdir || similarity >= 0.86)) { candidate = group; break; }
    }
    if (candidate) {
      candidate.files.push(file);
      continue;
    }
    const g = { seed: file, files: [file], seedTokens: ft, seedDir: fdir };
    groups.push(g); byKey.set(file.normalizedTitle, g);
  }
  return groups.map((group, index2) => {
    const similarity = group.files.length === 1 ? 1 : group.files.reduce((total, file) => total + jaccard(tokens(group.seed.normalizedTitle), tokens(file.normalizedTitle)), 0) / group.files.length;
    const confidence = Math.round(Math.min(0.99, 0.6 + similarity * 0.39) * 100);
    const groupKey = `pdf-group-${index2 + 1}-${stableHash(group.seed.normalizedTitle)}`;
    return { groupKey, title: group.seed.normalizedTitle, confidence, files: group.files.map((file) => ({ ...file, confidence, groupKey })) };
  }).sort((left, right) => right.files.length - left.files.length);
}
function stableHash(value) {
  let hash = 2166136261;
  for (let index2 = 0; index2 < value.length; index2 += 1) {
    hash ^= value.charCodeAt(index2);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalized(value) {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

// ---- 표시용 제목: 파일명에서 확장자·권 표시·스캔 표기를 걷어낸다 ----
function displayTitle(name) {
  let t = String(name).normalize('NFC').replace(/\.(?:pdf|epub)$/i, '');
  t = t.replace(/[\[(（【][^\])）】]*(?:scan|scanned|ocr|ebook|e-book|스캔|완역|개정|복사)[^\])）】]*[\])）】]/gi, ' ');
  t = t.replace(/(?:^|[\s._-])(?:part|pt|volume|vol|book)\s*[-_. ]*(?:\d+|[ivxlcdm]+)(?=$|[\s._-])/gi, ' ');
  t = t.replace(/(?:^|[\s._-])제?\s*\d+\s*(?:권|부|편)(?=$|[\s._-])/g, ' ');
  t = t.replace(/(?:^|[\s._-])(?:상권|하권)(?=$|[\s._-])/g, ' ');
  t = t.replace(/_+/g, ' ').replace(/[\s\-–.]+$/, '').replace(/^[\s\-–.]+/, '').replace(/\s+/g, ' ').trim();
  return t || String(name).replace(/\.(?:pdf|epub)$/i, '');
}

// 그룹화 전에 "제3권" 표기를 "3권"으로 통일
function canonName(name) {
  const ord = { 상: 1, 중: 2, 하: 3 };
  return String(name).replace(/_+/g, ' ').replace(/제\s*(\d+)\s*(권|부|편)/g, '$1$2')
    .replace(/(^|[\s.\-(\[])(상|중|하)\s*(권|편|부)(?=$|[\s.\-)\]])/g, (_m, pre, k, u) => `${pre}${ord[k]}${u}`);
}


// ---- 서점 검색: 파일명 정리 + 같은 책인지 판정 (보수적으로) ----
function _norm(t) { return String(t || "").normalize("NFC").toLowerCase().replace(/[\s\-_:;,.\u00b7\u318d'"!?()\[\]{}~\/&]+/g, ""); }
function _core(t) { return _norm(String(t || "").split(/[:(\[]| - /)[0]); }
function _bigrams(t) { const a = new Set(); for (let i = 0; i < t.length - 1; i++) a.add(t.slice(i, i + 2)); return a; }
// 파일명에서 검색에 방해되는 꼬리표(OCR, n25, 권수, 상/하 등)를 걷어낸다
function cleanForSearch(title) {
  let t = String(title || "").normalize("NFC").replace(/\.(?:pdf|epub)$/i, " ");
  t = t.replace(/(^|[^0-9a-z])n\d{2,4}[a-z]?(?![0-9a-z])/gi, " ");
  t = t.replace(/goodreader\s*\uC6A9?|\bocr\b|\uC2A4\uCE94(\uBCF8)?|\bscan(ned)?\b/gi, " ");
  t = t.replace(/[\[\]()\uFF08\uFF09\u3010\u3011~_]+/g, " ");
  t = t.replace(/(^|\s)(\uC81C\s*)?\d+(\s*[-~]\s*\d+)?\s*(\uAD8C|\uBD80|\uD3B8|\uC7A5|\uC8FC\uAC15|\uD68C)?(?=\s|$)/g, " ");
  t = t.replace(/(^|\s)(\uC0C1|\uC911|\uD558)(\uAD8C)?(?=\s|$)/g, " ");
  t = t.replace(/\s+-\s+|^-+|-+$/g, " ").replace(/\s+/g, " ").trim();
  return t || String(title || "").trim();
}
// 검색어 후보: 전체 정리본, (여러 단어면) 마지막 단어(대개 저자)를 뺀 것
function queryVariants(title) {
  const full = cleanForSearch(title); const out = [full];
  const toks = full.split(" ").filter(Boolean);
  if (toks.length >= 3) out.push(toks.slice(0, -1).join(" "));
  return [...new Set(out.filter((x) => x.length >= 2))];
}
function titleScore(workTitle, candTitle) {
  const a = _norm(workTitle), b = _norm(candTitle), ca = _core(workTitle), cb = _core(candTitle);
  if (!a || !b) return 0;
  if (a === b || (ca && ca === cb)) return 1;
  const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
  if (short.length >= 4 && long.includes(short) && short.length / long.length >= 0.6) return 0.92;
  const A = _bigrams(a), B = _bigrams(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function _authorTokens(author) {
  const names = String(author || "").replace(/\uC62E\uAE40|\uC9C0\uC74C|\uC5D0\uB514|\uC800|\uC5ED/g, " ").split(/[\/,&]| \uC678 /);
  const toks = new Set();
  for (const n of names) { const norm = _norm(n); if (norm.length >= 2) toks.add(norm); for (const w of n.split(/\s+/)) { const x = _norm(w); if (x.length >= 2 && /[\uAC00-\uD7A3]{2,}/.test(x)) toks.add(x); } }
  return [...toks];
}
function matchScore(workTitle, c) {
  const cleaned = cleanForSearch(workTitle), W = _norm(cleaned);
  const candCore = cleanForSearch(String(c.title || "").split(/[:(\[]| - /)[0]); const T = _norm(candCore);
  if (!W || T.length < 2) return 0;
  const direct = titleScore(cleaned, candCore);
  if (direct >= 0.9) return direct;
  const hits = _authorTokens(c.author).filter((t) => W.includes(t));
  if (!hits.length) return 0;
  let Wn = W; for (const h of hits) Wn = Wn.split(h).join("");
  if (T.length >= 3 && W.includes(T)) return 0.93;
  if (Wn.length >= 2) { const sc = titleScore(Wn, T); if (sc >= 0.8) return Math.min(0.92, 0.5 + sc * 0.5 + 0.1); }
  return 0;
}
function pickMatch(workTitle, candidates, threshold = 0.9) {
  const live = candidates.filter((c) => c.sourceStatus === "live").map((c) => ({ c, sc: matchScore(workTitle, c) }));
  let best = null; for (const x of live) if (!best || x.sc > best.sc) best = x;
  if (!best || best.sc < threshold) return null;
  // 제목만 같고 저자 단서가 없을 때: 저자가 다른 동명 도서가 있으면 어느 책인지 알 수 없으므로 건드리지 않는다
  const W = _norm(cleanForSearch(workTitle));
  const byAuthor = _authorTokens(best.c.author).some((t) => W.includes(t));
  if (!byAuthor) {
    const key = _norm(best.c.author);
    if (live.some((x) => x !== best && x.sc >= threshold && _norm(x.c.author) !== key)) return null;
  }
  return { cand: best.c, score: best.sc };
}


// ---- 파일명 규칙: "책제목_저자" (+ 스캔 구분용 꼬리표 B/G/C/H/v/OCR/Extract/번호) ----
const TAG_TOKEN = /^(?:ocr|extract(?:ed)?|scan(?:ned)?|copy|[a-z]|\d{1,2}(?:\s*\(\d+\))?|\(\d+\))$/i;
// 파일 이름 앞에 붙은 출판·스캔 표지(올재_, (SJ), CS …)는 제목·저자 판단에서 뺀다
const PUB_PREFIX = /^\s*(?:올재(?:클래식)?\s*[_\- ]\s*|\((?:SJ|JP|CS|SH|준열)\)\s*|(?:SJ|JP|CS|SH)\s+(?=[가-힣A-Za-z]))/;

// ---- 저자 표기 정리: 지음/옮김 같은 역할 표시, 옮긴이, 여러 저자를 다룬다 ----
const TRANS_ROLE = /(?:옮김|옮긴이|역자|번역|번역자|역주|역해|감수|해설|그림|삽화|엮음|편역)\s*$|^(?:옮김|옮긴이|역자|번역|감수)\s*[:：]?\s*/;
const AUTH_ROLE = /\s*(?:지음|지은이|저자|글쓴이|글|저|편저|엮은이|편|공저|著)\s*$/;
const TAGLIKE = /^(?:시집|소설|만화|완결|합본|ocr|스캔|고화질|흑백|컬러|전자책|epub|pdf|개정판|개정증보판|전집|상|중|하|\d{1,3})$/i;
function cleanAuthor(raw) {
  let a = String(raw || "").normalize("NFC").replace(/[\(\[（【][^)\]）】]*[\)\]）】]/g, (m) => /옮김|역|번역|감수|그림|지음|저$/.test(m) ? " " + m.slice(1, -1) + " " : " ").trim();
  if (!a) return "";
  const segs = a.split(/\s*(?:[,，、·&／/]|\band\b|\s및\s)\s*|\s외(?:\s|$)/i).map((x) => x.trim()).filter(Boolean);
  const keep = [];
  for (let x of segs) {
    if (TRANS_ROLE.test(x)) continue;
    x = x.replace(AUTH_ROLE, "").replace(/\s*(?:지음|지은이|저)\s+(?=\S)/g, " ").trim();
    if (x && !TRANS_ROLE.test(x)) keep.push(x);
  }
  return keep.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
}
const nameLike2 = (x) => /^[가-힣]{2,4}(?:\s[가-힣]{1,3})?$|^[A-Za-z][A-Za-z .·]{2,24}$/.test(String(x).trim()) && !TAGLIKE.test(String(x).trim());
function parseFileNameBase(name) {
  let t = String(name || "").normalize("NFC").replace(/\.(?:pdf|epub)$/i, "").replace(/\s*\(\d+\)\s*$/, "").trim().replace(PUB_PREFIX, "").trim();
  // "[저자] 제목" / "【저자】 제목" → "제목_저자" ([시집] 같은 분류 표시는 그대로 둔다)
  { const m = t.match(/^[\[【]\s*([^\]】]{2,20}?)\s*[\]】]\s*(.{2,})$/); if (m && nameLike2(m[1]) && !TAGLIKE.test(m[1].trim())) t = m[2].trim() + "_" + m[1].trim(); }
  const parts = t.split("_").map((x) => x.trim()).filter((x) => x.length);
  if (parts.length < 2 || !parts.slice(1).some((x) => x && !TAG_TOKEN.test(x))) {
    // "_" 가 없을 때 보조 규칙: "제목 (저자)" 또는 "제목-저자" / "제목 - 저자"
    const base = parts[0] || t;
    const nameLike = (x) => /^[가-힣A-Za-z][가-힣A-Za-z .·]{1,19}$/.test(x.trim()) && !/\d|^(?:상|중|하|ocr|scan)$/i.test(x.trim());
    let m = base.match(/^(.*?)\s*\(([^()]{2,24}?)\s*(?:외)?\s*\)\s*(?:ocr)?$/i);
    if (m && m[1].trim().length >= 2 && nameLike(m[2].replace(/\s*외$/, ""))) return { title: m[1].trim(), author: m[2].replace(/\s*외$/, "").trim(), volume: "" };
    m = base.match(/^(.*?)\s*-\s*([가-힣][가-힣A-Za-z .·]{1,15})$/);
    if (m && m[1].trim().length >= 2 && nameLike(m[2])) return { title: m[1].trim(), author: m[2].trim(), volume: "" };
    return { title: parts[0] && parts.length ? parts[0] : t, author: "", volume: "" };
  }
  let title = parts[0], author = "", volume = "";
  const vm = title.match(/^(.*?)[\s]+(\d{1,3})$/); if (vm) { title = vm[1].trim(); volume = vm[2]; }
  for (const raw of parts.slice(1)) {
    let p = raw.replace(/^\s*(?:(상|중|하)\s*-\s*)/, (m, g) => { if (!volume) volume = g; return ""; }).trim();
    if (!p || TAG_TOKEN.test(p)) { if (/^\d{1,2}$/.test(p) && !volume) volume = p; continue; }
    p = p.replace(/\s*[\(\[]?\b[A-Za-z][\)\]]?\s*$/, (m) => (/[가-힣]\s*[\(\[]?[A-Za-z][\)\]]?\s*$/.test(" " + raw) || /[가-힣]/.test(p.slice(0, p.length - m.length)) ? "" : m)).trim();
    p = p.replace(/\s*[\(\[]\s*[A-Za-z]\s*[\)\]]\s*$/, "").trim();
    if (p) { author = p; break; }
  }
  return { title: title.replace(/^_+|_+$/g, "").trim(), author, volume };
}

// 파일 이름 → {title, author, volume, alt?}. 저자가 앞에 오거나(저자_제목, 저자 - 제목), 지음·옮김 표시, 괄호 표기를 다룬다.
// 제목/저자 순서를 확신할 수 없으면 alt 에 뒤집은 해석을 담아 둔다(조회 때 둘 다 시도).
function parseFileName(name) {
  let raw = String(name || "").normalize("NFC");
  const m = raw.replace(/\.(?:pdf|epub)$/i, "").match(/^(.*?)\s*[\(（]([^()（）]*(?:지음|옮김|옮긴이|엮음|편저|저|역)[^()（）]*)[\)）]\s*$/);
  if (m && m[1].trim().length >= 2) raw = m[1].trim() + "_" + m[2].trim() + ".pdf";
  const r = parseFileNameBase(raw);
  if (!r.author) return r;
  const a = cleanAuthor(r.author) || r.author;
  const out = { title: r.title, author: a, volume: r.volume };
  if (nameLike2(r.title) && a.length >= 3 && !nameLike2(a)) out.alt = { title: a, author: r.title, volume: r.volume };
  else if (nameLike2(r.title) && nameLike2(a)) out.alt = { title: a, author: r.title, volume: r.volume };
  // "저자 - 제목" (왼쪽이 사람 이름, 오른쪽이 이름이 아닌 긴 말)
  if (!out.alt) { const h = String(raw).replace(/\.(?:pdf|epub)$/i, "").match(/^([가-힣]{2,4})\s+-\s+(.{4,})$/); if (h && !/_/.test(raw)) return { title: h[2].trim(), author: h[1], volume: "" }; }
  return out;
}
function fileHint(fileNames, fallbackTitle) {
  const parsed = (fileNames || []).map(parseFileName).filter((x) => x.author);
  if (!parsed.length) return null;
  const count = new Map(); for (const p of parsed) { const k = p.title + "|" + p.author; count.set(k, (count.get(k) || 0) + 1); }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0].split("|");
  const title = best[0], author = best[1];
  const noParen = title.replace(/[\(\[（][^)\]）]*[\)\]）]/g, " ").replace(/\s+/g, " ").trim();
  const a1 = author.replace(/\s*\b[A-Za-z]\.?(?=\s|$)/g, " ").replace(/\s+/g, " ").trim() || author;
  const queries = [...new Set([`${title} ${a1}`, `${noParen} ${a1}`, noParen].map((x) => cleanForSearch(x)).filter((x) => x.length >= 2))];
  const out = { title, author, queries, volume: (parsed[0] && parsed[0].volume) || "" };
  const altSrc = parsed.find((p) => p.alt && p.title + "|" + p.author === best.join("|"));
  if (altSrc) {
    const at = altSrc.alt.title, aa = altSrc.alt.author;
    const aq = [...new Set([`${at} ${aa}`, at].map((x) => cleanForSearch(x)).filter((x) => x.length >= 2))];
    out.alt = { title: at, author: aa, queries: aq, volume: altSrc.alt.volume || "" };
  }
  return out;
}
// 시리즈 약칭 규칙: EM = 엑스포지멘터리(송병현). 송병현 저작은 모두 이 시리즈로 본다.
const SERIES = [{ re: /^\s*EM(?=\s|$|\d)(?!\s*[_\-]?\s*(?:바운즈|바운드|bounds))\s*/i, name: "엑스포지멘터리", author: "송병현" }];
// 파일 이름 앞의 시리즈 표시를 태그 이름으로 바꾼다(올재, WBC, LAB, HOW, EM, BST). E.M 바운즈는 EM 이 아니다.
const SERIES_TAGS = [
  ["올재", /^\s*올재(?:클래식(?:스)?)?\s*[_\- ]/],
  ["WBC", /(?:^|[^a-z])WBC(?![a-z])/i],
  ["LAB", /^\s*LAB(?=[\s_]|$)/i],
  ["HOW", /^\s*HOW(?=[\s_]|$)(?!\s*to\b)/i],
  ["EM", /^\s*EM(?=\s|$|\d|_)(?!\s*[_\-]?\s*(?:바운즈|바운드|bounds))/i],
  ["BST", /(?:^|[^a-z])BST(?![a-z])/i],
];
function seriesTags(title, fileNames) {
  const out = [];
  const cands = [String(title || ""), ...(fileNames || []).map((n) => String(n || "").normalize("NFC").replace(/\.(?:pdf|epub)$/i, ""))];
  for (const [tag, re] of SERIES_TAGS) if (cands.some((t) => re.test(t.normalize("NFC")))) out.push(tag);
  return out;
}
function seriesHints(title, fileNames, base) {
  const out = [];
  const names = [String(title || ""), ...(fileNames || []).map((n) => String(n).replace(/\.(?:pdf|epub)$/i, ""))];
  for (const t of names) {
    const em = SERIES.find((s) => s.re.test(t));
    const hasAuthor = /송병현/.test(t) || (base && /송병현/.test(base.author || ""));
    if (!em && !hasAuthor) continue;
    let rest = t.replace(SERIES[0].re, "").replace(/송병현/g, " ").replace(/[_\-]+/g, " ");
    rest = cleanForSearch(rest).replace(/엑스포지멘터리/g, "").replace(/\s+/g, " ").trim();
    if (rest.length < 2) continue;
    out.push({ title: "엑스포지멘터리 " + rest, author: "송병현", volume: "",
      queries: [...new Set([`엑스포지멘터리 ${rest}`, `${rest} 송병현`, `${rest} 엑스포지멘터리 송병현`])] });
    break;
  }
  return out;
}

// ---- 월간지: 서점 도서가 아니므로 책 검색을 하지 않고, 이름에서 잡지·연월만 읽는다 ----
const MAGAZINES = [
  { re: /^\s*(?:생삶\s*플러스|생명의\s*삶\s*플러스)/, name: "생명의삶플러스", publisher: "두란노" },
  { re: /^\s*묵상과\s*설교/, name: "묵상과 설교", publisher: "성서유니온선교회" },
];
function magazineInfo(title, fileNames) {
  const names = [String(title || ""), ...(fileNames || []).map((n) => String(n).replace(/\.(?:pdf|epub)$/i, ""))];
  for (const t of names) {
    const m = MAGAZINES.find((x) => x.re.test(t)); if (!m) continue;
    const d = t.match(/(\d{4})\s*년\s*(\d{1,2})(?:\s*[-~]\s*(\d{1,2}))?\s*월/);
    return { name: m.name, publisher: m.publisher || "", year: d ? d[1] : "", month: d ? d[2] + (d[3] ? "-" + d[3] : "") : "" };
  }
  return null;
}
// ---- 주석 시리즈 규칙 (HOW 주석 / WBC 주석 / 메인 아이디어 주석) ----
// 작품 이름만으로 시리즈가 정해진다. 저자가 달라도(또는 없어도) 시리즈 이름 + 성경 책 이름으로 서점에서 찾는다.
const BIBLE_BOOK_RE = (() => { try { return require("./classify.js").BOOKS; } catch { return []; } })();
const COMMENTARY = [
  { id: "HOW", re: /^\s*HOW(?=[\s_]|$)(?!\s*to\b)/i, label: "HOW 주석", keys: ["how주석", "how성경주석"], extra: ["두란노 HOW 주석", "HOW 주석 시리즈"] },
  { id: "WBC", re: /(?:^|[^a-z])WBC(?![a-z])/i, label: "WBC 성경주석", keys: ["wbc"], extra: ["WBC 주석", "WORD BIBLICAL COMMENTARY"] },
  { id: "BST", re: /(?:^|[^a-z])BST(?![a-z])/i, label: "BST 강해 시리즈", keys: ["bst"], extra: ["BST 시리즈", "BST 성경 강해", "IVP BST"] },
  { id: "ACCS", re: /교부들의\s*성경\s*주해/, label: "교부들의 성경 주해", keys: ["교부들의성경주해", "교부들의성경"], extra: ["교부들의 성경 주해 구약", "교부들의 성경 주해 신약", "분도 교부들의 성경 주해"] },
  { id: "ZECNT", re: /강해로\s*푸는/, label: "강해로 푸는 신약", keys: ["강해로푸는"], extra: ["강해로 푸는", "ZECNT"] },
  { id: "MAIN", re: /(?:^|[^가-힣])메인\s*아이디어/, label: "메인 아이디어 주석", keys: ["메인아이디어"], extra: ["메인아이디어"] },
];
function commentaryParts(name, id) {
  const parts = String(name).normalize("NFC").replace(/\.(?:pdf|epub)$/i, "").split("_").map((x) => x.trim()).filter(Boolean);
  const strip = (x) => x.replace(/교부들의\s*성경\s*주해/g, " ").replace(/강해로\s*푸는(?:\s*신약)?/g, " ").replace(/(?:구약|신약)\s*\(\s*\d+\s*\)/g, " ").replace(/(?:^|\s)(?:HOW|WBC|BST)(?=\s|$)/gi, " ").replace(/메인\s*아이디어/g, " ").replace(/\bn\d{2}[a-z]?\b/gi, " ")
    .replace(/\(\s*(?:상|중|하)\s*\)/g, " ").replace(/\b\d{1,3}\s*-\s*\d{1,3}\b(?=\s*[가-힣])/g, " ").replace(/^\s*\d{1,3}(?=\s|\(|$)/, " ")
    .replace(/\s*\d+\s*[:\-–]\s*\d+(?:\s*[:\-–]\s*\d+)?\s*$/, " ").replace(/[\(\)\[\]]/g, " ").replace(/\s+/g, " ").trim();
  let book = "", author = "";
  const body = parts.filter((p) => !/^(?:HOW|WBC|BST)$/i.test(p));
  if (body.length) book = strip(body[0]);
  if (body.length > 1) author = strip(body[body.length - 1]).replace(/[A-Za-z]\.?$/, "").trim();
  if (id === "MAIN") author = "";
  return { book, author };
}
function commentaryHints(title, fileNames) {
  const names = [String(title || ""), ...(fileNames || []).map((n) => String(n).replace(/\.(?:pdf|epub)$/i, ""))];
  for (const t of names) {
    const c = COMMENTARY.find((x) => x.re.test(t)); if (!c) continue;
    const { book, author } = commentaryParts(t, c.id);
    if (book.length < 2) continue;
    const first = (BIBLE_BOOK_RE.find((b) => book.includes(b)) || book.split(/\s+/)[0]);
    const q = [`${c.label} ${first}`, `${first} ${c.label}`, ...c.extra.map((e) => `${e} ${first}`), ...(author ? [`${c.label} ${first} ${author}`, `${first} ${author}`] : [])];
    const vn = (String(t).match(/(?:구약|신약)\s*\(\s*(\d+)\s*\)/) || [])[1] || "";
    return [{ title: `${c.label} ${book}`, author, volume: vn, series: c.id, seriesKeys: c.keys, book: first, queries: [...new Set(q.map((x) => cleanForSearch(x)).filter((x) => x.length >= 2))] }];
  }
  return [];
}
// 서점 후보 중: 시리즈 이름이 제목에 있고, 성경 책 이름도 들어 있는 것
function pickMatchSeries(hint, candidates) {
  const bk = _norm(hint.book || ""); if (!bk) return null;
  let best = null;
  for (const c of candidates.filter((x) => x.sourceStatus === "live")) {
    const T = _norm(String(c.title || ""));
    if (!hint.seriesKeys.some((k) => T.includes(k)) || !T.includes(bk)) continue;
    let sc = 0.9; if (hint.volume && new RegExp("(?:^|[^0-9])0?" + String(+hint.volume) + "(?:[^0-9]|$)").test(String(c.title))) sc += 0.03;
    if (hint.author && _authorTokens(c.author).some((a) => { const k = _nameKey(a); return k.length >= 2 && _nameKey(hint.author).includes(k); })) sc += 0.05;
    if (!best || sc > best.sc) best = { c, sc };
  }
  return best ? { cand: best.c, score: best.sc } : null;
}
function _nameKey(n) { return _norm(String(n || "").replace(/\b[A-Za-z]\.?(?=\s|$)/g, "")); }
function pickMatchHint(hint, candidates) {
  const hT = _norm(cleanForSearch(hint.title)), hTnp = _norm(cleanForSearch(hint.title.replace(/[\(\[（][^)\]）]*[\)\]）]/g, " ")));
  const hA = _nameKey(hint.author);
  const live = candidates.filter((c) => c.sourceStatus === "live");
  let best = null;
  for (const c of live) {
    const T = _norm(cleanForSearch(String(c.title || "").split(/[:(\[]| - /)[0]));
    if (T.length < 2) continue;
    const toks = _authorTokens(c.author);
    const authorOK = hA && toks.some((t) => { const k = _nameKey(t); return k.length >= 2 && (hA.includes(k) || k.includes(hA)); });
    if (!authorOK) continue;
    const sc = Math.max(titleScore(hT, T), titleScore(hTnp, T), (T.length >= 3 && (hTnp.includes(T) || T.includes(hTnp)) && hTnp.length >= 3) ? 0.85 : 0);
    if (sc < 0.8) continue;
    const vol = hint.volume && /^\d+$/.test(hint.volume) && new RegExp("(^|[^0-9])" + hint.volume + "([^0-9]|$)").test(String(c.title)) ? 0.05 : 0;
    const total = sc + vol; if (!best || total > best.sc) best = { c, sc: total };
  }
  return best ? { cand: best.c, score: best.sc } : null;
}

module.exports = { seriesTags, parseTocText, normIsbn, findIsbns, lookupIsbn, magazineInfo, commentaryHints, pickMatchSeries, seriesHints, parseFileName, fileHint, pickMatchHint,  titleScore, matchScore, cleanForSearch, queryVariants, pickMatch,  canonName, searchBookstores, bibleSeed, categorySeed, groupPdfFiles, inferDocumentType, normalized, displayTitle, extractPartNumber };
