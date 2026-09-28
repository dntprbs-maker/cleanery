// 가상 상담 100건 검토 데이터
// - 원본 사례: review/cases/*.json (읽기 전용, 절대 수정하지 않음)
// - 아빠의 수정·검토 상태: 저장소 cleanery:review:case:{id} (버전 번호 + 수정한 사람·시각)
// - 이전 버전: cleanery:review:history:{id} (저장할 때마다 직전 상태를 쌓아 두고 복원 가능, 최근 50개)
// 고객 발언은 수정할 수 없고, 상담직원 답변(staff 턴)만 수정할 수 있습니다.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { withLock } = require('./lock');

const CASES_DIR = path.join(__dirname, '..', 'review', 'cases');
const STATUSES = ['미검토', '수정 중', '검토 완료', '보류', '기준 반영 완료'];
const APPROVED = ['검토 완료', '기준 반영 완료'];
const HISTORY_LIMIT = 50;
const TOPICS = {
  첫문의: '처음 문의한 고객에게 확인할 정보',
  견적설명: '평수와 견적을 설명하는 방법',
  할인대응: '할인 요구 대응',
  추가요금: '추가요금 발생 가능성 안내',
  계약금입금: '계약금과 입금 확인 안내',
  변경취소: '예약 변경 및 취소 응대',
  불만처리: '고객 불만 처리',
  방문견적: '방문견적 안내',
  상담종료: '상담 종료 방법',
  일정안내: '일정·날짜 안내',
  작업범위: '작업 범위 안내',
};

let cache = null;
function loadCases() {
  if (cache) return cache;
  const out = [];
  for (const f of fs.readdirSync(CASES_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
    for (const c of d.cases) {
      out.push({
        id: 'C' + String(c.no).padStart(3, '0'),
        no: c.no,
        title: c.title,
        category: d.category,
        channel: c.channel,
        difficulty: c.difficulty,
        situation: c.situation,
        tags: c.tags || [],
        outcome: c.outcome,
        cautions: c.cautions || [],
        policy: c.policy || [],
        turns: c.t.map(([sp, text], i) => ({ id: 't' + (i + 1), speaker: sp === 's' ? 'staff' : 'customer', text })),
      });
    }
  }
  out.sort((a, b) => a.no - b.no);
  cache = out;
  return out;
}

function getCase(id) {
  return loadCases().find((c) => c.id === id) || null;
}

const key = (id) => `cleanery:review:case:${id}`;
const histKey = (id) => `cleanery:review:history:${id}`;

function emptyState() {
  return { status: '미검토', edits: {}, notes: {}, caseNote: '', version: 0, updatedAt: null, updatedBy: null };
}

async function getState(id) {
  const raw = await store.cmd('GET', key(id));
  return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState();
}

async function getHistory(id) {
  return ((await store.cmd('LRANGE', histKey(id), '0', String(HISTORY_LIMIT - 1))) || []).map((j) => JSON.parse(j));
}

function validate(c, { edits, notes, status }) {
  const staffIds = new Set(c.turns.filter((t) => t.speaker === 'staff').map((t) => t.id));
  for (const tid of Object.keys(edits || {})) {
    if (!staffIds.has(tid)) return `고객 발언이나 없는 문장(${tid})은 수정할 수 없습니다.`;
    if (typeof edits[tid] !== 'string' || edits[tid].length > 3000) return '수정한 답변이 비었거나 너무 깁니다.';
  }
  for (const tid of Object.keys(notes || {})) if (!staffIds.has(tid)) return `메모 대상(${tid})이 올바르지 않습니다.`;
  if (status !== undefined && !STATUSES.includes(status)) return '알 수 없는 검토 상태입니다.';
  return null;
}

// 저장: 버전이 맞을 때만. 저장 직전 상태는 이력에 보관.
async function save(id, patch, who, { reason = '저장' } = {}) {
  const c = getCase(id);
  if (!c) return { status: 404, error: '사례를 찾을 수 없습니다.' };
  const err = validate(c, patch);
  if (err) return { status: 400, error: err };
  return withLock(`review:${id}`, async () => {
    const cur = await getState(id);
    if (patch.version !== undefined && Number(patch.version) !== cur.version) {
      return { status: 409, error: '다른 기기에서 먼저 저장됐습니다. 새로 불러온 뒤 다시 수정해 주세요.', state: cur };
    }
    const edits = { ...cur.edits };
    for (const [tid, text] of Object.entries(patch.edits || {})) {
      const orig = c.turns.find((t) => t.id === tid).text;
      if (text.trim() === orig.trim()) delete edits[tid]; // 원문과 같아지면 수정 해제
      else edits[tid] = text;
    }
    const notes = { ...cur.notes };
    for (const [tid, text] of Object.entries(patch.notes || {})) {
      if (text && String(text).trim()) notes[tid] = String(text).slice(0, 1000);
      else delete notes[tid];
    }
    const next = {
      status: patch.status || (cur.status === '미검토' && Object.keys(edits).length ? '수정 중' : cur.status),
      edits,
      notes,
      caseNote: patch.caseNote !== undefined ? String(patch.caseNote).slice(0, 3000) : cur.caseNote,
      version: cur.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: who,
    };
    if (cur.version > 0) {
      await store.cmd('LPUSH', histKey(id), JSON.stringify({ ...cur, archivedAt: next.updatedAt, archivedReason: reason }));
      await store.cmd('LTRIM', histKey(id), '0', String(HISTORY_LIMIT - 1));
    }
    await store.cmd('SET', key(id), JSON.stringify(next));
    return { status: 200, state: next };
  });
}

// 이전 버전 복원(복원도 새 버전으로 저장되어 다시 되돌릴 수 있음)
async function restore(id, targetVersion, currentVersion, who) {
  const hist = await getHistory(id);
  const snap = hist.find((h) => Number(h.version) === Number(targetVersion));
  if (!snap) return { status: 404, error: '해당 버전을 찾을 수 없습니다.' };
  const c = getCase(id);
  const cur = await getState(id);
  const clearEdits = {};
  for (const tid of Object.keys(cur.edits)) if (!(tid in snap.edits)) clearEdits[tid] = c.turns.find((t) => t.id === tid).text;
  const clearNotes = {};
  for (const tid of Object.keys(cur.notes)) if (!(tid in snap.notes)) clearNotes[tid] = '';
  return save(id, {
    version: currentVersion,
    edits: { ...clearEdits, ...snap.edits },
    notes: { ...clearNotes, ...snap.notes },
    caseNote: snap.caseNote,
    status: snap.status,
  }, who, { reason: `버전 ${targetVersion} 복원 전 상태` });
}

async function allStates() {
  const cases = loadCases();
  const states = await Promise.all(cases.map((c) => getState(c.id)));
  return cases.map((c, i) => ({ case: c, state: states[i] }));
}

function stats(rows) {
  const s = { total: rows.length };
  for (const st of STATUSES) s[st] = 0;
  for (const r of rows) s[r.state.status] = (s[r.state.status] || 0) + 1;
  s.progressPercent = Math.round(((s['검토 완료'] + s['기준 반영 완료']) / Math.max(1, s.total)) * 100);
  return s;
}

function finalTurns(c, state) {
  return c.turns.map((t) => ({
    ...t,
    original: t.text,
    final: t.speaker === 'staff' && state.edits[t.id] !== undefined ? state.edits[t.id] : t.text,
    edited: t.speaker === 'staff' && state.edits[t.id] !== undefined,
    note: state.notes[t.id] || '',
  }));
}

module.exports = { loadCases, getCase, getState, getHistory, save, restore, allStates, stats, finalTurns, STATUSES, APPROVED, TOPICS };
