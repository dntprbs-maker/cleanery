# 크리너리 → 클린메니저 자동 일정 연동 API 계약서 (초안, 2026-09-28)

> 상태: **설계 초안 — 클린메니저 운영본 무변경.** 구현은 아빠 결정 후. 현재 동작은 수동 복사(`lib/cleanmanager-bridge.js` ManualCopySink).

## 1. 범위
- 크리너리 관리자가 **예약확정(실입금 확인 후)** 또는 **방문일정확정** 처리한 건만 클린메니저 일정으로 보낸다.
- 입금대기·입금확인요청(고객 주장) 단계는 절대 보내지 않는다.

## 2. 엔드포인트 (클린메니저 쪽 신설 필요)
| 메서드 | 경로 | 설명 |
|---|---|---|
| `PUT` | `/api/integrations/cleanery/events/{externalId}` | 일정 생성 또는 수정(멱등) |
| `DELETE` | `/api/integrations/cleanery/events/{externalId}` | 예약 취소 시 일정 취소(삭제 대신 상태=취소 권장) |
| `GET` | `/api/integrations/cleanery/events/{externalId}` | 연동 상태 확인 |

- `externalId` = 크리너리 예약번호(예: `R1ABC23F9`). **같은 externalId 로 여러 번 보내도 일정은 1개**(멱등, 중복 방지의 핵심).

## 3. 요청 본문 (create_event 입력과 동일 필드 + 추적 정보)
```json
{
  "title": "[입주청소] 홍가상 - 가상시 가상구 한빛로 7",
  "start": "2026-10-17", "end": "2026-10-17", "allDay": true,
  "startTime": null, "endTime": null,
  "place": "가상시 가상구 한빛로 7, 301호",
  "contact": "010-0000-9001",
  "description": "[크리너리 예약 R1ABC23F9] 청소금액 230,000원(VAT별도) / 예약금 50,000원 / 잔금 180,000원 …",
  "team": null,
  "source": { "system": "cleanery", "reservationId": "R1ABC23F9", "reservationVersion": 7, "sentAt": "2026-10-01T03:00:00Z" }
}
```
- `team` 은 비움(작업 하루 전 배정 원칙) — 클린메니저에서 지정.
- 클린메니저는 `reservationVersion` 이 **저장된 값보다 작으면 무시**(늦게 도착한 옛 요청이 최신을 덮지 않게).

## 4. 인증
- 사람 로그인(OAuth) 대신 **서버 간 전용 토큰**: `Authorization: Bearer <CLEANMANAGER_SERVICE_TOKEN>`
  - 회사(companyId) 1곳 전용, 권한은 이 연동 경로의 일정 생성·수정·취소만.
  - 토큰은 양쪽 Vercel 환경변수에만 저장, 화면·로그 출력 금지, 교체(회전) 가능하게 2개 병행 허용.
- 추가 권장: 요청 본문 HMAC 서명 헤더 `X-Cleanery-Signature: sha256=<hex>` + `X-Cleanery-Timestamp`(5분 이내만 허용, 재전송 공격 방지).

## 5. 응답
| 상태 | 의미 | 크리너리 처리 |
|---|---|---|
| 200/201 | 반영됨 `{ eventId, updatedAt }` | 예약에 `cmEventId` 저장, "일정 연동됨" 표시 |
| 409 | 더 최신 버전이 이미 있음 | 무시(성공 취급) |
| 400 | 입력 오류 | 관리자 화면에 사유 표시, 수동 복사 버튼 유지 |
| 401/403 | 토큰 문제 | 연동 중단 + 관리자 알림 |
| 5xx/시간초과 | 일시 오류 | 최대 3회 재시도(1분·5분·30분), 이후 "연동 실패" 표시 |

## 6. 크리너리 쪽 흐름
1. 관리자 [예약확정] 저장 → (설정 `CLEANMANAGER_SYNC=api` 일 때만) 관리자에게 **[클린메니저로 보내기] 버튼**(처음엔 자동 전송 대신 승인 버튼 권장)
2. 전송 성공 → 예약 기록에 이력 남김, 실패 → 수동 복사로 대체 가능
3. 날짜·주소 수정 → 같은 externalId 로 다시 PUT(수정), 취소 → DELETE

## 7. 아빠 결정 필요
- 클린메니저에 연동 API·서비스 토큰을 새로 만들지(클린메니저 리빌딩 보류 결정과의 관계)
- 자동 전송 vs 승인 버튼 방식
- 취소 시 일정 삭제 vs 취소 표시
