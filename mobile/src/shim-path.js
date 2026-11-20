// store.js 가 쓰는 path.join 만 흉내 낸다 (브라우저용 번들)
module.exports = { join: (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/') };
