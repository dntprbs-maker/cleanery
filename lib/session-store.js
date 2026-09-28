// 카카오 챗봇용 세션(대화 기록) 저장소
// 저장 키·형식은 기존과 같습니다: cleanery:session:{userId} = {"messages":[...]} (TTL 60일)
// 저장소 접근은 lib/store.js (운영=Upstash, 개발·시험=메모리)로 통일했습니다.
const store = require('./store');

const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60; // 60일 (안전장치: 이벤트 없이 방치되면 자동 소멸)
const INDEX_KEY = 'cleanery:sessions:index';

function keyFor(userId) {
  return `cleanery:session:${userId}`;
}

// 세션 조회. 저장된 게 없으면 빈 대화로 시작.
async function getSession(userId) {
  try {
    const raw = await store.cmd('GET', keyFor(userId));
    if (!raw) return { messages: [] };
    return JSON.parse(raw);
  } catch (e) {
    // Redis 조회 실패해도 챗봇 자체는 계속 동작해야 하므로, 빈 세션으로 폴백
    console.error('getSession error:', e.message);
    return { messages: [] };
  }
}

// 세션 저장 + TTL(60일) 갱신
async function saveSession(userId, session) {
  try {
    await store.cmd('SET', keyFor(userId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  } catch (e) {
    console.error('saveSession error:', e.message);
    return;
  }
  // 상담내역 목록(관리자용)에 표시하기 위한 인덱스 갱신. 실패해도 챗봇 동작엔 영향 없음.
  try {
    await store.cmd('ZADD', INDEX_KEY, String(Date.now()), userId);
  } catch (e) {
    console.error('session index update failed:', e.message);
  }
}

// 상담 재시작: 기존 대화는 지우지 않고 보관 키로 옮긴 뒤(같은 60일 보관) 새 대화로 시작합니다.
async function archiveAndReset(userId, session) {
  const archiveKey = `cleanery:session-archive:${userId}:${Date.now()}`;
  try {
    await store.cmd('SET', archiveKey, JSON.stringify(session || { messages: [] }), 'EX', SESSION_TTL_SECONDS);
    await store.cmd('SET', keyFor(userId), JSON.stringify({ messages: [], restartedAt: new Date().toISOString(), previous: archiveKey }), 'EX', SESSION_TTL_SECONDS);
    await store.cmd('ZADD', INDEX_KEY, String(Date.now()), userId);
  } catch (e) {
    console.error('archiveAndReset error:', e.message);
  }
  return archiveKey;
}

// 예약확정/취소 등으로 상담이 끝났을 때 즉시 세션 삭제 (지금은 미사용, 추후 이벤트 감지 붙일 때 사용)
async function clearSession(userId) {
  try {
    await store.cmd('DEL', keyFor(userId));
  } catch (e) {
    console.error('clearSession error:', e.message);
  }
}

module.exports = { getSession, saveSession, clearSession, archiveAndReset, SESSION_TTL_SECONDS, INDEX_KEY, keyFor };
