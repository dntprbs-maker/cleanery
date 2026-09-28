// 홈페이지 AI 상담 채팅 API (카카오톡 상담봇과 같은 상담 엔진 사용)
// POST /api/web-chat  body { sessionId, message }  -> { ok, messages: ["말풍선", ...] }
// POST /api/web-chat  body { sessionId, reset: true } -> 새 상담(기존 대화는 보관)
//
// 남용 방지: IP당 10분에 40회, 세션당 10분에 25회, 메시지 1000자 제한. (AI 비용 보호)
const crypto = require('crypto');
const consult = require('../lib/consult');
const sessions = require('../lib/session-store');
const store = require('../lib/store');
const { jsonBody, clientIp } = require('../lib/http');

const WINDOW_SECONDS = 600;
const LIMIT_PER_IP = 40;
const LIMIT_PER_SESSION = 25;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

async function overLimit(kind, value, limit) {
  const key = `cleanery:web-chat:rate:${kind}:${value}`;
  const n = Number(await store.cmd('INCR', key));
  if (n === 1) await store.cmd('EXPIRE', key, WINDOW_SECONDS);
  return n > limit;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        res.status(403).json({ ok: false, error: '허용되지 않은 요청입니다.' });
        return;
      }
    } catch (e) {
      res.status(403).json({ ok: false, error: '허용되지 않은 요청입니다.' });
      return;
    }
  }

  const body = jsonBody(req);
  const sessionId = String(body.sessionId || '');
  if (!ID_RE.test(sessionId)) {
    res.status(400).json({ ok: false, error: '상담 세션 정보가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.' });
    return;
  }

  if (body.reset) {
    const sid = consult.sessionIdFor('web', sessionId);
    const cur = await sessions.getSession(sid);
    if ((cur.messages || []).length) await sessions.archiveAndReset(sid, cur);
    res.status(200).json({ ok: true, sessionId: crypto.randomUUID() });
    return;
  }

  const message = String(body.message || '').trim();
  if (!message) {
    res.status(400).json({ ok: false, error: '메시지를 입력해 주세요.' });
    return;
  }
  if (message.length > 1000) {
    res.status(400).json({ ok: false, error: '메시지가 너무 깁니다(1000자 이내).' });
    return;
  }
  if ((await overLimit('ip', clientIp(req), LIMIT_PER_IP)) || (await overLimit('session', sessionId, LIMIT_PER_SESSION))) {
    res.status(429).json({ ok: false, error: '잠시 후 다시 시도해 주세요. (짧은 시간에 너무 많은 메시지)' });
    return;
  }

  try {
    const prep = await consult.prepare({ channel: 'web', userId: sessionId, utterance: message });
    if (prep.mode === 'silent') {
      res.status(200).json({ ok: true, messages: [], ended: true, hint: '상담이 종료되었습니다. "상담 다시 시작"이라고 보내시거나 [새 상담]을 눌러 주세요.' });
      return;
    }
    if (prep.mode === 'reply') {
      res.status(200).json({ ok: true, messages: consult.toBubbles(prep.text) });
      return;
    }
    const answer = await consult.callOpenRouter(prep.messagesForModel, 25000);
    const out = await consult.finalize(prep, answer, {
      regenerate: (note) => consult.callOpenRouter([...prep.messagesForModel, { role: 'system', content: note }], 20000),
    });
    res.status(200).json({ ok: true, messages: consult.toBubbles(out.text) });
  } catch (e) {
    console.error('[web-chat] 실패:', e.message);
    res.status(500).json({ ok: false, error: '잠시 후 다시 시도해 주세요.' });
  }
};
