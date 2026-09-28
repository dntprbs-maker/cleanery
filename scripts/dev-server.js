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
process.env.CLEANERY_NOTIFY = 'log';

// --review-local: 아빠용 "크리너리 상담검토" 프로그램 모드
//  - 데이터는 저장소 폴더가 아니라 사용자 폴더(%LOCALAPPDATA%\Cleanery Review)에 저장 → 코드 작업·시험과 섞이지 않음
//  - 자동 백업 폴더(backups), 첫 실행 때 이 PC 전용 비밀번호 설정(/admin/setup), 가짜 데모 데이터 없음
const REVIEW_LOCAL = args.includes('--review-local');
const REVIEW_HOME = process.env.CLEANERY_REVIEW_HOME || path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'Cleanery Review');
const ADMIN_FILE = path.join(REVIEW_HOME, 'admin.json');
if (REVIEW_LOCAL) {
  fs.mkdirSync(REVIEW_HOME, { recursive: true });
  process.env.CLEANERY_REVIEW_LOCAL = '1';
  process.env.CLEANERY_DEV_STORE_FILE = path.join(REVIEW_HOME, 'review-store.json');
  process.env.CLEANERY_REVIEW_BACKUP_DIR = path.join(REVIEW_HOME, 'backups');
  delete process.env.CLEANERY_DEMO;
  loadLocalAdmin();
} else {
  process.env.CLEANERY_DEMO = '1';
  process.env.CLEANERY_DEV_STORE_FILE = process.env.CLEANERY_DEV_STORE_FILE || path.join(ROOT, '.dev-store.json');
}

function loadLocalAdmin() {
  if (!fs.existsSync(ADMIN_FILE)) return false;
  const a = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
  process.env.ADMIN_USERNAME = a.username;
  process.env.ADMIN_PASSWORD_HASH = a.passwordHash;
  process.env.ADMIN_SESSION_SECRET = a.sessionSecret;
  return true;
}
const localConfigured = () => !!process.env.ADMIN_PASSWORD_HASH;

function sameOrigin(req) {
  const host = req.headers.host || '';
  const okHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
  const origin = req.headers.origin;
  return okHost && (!origin || origin === `http://${host}`) && req.headers['x-cleanery-admin'] === '1';
}

const SETUP_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>크리너리 상담검토 — 처음 설정</title>
<style>body{margin:0;background:#f4f7fa;font:17px/1.6 system-ui,"Malgun Gothic",sans-serif;color:#16202c}main{max-width:420px;margin:40px auto;padding:20px;background:#fff;border-radius:14px}h1{font-size:21px;color:#0f2a4a;margin:0 0 8px}label{display:block;margin-top:14px;font-weight:700}input{width:100%;box-sizing:border-box;font:inherit;min-height:48px;border:1px solid #cfd8e3;border-radius:10px;padding:0 12px;margin-top:4px}button{width:100%;margin-top:18px;min-height:50px;border:0;border-radius:10px;background:#0f2a4a;color:#fff;font:inherit;font-weight:700}.msg{margin-top:12px;color:#b42318;min-height:24px}.help{font-size:14px;color:#5b6b7c}</style></head>
<body><main><h1>처음 한 번만: 비밀번호 만들기</h1><p class="help">이 PC에서 상담 검토 화면을 열 때 쓸 비밀번호입니다. 아이디는 <b>admin</b> 입니다. 10자 이상으로 정해 주세요.</p>
<form id="f"><label>비밀번호<input id="p1" type="password" autocomplete="new-password" required minlength="10"></label><label>비밀번호 확인<input id="p2" type="password" autocomplete="new-password" required minlength="10"></label><button>저장하고 로그인 화면으로</button><div class="msg" id="m"></div></form>
<p class="help">비밀번호를 잊으면: 코드디에게 "상담검토 비밀번호 초기화"를 요청하세요(검토 내용은 지워지지 않습니다).</p></main>
<script>document.getElementById('f').onsubmit=function(e){e.preventDefault();var a=p1.value,b=p2.value;if(a.length<10){m.textContent='10자 이상으로 정해 주세요.';return}if(a!==b){m.textContent='두 비밀번호가 다릅니다.';return}
fetch('/api/local-setup',{method:'POST',headers:{'Content-Type':'application/json','X-Cleanery-Admin':'1'},body:JSON.stringify({password:a})}).then(function(r){return r.json()}).then(function(d){if(d.ok)location.replace('/admin/login?next=/admin/review');else m.textContent=d.error||'저장하지 못했습니다.'}).catch(function(){m.textContent='프로그램에 연결하지 못했습니다.'})}</script></body></html>`;

async function handleLocal(req, res, p) {
  if (!REVIEW_LOCAL) return false;
  if (p === '/admin/setup' && req.method === 'GET') {
    if (localConfigured()) { res.statusCode = 302; res.setHeader('Location', '/admin/login?next=/admin/review'); res.end(); return true; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(SETUP_HTML); return true;
  }
  if ((p === '/admin/login' || p === '/admin/login.html' || p === '/' || p === '/admin/review') && req.method === 'GET' && !localConfigured()) {
    res.statusCode = 302; res.setHeader('Location', '/admin/setup'); res.end(); return true;
  }
  if (p === '/' && req.method === 'GET') { res.statusCode = 302; res.setHeader('Location', '/admin/review'); res.end(); return true; }
  if (p === '/api/local-setup' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!sameOrigin(req)) { res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: '허용되지 않은 요청입니다.' })); return true; }
    if (localConfigured()) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: '이미 비밀번호가 설정돼 있습니다.' })); return true; }
    const body = await readBody(req);
    try {
      const { hashPassword } = require(path.join(ROOT, 'lib', 'auth'));
      const passwordHash = await hashPassword(body && body.password);
      const cfg = { username: 'admin', passwordHash, sessionSecret: require('crypto').randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() };
      fs.writeFileSync(ADMIN_FILE + '.tmp', JSON.stringify(cfg, null, 2));
      fs.renameSync(ADMIN_FILE + '.tmp', ADMIN_FILE);
      loadLocalAdmin();
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }
  if (p === '/api/local-shutdown' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const { getSession } = require(path.join(ROOT, 'lib', 'auth'));
    if (!sameOrigin(req) || !(await getSession(req).catch(() => null))) { res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: '허용되지 않은 요청입니다.' })); return true; }
    res.end(JSON.stringify({ ok: true }));
    console.log('검토 화면에서 [프로그램 종료]를 눌러 종료합니다.');
    setTimeout(() => process.exit(0), 300);
    return true;
  }
  return false;
}

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
    if (await handleLocal(req, res, p)) return;

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

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `포트 ${PORT} 를 이미 쓰고 있습니다(이미 실행 중일 수 있음).` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  if (REVIEW_LOCAL) {
    console.log(`크리너리 상담검토: http://${HOST}:${PORT}/admin/review`);
    console.log(`검토 기록 저장 위치: ${REVIEW_HOME}  (자동 백업: backups 폴더)`);
    console.log('이 창을 닫거나 검토 화면의 [프로그램 종료]를 누르면 끝납니다. 저장한 내용은 남아 있습니다.');
    return;
  }
  console.log(`크리너리 개발 서버: http://${HOST}:${PORT}/  (메모리 저장소·가짜 데이터·알림 기록만)`);
  console.log(`관리자: http://${HOST}:${PORT}/admin/login  (데모 계정 admin)`);
  console.log(`AI 상담: ${process.env.OPENROUTER_API_KEY ? '실제 AI 연결' : 'AI 키 없음 → 폴백 문구'}`);
});
