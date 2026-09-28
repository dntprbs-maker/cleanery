// 개발 미리보기(데모) 모드
//
// 켜지는 조건(모두 만족): ① 메모리 저장소 사용(운영 Redis 미사용) ② Vercel 미리보기 배포이거나 CLEANERY_DEMO=1
//   ③ 운영용 관리자 설정(ADMIN_PASSWORD_HASH)이 없음
// 운영 배포(VERCEL_ENV=production)에서는 절대 켜지지 않습니다.
// 켜지면: 데모 관리자 계정(비밀번호는 아빠에게 별도 전달)과 가짜 예약·견적 데이터를 씁니다.
const store = require('./store');

const DEMO_USERNAME = 'admin';
// 데모 전용 비밀번호의 해시 (운영 계정과 무관, 가짜 데이터만 볼 수 있음)
const DEMO_PASSWORD_HASH =
  'scrypt$32768$8$1$dbsgE3zLpTJxi80YCd5YYQ==$tebsSqqUU2g5C+iRz1s8nxUeh7+hDffgcVXAFWJF36SK1mjQaHLJHNCEDP4TiGoP0YB37JG164WQjxTAmvFDfQ==';
const DEMO_SESSION_SECRET = 'cleanery-demo-preview-only-session-secret-not-for-production';

function isDemo() {
  if (process.env.VERCEL_ENV === 'production') return false;
  if (!store.isMemory()) return false;
  if (process.env.ADMIN_PASSWORD_HASH) return false;
  return process.env.VERCEL_ENV === 'preview' || process.env.CLEANERY_DEMO === '1';
}

let seeded = false;
async function seedOnce() {
  if (seeded || !isDemo()) return;
  seeded = true;
  if (await store.cmd('GET', 'cleanery:demo:seeded')) return;
  await store.cmd('SET', 'cleanery:demo:seeded', new Date().toISOString());
  require('./demo-data').seed && (await require('./demo-data').seed(store));
}

module.exports = { isDemo, seedOnce, DEMO_USERNAME, DEMO_PASSWORD_HASH, DEMO_SESSION_SECRET };
