// 관리자(사장님) 실시간 알림
// 봇이 스스로 판단하기 어려운 상황(입금자명 확인 필요, 정기청소·상가·사무실·공장처럼
// 사람이 직접 연락해야 하는 견적 등)이 생기면, 실제로 관리자한테 알림을 보냅니다.
//
// 채널 2개를 동시에 시도합니다:
// 1) ntfy.sh 푸시 알림 - 항상 시도 (NTFY_TOPIC 환경변수만 있으면 동작)
// 2) 카카오톡 "나에게 보내기" - /api/kakao-oauth-callback로 최초 인증이 끝난 경우에만 시도 (아직 미설정 시 조용히 건너뜀)
//
// 두 채널 다 실패해도 예외를 던지지 않습니다 — 알림 실패가 챗봇 응답 자체를 막으면 안 되기 때문입니다.

async function sendNtfy(reason, detail) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.warn('[notify] NTFY_TOPIC 환경변수가 없어 ntfy 알림을 건너뜁니다.');
    return;
  }
  try {
    // 헤더(Title 등)로 보내면 한글이 깨지므로(HTTP 헤더는 ASCII만 허용), JSON 발행 API를 사용합니다.
    const r = await fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        topic,
        title: `크리너리 상담 알림: ${reason}`,
        message: detail,
        priority: 5,
        tags: ['bell'],
      }),
    });
    if (!r.ok) {
      console.error('[notify] ntfy 전송 실패, status:', r.status);
    }
  } catch (e) {
    console.error('[notify] ntfy 전송 오류:', e.message);
  }
}

async function sendKakaoToMe(reason, detail) {
  const { getValidAccessToken } = require('./kakao-oauth');
  const accessToken = await getValidAccessToken().catch(() => null);
  if (!accessToken) {
    // 아직 카카오 "나에게 보내기" 인증(/api/kakao-oauth-callback) 전이면 조용히 건너뜁니다 (ntfy만으로도 알림은 감).
    return;
  }
  try {
    const templateObject = {
      object_type: 'text',
      text: `[크리너리 상담 알림]\n${reason}\n\n${detail}`,
      link: { web_url: 'https://cleanery-kakao-bot.vercel.app', mobile_web_url: 'https://cleanery-kakao-bot.vercel.app' },
    };
    const body = new URLSearchParams({ template_object: JSON.stringify(templateObject) });
    const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('[notify] 카카오 나에게 보내기 실패, status:', r.status, text);
    }
  } catch (e) {
    console.error('[notify] 카카오 나에게 보내기 오류:', e.message);
  }
}

// reason: 짧은 사유 (예: "입금 확인 필요", "정기청소 상담 - 팀장 연락 필요")
// detail: 고객 대화 내용 등 상세 텍스트
async function notifyAdmin(reason, detail) {
  await Promise.all([sendNtfy(reason, detail), sendKakaoToMe(reason, detail)]);
}

module.exports = { notifyAdmin };
