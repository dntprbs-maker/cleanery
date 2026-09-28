// 상담내역(카카오봇·홈페이지 대화) 조회용 관리자 API — 관리자 로그인 필요 (고객 개인정보 포함)
// GET /api/conversations          -> 대화 목록 (최근 순, 미리보기 포함)
// GET /api/conversations?id=userId -> 특정 유저와의 전체 대화 내용
//
// 60일이 지나 대화 본문이 만료된 항목은 목록에서 숨깁니다(목록 인덱스 자체는 지우지 않음).
const store = require('../lib/store');
const { requireAdmin } = require('../lib/auth');
const { INDEX_KEY, keyFor } = require('../lib/session-store');

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const id = req.query && req.query.id;

  if (id) {
    try {
      const raw = await store.cmd('GET', keyFor(id));
      const session = raw ? JSON.parse(raw) : { messages: [] };
      res.status(200).json({ userId: id, messages: session.messages || [], restartedAt: session.restartedAt || null });
    } catch (e) {
      console.error('[conversations] detail load failed:', e.message);
      res.status(500).json({ userId: id, messages: [], error: '대화를 불러오지 못했습니다.' });
    }
    return;
  }

  try {
    const flat = (await store.cmd('ZREVRANGE', INDEX_KEY, '0', '99', 'WITHSCORES')) || [];
    const sessions = [];
    for (let i = 0; i < flat.length; i += 2) sessions.push({ userId: flat[i], updatedAt: Number(flat[i + 1]) });

    const withPreview = await Promise.all(
      sessions.map(async (s) => {
        try {
          const raw = await store.cmd('GET', keyFor(s.userId));
          if (!raw) return null; // 만료된 대화
          const msgs = JSON.parse(raw).messages || [];
          const last = msgs[msgs.length - 1];
          return {
            ...s,
            channel: String(s.userId).startsWith('web:') ? '홈페이지' : '카카오톡',
            preview: last ? String(last.content || '').replace(/\[\[[^\]]*\]\]/g, '').slice(0, 60) : '',
            messageCount: msgs.length,
          };
        } catch (e) {
          return { ...s, preview: '', messageCount: 0 };
        }
      })
    );

    const visible = withPreview.filter(Boolean);
    res.status(200).json({ sessions: visible, hiddenExpired: withPreview.length - visible.length });
  } catch (e) {
    console.error('[conversations] list failed:', e.message);
    res.status(500).json({ sessions: [], error: '목록을 불러오지 못했습니다.' });
  }
};
