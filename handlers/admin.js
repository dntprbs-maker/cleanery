// 관리자 로그인 API
// POST /api/admin?action=login   body { username, password }
// POST /api/admin?action=logout
// GET  /api/admin?action=me      -> 로그인 상태 확인
// (Vercel 무료 요금제 함수 개수 제한 때문에 한 파일로 묶었습니다.)
const auth = require('../lib/auth');
const { jsonBody, isSameSiteWrite } = require('../lib/http');

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  res.setHeader('Cache-Control', 'no-store');

  if (action === 'me' && req.method === 'GET') {
    const session = await auth.getSession(req).catch(() => null);
    if (!session) {
      res.status(401).json({ ok: false, configured: auth.configProblems().length === 0 });
      return;
    }
    res.status(200).json({ ok: true, username: session.username, role: session.role, expiresAt: session.expiresAt });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  if (!isSameSiteWrite(req)) {
    res.status(403).json({ ok: false, error: '허용되지 않은 요청입니다.' });
    return;
  }

  if (action === 'login') {
    const { username, password } = jsonBody(req);
    try {
      const result = await auth.login(req, username, password);
      if (!result.ok) {
        res.status(result.status).json({ ok: false, error: result.error });
        return;
      }
      res.setHeader('Set-Cookie', result.cookie);
      res.status(200).json({ ok: true, username: result.session.username });
    } catch (e) {
      console.error('[admin] login error:', e.message);
      res.status(500).json({ ok: false, error: '로그인 처리 중 오류가 발생했습니다.' });
    }
    return;
  }

  if (action === 'logout') {
    const cookie = await auth.logout(req).catch(() => null);
    if (cookie) res.setHeader('Set-Cookie', cookie);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(404).json({ ok: false, error: 'unknown action' });
};
