// 2차 보안 시험: 세션 만료, 인증 우회 시도, 관리자 API 직접 호출, CSRF, 동시 수정, 마이그레이션 결함
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { call, setupAdmin, loginCookie, resetStore, ADMIN_WRITE, store } = require('./helpers');

const admin = require('../handlers/admin');
const tracker = require('../handlers/tracker');
const conversations = require('../handlers/conversations');
const reservationsApi = require('../handlers/reservations');
const adminPage = require('../handlers/admin-page');
const reservations = require('../lib/reservations');

test.beforeEach(async () => {
  resetStore();
  await setupAdmin();
});

function sessionKeysIn() {
  return [...store._memDump().data.keys()].filter((k) => k.startsWith('cleanery:admin:session:'));
}

test('세션 만료: 저장된 만료시각이 지나면 거부', async () => {
  const cookie = await loginCookie();
  const [key] = sessionKeysIn();
  const s = JSON.parse(await store.cmd('GET', key));
  s.expiresAt = new Date(Date.now() - 1000).toISOString();
  await store.cmd('SET', key, JSON.stringify(s));
  assert.equal((await call(tracker, { cookie })).statusCode, 401);
});

test('세션 만료: 서버 기록이 TTL 로 사라지면 거부(12시간)', async () => {
  const cookie = await loginCookie();
  const [key] = sessionKeysIn();
  const ttl = await store.cmd('TTL', key);
  assert.ok(ttl > 11 * 3600 && ttl <= 12 * 3600, 'TTL 12시간');
  await store.cmd('DEL', key);
  assert.equal((await call(tracker, { cookie })).statusCode, 401);
});

test('인증 우회: 서명만 맞춘 가짜 세션ID·서명 없는 쿠키·다른 쿠키 이름은 거부', async () => {
  const id = crypto.randomBytes(32).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(id).digest('base64url');
  assert.equal((await call(tracker, { cookie: `cln_admin=${id}.${sig}` })).statusCode, 401, '서버 기록 없는 세션');
  assert.equal((await call(tracker, { cookie: `cln_admin=${id}` })).statusCode, 401);
  assert.equal((await call(tracker, { cookie: 'admin=1; role=owner' })).statusCode, 401);
  assert.equal((await call(tracker, { headers: { authorization: 'Bearer anything' } })).statusCode, 401);
});

test('관리자 API 직접 호출: 로그인 없이 모든 읽기·쓰기 거부', async () => {
  for (const [h, method, query] of [
    [tracker, 'GET', {}], [tracker, 'POST', {}], [tracker, 'PUT', { id: 'x' }], [tracker, 'DELETE', { id: 'x' }],
    [conversations, 'GET', {}], [conversations, 'GET', { id: 'u' }],
    [reservationsApi, 'GET', {}], [reservationsApi, 'PATCH', { id: 'x' }], [reservationsApi, 'GET', { id: 'x', schedule: '1' }],
  ]) {
    const r = await call(h, { method, query, headers: ADMIN_WRITE, body: {} });
    assert.equal(r.statusCode, 401, `${method} ${JSON.stringify(query)}`);
  }
});

test('CSRF: 로그인 쿠키가 있어도 사용자 정의 헤더 없거나 다른 출처면 모든 쓰기 거부', async () => {
  const cookie = await loginCookie();
  const r = await reservations.upsertFromChat({ channel: 'web', userId: 'c1', data: { quoteAmount: 200000 }, kind: '예약' });
  const cases = [
    [tracker, 'POST', {}, { record: { site: 'x' } }],
    [reservationsApi, 'PATCH', { id: r.id }, { fields: { adminMemo: 'x' } }],
    [admin, 'POST', { action: 'logout' }, {}],
  ];
  for (const [h, method, query, body] of cases) {
    assert.equal((await call(h, { method, query, cookie, body })).statusCode, 403, `헤더 없음 ${method}`);
    assert.equal((await call(h, { method, query, cookie, body, headers: { ...ADMIN_WRITE, origin: 'https://evil.example' } })).statusCode, 403, `다른 출처 ${method}`);
  }
  assert.equal((await call(tracker, { cookie })).statusCode, 200, '로그아웃 요청이 거부돼 세션 유지');
});

test('관리자 화면: 경로 조작·없는 화면 404, 로그인 전 302', async () => {
  const cookie = await loginCookie();
  for (const page of ['../../.env', '..%2F..%2Flib%2Fauth', 'admin', '']) {
    const r = await call(adminPage, { query: { page }, cookie });
    assert.ok([404, 200].includes(r.statusCode));
    if (r.statusCode === 200) assert.match(r.body, /예약 관리/, '빈 값은 기본 화면(예약)');
  }
});

test('예약 동시 수정: 같은 버전으로 두 관리자가 저장하면 하나는 409', async () => {
  const cookie = await loginCookie();
  const r = await reservations.upsertFromChat({ channel: 'kakao', userId: 'k1', data: { quoteAmount: 300000 }, kind: '예약' });
  const [a, b] = await Promise.all([
    call(reservationsApi, { method: 'PATCH', query: { id: r.id }, cookie, headers: ADMIN_WRITE, body: { version: 1, fields: { adminMemo: 'A' } } }),
    call(reservationsApi, { method: 'PATCH', query: { id: r.id }, cookie, headers: ADMIN_WRITE, body: { version: 1, fields: { adminMemo: 'B' } } }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

// ---------------- 마이그레이션 ----------------
test('마이그레이션: id 없는 기록·중복 id 기록도 누락 없이 옮기고 원래 id 보존', async () => {
  const legacy = [
    { id: 'a1', site: '현장1' },
    { site: 'id 없는 현장' },
    { id: 'a1', site: '같은 id 다른 현장' },
    null,
    { id: 'b2', site: '현장4' },
  ];
  await store.cmd('SET', 'cleanery:tracker:records', JSON.stringify(legacy));
  const cookie = await loginCookie();
  const recs = (await call(tracker, { cookie })).body.records;
  assert.equal(recs.length, 4, 'null 제외 4건 전부');
  assert.deepEqual(recs.map((r) => r.site).sort(), ['id 없는 현장', '같은 id 다른 현장', '현장1', '현장4'].sort());
  assert.equal(new Set(recs.map((r) => r.id)).size, 4, 'id 중복 없음');
  assert.equal(recs.find((r) => r.site === '같은 id 다른 현장')._legacyId, 'a1');
});

test('마이그레이션: 중간에 멈춘 뒤 다시 실행해도 중복·덮어쓰기 없음', async () => {
  const legacy = Array.from({ length: 30 }, (_, i) => ({ id: 'r' + i, site: '현장' + i }));
  await store.cmd('SET', 'cleanery:tracker:records', JSON.stringify(legacy));
  // 1차 실행이 10건 복사 후 중단된 상황을 재현(완료 표시 없음) + 그중 1건은 이미 관리자가 수정함
  for (let i = 0; i < 10; i++) {
    await store.cmd('HSETNX', 'cleanery:tracker:v2', 'r' + i, JSON.stringify({ site: '현장' + i, _version: 1 }));
  }
  await store.cmd('HSET', 'cleanery:tracker:v2', 'r3', JSON.stringify({ site: '현장3(관리자 수정)', _version: 2 }));
  const cookie = await loginCookie();
  const recs = (await call(tracker, { cookie })).body.records;
  assert.equal(recs.length, 30);
  assert.equal(recs.find((r) => r.id === 'r3').site, '현장3(관리자 수정)', '수정된 기록 덮어쓰지 않음');
  assert.ok(await store.cmd('GET', 'cleanery:tracker:v2:migrated'));
  // 완료 후 예전 배열이 (다른 기기의 옛 화면 때문에) 바뀌어도 다시 복사해 덮어쓰지 않음
  await store.cmd('SET', 'cleanery:tracker:records', JSON.stringify([{ id: 'r0', site: '옛 화면이 덮어쓴 값' }]));
  const again = (await call(tracker, { cookie })).body.records;
  assert.equal(again.find((r) => r.id === 'r0').site, '현장0');
  assert.equal(again.length, 30);
});

test('마이그레이션: 예전 데이터가 깨진 JSON 이면 복사하지 않고 다음에 재시도(완료 표시 안 함)', async () => {
  await store.cmd('SET', 'cleanery:tracker:records', '[{broken');
  const cookie = await loginCookie();
  const r = await call(tracker, { cookie });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.records.length, 0);
  assert.equal(await store.cmd('GET', 'cleanery:tracker:v2:migrated'), null);
});

test('저장소 진단(store-probe)은 데모 모드에서만 열림', async () => {
  const r = await call(admin, { query: { action: 'store-probe' } });
  assert.equal(r.statusCode, 404);
});
