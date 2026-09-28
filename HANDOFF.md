# 크리너리 카카오봇 + 견적프로그램 — 인계 문서
(이 문서를 Claude Code 세션에 그대로 붙여넣으면 됩니다)

> **할 일 목록은 `TODO.md`에서 관리합니다.** 이 문서는 아키텍처·환경변수·파일구조 등 온보딩용 배경 설명 전용입니다.

## 프로젝트 개요
- 업체명: 크리너리(Cleanery), 청소 전문업체
- 카카오톡 채널: 크리너리_cleanery (http://pf.kakao.com/_veNfX)
- Vercel 프로젝트명: `cleanery-kakao-bot` (팀: woo-se-guin-s-projects, teamId: team_hMSMkg1OCmGbzww6HOD9UgWp)
- 배포 URL: https://cleanery-kakao-bot.vercel.app
- 인프라: Vercel 서버리스 함수 + Upstash Redis(KV) + OpenRouter API(모델: anthropic/claude-haiku-4.5)
- GitHub: 아직 연동 안 됨 (Vercel 대시보드에서 직접 배포만 해온 상태). 별도 저장소 생성 필요 시 사용자가 빈 레포를 먼저 만들어줘야 함(fine-grained 토큰은 존재하는 레포만 선택 가능).

## 배포된 페이지/엔드포인트 (총 3 API 함수)
1. `POST /api/kakao-skill` — 카카오 i 오픈빌더 스킬 서버. 고객과의 상담/견적/예약 전체 처리
2. `GET/POST /api/tracker` — 견적 프로그램 데이터 저장/조회 API (Upstash Redis, 키: `cleanery:tracker:records`)
3. `GET /api/conversations` — 상담내역(카카오봇 대화) 조회 API (`?id=userId`로 특정 대화 조회, 목록은 `cleanery:sessions:index`라는 sorted set 인덱스 사용)

### 정적 페이지
- `/tracker.html` — **"크리너리 견적 프로그램"**. 상가·사무실·공장·특수청소용 실측 데이터 기록 + 견적서 PDF 생성 + 일정 생성용 텍스트 복사 기능. Upstash Redis에 영구 저장(브라우저 저장 아님, 어느 기기서든 동일 데이터 보임)
- `/conversations.html` — **상담내역 조회 페이지**. 카카오봇과 고객 간 대화 내역을 관리자가 확인 가능. **⚠️ 지금은 비밀번호 등 접근 제한이 전혀 없음 — 테스트 단계라 의도적으로 비워둔 상태. 실제 운영 전 반드시 인증 추가 필요**

## 파일 구조 (Vercel 프로젝트 루트)
```
package.json
api/
  kakao-skill.js       # 카카오 스킬 서버 (메인 로직)
  tracker.js           # 견적프로그램 데이터 API
  conversations.js     # 상담내역 조회 API
lib/
  business-info.js     # 시스템 프롬프트 전체 (견적 로직·가격표·예약 템플릿 등, 가장 자주 수정하는 파일)
  session-store.js     # 카카오 세션(대화기록) 저장 + 상담내역 인덱스 관리
tracker.html           # 견적 프로그램 페이지
conversations.html     # 상담내역 조회 페이지
```

## 환경변수 (Vercel에 이미 등록되어 있음, 재설정 불필요)
- `OPENROUTER_API_KEY` — OpenRouter API 키
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Upstash Redis REST API (Vercel Storage 연동으로 자동 등록됨)

## 핵심 아키텍처 결정사항
- 대화 기록: Redis에 카카오 유저ID별로 저장(`cleanery:session:{userId}`), TTL 60일, 최근 20개 메시지만 유지
- 견적 계산: LLM이 시스템 프롬프트에 명시된 공식으로 직접 계산 (별도 결정론적 코드 없음 — 프롬프트에 계산 예시를 넣어 정확도 확보하는 방식)
- 카카오 5초 응답 제한 대응: `userRequest.callbackUrl` 존재 시(콜백 기능 켜진 경우) 최대 25초 여유, 없으면 4.2초 내 폴백 문구 전송
- 말풍선 분리: 응답 텍스트에 `===메시지분리===` 구분자를 넣으면 카카오에 여러 개 말풍선으로 나뉘어 전달됨 (예: 예약안내 + 추가요금안내)
- 견적프로그램(tracker.html)의 금액 입력 필드는 `73*10000+50000` 같은 수식 입력 지원 (JS Function()으로 안전하게 평가, 숫자/사칙연산만 허용)

## 카카오 i 오픈빌더 설정 현황 (i.kakao.com, business.kakao.com과는 별개 사이트)
- 웰컴 블록 설정 완료: "안녕하세요! 크리너리입니다 😊 어떤 청소 상담을 원하세요?" — 채팅방 첫 입장 시 1회만 노출됨(카카오 자체 기능, 우리 서버 코드 아님)
- 이에 맞춰 `business-info.js`에서 챗봇 자체 인사말 지시는 제거함(중복 인사 방지)
- 상담원 채팅(1:1채팅) 노출을 끄고 싶다면 → business.kakao.com 파트너센터 → 채팅 관련 설정에서 "1:1 채팅 사용" OFF (챗봇 채팅과는 별개 기능)

## 현재 견적 로직 요약 (lib/business-info.js 안에 전체 있음)
- 건물유형: 아파트/빌라/다세대주택/단독주택/상가주택/상가/사무실/공장/특수청소
- 아파트: 고객이 말한 평/타입을 그대로 공급면적으로 사용 (환산표 있음: 59㎡→25평 등)
- 빌라·다세대·단독·상가주택: 고객이 말한 수치는 항상 "전용면적" → 평 환산 → ÷0.76 해서 공급면적 계산 (이 2단계 누락 시 심각한 저평가 오류 발생하므로 프롬프트에 강조되어 있음)
- 평당 단가: **[다음 세션에서 마무리할 작업 — 아래 참고]**
- 룸/화장실/노후 가산: 2~5룸 기준표 있음 (정액 가산 방식)
- 상가·사무실·공장: 면적이 아닌 인원 기준 (반일 12만원/전일 20만원, 최소 3인)
- 예약 확정 시: 고객명/연락처/주소 일괄 확인 → 계약금(40만원 미만 5만원/이상 10만원) → 예약안내 템플릿 → 말풍선 분리 → 추가요금 안내
- 입금 확인 시: 고정 문구 + (필요시만) 정확한 주소 재확인

## Vercel 배포 시 참고
재배포할 때는 package.json, api/kakao-skill.js, lib/session-store.js, lib/business-info.js, api/tracker.js, tracker.html, api/conversations.js, conversations.html — 이 8개 파일을 항상 함께 보내야 함(Vercel MCP 배포는 파일 일부만 보내면 나머지가 빠진 걸로 처리되어 라이브 봇이 깨짐).
