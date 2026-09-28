// 1단계 보안 자동시험: 인증·권한·동시저장·기존 데이터 호환
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, setupAdmin, loginCookie, resetStore, ADMIN_WRITE, store } = require('./helpers');

const admin = require('../handlers/admin');
const tracker = require('../handlers/tracker');
const conversations = require('../handlers/conversations');
const adminPage = require('../handlers/admin-page');
const auth = require('../lib/auth');

test.beforeEach(async () => {
  resetStore();
  await setupAdmin();
});

test('비밀번호 해시: 같은 비밀번호도 매번 다른 솔트, 검증은 정확', async () => {
  const a = await auth.hashPassword('abcdefghij1');
  const b = await auth.hashPassword('abcdefghij1');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await auth.verifyPassword('abcdefghij1', a), true);
  assert.equal(await auth.verifyPassword('abcdefghij2', a), false);
  await assert.rejects(() => auth.hashPassword('short'));
});

test('설정 누락 시 로그인 차단(fail closed)', async () => {
  const saved = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = '';
  const res = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password: 'correct-horse-battery' } });
  process.env.ADMIN_SESSION_SECRET = saved;
  assert.equal(res.statusCode, 503);
});

test('로그인: 틀린 비밀번호 401, 맞으면 HttpOnly·SameSite=Strict 쿠키', async () => {
  const bad = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password: 'wrong-password-1' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  const unknown = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'nobody', password: 'wrong-password-1' } });
  assert.equal(unknown.statusCode, 401);
  const ok = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password: 'correct-horse-battery' } });
  assert.equal(ok.statusCode, 200);
  const c = String(ok.headers['set-cookie']);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.doesNotMatch(c, /correct-horse/);
});

test('https 요청이면 쿠키에 Secure', async () => {
  const ok = await call(admin, { method: 'POST', query: { action: 'login' }, headers: { ...ADMIN_WRITE, 'x-forwarded-proto': 'https' }, body: { username: 'admin', password: 'correct-horse-battery' } });
  assert.match(String(ok.headers['set-cookie']), /Secure/);
});

test('다른 사이트에서 온 로그인·저장 요청 차단(CSRF)', async () => {
  const noHeader = await call(admin, { method: 'POST', query: { action: 'login' }, body: { username: 'admin', password: 'correct-horse-battery' } });
  assert.equal(noHeader.statusCode, 403);
  const cookie = await loginCookie();
  const foreign = await call(tracker, { method: 'POST', cookie, headers: { ...ADMIN_WRITE, origin: 'https://evil.example' }, body: { record: { site: 'x' } } });
  assert.equal(foreign.statusCode, 403);
});

test('로그인 시도 제한: 계정당 5회 실패 후 맞는 비밀번호도 429', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password: 'nope-nope-' + i }, ip: '10.1.1.' + i });
    assert.equal(r.statusCode, 401);
  }
  const locked = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password: 'correct-horse-battery' }, ip: '10.1.1.99' });
  assert.equal(locked.statusCode, 429);
});

test('로그인 시도 제한: IP당 10회 실패', async () => {
  for (let i = 0; i < 10; i++) {
    await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'user' + i, password: 'nope-nope-x' }, ip: '10.9.9.9' });
  }
  const locked = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'admin', password: 'correct-horse-battery' }, ip: '10.9.9.9' });
  assert.equal(locked.statusCode, 429);
});

test('보호된 API·화면: 로그인 없으면 401/로그인 화면으로', async () => {
  assert.equal((await call(tracker)).statusCode, 401);
  assert.equal((await call(tracker, { method: 'POST', headers: ADMIN_WRITE, body: { records: [] } })).statusCode, 401);
  assert.equal((await call(conversations)).statusCode, 401);
  assert.equal((await call(conversations, { query: { id: 'u1' } })).statusCode, 401);
  const page = await call(adminPage, { query: { page: 'conversations' } });
  assert.equal(page.statusCode, 302);
  assert.match(page.headers.location, /^\/admin\/login\?next=/);
});

test('위조·만료·로그아웃된 쿠키는 거부', async () => {
  const cookie = await loginCookie();
  assert.equal((await call(tracker, { cookie })).statusCode, 200);
  const [name, value] = cookie.split('=');
  const tampered = `${name}=${decodeURIComponent(value).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`;
  assert.equal((await call(tracker, { cookie: tampered })).statusCode, 401);
  const out = await call(admin, { method: 'POST', query: { action: 'logout' }, headers: ADMIN_WRITE, cookie });
  assert.equal(out.statusCode, 200);
  assert.equal((await call(tracker, { cookie })).statusCode, 401, '로그아웃 후 같은 쿠키 재사용 불가');
});

test('세션 서명 키가 바뀌면 기존 쿠키 무효', async () => {
  const cookie = await loginCookie();
  const saved = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = 'another-secret-'.padEnd(48, 'y');
  const r = await call(tracker, { cookie });
  process.env.ADMIN_SESSION_SECRET = saved;
  assert.equal(r.statusCode, 401);
});

test('계정별 확장: 저장소 계정으로 로그인, 비활성 계정은 거부', async () => {
  await store.cmd('HSET', 'cleanery:admin:accounts', 'staff1', JSON.stringify({ passwordHash: await auth.hashPassword('staff-password-1'), role: 'staff' }));
  await store.cmd('HSET', 'cleanery:admin:accounts', 'staff2', JSON.stringify({ passwordHash: await auth.hashPassword('staff-password-2'), role: 'staff', disabled: true }));
  const ok = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'staff1', password: 'staff-password-1' } });
  assert.equal(ok.statusCode, 200);
  const me = await call(admin, { query: { action: 'me' }, cookie: String(ok.headers['set-cookie']).split(';')[0] });
  assert.equal(me.body.role, 'staff');
  const disabled = await call(admin, { method: 'POST', query: { action: 'login' }, headers: ADMIN_WRITE, body: { username: 'staff2', password: 'staff-password-2' } });
  assert.equal(disabled.statusCode, 401);
});

test('로그인하면 관리자 화면 HTML 전달', async () => {
  const cookie = await loginCookie();
  const page = await call(adminPage, { query: { page: 'tracker' }, cookie });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /크리너리 견적 프로그램/);
  assert.equal((await call(adminPage, { query: { page: '../lib/auth' }, cookie })).statusCode, 404);
});

// ---------------- 견적 프로그램 저장 ----------------
const LEGACY = [
  { id: 'mfa1b2c3', date: '2026-08-20', site: '역삼동 A사무실', type: '사무실', area: '45', quote: 350000, final: 420000, cost: 300000, memo: '유리 별도' },
  { id: 'mfa9z8y7', date: '2026-08-25', site: '성수 공장', type: '공장', area: '120', quote: 900000, special: '기름때' },
];

test('기존 데이터 호환: 예전 배열 기록이 그대로 보이고, 예전 저장 키는 바뀌지 않음', async () => {
  const legacyJson = JSON.stringify(LEGACY);
  await store.cmd('SET', 'cleanery:tracker:records', legacyJson);
  const cookie = await loginCookie();
  const r = await call(tracker, { cookie });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.records.length, 2);
  for (const orig of LEGACY) {
    const got = r.body.records.find((x) => x.id === orig.id);
    for (const [k, v] of Object.entries(orig)) assert.deepEqual(got[k], v, `${orig.id}.${k}`);
    assert.equal(got._version, 1);
  }
  // 수정·삭제 후에도 예전 키는 그대로
  const target = r.body.records[0];
  await call(tracker, { method: 'PUT', query: { id: target.id }, cookie, headers: ADMIN_WRITE, body: { record: { memo: '수정됨' }, version: 1 } });
  await call(tracker, { method: 'DELETE', query: { id: r.body.records[1].id }, cookie, headers: ADMIN_WRITE, body: { version: 1 } });
  assert.equal(await store.cmd('GET', 'cleanery:tracker:records'), legacyJson);
  // 두 번째 조회에서 다시 복사해 덮어쓰지 않음
  const again = await call(tracker, { cookie });
  assert.equal(again.body.records.find((x) => x.id === target.id).memo, '수정됨');
});

test('예전 기록이 없어도 정상, 빈 배열 전송으로 전체 삭제 불가', async () => {
  const cookie = await loginCookie();
  await call(tracker, { method: 'POST', cookie, headers: ADMIN_WRITE, body: { record: { site: '남아있어야 할 기록' } } });
  const wipe = await call(tracker, { method: 'POST', cookie, headers: ADMIN_WRITE, body: { records: [] } });
  assert.equal(wipe.statusCode, 400);
  const list = await call(tracker, { cookie });
  assert.equal(list.body.records.length, 1);
});

test('건별 저장: 추가·수정·삭제 표시, 삭제된 기록도 서버에는 보존', async () => {
  const cookie = await loginCookie();
  const created = await call(tracker, { method: 'POST', cookie, headers: ADMIN_WRITE, body: { record: { site: '논현 상가', quote: 360000, id: 'client-given', _version: 99 } } });
  assert.equal(created.statusCode, 201);
  const rec = created.body.record;
  assert.notEqual(rec.id, 'client-given');
  assert.equal(rec._version, 1);
  const upd = await call(tracker, { method: 'PUT', query: { id: rec.id }, cookie, headers: ADMIN_WRITE, body: { record: { final: 400000 }, version: 1 } });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.body.record.quote, 360000);
  assert.equal(upd.body.record.final, 400000);
  assert.equal(upd.body.record._version, 2);
  const del = await call(tracker, { method: 'DELETE', query: { id: rec.id }, cookie, headers: ADMIN_WRITE, body: { version: 2 } });
  assert.equal(del.statusCode, 200);
  assert.equal((await call(tracker, { cookie })).body.records.length, 0);
  const kept = JSON.parse(await store.cmd('HGET', 'cleanery:tracker:v2', rec.id));
  assert.equal(kept._deleted, true);
  assert.equal(kept.site, '논현 상가');
});

test('동시 저장: 같은 버전으로 두 기기가 동시에 수정하면 하나만 성공, 다른 쪽은 409', async () => {
  const cookie = await loginCookie();
  const rec = (await call(tracker, { method: 'POST', cookie, headers: ADMIN_WRITE, body: { record: { site: '동시 수정 현장' } } })).body.record;
  const [a, b] = await Promise.all([
    call(tracker, { method: 'PUT', query: { id: rec.id }, cookie, headers: ADMIN_WRITE, body: { record: { memo: '기기A' }, version: 1 } }),
    call(tracker, { method: 'PUT', query: { id: rec.id }, cookie, headers: ADMIN_WRITE, body: { record: { memo: '기기B' }, version: 1 } }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const final = (await call(tracker, { cookie })).body.records[0];
  assert.equal(final._version, 2);
  assert.equal(final.memo, a.statusCode === 200 ? '기기A' : '기기B');
});

test('동시 추가: 서로 다른 기기에서 동시에 추가해도 둘 다 남음', async () => {
  const cookie = await loginCookie();
  await Promise.all([1, 2, 3, 4, 5].map((i) => call(tracker, { method: 'POST', cookie, headers: ADMIN_WRITE, body: { record: { site: '현장' + i } } })));
  assert.equal((await call(tracker, { cookie })).body.records.length, 5);
});

test('상담내역: 로그인 후 목록, 만료된 대화는 숨김(인덱스는 보존)', async () => {
  const cookie = await loginCookie();
  await store.cmd('SET', 'cleanery:session:kakaoUser1', JSON.stringify({ messages: [{ role: 'user', content: '빌라 청소 문의' }, { role: 'assistant', content: '면적이 어떻게 되세요? [[관리자알림: x]]' }] }));
  await store.cmd('ZADD', 'cleanery:sessions:index', String(Date.now()), 'kakaoUser1');
  await store.cmd('ZADD', 'cleanery:sessions:index', String(Date.now() - 1000), 'expiredUser');
  const list = await call(conversations, { cookie });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.sessions.length, 1);
  assert.equal(list.body.hiddenExpired, 1);
  assert.doesNotMatch(list.body.sessions[0].preview, /관리자알림/);
  assert.equal(await store.cmd('ZSCORE', 'cleanery:sessions:index', 'expiredUser') !== null, true);
  const detail = await call(conversations, { query: { id: 'kakaoUser1' }, cookie });
  assert.equal(detail.body.messages.length, 2);
});
