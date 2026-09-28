# 크리너리 → 클린메니저 일정 연동 설계 (준비 단계, 2026-09-28)

**클린메니저 운영본은 수정하지 않았습니다.** 기존 "일정 생성용 복사"(견적 프로그램)는 그대로 유지하고,
예약 관리 화면의 확정 예약에도 같은 방식의 복사 버튼을 추가했습니다.

## 현재 (수동, 동작 중)
예약확정/방문일정확정 → 관리자 화면 [📋 일정 생성용 복사] → 클린메니저에 붙여넣기

## 인터페이스 (`lib/cleanmanager-bridge.js`)
- `toCleanManagerEvent(예약)` → 클린메니저 `create_event` 입력과 같은 형식
  `{ title, start, end, allDay, startTime?, place, contact, description, team }`
  (클린메니저 `functions/mcp/tools/events.js` create_event 스키마 기준 2026-09-28 확인)
- 확정되지 않은 예약(입금대기·입금확인요청 등)은 변환을 거부 → 입금 미확인 일정이 잡히지 않음
- `ManualCopySink`(현재) / `CleanManagerApiSink`(자리만, 비활성) — `CLEANMANAGER_SYNC=api` 로 전환 예정

## 자동 연동에 필요한 것 (아빠 결정 대기)
1. 클린메니저 쪽: 서버 간 인증(서비스 토큰, 회사 단위) + 일정 생성 API(HTTPS). 현재 create_event 는 사람 OAuth 로그인 기반 MCP 도구라 서버에서 직접 호출 불가.
2. 크리너리 쪽: `CleanManagerApiSink.send()` 구현 → 관리자 "예약확정" 시 **승인 버튼 방식**으로 전송(권장, 처음부터 완전 자동은 비권장)
3. 중복 방지: 예약 id 를 클린메니저 일정 메모/외부키로 저장, 재전송 시 수정(update_event)
4. 팀 배정: 작업 하루 전 배정 원칙 → 일정은 팀 없이 생성, 팀은 클린메니저에서 지정
5. 실패 시: 예약에 "일정 연동 실패" 표시 + 수동 복사 버튼 유지
