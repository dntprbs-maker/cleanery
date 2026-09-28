# 카카오 연동 설정 정리 (2026-09-28)

## A. 카카오 i 오픈빌더 (상담봇) — 현재 운영 중
- 스킬 URL: `https://cleanery-kakao-bot.vercel.app/api/kakao-skill` (변경 없음)
- **콜백 사용 여부 확인 필요(아빠 직접 확인)**: i.kakao.com → 봇 → 설정 → **AI 챗봇 관리 → 콜백 설정 ON** 인지.
  - ON 이면 긴 답변(예약 안내)도 최대 25초까지 기다렸다가 전송, OFF 면 4.2초 넘는 답변은 폴백 문구로 나감.
  - 코드 쪽 콜백 처리는 가짜 콜백 주소로 자동시험 통과(`test/consult.test.js`).
- 잘못된 형식의 요청은 AI 를 부르지 않고 400 으로 거절합니다.

## B. 카카오톡 "나에게 보내기" (관리자 알림) — 아직 미연결
현재 운영 `/api/kakao-oauth-callback` 은 환경변수 미설정 상태입니다. 관리자 알림은 ntfy 로만 가고 있습니다.

1. developers.kakao.com → 내 애플리케이션 → (크리너리 앱 선택 또는 추가)
2. 앱 키 → **REST API 키** 복사 → Vercel 환경변수 `KAKAO_REST_API_KEY`
3. 카카오 로그인 → 활성화 ON, Redirect URI 등록: `https://cleanery-kakao-bot.vercel.app/api/kakao-oauth-callback`
   → 같은 값을 Vercel 환경변수 `KAKAO_REDIRECT_URI` 에 (한 글자도 다르면 실패)
4. 동의항목 → **카카오톡 메시지 전송(talk_message)** 사용 설정
5. (선택) 보안 → Client Secret 사용 시 코드 값을 `KAKAO_CLIENT_SECRET` 에
6. Vercel 재배포 후, 아빠 카카오 계정으로 `https://cleanery-kakao-bot.vercel.app/api/kakao-oauth-callback` 을 한 번 열어 동의
7. 점검: `npm run check-kakao`(로컬 .env 기준) — 무엇이 빠졌는지 알려줌, 값은 출력하지 않음

오류 화면은 이제 원인별로 안내합니다: 설정 누락 / 만료된 인증코드 / Redirect URI 불일치 / Client Secret 문제 / 사용자 취소.
자동시험: `test/kakao.test.js` (가짜 카카오 토큰 서버로 인증 흐름·토큰 저장 확인).
