// 5단계 카카오 연동 자동시험: 환경변수 점검, OAuth 가짜 콜백, 오픈빌더 스킬 가짜 요청
// 실제 카카오 서버·운영 저장소에는 접속하지 않습니다(가짜 응답).
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, resetStore, store } = require('./helpers');
const { checkOAuth, checkSkillRequest } = require('../lib/kakao-config');
const oauthCallback = require('../api/kakao-oauth-callback');
const kakaoSkill = require('../api/kakao-skill');

const GOOD = { KAKAO_REST_API_KEY: '0123456789abcdef0123456789abcdef', KAKAO_REDIRECT_URI: 'https://cleanery-kakao-bot.vercel.app/api/kakao-oauth-callback' };
let kauthResponse = null;
let kauthCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://kauth.kakao.com/oauth/token')) {
    kauthCalls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    return new Response(JSON.stringify(kauthResponse.body), { status: kauthResponse.status });
  }
  if (String(url).includes('openrouter.ai')) return new Response(JSON.stringify({ choices: [{ message: { content: '면적이 어떻게 되세요?' } }] }), { status: 200 });
  if (String(url).includes('kakao.com') || String(url).includes('ntfy.sh')) throw new Error('실제 외부 호출 금지');
  return realFetch(url, init);
};

function withEnv(vars, fn) {
  const saved = {};
  for (const k of ['KAKAO_REST_API_KEY', 'KAKAO_REDIRECT_URI', 'KAKAO_CLIENT_SECRET']) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test.beforeEach(() => { resetStore(); kauthCalls = []; });

test('환경변수 점검: 빠짐·형식 오류를 구체적으로 알려주고 값은 노출하지 않음', () => {
  assert.equal(checkOAuth({}).ok, false);
  assert.equal(checkOAuth({}).problems.length, 2);
  const bad = checkOAuth({ KAKAO_REST_API_KEY: 'js-key-123', KAKAO_REDIRECT_URI: 'http://example.com/wrong?x=1' });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes('형식')));
  assert.ok(bad.problems.some((p) => p.includes('https')));
  assert.ok(bad.problems.some((p) => p.includes('/api/kakao-oauth-callback')));
  assert.ok(!bad.problems.join(' ').includes('js-key-123'), '키 값 노출 금지');
  assert.equal(checkOAuth(GOOD).ok, true);
});

test('OAuth 콜백: 설정이 없으면 무엇이 빠졌는지 안내(500)', () => withEnv({}, async () => {
  const r = await call(oauthCallback, { query: {} });
  assert.equal(r.statusCode, 500);
  assert.match(r.body, /KAKAO_REST_API_KEY/);
}));

test('OAuth 콜백: 코드 없이 열면 카카오 로그인으로 이동', () => withEnv(GOOD, async () => {
  const r = await call(oauthCallback, { query: {} });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location, /^https:\/\/kauth\.kakao\.com\/oauth\/authorize\?client_id=0123/);
  assert.match(r.headers.location, /scope=talk_message/);
}));

test('OAuth 콜백: 가짜 인증코드 → 토큰 저장(메모리 저장소)', () => withEnv(GOOD, async () => {
  kauthResponse = { status: 200, body: { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 21599 } };
  const r = await call(oauthCallback, { query: { code: 'fake-code' } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /연결 완료/);
  assert.equal(kauthCalls[0].code, 'fake-code');
  assert.equal(kauthCalls[0].redirect_uri, GOOD.KAKAO_REDIRECT_URI);
  assert.equal(await store.cmd('GET', 'cleanery:kakao:refresh_token'), 'fake-refresh');
  assert.equal(await store.cmd('GET', 'cleanery:kakao:access_token'), 'fake-access');
}));

test('OAuth 콜백: 만료된 코드·사용자 취소는 이해 가능한 안내, 원문 오류 노출 없음', () => withEnv(GOOD, async () => {
  kauthResponse = { status: 400, body: { error: 'invalid_grant', error_description: 'authorization code not found for code=fake', error_code: 'KOE320' } };
  const r = await call(oauthCallback, { query: { code: 'old-code' } });
  assert.equal(r.statusCode, 500);
  assert.match(r.body, /인증 코드가 만료/);
  assert.doesNotMatch(r.body, /KOE320|code=fake/);
  const cancel = await call(oauthCallback, { query: { error: 'access_denied', error_description: 'User denied access' } });
  assert.equal(cancel.statusCode, 400);
}));

test('오픈빌더 스킬: 형식이 아닌 요청은 400(AI 호출 없음), GET 은 상태 확인', async () => {
  assert.equal(checkSkillRequest({ userRequest: { utterance: 'x', user: { id: 'u' }, callbackUrl: 'http://no' } }).ok, false);
  const bad = await call(kakaoSkill, { method: 'POST', body: { hello: 1 } });
  assert.equal(bad.statusCode, 400);
  const get = await call(kakaoSkill, { method: 'GET' });
  assert.equal(get.body.ok, true);
});

test('오픈빌더 스킬: 가짜 요청 → 카카오 응답 형식(version 2.0, simpleText)', async () => {
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-not-real';
  const r = await call(kakaoSkill, { method: 'POST', body: { userRequest: { utterance: '빌라 청소요', user: { id: 'fake-kakao-user' } } } });
  assert.equal(r.body.version, '2.0');
  assert.equal(r.body.template.outputs[0].simpleText.text, '면적이 어떻게 되세요?');
  const saved = JSON.parse(await store.cmd('GET', 'cleanery:session:fake-kakao-user'));
  assert.equal(saved.messages.length, 2, '기존 키 형식(cleanery:session:{카카오ID}) 그대로 저장');
});
