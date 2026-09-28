# 운영 긴급 보안 패치 — 반영 절차 (아빠 승인 후에만)

새 기능(개발 브랜치)과 섞지 않고, 지금 운영 중인 코드(main)에 **보안 차단만** 얹은 브랜치 2개입니다.

| 단계 | 브랜치 · 커밋 | 막는 것 | 영향 |
|---|---|---|---|
| 1단계 | `hotfix/block-internal-files` · ca37e6d | 상담 규칙·계좌정보가 든 내부 파일 9개의 외부 공개 (`lib/*.js`, `HANDOFF.md`, `TODO.md`, `CLAUDE.md`, `AGENTS.md`, `local-chat-test.js`) | 없음 — 카카오 상담봇·견적 프로그램·상담내역 화면 그대로 |
| 2단계(선택) | `hotfix/block-admin-data` · 4f40f87 (1단계 포함) | 로그인 없이 고객 대화(이름·연락처·주소) 조회, 로그인 없이 견적기록 전체 덮어쓰기 | 상담내역 화면이 비고, 견적 프로그램은 조회만 됨. 카카오 상담봇은 무영향 |

## 배포 전 확인
1. Vercel 미리보기 주소에서: 내부 파일 주소가 404, `/tracker.html`·`/conversations.html` 200, `/api/kakao-skill` GET 200
2. (2단계) `/api/conversations` 403, `/api/tracker` GET 200·POST 403

## 반영 방법
- GitHub에서 해당 브랜치를 main 으로 병합 → Vercel 자동 배포(운영).

## 배포 후 확인 (5분 안)
- 내부 파일 주소 404 · 카카오 채널에서 "안녕하세요" 보내 답장 오는지 · 관리자 알림 영향 없음

## 되돌리기 (문제 시)
- Vercel 대시보드 → Deployments → 직전 운영 배포(dd32839) → **Promote to Production** (1분 이내 복구), 또는 main 에서 해당 커밋 revert.

## 근본 해결
- 관리자 로그인이 들어간 개발 브랜치(`dev/codeD-20260928-phase2`) 운영 반영 시 2단계 차단은 로그인 보호로 대체됩니다.
