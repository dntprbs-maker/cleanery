// 관리자·홈페이지용 API 묶음 함수
// /api/tracker, /api/conversations, /api/admin, /api/reservations, /api/web-chat, /admin/<화면>
// 주소는 vercel.json 에서 이 함수로 연결됩니다(카카오 스킬 /api/kakao-skill 은 별도 함수 그대로).
// 한 함수로 묶은 이유: ① Vercel 무료 요금제 함수 개수 제한 ② 미리보기(메모리 저장소)에서도
// 로그인·데이터가 같은 인스턴스 안에서 일관되게 보이도록.
const demo = require('../lib/demo');

const ROUTES = {
  tracker: () => require('../handlers/tracker'),
  conversations: () => require('../handlers/conversations'),
  admin: () => require('../handlers/admin'),
  'admin-page': () => require('../handlers/admin-page'),
  reservations: () => require('../handlers/reservations'),
  'web-chat': () => require('../handlers/web-chat'),
  review: () => require('../handlers/review'),
};

module.exports = async (req, res) => {
  const route = String((req.query && req.query.__route) || '');
  const load = ROUTES[route];
  if (!load) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  if (req.query) delete req.query.__route;
  await demo.seedOnce().catch((e) => console.error('[app] demo seed failed:', e.message));
  return load()(req, res);
};

module.exports.ROUTES = ROUTES;
