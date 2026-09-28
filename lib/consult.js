// 상담 엔진 — 카카오톡(api/kakao-skill.js)과 홈페이지 채팅(handlers/web-chat.js)이 함께 씁니다.
//
// 흐름: prepare() 로 대화·상태를 읽고 AI 에게 보낼 메시지를 만든 뒤 → (호출자가 AI 호출) →
//       finalize() 가 규칙 위반 재시도·요일 교정·되풀이 제거·마커 처리·예약 기록·저장을 합니다.
// 카카오 5초 제한 때문에 AI 호출 자체는 호출자(kakao-skill)가 시간 관리를 하도록 분리했습니다.
const { SYSTEM_PROMPT } = require('./business-info');
const sessions = require('./session-store');
const rules = require('./consult-rules');
const reservations = require('./reservations');
const { notifyAdmin } = require('./notify');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_HISTORY_MESSAGES = 20;
const SPLIT_MARKER = '===메시지분리===';
// business-info.js 의 [상담 종료 규칙] 문구와 반드시 일치해야 합니다.
const TERMINATION_PHRASE = '상담이 필요없으신것으로 간주하고 상담을 종료 하겠읍니다';
const AUTO_RESTART_AFTER_MS = 24 * 60 * 60 * 1000;
const FALLBACK_TEXT = '죄송해요, 지금 답변드리기 어려워요. 잠시 후 다시 문의해주시거나 담당자에게 직접 연락 부탁드려요 🙏';
const RESTART_TEXT = '상담을 새로 시작할게요. 어떤 건물의 청소를 원하세요? (아파트 / 빌라·다세대주택 / 단독주택·상가주택 / 상가·사무실·공장)';
const ADMIN_ALERT_RE = /\[\[관리자알림:\s*([^\]]*)\]\]/g;
const RESERVATION_RE = /\[\[예약정보:\s*(\{[\s\S]*?\})\s*\]\]/g;
const SAFE_TEXT = {
  quote: '예약 진행 전에 먼저 정확한 견적을 안내드릴게요. 건물 유형과 면적(평 또는 ㎡)을 알려주시겠어요?',
  deposit: '입금 전에 먼저 예약 안내(견적 금액·희망 날짜·계좌)를 보내드릴게요. 아직 확인되지 않은 정보부터 여쭤볼게요 — 견적은 받아보셨나요?',
};

function sessionIdFor(channel, userId) {
  return channel === 'kakao' ? userId : `${channel}:${userId}`;
}

async function callOpenRouter(messagesForModel, timeoutMs) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, temperature: 0.4, messages: messagesForModel }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      console.error('[consult] OpenRouter non-OK status:', r.status);
      return null;
    }
    const data = await r.json();
    const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return (answer || '').trim() || null;
  } catch (e) {
    clearTimeout(timer);
    console.error('[consult] OpenRouter call failed/timed out:', e.message);
    return null;
  }
}

// 결과: { mode: 'silent' } | { mode: 'reply', text } (AI 호출 없이 바로 답) | { mode: 'ai', messagesForModel, ... }
async function prepare({ channel, userId, utterance, now = new Date() }) {
  const sid = userId ? sessionIdFor(channel, userId) : null;
  let session = sid ? await sessions.getSession(sid) : { messages: [] };
  let history = Array.isArray(session.messages) ? session.messages : [];

  const terminated = history.some((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(TERMINATION_PHRASE));
  if (terminated) {
    const terminatedAt = session.terminatedAt ? new Date(session.terminatedAt).getTime() : 0;
    const longAgo = terminatedAt && now.getTime() - terminatedAt > AUTO_RESTART_AFTER_MS;
    if (rules.wantsRestart(utterance) || longAgo) {
      // 상담 재시작: 기존 대화는 보관 키로 옮기고(삭제 안 함) 새 대화로 시작
      if (sid) await sessions.archiveAndReset(sid, session);
      if (rules.wantsRestart(utterance)) {
        const messages = [{ role: 'user', content: utterance }, { role: 'assistant', content: RESTART_TEXT }];
        if (sid) await sessions.saveSession(sid, { messages, restartedAt: now.toISOString() });
        return { mode: 'reply', text: RESTART_TEXT, restarted: true };
      }
      session = { messages: [] };
      history = [];
    } else {
      // 종료 후 무응답. 저장하지 않아 60일 보관기간이 계속 연장되지 않게 합니다.
      return { mode: 'silent' };
    }
  }

  const state = rules.conversationState([...history, { role: 'user', content: utterance }]);
  const systemExtra = [rules.dateContext(now), rules.stateHints(state)].filter(Boolean).join('\n\n');
  const messagesForModel = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: systemExtra },
    ...history.slice(-MAX_HISTORY_MESSAGES),
    { role: 'user', content: utterance },
  ];
  return { mode: 'ai', channel, userId, sid, utterance, session, history, state, messagesForModel, now };
}

function parseReservation(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      return JSON.parse(raw.replace(/,\s*}/g, '}').replace(/[“”]/g, '"'));
    } catch (e2) {
      return null;
    }
  }
}

function extractMarkers(answer) {
  const alerts = [];
  const reservationsFound = [];
  let text = answer.replace(RESERVATION_RE, (m, json) => {
    const data = parseReservation(json);
    if (data) reservationsFound.push(data);
    return '';
  });
  text = text.replace(ADMIN_ALERT_RE, (m, reason) => {
    alerts.push(reason.trim());
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), alerts, reservationsFound };
}

function polish(text, prep) {
  const bubbles = text.split(SPLIT_MARKER).map((p) => p.trim()).filter(Boolean);
  const fixed = bubbles.map((b, i) => {
    let t = rules.fixWeekdays(b, prep.now).text;
    if (i === 0) t = rules.stripEcho(t).text;
    t = rules.removeAddressReask(t, [...prep.history, { role: 'user', content: prep.utterance }]).text;
    return t;
  });
  return fixed.join(`\n${SPLIT_MARKER}\n`);
}

// regenerate(extraSystemNote) → Promise<string|null>  (시간 여유가 없으면 호출자가 null 을 넘김)
async function finalize(prep, answer, { regenerate } = {}) {
  if (!answer) answer = FALLBACK_TEXT;
  let violation = answer === FALLBACK_TEXT ? null : rules.detectViolation(answer, prep.state);
  if (violation && regenerate) {
    console.warn('[consult] 규칙 위반 감지, 1회 재작성:', violation);
    const retry = await regenerate(`[중요] 방금 작성한 답변이 규칙을 어겼습니다: ${violation}. 그 절차로 넘어가지 말고 규칙에 맞게 다시 답하세요.`);
    if (retry && !rules.detectViolation(retry, prep.state)) {
      answer = retry;
      violation = null;
    }
  }
  if (violation) {
    console.warn('[consult] 규칙 위반 답변을 안전 문구로 대체:', violation);
    if (violation.startsWith('아파트')) {
      const q = rules.computeQuote(prep.state.facts);
      answer = `${q.supply}평 아파트 기준 약 ${q.base.toLocaleString('ko-KR')}원(VAT별도)입니다. 화장실이 표준 구성보다 많으면 추가될 수 있어요.`;
    } else answer = violation.startsWith('견적') ? SAFE_TEXT.quote : SAFE_TEXT.deposit;
  }

  const { text: withoutMarkers, alerts, reservationsFound } = extractMarkers(answer);
  const customerText = polish(withoutMarkers, prep) || FALLBACK_TEXT;

  // 부가 처리: 예약 기록, 입금 알림, 관리자 알림
  const channel = prep.channel;
  const who = prep.userId || 'unknown';
  let reservation = null;
  // AI 가 숨은 마커를 빠뜨려도: 예약 안내 템플릿·방문견적 알림에서 직접 예약 정보를 읽어 기록
  if (!reservationsFound.length) {
    const fromTemplate = rules.parseReservationTemplate(withoutMarkers);
    if (fromTemplate) reservationsFound.push(fromTemplate);
    else {
      for (const reason of alerts) {
        const visit = rules.parseVisitFromAlert(reason, [...prep.history, { role: 'user', content: prep.utterance }]);
        if (visit) { reservationsFound.push(visit); break; }
      }
    }
  }
  for (const data of reservationsFound) {
    try {
      const kind = data.kind === '방문견적' || prep.state.commercial && !data.quoteAmount ? '방문견적' : '예약';
      reservation = await reservations.upsertFromChat({ channel, userId: who, data, kind });
      if (kind === '방문견적' && !alerts.some((a) => a.includes('팀장 연락'))) {
        // 방문견적 예약은 마커 누락과 상관없이 관리자에게 반드시 알림
        alerts.push(`팀장 연락 필요 - 방문견적 요청, 연락처 ${data.phone || '미확인'}, 방문희망 ${data.visitAt || data.desiredDate || '미확인'}`);
      }
    } catch (e) {
      console.error('[consult] 예약 기록 실패:', e.message);
    }
  }
  for (const reason of alerts) {
    const m = reason.match(/입금자명 확인 필요\s*-\s*(.+)$/);
    if (m) {
      try {
        reservation = (await reservations.markPaymentClaimed({ channel, userId: who, depositorName: m[1].trim() })) || reservation;
      } catch (e) {
        console.error('[consult] 입금 알림 기록 실패:', e.message);
      }
    }
    notifyAdmin(reason, `고객 메시지: ${prep.utterance}\n(${channel === 'kakao' ? '카카오' : '홈페이지'} 고객ID: ${who})${reservation ? `\n예약번호: ${reservation.id}` : ''}`)
      .catch((e) => console.error('[consult] notifyAdmin failed:', e.message));
  }

  // 대화 저장: 고객에게 보낸 문장 + (AI 가 다음 턴에 '이미 보냈음'을 알 수 있도록) 마커 원문
  if (prep.sid) {
    const markerTail = [...alerts.map((a) => `[[관리자알림: ${a}]]`), ...(reservation ? [`[[예약번호: ${reservation.id}]]`] : [])].join('\n');
    const stored = markerTail ? `${customerText}\n${markerTail}` : customerText;
    const updated = [...prep.history, { role: 'user', content: prep.utterance }, { role: 'assistant', content: stored }].slice(-MAX_HISTORY_MESSAGES);
    const next = { messages: updated };
    if (prep.session.restartedAt) next.restartedAt = prep.session.restartedAt;
    if (customerText.includes(TERMINATION_PHRASE)) next.terminatedAt = new Date().toISOString();
    await sessions.saveSession(prep.sid, next);
  }

  return { text: customerText, alerts, reservation, violation };
}

function toBubbles(text) {
  const parts = String(text || '').split(SPLIT_MARKER).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [String(text || '')];
}

module.exports = {
  prepare,
  finalize,
  callOpenRouter,
  toBubbles,
  extractMarkers,
  sessionIdFor,
  SPLIT_MARKER,
  TERMINATION_PHRASE,
  FALLBACK_TEXT,
  RESTART_TEXT,
  MODEL,
};
