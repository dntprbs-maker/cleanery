// 관리자 로그인·세션
//
// [1차] 단일 관리자 계정: 환경변수 ADMIN_USERNAME(기본 admin) + ADMIN_PASSWORD_HASH
// [확장] 계정별 로그인: 저장소 해시 cleanery:admin:accounts 에 username → {passwordHash, role, disabled}
//        를 넣으면 같은 로그인 흐름으로 동작합니다(역할 role 은 세션에 함께 저장).
//
// - 비밀번호: scrypt(N=32768, r=8, p=1, 64바이트) + 16바이트 솔트. 형식 scrypt$N$r$p$salt$hash (base64)
//   해시 만들기: node scripts/hash-password.js
// - 세션: 무작위 32바이트 ID 를 서버 저장소에 기록(12시간), 쿠키에는 ID + HMAC 서명만 담습니다.
//   서명 키는 ADMIN_SESSION_SECRET(32자 이상). 로그아웃하면 서버 기록을 지워 즉시 무효화됩니다.
// - 로그인 시도 제한: IP당 15분에 10회, 계정당 15분에 5회 실패하면 15분 잠금.
// - 설정이 빠져 있으면 로그인을 막습니다(fail closed).
const crypto = require('crypto');
const store = require('./store');
const { parseCookies, serializeCookie, isHttps, clientIp } = require('./http');

const COOKIE_NAME = 'cln_admin';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const FAIL_WINDOW_SECONDS = 15 * 60;
const MAX_FAILS_PER_IP = 10;
const MAX_FAILS_PER_USER = 5;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const ACCOUNTS_KEY = 'cleanery:admin:accounts';

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('비밀번호는 10자 이상이어야 합니다.');
  }
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(String(password || ''), Buffer.from(saltB64, 'base64'), {
    N: Number(N), r: Number(r), p: Number(p), keylen: expected.length,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// 존재하지 않는 계정도 같은 시간만큼 계산해 계정 존재 여부가 드러나지 않게 합니다.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing');
  return dummyHashPromise;
}

function configProblems() {
  const problems = [];
  const secret = process.env.ADMIN_SESSION_SECRET || '';
  if (secret.length < 32) problems.push('ADMIN_SESSION_SECRET(32자 이상)이 설정되지 않았습니다.');
  return problems;
}

async function findAccount(username) {
  const name = String(username || '').trim();
  if (!name) return null;
  try {
    const raw = await store.cmd('HGET', ACCOUNTS_KEY, name);
    if (raw) {
      const acc = JSON.parse(raw);
      return { username: name, passwordHash: acc.passwordHash, role: acc.role || 'admin', disabled: !!acc.disabled };
    }
  } catch (e) {
    console.error('[auth] 계정 저장소 조회 실패:', e.message);
  }
  const envUser = process.env.ADMIN_USERNAME || 'admin';
  if (name === envUser && process.env.ADMIN_PASSWORD_HASH) {
    return { username: envUser, passwordHash: process.env.ADMIN_PASSWORD_HASH, role: 'owner', disabled: false };
  }
  return null;
}

function sign(id) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(id).digest('base64url');
}

function sessionKey(id) {
  return `cleanery:admin:session:${crypto.createHash('sha256').update(id).digest('hex')}`;
}

async function failCount(kind, value) {
  const v = await store.cmd('GET', `cleanery:admin:login-fail:${kind}:${value}`);
  return Number(v || 0);
}

async function addFail(kind, value) {
  const key = `cleanery:admin:login-fail:${kind}:${value}`;
  const n = await store.cmd('INCR', key);
  if (Number(n) === 1) await store.cmd('EXPIRE', key, FAIL_WINDOW_SECONDS);
}

// 결과: { ok: true, cookie, session } | { ok: false, status, error }
async function login(req, username, password) {
  const problems = configProblems();
  if (problems.length) return { ok: false, status: 503, error: '관리자 로그인이 아직 설정되지 않았습니다. ' + problems.join(' ') };

  const ip = clientIp(req);
  const user = String(username || '').trim().toLowerCase();
  if ((await failCount('ip', ip)) >= MAX_FAILS_PER_IP || (await failCount('user', user)) >= MAX_FAILS_PER_USER) {
    return { ok: false, status: 429, error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.' };
  }

  const account = await findAccount(String(username || '').trim());
  const ok = account && !account.disabled
    ? await verifyPassword(password, account.passwordHash)
    : (await verifyPassword(password, await dummyHash()), false);

  if (!ok) {
    await addFail('ip', ip);
    await addFail('user', user);
    return { ok: false, status: 401, error: '아이디 또는 비밀번호가 올바르지 않습니다.' };
  }

  await store.cmd('DEL', `cleanery:admin:login-fail:user:${user}`);
  const id = crypto.randomBytes(32).toString('base64url');
  const session = {
    username: account.username,
    role: account.role,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  await store.cmd('SET', sessionKey(id), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  const cookie = serializeCookie(COOKIE_NAME, `${id}.${sign(id)}`, { maxAge: SESSION_TTL_SECONDS, secure: isHttps(req) });
  return { ok: true, cookie, session };
}

async function getSession(req) {
  if (configProblems().length) return null;
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(id));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const stored = await store.cmd('GET', sessionKey(id));
  if (!stored) return null;
  const session = JSON.parse(stored);
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const account = await findAccount(session.username);
  if (!account || account.disabled) return null;
  return { ...session, id };
}

async function logout(req) {
  const session = await getSession(req);
  if (session) await store.cmd('DEL', sessionKey(session.id));
  return serializeCookie(COOKIE_NAME, '', { maxAge: 0, secure: isHttps(req) });
}

// API 보호: 로그인 안 됐으면 401 을 보내고 null 반환
async function requireAdmin(req, res) {
  let session = null;
  try {
    session = await getSession(req);
  } catch (e) {
    console.error('[auth] 세션 확인 실패:', e.message);
  }
  if (!session) {
    res.status(401).json({ ok: false, error: '관리자 로그인이 필요합니다.', login: '/admin/login' });
    return null;
  }
  return session;
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  hashPassword,
  verifyPassword,
  login,
  logout,
  getSession,
  requireAdmin,
  configProblems,
  findAccount,
};
