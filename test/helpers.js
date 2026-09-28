// 시험 도우미: Vercel 서버리스 함수를 가짜 요청·응답으로 직접 호출합니다(네트워크·운영 저장소 사용 안 함).
process.env.CLEANERY_STORE = 'memory';
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.NTFY_TOPIC;
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-secret-'.padEnd(48, 'x');

const store = require('../lib/store');

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(obj) { this.setHeader('content-type', 'application/json'); this.body = obj; this.ended = true; return this; },
    send(b) { this.body = b; this.ended = true; return this; },
    end(b) { if (b !== undefined) this.body = b; this.ended = true; return this; },
  };
  return res;
}

async function call(handler, { method = 'GET', query = {}, body, headers = {}, cookie, ip = '10.0.0.1' } = {}) {
  const req = {
    method,
    query,
    body,
    headers: { host: 'localhost:3000', 'x-real-ip': ip, ...(cookie ? { cookie } : {}), ...headers },
    socket: { remoteAddress: ip },
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

const ADMIN_WRITE = { 'x-cleanery-admin': '1' };

async function setupAdmin(password = 'correct-horse-battery') {
  const { hashPassword } = require('../lib/auth');
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(password);
  return password;
}

async function loginCookie(password = 'correct-horse-battery', ip = '10.0.0.50') {
  const admin = require('../handlers/admin');
  const res = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password }, ip });
  if (res.statusCode !== 200) throw new Error('login failed in test: ' + JSON.stringify(res.body));
  return String(res.headers['set-cookie']).split(';')[0];
}

function resetStore() {
  store._resetMemory();
}

module.exports = { call, mockRes, setupAdmin, loginCookie, resetStore, ADMIN_WRITE, store };
