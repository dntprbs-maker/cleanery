// 로컬 개발 서버 — Vercel 과 같은 주소 구조로 홈페이지·관리자 화면·API 를 띄웁니다.
// 운영 Redis·실제 알림은 절대 쓰지 않습니다(메모리 저장소 + 가짜 데이터 + 알림은 기록만).
// 사용: node scripts/dev-server.js [--port 3000] [--host 127.0.0.1]
//  - AI 상담을 실제로 시험하려면 .env 에 OPENROUTER_API_KEY 가 있어야 합니다(없으면 폴백 문구).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(opt('port', 3000));
const HOST = opt('host', '127.0.0.1');

// .env 에서 AI 키만 읽음 (운영 저장소·알림·카카오 값은 읽지 않음)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)\s*$/);
    if (m && !process.env.OPENROUTER_API_KEY) process.env.OPENROUTER_API_KEY = m[1].trim();
  }
} catch (e) {}
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NTFY_TOPIC', 'KAKAO_REST_API_KEY', 'KAKAO_CLIENT_SECRET', 'KAKAO_REDIRECT_URI', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) delete process.env[k];
process.env.CLEANERY_STORE = 'memory';
process.env.CLEANERY_DEMO = '1';
process.env.CLEANERY_NOTIFY = 'log';
process.env.CLEANERY_DEV_STORE_FILE = process.env.CLEANERY_DEV_STORE_FILE || path.join(ROOT, '.dev-store.json');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const APP_ROUTES = ['tracker', 'conversations', 'admin', 'reservations', 'web-chat', 'review'];

function vercelRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { if (typeof b === 'string' && !res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(b); return res; };
  return res;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }
  return raw;
}

async function runFunction(file, req, res, query) {
  req.query = query;
  req.body = await readBody(req);
  const handler = require(path.join(ROOT, file));
  await handler(req, vercelRes(res));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = Object.fromEntries(url.searchParams);
    let p = decodeURIComponent(url.pathname);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const redirects = { '/tracker.html': '/admin/tracker', '/conversations.html': '/admin/conversations', '/admin': '/admin/reservations' };
    if (redirects[p]) { res.statusCode = 307; res.setHeader('Location', redirects[p]); return res.end(); }
    if (p === '/admin/login') p = '/admin/login.html';
    let m = p.match(/^\/admin\/(tracker|conversations|reservations|review)$/);
    if (m) return runFunction('api/app.js', req, res, { ...query, __route: 'admin-page', page: m[1] });
    m = p.match(/^\/api\/([a-z-]+)$/);
    if (m && APP_ROUTES.includes(m[1])) return runFunction('api/app.js', req, res, { ...query, __route: m[1] });
    if (m && fs.existsSync(path.join(ROOT, 'api', m[1] + '.js'))) return runFunction(`api/${m[1]}.js`, req, res, query);

    // 정적 파일은 public/ 에서만 (Vercel outputDirectory 와 동일)
    const file = path.normalize(path.join(ROOT, 'public', p === '/' ? 'index.html' : p));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404; return res.end('Not found');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('[dev-server]', e);
    res.statusCode = 500; res.end('dev server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`크리너리 개발 서버: http://${HOST}:${PORT}/  (메모리 저장소·가짜 데이터·알림 기록만)`);
  console.log(`관리자: http://${HOST}:${PORT}/admin/login  (데모 계정 admin)`);
  console.log(`AI 상담: ${process.env.OPENROUTER_API_KEY ? '실제 AI 연결' : 'AI 키 없음 → 폴백 문구'}`);
});
