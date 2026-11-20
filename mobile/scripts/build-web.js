// mobile/src → mobile/www 로 묶는다. 서재 규칙(store·classify·logic)은 PC 앱과 같은 코드를 그대로 쓴다.
const esbuild = require('esbuild'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..'); const www = path.join(root, 'www');
fs.mkdirSync(www, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'src/main.js')], bundle: true, outfile: path.join(www, 'app.js'),
  platform: 'browser', format: 'iife', target: ['chrome100'], minify: true, legalComments: 'none', logLevel: 'info',
  alias: { fs: path.join(root, 'src/shim-fs.js'), path: path.join(root, 'src/shim-path.js') },
  define: { 'process.env.KAKAO_REST_API_KEY': 'undefined', 'process.env.NL_CERT_KEY': 'undefined' },
});
// PDF 엔진: PC 앱과 같은 것을 복사
const src = path.join(root, '..', 'public', 'vendor', 'pdfjs'); const dst = path.join(www, 'pdfjs');
fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst, { recursive: true });
// 안드로이드 WebView 의 로컬 서버가 .mjs 의 형식을 모를 수 있어, 확장자를 .js 로 바꿔 복사한다(내용은 같다).
for (const [from, to] of [['pdf.min.mjs', 'pdf.min.js'], ['pdf.worker.min.mjs', 'pdf.worker.min.js'], ['LICENSE', 'LICENSE']]) if (fs.existsSync(path.join(src, from))) fs.copyFileSync(path.join(src, from), path.join(dst, to));
for (const d of ['cmaps', 'standard_fonts']) if (fs.existsSync(path.join(src, d))) fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true });
console.log('web build ok');
