// 크리너리 현장기록 트래커용 저장소 API
// GET  /api/tracker  -> { records: [...] }
// POST /api/tracker  -> body { records: [...] } 를 그대로 저장
//
// 카카오봇(api/kakao-skill.js)과 같은 Upstash Redis(KV_REST_API_URL/TOKEN)를 그대로 재사용합니다.
const TRACKER_KEY = 'cleanery:tracker:records';

async function upstashGet(key) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 설정되지 않았습니다.');
  }
  const url = `${base}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(`Upstash 요청 실패 (status ${r.status})`);
  }
  return r.json();
}

// 기록이 많아지면 값이 길어질 수 있으므로, URL 경로가 아니라 요청 본문(body)으로 값을 보내는
// 방식(Upstash REST API의 POST 커맨드 형식)을 사용해 URL 길이 제한 문제를 피합니다.
async function upstashSet(key, value) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 설정되지 않았습니다.');
  }
  const url = `${base}/set/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: value,
  });
  if (!r.ok) {
    throw new Error(`Upstash 요청 실패 (status ${r.status})`);
  }
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      const data = await upstashGet(TRACKER_KEY);
      const records = data && data.result ? JSON.parse(data.result) : [];
      res.status(200).json({ records });
    } catch (e) {
      console.error('[tracker] load failed:', e.message);
      res.status(200).json({ records: [] });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const records = (req.body && req.body.records) || [];
      const value = JSON.stringify(records);
      await upstashSet(TRACKER_KEY, value);
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[tracker] save failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
};
