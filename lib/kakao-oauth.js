// 카카오톡 "나에게 보내기" 기능을 쓰기 위한 OAuth 토큰 관리.
// 관리자(사장님)가 최초 1회 카카오 로그인 동의를 하면(=/api/kakao-oauth-callback),
// 그때 받은 refresh_token을 Redis에 저장해두고, 이후로는 이 파일이 access_token을
// 자동으로 갱신해서 lib/notify.js가 실제 메시지를 보낼 수 있게 해줍니다.
//
// 필요한 환경변수: KAKAO_REST_API_KEY(카카오 앱의 REST API 키), KAKAO_CLIENT_SECRET(선택),
// KAKAO_REDIRECT_URI(카카오 개발자센터에 등록한 것과 정확히 동일해야 함)

const REFRESH_TOKEN_KEY = 'cleanery:kakao:refresh_token';
const ACCESS_TOKEN_KEY = 'cleanery:kakao:access_token';

async function upstash(pathSegments) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 설정되지 않았습니다.');
  const url = `${base}/${pathSegments.map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Upstash 요청 실패 (status ${r.status})`);
  return r.json();
}

async function saveRefreshToken(refreshToken) {
  // 리프레시 토큰은 만료가 매우 길기 때문에(보통 몇 달~1년) TTL 없이 저장합니다.
  await upstash(['set', REFRESH_TOKEN_KEY, refreshToken]);
}

async function saveAccessToken(accessToken, expiresInSeconds) {
  const ttl = Math.max(60, (expiresInSeconds || 3600) - 120); // 만료 2분 전에 미리 갱신
  await upstash(['set', ACCESS_TOKEN_KEY, accessToken, 'EX', String(ttl)]);
}

// 최초 OAuth 인가 코드를 실제 토큰으로 교환합니다 (api/kakao-oauth-callback.js에서 호출).
async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.KAKAO_REST_API_KEY,
    redirect_uri: process.env.KAKAO_REDIRECT_URI,
    code,
  });
  if (process.env.KAKAO_CLIENT_SECRET) params.set('client_secret', process.env.KAKAO_CLIENT_SECRET);

  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`카카오 토큰 교환 실패: ${JSON.stringify(data)}`);

  await saveRefreshToken(data.refresh_token);
  await saveAccessToken(data.access_token, data.expires_in);
  return data;
}

// refresh_token으로 access_token을 새로 발급받습니다.
async function refreshAccessToken() {
  const stored = await upstash(['get', REFRESH_TOKEN_KEY]);
  const refreshToken = stored && stored.result;
  if (!refreshToken) return null;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.KAKAO_REST_API_KEY,
    refresh_token: refreshToken,
  });
  if (process.env.KAKAO_CLIENT_SECRET) params.set('client_secret', process.env.KAKAO_CLIENT_SECRET);

  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('[kakao-oauth] 리프레시 실패:', data);
    return null;
  }

  await saveAccessToken(data.access_token, data.expires_in);
  // 카카오는 리프레시 토큰 자체가 갱신되는 경우도 있어서, 새로 왔으면 같이 저장합니다.
  if (data.refresh_token) await saveRefreshToken(data.refresh_token);
  return data.access_token;
}

// 캐시된 access_token이 있으면 그걸 쓰고, 없으면 refresh_token으로 새로 발급받습니다.
async function getValidAccessToken() {
  try {
    const cached = await upstash(['get', ACCESS_TOKEN_KEY]);
    if (cached && cached.result) return cached.result;
  } catch (e) {
    console.error('[kakao-oauth] 캐시된 토큰 조회 실패:', e.message);
  }
  try {
    return await refreshAccessToken();
  } catch (e) {
    console.error('[kakao-oauth] 토큰 갱신 실패:', e.message);
    return null;
  }
}

module.exports = { exchangeCodeForTokens, getValidAccessToken };
