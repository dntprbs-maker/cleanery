// 카카오 i 오픈빌더 스킬 서버
// Vercel 배포 시 경로: api/kakao-skill.js
//
// [2026-07 수정 2] 성공 케이스에도 진단용 로그를 남기고, 카카오 "콜백" 기능이
// 켜져있는 요청(userRequest.callbackUrl 존재)이면 5초 제한 없이 최대 25초까지
// 여유를 두고 처리한 뒤 callbackUrl로 결과를 별도 전송하도록 개선했습니다.
// (예약 안내처럼 긴 응답이 5초 제한에 걸려 아예 전달되지 않던 문제 대응)
//
// 콜백이 없는 일반 요청은 기존처럼 4.2초 안에 못 받으면 폴백 문구를 즉시 보냅니다.
const { SYSTEM_PROMPT } = require('../lib/business-info');
const { getSession, saveSession } = require('../lib/session-store');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4.5';
const FALLBACK_TEXT =
  '죄송해요, 지금 답변드리기 어려워요. 잠시 후 다시 문의해주시거나 담당자에게 직접 연락 부탁드려요 🙏';

const MAX_HISTORY_MESSAGES = 20;
const SPLIT_MARKER = '===메시지분리===';

function buildOutputs(text) {
  const parts = text
    .split(SPLIT_MARKER)
    .map((p) => p.trim())
    .filter(Boolean);
  return (parts.length ? parts : [text]).map((p) => ({ simpleText: { text: p } }));
}

function respond(res, text) {
  res.status(200).json({
    version: '2.0',
    template: { outputs: buildOutputs(text) },
  });
}

async function callOpenRouter(messagesForModel, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.4,
        messages: messagesForModel,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.error('[kakao-skill] OpenRouter non-OK status:', r.status);
      return null;
    }
    const data = await r.json();
    const answer =
      data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return (answer || '').trim() || null;
  } catch (e) {
    clearTimeout(timer);
    console.error('[kakao-skill] OpenRouter call failed/timed out:', e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: '크리너리 카카오 챗봇 스킬 서버가 정상 동작 중입니다.' });
    return;
  }

  const utterance =
    (req.body && req.body.userRequest && req.body.userRequest.utterance) || '';
  const userId =
    (req.body && req.body.userRequest && req.body.userRequest.user && req.body.userRequest.user.id) ||
    null;
  const callbackUrl =
    (req.body && req.body.userRequest && req.body.userRequest.callbackUrl) || null;

  console.log(
    '[kakao-skill] utterance:',
    utterance.slice(0, 80),
    '| userId:',
    userId,
    '| hasCallback:',
    !!callbackUrl
  );

  if (!utterance) {
    respond(res, '무엇을 도와드릴까요? 청소 종류, 평수, 지역을 알려주시면 견적 안내해드릴게요!');
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[kakao-skill] OPENROUTER_API_KEY missing');
    respond(res, FALLBACK_TEXT);
    return;
  }

  const session = userId ? await getSession(userId) : { messages: [] };
  const history = Array.isArray(session.messages) ? session.messages : [];
  const messagesForModel = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-MAX_HISTORY_MESSAGES),
    { role: 'user', content: utterance },
  ];

  async function finishAndSave(finalAnswer) {
    if (userId) {
      const updatedHistory = [
        ...history,
        { role: 'user', content: utterance },
        { role: 'assistant', content: finalAnswer },
      ].slice(-MAX_HISTORY_MESSAGES);
      saveSession(userId, { messages: updatedHistory }).catch((e) =>
        console.error('[kakao-skill] saveSession failed:', e.message)
      );
    }
  }

  // 콜백이 켜져있는 요청: 5초 제한 없이 최대 25초까지 여유있게 처리 후 callbackUrl로 결과 전송
  if (callbackUrl) {
    res.status(200).json({ version: '2.0', useCallback: true });
    console.log('[kakao-skill] sent useCallback ack, processing in background...');

    const finalAnswer = (await callOpenRouter(messagesForModel, 25000)) || FALLBACK_TEXT;
    await finishAndSave(finalAnswer);

    try {
      const cbRes = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '2.0', template: { outputs: buildOutputs(finalAnswer) } }),
      });
      console.log('[kakao-skill] callback POST status:', cbRes.status);
    } catch (e) {
      console.error('[kakao-skill] callback POST failed:', e.message);
    }
    return;
  }

  // 일반 요청: 기존처럼 4.2초 안에 못 받으면 폴백 문구 즉시 전송
  const finalAnswer = (await callOpenRouter(messagesForModel, 4200)) || FALLBACK_TEXT;
  if (finalAnswer === FALLBACK_TEXT) {
    console.warn('[kakao-skill] fell back to default text (timeout or error)');
  } else {
    console.log('[kakao-skill] success, answer length:', finalAnswer.length);
  }
  respond(res, finalAnswer);
  await finishAndSave(finalAnswer);
};
