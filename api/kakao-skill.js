// 카카오 i 오픈빌더 스킬 서버
// Vercel 배포 시 경로: api/kakao-skill.js (오픈빌더에 등록된 주소 그대로 유지)
//
// [2026-07 수정 3] OpenRouter 호출을 한 번만 시작해두고, 4.2초 안에 끝나면 콜백 없이 바로 응답합니다.
// 4.2초를 넘기면 콜백 모드로 전환해 카카오가 대기 메시지를 보여주게 하고, 같은 호출이 끝날 때까지
// (최대 25초) 기다렸다가 callbackUrl 로 결과를 별도 전송합니다. 콜백이 꺼진 요청은 4.2초 안에 못 받으면 폴백 문구.
//
// [2026-09-28] 상담 로직을 lib/consult.js 로 분리(홈페이지 채팅과 공용). 날짜·요일 서버 계산, 되풀이 문구 제거,
// 주소 재확인 제거, 견적 전 예약·템플릿 전 입금 처리 차단, 상담 종료 후 재시작, 예약 데이터 구조화 저장 추가.
const consult = require('../lib/consult');

const FAST_TIMEOUT_MS = 4200; // 카카오 5초 SLA 안에 안전하게 들어오는 기준
const CALLBACK_BUDGET_MS = 25000;

function buildOutputs(text) {
  return consult.toBubbles(text).map((p) => ({ simpleText: { text: p } }));
}

function respond(res, text) {
  res.status(200).json({ version: '2.0', template: { outputs: buildOutputs(text) } });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: '크리너리 카카오 챗봇 스킬 서버가 정상 동작 중입니다.' });
    return;
  }

  if (!req.body || !req.body.userRequest) {
    // 오픈빌더 형식이 아닌 요청: AI 를 부르지 않고 형식 오류만 알림
    const { checkSkillRequest } = require('../lib/kakao-config');
    res.status(400).json({ ok: false, error: '카카오 i 오픈빌더 스킬 요청 형식이 아닙니다.', problems: checkSkillRequest(req.body).problems });
    return;
  }
  const ur = req.body.userRequest;
  const utterance = ur.utterance || '';
  const userId = (ur.user && ur.user.id) || null;
  const callbackUrl = ur.callbackUrl || null;
  const startedAt = Date.now();

  console.log('[kakao-skill] utterance:', utterance.slice(0, 80), '| userId:', userId, '| hasCallback:', !!callbackUrl);

  if (!utterance) {
    respond(res, '무엇을 도와드릴까요? 청소 종류, 평수, 지역을 알려주시면 견적 안내해드릴게요!');
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[kakao-skill] OPENROUTER_API_KEY missing');
    respond(res, consult.FALLBACK_TEXT);
    return;
  }

  const prep = await consult.prepare({ channel: 'kakao', userId, utterance });
  if (prep.mode === 'silent') {
    console.log('[kakao-skill] session already terminated, staying silent | userId:', userId);
    res.status(200).json({ version: '2.0', template: { outputs: [] } });
    return;
  }
  if (prep.mode === 'reply') {
    respond(res, prep.text);
    return;
  }

  const overallTimeoutMs = callbackUrl ? CALLBACK_BUDGET_MS : FAST_TIMEOUT_MS;
  // OpenRouter 호출은 딱 한 번만 시작합니다 (빠른 경로/콜백 경로가 같은 호출을 공유).
  const answerPromise = consult.callOpenRouter(prep.messagesForModel, overallTimeoutMs);
  // 규칙 위반 시 재작성은 콜백 모드에서 남은 시간이 충분할 때만 (빠른 경로는 5초 제한 때문에 안전 문구로 대체)
  const regenerateIfTime = (note) => {
    const left = startedAt + CALLBACK_BUDGET_MS - Date.now() - 1500;
    if (left < 4000) return Promise.resolve(null);
    return consult.callOpenRouter([...prep.messagesForModel, { role: 'system', content: note }], left);
  };

  if (!callbackUrl) {
    const answer = await answerPromise;
    if (!answer) console.warn('[kakao-skill] fell back to default text (timeout or error)');
    const out = await consult.finalize(prep, answer);
    respond(res, out.text);
    return;
  }

  const FAST_TIMEOUT = Symbol('fast-timeout');
  const raced = await Promise.race([
    answerPromise,
    new Promise((resolve) => setTimeout(() => resolve(FAST_TIMEOUT), FAST_TIMEOUT_MS)),
  ]);

  if (raced !== FAST_TIMEOUT) {
    const out = await consult.finalize(prep, raced);
    console.log('[kakao-skill] fast path (no callback needed), answer length:', out.text.length);
    respond(res, out.text);
    return;
  }

  // 4.2초를 넘김: 콜백 모드로 전환
  res.status(200).json({ version: '2.0', useCallback: true });
  console.log('[kakao-skill] exceeded fast timeout, switched to callback mode...');

  const out = await consult.finalize(prep, await answerPromise, { regenerate: regenerateIfTime });
  try {
    const cbRes = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '2.0', template: { outputs: buildOutputs(out.text) } }),
    });
    console.log('[kakao-skill] callback POST status:', cbRes.status);
  } catch (e) {
    console.error('[kakao-skill] callback POST failed:', e.message);
  }
};
