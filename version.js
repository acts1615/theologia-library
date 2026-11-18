'use strict';
// 버전 표기: 1.0.a.1 → …a.9 → 1.0.b.1 … 1.0.z.9 → 1.1.a.1  (seq 는 0부터 올리는 일련번호)
function versionOf(seq) {
  const i = Math.max(0, Math.floor(Number(seq) || 0)); const n = (i % 9) + 1; const li = Math.floor(i / 9); const letter = String.fromCharCode(97 + (li % 26)); const minor = Math.floor(li / 26);
  return `1.${minor}.${letter}.${n}`;
}
module.exports = { versionOf };
