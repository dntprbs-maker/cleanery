// 상담내역(카카오봇 대화) 조회용 관리자 API
// GET /api/conversations          -> 대화 목록 (최근 순, 미리보기 포함)
// GET /api/conversations?id=userId -> 특정 유저와의 전체 대화 내용
//
// [주의] 지금은 테스트 단계라 별도 인증이 없습니다. 실제 운영 전에는
// 반드시 아이디/비밀번호 등 접근 제한을 추가해야 합니다 (고객 개인정보 포함).
const INDEX_KEY = 'cleanery:sessions:index';

function sessionKeyFor(userId) {
  return `cleanery:session:${userId}`;
}

async function upstash(pathSegments) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 설정되지 않았습니다.');
  }
  const url = `${base}/${pathSegments.map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(`Upstash 요청 실패 (status ${r.status})`);
  }
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const id = req.query && req.query.id;

  // 특정 유저의 전체 대화 조회
  if (id) {
    try {
      const data = await upstash(['get', sessionKeyFor(id)]);
      const session = data && data.result ? JSON.parse(data.result) : { messages: [] };
      res.status(200).json({ userId: id, messages: session.messages || [] });
    } catch (e) {
      console.error('[conversations] detail load failed:', e.message);
      res.status(200).json({ userId: id, messages: [] });
    }
    return;
  }

  // 전체 대화 목록 (최근 순)
  try {
    const data = await upstash(['zrevrange', INDEX_KEY, '0', '99', 'withscores']);
    const flat = (data && data.result) || [];
    const sessions = [];
    for (let i = 0; i < flat.length; i += 2) {
      sessions.push({ userId: flat[i], updatedAt: Number(flat[i + 1]) });
    }

    const withPreview = await Promise.all(
      sessions.map(async (s) => {
        try {
          const d = await upstash(['get', sessionKeyFor(s.userId)]);
          const session = d && d.result ? JSON.parse(d.result) : { messages: [] };
          const msgs = session.messages || [];
          const last = msgs[msgs.length - 1];
          const preview = last ? String(last.content || '').slice(0, 60) : '';
          return { ...s, preview, messageCount: msgs.length };
        } catch (e) {
          return { ...s, preview: '', messageCount: 0 };
        }
      })
    );

    res.status(200).json({ sessions: withPreview });
  } catch (e) {
    console.error('[conversations] list failed:', e.message);
    res.status(200).json({ sessions: [] });
  }
};
