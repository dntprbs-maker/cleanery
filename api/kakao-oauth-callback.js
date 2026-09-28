// 카카오톡 "나에게 보내기" 최초 인증용 엔드포인트.
// 사장님(관리자)이 딱 한 번만 브라우저로 이 주소(파라미터 없이)를 열어서 카카오 로그인 동의를
// 하면, 그 뒤로는 서버가 refresh_token으로 계속 알아서 갱신하며 알림을 보낼 수 있습니다.
//
// 사용법: https://cleanery-kakao-bot.vercel.app/api/kakao-oauth-callback 접속 -> 카카오 로그인 -> 동의
// 필요한 환경변수: KAKAO_REST_API_KEY, KAKAO_REDIRECT_URI (여기 이 파일의 실제 배포 URL과 정확히 일치해야 함), KAKAO_CLIENT_SECRET(선택)
// [2026-09-28] 설정 점검 메시지를 구체화(무엇이 빠졌는지·어디서 확인하는지). 값 자체는 화면에 내보내지 않습니다.
const { exchangeCodeForTokens } = require('../lib/kakao-oauth');
const { checkOAuth } = require('../lib/kakao-config');

function page(res, status, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(
    '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${title}</title></head><body style="font-family:sans-serif;padding:32px 20px;max-width:560px;margin:auto;line-height:1.6">` +
      `<h2>${title}</h2>${body}</body></html>`
  );
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  const q = req.query || {};
  const cfg = checkOAuth();
  if (!cfg.ok) {
    page(res, 500, '카카오 알림 연결 설정이 아직 끝나지 않았습니다', '<ul>' + cfg.problems.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul><p>Vercel 환경변수를 설정한 뒤 다시 배포하고 이 주소를 다시 열어 주세요.</p>');
    return;
  }

  if (q.error) {
    page(res, 400, '카카오 로그인이 취소되었거나 실패했습니다', `<p>카카오가 알려준 사유: ${esc(q.error_description || q.error)}</p><p>이 주소를 다시 열어 동의를 진행해 주세요.</p>`);
    return;
  }

  if (!q.code) {
    const authorizeUrl =
      `https://kauth.kakao.com/oauth/authorize?client_id=${encodeURIComponent(process.env.KAKAO_REST_API_KEY)}` +
      `&redirect_uri=${encodeURIComponent(process.env.KAKAO_REDIRECT_URI)}` +
      `&response_type=code&scope=talk_message`;
    res.statusCode = 302;
    res.setHeader('Location', authorizeUrl);
    res.end();
    return;
  }

  try {
    await exchangeCodeForTokens(q.code);
    page(res, 200, '✅ 카카오톡 "나에게 보내기" 연결 완료!', '<p>이제부터 관리자 알림이 카카오톡으로도 옵니다. 이 창은 닫으셔도 됩니다.</p>');
  } catch (e) {
    console.error('[kakao-oauth-callback] 실패:', e.message);
    const hint = /invalid_grant|authorization code/i.test(e.message)
      ? '인증 코드가 만료됐거나 이미 사용됐습니다. 이 주소를 처음부터 다시 열어 주세요.'
      : /redirect/i.test(e.message)
        ? '카카오 개발자센터에 등록한 Redirect URI 와 KAKAO_REDIRECT_URI 값이 정확히 같은지 확인해 주세요.'
        : /client_secret|KOE010/i.test(e.message)
          ? 'Client Secret 설정(개발자센터 보안 탭의 사용 여부와 KAKAO_CLIENT_SECRET)을 확인해 주세요.'
          : '잠시 후 다시 시도해 주세요. 계속되면 서버 기록을 확인해야 합니다.';
    page(res, 500, '카카오 연결 처리 중 오류가 발생했습니다', `<p>${esc(hint)}</p>`);
  }
};
