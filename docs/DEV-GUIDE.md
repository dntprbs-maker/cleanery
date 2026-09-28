# 크리너리 개발 안내 (2026-09-28 코드디, 브랜치 `dev/codeD-20260928-full-build`)

> 운영(main·production) 배포 전 단계의 개발 결과입니다. 운영에는 아직 반영되지 않았습니다.

## 구조
| 경로 | 역할 |
|---|---|
| `public/` | 공개 정적 파일만(홈페이지 `index.html`, `assets/`, `admin/login.html`). **vercel.json `outputDirectory: public`** |
| `admin-pages/` | 관리자 화면(예약·상담내역·견적 프로그램) — 로그인해야 `/admin/<화면>`으로 열림 |
| `api/kakao-skill.js` | 카카오 i 오픈빌더 스킬(주소 그대로) |
| `api/kakao-oauth-callback.js` | 카카오 "나에게 보내기" 최초 인증 |
| `api/app.js` → `handlers/*` | 관리자·홈페이지 API 묶음(`/api/admin`, `/api/tracker`, `/api/conversations`, `/api/reservations`, `/api/web-chat`) |
| `lib/consult.js`, `lib/consult-rules.js` | 상담 엔진(카카오·홈페이지 공용) + 코드로 강제하는 상담 규칙 |
| `lib/store.js` | 저장소(운영=Upstash, 개발·시험·미리보기=메모리) |
| `lib/auth.js` | 관리자 로그인·세션 |
| `lib/reservations.js` | 예약 데이터·상태 흐름 |
| `lib/cleanmanager-bridge.js` | 클린메니저 일정 연동 인터페이스(현재 수동 복사) |

## 명령
```bash
npm test                      # 자동시험 44개 (운영 저장소·외부 발송 없음)
npm run dev                   # 로컬 개발 서버 http://127.0.0.1:3000 (메모리 저장소·가짜 데이터)
node scripts/hash-password.js --secret   # 운영 관리자 비밀번호 해시 + 세션 비밀값 만들기
npm run check-kakao           # 카카오 환경변수 점검(값은 출력 안 함)
```

## 안전장치
- **운영이 아닌 Vercel 배포(미리보기)는 운영 Redis 를 절대 쓰지 않습니다**(`VERCEL_ENV !== production` → 메모리 저장소).
- 개발·미리보기에서는 관리자 알림을 실제로 보내지 않고 "관리자 알림함"에만 기록합니다.
- 데모 계정은 메모리 저장소 + 미리보기/개발 + 운영 관리자 설정 없음일 때만 켜집니다.
- 예전 견적 프로그램 저장 키(`cleanery:tracker:records`)는 읽기만 하고 수정·삭제하지 않습니다(새 저장소로 1회 복사).
- 카카오 대화 저장 키(`cleanery:session:{카카오ID}`)·형식은 그대로입니다.

## 운영 반영 전 해야 할 일 (아빠 결정·직접조작)
1. Vercel 운영 환경변수 추가: `ADMIN_USERNAME`(선택, 기본 admin), `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`
   → 없으면 운영에서 관리자 로그인이 막힙니다(fail closed).
2. 운영 반영(main 병합) 시점 결정 — 반영하면 기존 `/tracker.html`·`/conversations.html` 이 로그인 필요 화면으로 바뀝니다.
3. 상담 문구 변경 확인: 입금 알림 시 "입금 확인 되었읍니다" → "입금 알려주셔서 감사합니다. 담당자가 계좌 입금을 확인한 뒤 예약이 최종 확정…"
4. 홈페이지 `public/assets/site-config.js` 의 전화·주소·사업자번호·대표자·개인정보 담당자 값 확인·입력
5. 카카오 설정: `docs/kakao-setup.md`
6. 클린메니저 자동 연동 여부: `docs/clean-manager-integration.md`
