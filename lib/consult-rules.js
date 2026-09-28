// 상담 품질 규칙(코드로 강제하는 부분)
// AI 프롬프트만으로는 반복 실패가 확인된 것들을 서버 코드에서 확정적으로 처리합니다(2026-09-28 전수조사 결과 반영).
// - 날짜·요일: 서버가 한국시간 기준 오늘·달력을 계산해 주고, 답변 속 요일이 틀리면 고쳐서 보냅니다.
// - 되풀이 문구("~군요", "좋습니다!")로 시작하는 첫 문장 제거
// - 주소에 동/호/층이 이미 있으면 주소 재확인 질문 제거
// - 대화 상태(견적 제시 여부·예약안내 발송 여부·업종) 판단 → AI 에게 상태 안내, 위반 답변 감지
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 한국시간 기준 연·월·일 (Date 의 UTC 필드로 계산)
function kstParts(now = new Date()) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate(), w: k.getUTCDay() };
}

function weekdayOf(y, m, d) {
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function isValidDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// 연도 없는 "10월 3일" → 오늘 이후 가장 가까운 날짜의 연도
function inferYear(m, d, now = new Date()) {
  const t = kstParts(now);
  const thisYear = Date.UTC(t.y, m - 1, d);
  const today = Date.UTC(t.y, t.m - 1, t.d);
  return thisYear < today - 7 * 86400000 ? t.y + 1 : t.y;
}

function dateContext(now = new Date(), days = 62) {
  const t = kstParts(now);
  const lines = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.UTC(t.y, t.m - 1, t.d + i));
    lines.push(`${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${WEEKDAYS[dt.getUTCDay()]})`);
  }
  return (
    `[오늘 날짜와 달력 - 시스템이 한국시간 기준으로 계산한 값입니다. 날짜·요일은 반드시 이 표를 보고 쓰세요]\n` +
    `오늘: ${t.y}년 ${t.m}월 ${t.d}일 (${WEEKDAYS[t.w]}요일)\n` +
    `앞으로 ${days}일: ${lines.join(' ')}\n` +
    `고객이 "내일", "다음 주 토요일"처럼 말하면 위 달력으로 정확한 날짜를 계산해 "10월 10일(토)"처럼 날짜와 요일을 함께 확인하세요.`
  );
}

// 답변 속 "2026-10-10(수)", "10월 10일(수)", "10월 10일 수요일" 의 요일을 실제 요일로 교정
function fixWeekdays(text, now = new Date()) {
  let fixes = 0;
  const full = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\s*\(\s*([월화수목금토일])(?:요일)?\s*\)/g;
  let out = text.replace(full, (all, y, m, d, w) => {
    y = +y; m = +m; d = +d;
    if (!isValidDate(y, m, d)) return all;
    const real = weekdayOf(y, m, d);
    if (real === w) return all;
    fixes++;
    return all.replace(/\(\s*[월화수목금토일](요일)?\s*\)/, `(${real}$1)`.replace('undefined', ''));
  });
  const md = /(?<!\d[-./년]\s*)(\d{1,2})월\s*(\d{1,2})일\s*(\(\s*([월화수목금토일])(?:요일)?\s*\)|([월화수목금토일])요일)/g;
  out = out.replace(md, (all, m, d, _grp, w1, w2) => {
    m = +m; d = +d;
    const y = inferYear(m, d, now);
    if (!isValidDate(y, m, d)) return all;
    const real = weekdayOf(y, m, d);
    const given = w1 || w2;
    if (real === given) return all;
    fixes++;
    return w1 ? all.replace(/\(\s*[월화수목금토일]/, `(${real}`) : all.replace(/[월화수목금토일]요일$/, `${real}요일`);
  });
  return { text: out, fixes };
}

// 첫 말풍선의 첫 문장이 고객 말 되풀이·맞장구라면 제거
const ECHO_START = /^\s*(?:네[,!.\s]*)?(?:좋습니다|알겠습니다|알겠어요|확인했습니다|확인했어요|감사합니다)[!.~\s]*/;
const ECHO_SENTENCE = /^\s*[^.!?\n]{0,40}(?:이시군요|시군요|군요|이네요|네요)[.!~]*\s*/;
function stripEcho(text) {
  let out = text;
  let changed = false;
  for (let i = 0; i < 2; i++) {
    const before = out;
    out = out.replace(ECHO_START, '');
    out = out.replace(ECHO_SENTENCE, (m) => (/[?？]/.test(m) ? m : ''));
    if (out !== before) changed = true;
  }
  out = out.replace(/^\s+/, '');
  if (!out.trim()) return { text, changed: false }; // 전부 지워지면 원문 유지
  return { text: out, changed };
}

const ADDRESS_DETAIL = /\d+\s*(?:호|층|동(?!\s*[가-힣]*구))(?![가-힣])/;
function userGaveDetailedAddress(history) {
  return history.some((m) => m.role === 'user' && typeof m.content === 'string' && ADDRESS_DETAIL.test(m.content));
}

// "정확한 주소(동/호수…)를 한 번 더 알려주시겠어요?" 류 문장 제거
const ADDRESS_REASK = /[^\n.!?]*(?:정확한\s*주소|상세\s*주소|동\s*\/?\s*호수|호수)[^\n.!?]*(?:알려|확인)[^\n.!?]*[?？.]?/g;
function removeAddressReask(text, history) {
  if (!userGaveDetailedAddress(history)) return { text, removed: false };
  const out = text.replace(ADDRESS_REASK, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out || text, removed: out !== text.trim() };
}

const QUOTE_RE = /\d[\d,]*\s*원\s*\(\s*VAT\s*별도\s*\)/;
const TEMPLATE_RE = /계좌번호\s*:/;
const COMMERCIAL_RE = /상가(?!주택)|사무실|공장|매장|점포/;

function conversationState(history) {
  const assistant = history.filter((m) => m.role === 'assistant').map((m) => String(m.content || ''));
  const all = history.map((m) => String(m.content || '')).join('\n');
  return {
    quotePresented: assistant.some((c) => QUOTE_RE.test(c)),
    templateSent: assistant.some((c) => TEMPLATE_RE.test(c)),
    commercial: COMMERCIAL_RE.test(all),
    apartment: history.some((m) => m.role === 'user' && /아파트/.test(String(m.content || ''))),
    detailedAddress: userGaveDetailedAddress(history),
    depositAlertSent: assistant.some((c) => /\[\[관리자알림:\s*입금자명/.test(c)),
  };
}

function stateHints(state) {
  const hints = [];
  if (!state.quotePresented && !state.commercial) {
    hints.push('아직 고객에게 견적 금액("OOO원(VAT별도)")을 제시하지 않았습니다. 고객이 예약하겠다고 해도 예약 절차(고객명·연락처·계좌 안내)로 넘어가지 말고, 먼저 견적에 필요한 정보를 확인해 금액을 안내하세요.');
  }
  if (!state.templateSent) {
    hints.push('아직 [예약 안내 템플릿](계좌번호 포함)을 보내지 않았습니다. 고객이 "입금했다"고 해도 입금 접수 안내나 입금자명 관리자 알림을 하지 말고, 먼저 견적·예약 정보를 확인해 템플릿부터 보내세요.');
  }
  if (state.apartment) {
    hints.push('고객 건물이 아파트입니다. 아파트는 방·화장실 개수를 묻지 말고 [아파트 평형대별 표준 방/화장실 구성] 표를 기준으로 바로 견적을 안내하세요(고객이 먼저 다르다고 말한 경우만 반영).');
  }
  if (state.detailedAddress) {
    hints.push('고객이 이미 동/호수/층이 포함된 주소를 알려줬습니다. 주소를 다시 묻거나 재확인하지 마세요.');
  }
  return hints.length ? `[시스템 상태 안내 - 고객에게 보이지 않는 내부 정보]\n- ${hints.join('\n- ')}` : '';
}

// 답변이 규칙을 어겼는지 (어겼으면 이유 문자열, 아니면 null)
const ASK_PERSONAL_RE = /(?:고객명|성함|이름)[^\n]{0,25}(?:연락처|전화)/;
function detectViolation(answer, state) {
  if (!state.commercial && !state.quotePresented) {
    // 견적 금액을 먼저 따로 안내하지 않은 채 예약 안내(계좌)를 보내거나, 개인정보부터 묻는 경우
    if (TEMPLATE_RE.test(answer)) return '견적 금액을 먼저 안내하기 전에 예약 안내(계좌)를 보냈습니다';
    if (ASK_PERSONAL_RE.test(answer) && !QUOTE_RE.test(answer)) return '견적 금액을 안내하기 전에 예약 절차(개인정보 요청)로 넘어갔습니다';
  }
  if (!state.templateSent && !TEMPLATE_RE.test(answer) && /\[\[관리자알림:\s*입금자명/.test(answer)) {
    return '예약 안내 템플릿을 보내기 전에 입금 접수 처리를 했습니다';
  }
  return null;
}

const RESTART_RE = /(?:다시|새로|처음부터)\s*(?:상담|시작|문의)|상담\s*(?:재개|재시작|다시)|재상담|새\s*상담/;
function wantsRestart(utterance) {
  return RESTART_RE.test(String(utterance || ''));
}

module.exports = {
  kstParts,
  weekdayOf,
  inferYear,
  dateContext,
  fixWeekdays,
  stripEcho,
  removeAddressReask,
  userGaveDetailedAddress,
  conversationState,
  stateHints,
  detectViolation,
  wantsRestart,
  QUOTE_RE,
  TEMPLATE_RE,
};
