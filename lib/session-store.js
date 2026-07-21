// 카카오 챗봇용 세션(대화 기록) 저장소
// Upstash Redis의 REST API를 직접 fetch로 호출합니다 (별도 npm 설치 필요 없음).
// 필요한 환경변수: KV_REST_API_URL, KV_REST_API_TOKEN
// (Vercel Storage에서 Upstash for Redis를 연결하면 자동으로 등록됩니다.)

const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60; // 60일 (안전장치: 이벤트 없이 방치되면 자동 소멸)

function keyFor(userId) {
  return `cleanery:session:${userId}`;
}

async function upstash(pathSegments) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 설정되지 않았습니다.');
  }
  const url = `${base}/${pathSegments.map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(`Upstash 요청 실패 (status ${r.status})`);
  }
  return r.json();
}

// 세션 조회. 저장된 게 없으면 빈 대화로 시작.
async function getSession(userId) {
  try {
    const data = await upstash(['get', keyFor(userId)]);
    if (!data || !data.result) {
      return { messages: [] };
    }
    return JSON.parse(data.result);
  } catch (e) {
    // Redis 조회 실패해도 챗봇 자체는 계속 동작해야 하므로, 빈 세션으로 폴백
    console.error('getSession error:', e.message);
    return { messages: [] };
  }
}

// 세션 저장 + TTL(60일) 갱신
async function saveSession(userId, session) {
  try {
    const value = JSON.stringify(session);
    await upstash(['set', keyFor(userId), value, 'EX', String(SESSION_TTL_SECONDS)]);
  } catch (e) {
    console.error('saveSession error:', e.message);
    return;
  }
  // 상담내역 목록(관리자용)에 표시하기 위한 인덱스 갱신. 실패해도 챗봇 동작엔 영향 없음.
  try {
    await upstash(['zadd', 'cleanery:sessions:index', String(Date.now()), userId]);
  } catch (e) {
    console.error('session index update failed:', e.message);
  }
}

// 예약확정/취소 등으로 상담이 끝났을 때 즉시 세션 삭제 (지금은 미사용, 추후 이벤트 감지 붙일 때 사용)
async function clearSession(userId) {
  try {
    await upstash(['del', keyFor(userId)]);
  } catch (e) {
    console.error('clearSession error:', e.message);
  }
}

module.exports = { getSession, saveSession, clearSession, SESSION_TTL_SECONDS };
