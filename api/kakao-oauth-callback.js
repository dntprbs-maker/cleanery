// 카카오톡 "나에게 보내기" 최초 인증용 엔드포인트.
// 사장님(관리자)이 딱 한 번만 브라우저로 이 주소(파라미터 없이)를 열어서 카카오 로그인 동의를
// 하면, 그 뒤로는 서버가 refresh_token으로 계속 알아서 갱신하며 알림을 보낼 수 있습니다.
//
// 사용법: https://cleanery-kakao-bot.vercel.app/api/kakao-oauth-callback 접속 -> 카카오 로그인 -> 동의
// 필요한 환경변수: KAKAO_REST_API_KEY, KAKAO_REDIRECT_URI (여기 이 파일의 실제 배포 URL과 정확히 일치해야 함), KAKAO_CLIENT_SECRET(선택)
const { exchangeCodeForTokens } = require('../lib/kakao-oauth');

module.exports = async (req, res) => {
  const code = req.query && req.query.code;

  if (!process.env.KAKAO_REST_API_KEY || !process.env.KAKAO_REDIRECT_URI) {
    res.status(500).send('KAKAO_REST_API_KEY / KAKAO_REDIRECT_URI 환경변수가 설정되지 않았습니다.');
    return;
  }

  if (!code) {
    const authorizeUrl =
      `https://kauth.kakao.com/oauth/authorize?client_id=${encodeURIComponent(process.env.KAKAO_REST_API_KEY)}` +
      `&redirect_uri=${encodeURIComponent(process.env.KAKAO_REDIRECT_URI)}` +
      `&response_type=code&scope=talk_message`;
    res.status(302).setHeader('Location', authorizeUrl);
    res.end();
    return;
  }

  try {
    await exchangeCodeForTokens(code);
    res.status(200).send(
      '<html><body style="font-family:sans-serif; padding:40px; text-align:center;">' +
        '<h2>✅ 카카오톡 "나에게 보내기" 연결 완료!</h2>' +
        '<p>이제부터 관리자 알림이 카카오톡으로도 옵니다. 이 창은 닫으셔도 됩니다.</p>' +
        '</body></html>'
    );
  } catch (e) {
    console.error('[kakao-oauth-callback] 실패:', e.message);
    res.status(500).send(`인증 처리 중 오류가 발생했습니다: ${e.message}`);
  }
};
