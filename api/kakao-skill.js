// 카카오 i 오픈빌더 스킬 서버
// Vercel 배포 시 경로: api/kakao-skill.js
//
// [2026-07 수정 3] 콜백이 켜져있는 요청이라도 무조건 대기 메시지부터 보여주지 않도록 개선.
// OpenRouter 호출을 한 번만 시작해두고, 4.2초 안에 끝나면 콜백을 쓰지 않고 바로 응답합니다
// (짧은 답변은 예전처럼 즉시 감). 4.2초를 넘기면 그때 비로소 콜백 모드로 전환해서
// 카카오가 대기 메시지를 보여주게 하고, 같은 호출이 끝날 때까지(최대 25초) 기다렸다가
// callbackUrl로 결과를 별도 전송합니다 (예약 안내처럼 긴 응답 대응).
//
// 콜백 자체가 꺼져있는 요청(callbackUrl 없음)은 기존처럼 4.2초 안에 못 받으면 폴백 문구를 보냅니다.
const { SYSTEM_PROMPT } = require('../lib/business-info');
const { getSession, saveSession } = require('../lib/session-store');
const { notifyAdmin } = require('../lib/notify');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4.5';
const FALLBACK_TEXT =
  '죄송해요, 지금 답변드리기 어려워요. 잠시 후 다시 문의해주시거나 담당자에게 직접 연락 부탁드려요 🙏';

const MAX_HISTORY_MESSAGES = 20;
const SPLIT_MARKER = '===메시지분리===';
// business-info.js의 [상담 종료 규칙]에서 AI가 그대로 출력하는 문구와 반드시 일치해야 합니다.
const TERMINATION_PHRASE = '상담이 필요없으신것으로 간주하고 상담을 종료 하겠읍니다';
// business-info.js의 [관리자 알림 마커] 형식과 반드시 일치해야 합니다.
const ADMIN_ALERT_REGEX = /\[\[관리자알림:\s*([^\]]*)\]\]\s*$/;

// AI 응답 끝에 붙은 관리자 알림 마커를 찾아서, 고객에게 보낼 텍스트에서는 제거하고
// 사유(reason)만 따로 뽑아냅니다. 마커가 없으면 reason은 null입니다.
function extractAdminAlert(text) {
  const match = text.match(ADMIN_ALERT_REGEX);
  if (!match) return { cleanedText: text, reason: null };
  return { cleanedText: text.slice(0, match.index).trim(), reason: match[1].trim() };
}

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

  // 이미 상담 종료 문구를 보낸 대화라면, AI 판단에 의존하지 않고 코드에서 확실하게 무응답 처리합니다.
  const alreadyTerminated = history.some(
    (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(TERMINATION_PHRASE)
  );
  if (alreadyTerminated) {
    console.log('[kakao-skill] session already terminated, staying silent | userId:', userId);
    if (userId) {
      const updatedHistory = [...history, { role: 'user', content: utterance }].slice(-MAX_HISTORY_MESSAGES);
      saveSession(userId, { messages: updatedHistory }).catch((e) =>
        console.error('[kakao-skill] saveSession failed:', e.message)
      );
    }
    res.status(200).json({ version: '2.0', template: { outputs: [] } });
    return;
  }

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

  // 마커(있으면)를 추출해서 실제 관리자에게 알림을 보냅니다. 대화 기록에는 마커가 포함된
  // 원문을 그대로 저장해서, AI가 "이미 알림을 보냈는지"를 다음 턴에도 스스로 판단할 수 있게 합니다.
  function handleAdminAlert(finalAnswer) {
    const { cleanedText, reason } = extractAdminAlert(finalAnswer);
    if (reason) {
      console.log('[kakao-skill] admin alert triggered:', reason);
      notifyAdmin(reason, `고객 메시지: ${utterance}\n(카카오 유저ID: ${userId || '알수없음'})`).catch((e) =>
        console.error('[kakao-skill] notifyAdmin failed:', e.message)
      );
    }
    return cleanedText;
  }

  const FAST_TIMEOUT_MS = 4200; // 카카오 5초 SLA 안에 안전하게 들어오는 기준
  const overallTimeoutMs = callbackUrl ? 25000 : FAST_TIMEOUT_MS;
  // OpenRouter 호출은 딱 한 번만 시작합니다 (빠른 경로/콜백 경로가 같은 호출을 공유).
  const answerPromise = callOpenRouter(messagesForModel, overallTimeoutMs);

  if (!callbackUrl) {
    // 콜백 자체가 꺼져있는 요청: 기존처럼 4.2초 안에 못 받으면 폴백 문구 즉시 전송
    const finalAnswer = (await answerPromise) || FALLBACK_TEXT;
    if (finalAnswer === FALLBACK_TEXT) {
      console.warn('[kakao-skill] fell back to default text (timeout or error)');
    } else {
      console.log('[kakao-skill] success (no callback), answer length:', finalAnswer.length);
    }
    const cleanedText = handleAdminAlert(finalAnswer);
    respond(res, cleanedText);
    await finishAndSave(finalAnswer);
    return;
  }

  // 콜백이 가능한 요청: 먼저 4.2초 안에 끝나는지 지켜보고, 끝나면 콜백 없이 바로 응답합니다.
  const FAST_TIMEOUT = Symbol('fast-timeout');
  const raced = await Promise.race([
    answerPromise,
    new Promise((resolve) => setTimeout(() => resolve(FAST_TIMEOUT), FAST_TIMEOUT_MS)),
  ]);

  if (raced !== FAST_TIMEOUT) {
    // 4.2초 안에 끝남: 콜백(대기 메시지) 없이 즉시 응답
    const finalAnswer = raced || FALLBACK_TEXT;
    console.log('[kakao-skill] fast path (no callback needed), answer length:', finalAnswer.length);
    const cleanedText = handleAdminAlert(finalAnswer);
    respond(res, cleanedText);
    await finishAndSave(finalAnswer);
    return;
  }

  // 4.2초를 넘김: 이제서야 콜백 모드로 전환. 카카오가 대기 메시지를 보여주는 동안
  // 원래 시작해뒀던 answerPromise가 끝나길(최대 25초 예산 안에서) 기다렸다가 콜백으로 전송합니다.
  res.status(200).json({ version: '2.0', useCallback: true });
  console.log('[kakao-skill] exceeded fast timeout, switched to callback mode...');

  const finalAnswer = (await answerPromise) || FALLBACK_TEXT;
  await finishAndSave(finalAnswer);
  const cleanedText = handleAdminAlert(finalAnswer);

  try {
    const cbRes = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '2.0', template: { outputs: buildOutputs(cleanedText) } }),
    });
    console.log('[kakao-skill] callback POST status:', cbRes.status);
  } catch (e) {
    console.error('[kakao-skill] callback POST failed:', e.message);
  }
};
