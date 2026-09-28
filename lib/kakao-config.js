// 카카오 연동 설정 점검 (값 자체는 절대 출력하지 않고, 무엇이 빠졌거나 잘못됐는지만 알려줍니다)
//
// 1) 카카오 "나에게 보내기" 알림(OAuth): KAKAO_REST_API_KEY, KAKAO_REDIRECT_URI, (선택) KAKAO_CLIENT_SECRET
// 2) 카카오 i 오픈빌더 스킬: 스킬 URL = https://<도메인>/api/kakao-skill, 콜백 사용 시 오픈빌더에서 "콜백 설정" ON
const CALLBACK_PATH = '/api/kakao-oauth-callback';

function checkOAuth(env = process.env) {
  const problems = [];
  const key = env.KAKAO_REST_API_KEY || '';
  const uri = env.KAKAO_REDIRECT_URI || '';
  if (!key) problems.push('KAKAO_REST_API_KEY(카카오 개발자센터 > 내 애플리케이션 > 앱 키 > REST API 키)가 없습니다.');
  else if (!/^[0-9a-f]{32}$/i.test(key)) problems.push('KAKAO_REST_API_KEY 형식이 이상합니다(보통 32자리 영문·숫자). 다른 키(JavaScript·Admin 키)를 넣었는지 확인하세요.');
  if (!uri) problems.push(`KAKAO_REDIRECT_URI 가 없습니다. 예: https://cleanery-kakao-bot.vercel.app${CALLBACK_PATH}`);
  else {
    let u = null;
    try { u = new URL(uri); } catch (e) { problems.push('KAKAO_REDIRECT_URI 가 올바른 주소 형식이 아닙니다.'); }
    if (u) {
      if (u.protocol !== 'https:' && u.hostname !== 'localhost') problems.push('KAKAO_REDIRECT_URI 는 https 주소여야 합니다.');
      if (u.pathname !== CALLBACK_PATH) problems.push(`KAKAO_REDIRECT_URI 의 경로는 ${CALLBACK_PATH} 이어야 합니다(현재 ${u.pathname}).`);
      if (u.search || u.hash) problems.push('KAKAO_REDIRECT_URI 에 ?나 # 뒤 값이 없어야 합니다.');
    }
  }
  if (env.KAKAO_CLIENT_SECRET !== undefined && env.KAKAO_CLIENT_SECRET !== '' && env.KAKAO_CLIENT_SECRET.length < 16) {
    problems.push('KAKAO_CLIENT_SECRET 이 너무 짧습니다. 카카오 개발자센터 > 보안 > Client Secret 값을 확인하세요(사용 안 하면 비워 두세요).');
  }
  return { ok: problems.length === 0, problems };
}

// 오픈빌더 스킬 요청 형식 점검 (잘못된 요청에도 서버가 죽지 않도록)
function checkSkillRequest(body) {
  const problems = [];
  if (!body || typeof body !== 'object') problems.push('요청 본문(JSON)이 없습니다.');
  else if (!body.userRequest) problems.push('userRequest 가 없습니다(오픈빌더 스킬 요청 형식이 아님).');
  else {
    if (typeof body.userRequest.utterance !== 'string') problems.push('userRequest.utterance 가 없습니다.');
    if (!body.userRequest.user || !body.userRequest.user.id) problems.push('userRequest.user.id 가 없습니다(대화 기록을 이어갈 수 없음).');
    if (body.userRequest.callbackUrl && !/^https:\/\//.test(body.userRequest.callbackUrl)) problems.push('callbackUrl 이 https 주소가 아닙니다.');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { checkOAuth, checkSkillRequest, CALLBACK_PATH };
