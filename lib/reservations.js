// 예약 관리 데이터
// 저장: 해시 cleanery:reservations (필드=예약 id, 값=JSON), 고객별 진행 중 예약: cleanery:reservation-open:{channel}:{userId}
//
// 상태 흐름 (관리자 승인 전에는 절대 '예약확정'이 되지 않습니다)
//   가정 청소: 입금대기 → 입금확인요청(고객이 입금했다고 알림) → [관리자: 실제 입금 확인 + 승인] → 예약확정
//   상가·사무실·공장: 방문견적요청 → [관리자] 방문일정확정 → (견적 확정 후) 입금대기 …
//   언제든: 취소
// '입금확인요청'은 고객의 말일 뿐이고, 실제 입금 확인은 관리자가 paymentVerified 로 따로 기록합니다.
const crypto = require('crypto');
const store = require('./store');
const { withLock } = require('./lock');

const HASH_KEY = 'cleanery:reservations';
const STATUSES = ['방문견적요청', '방문일정확정', '입금대기', '입금확인요청', '예약확정', '작업완료', '취소'];
const ADMIN_TRANSITIONS = {
  방문견적요청: ['방문일정확정', '입금대기', '취소'],
  방문일정확정: ['입금대기', '취소'],
  입금대기: ['입금확인요청', '예약확정', '취소'],
  입금확인요청: ['입금대기', '예약확정', '취소'],
  예약확정: ['작업완료', '취소'],
  작업완료: [],
  취소: ['입금대기'],
};
const EDITABLE = ['customerName', 'phone', 'address', 'desiredDate', 'visitAt', 'cleaningType', 'buildingType', 'areaPyeong', 'quoteAmount', 'deposit', 'balance', 'depositorName', 'adminMemo', 'notes'];

function depositFor(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 400000 ? 50000 : 100000;
}

function openKey(channel, userId) {
  return `cleanery:reservation-open:${channel}:${userId}`;
}

async function get(id) {
  const raw = await store.cmd('HGET', HASH_KEY, id);
  return raw ? JSON.parse(raw) : null;
}

async function list() {
  const map = store.pairsToObject(await store.cmd('HGETALL', HASH_KEY));
  return Object.values(map).map((j) => JSON.parse(j)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function save(rec) {
  await store.cmd('HSET', HASH_KEY, rec.id, JSON.stringify(rec));
  return rec;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalize(data) {
  const out = {};
  for (const k of EDITABLE) {
    if (data[k] === undefined) continue;
    out[k] = ['quoteAmount', 'deposit', 'balance', 'areaPyeong'].includes(k) ? num(data[k]) : (data[k] === null ? null : String(data[k]).slice(0, 500));
  }
  if (out.quoteAmount && out.deposit == null) out.deposit = depositFor(out.quoteAmount);
  if (out.quoteAmount && out.deposit != null && out.balance == null) out.balance = out.quoteAmount - out.deposit;
  return out;
}

// 상담봇이 예약 안내(또는 방문견적 예약)를 보낼 때 호출: 고객별 진행 중 예약을 만들거나 갱신
async function upsertFromChat(args) {
  return withLock(`reservation-user:${args.channel}:${args.userId}`, () => upsertFromChatUnlocked(args));
}

async function upsertFromChatUnlocked({ channel, userId, data, kind }) {
  const now = new Date().toISOString();
  const openId = await store.cmd('GET', openKey(channel, userId));
  let rec = openId ? await get(openId) : null;
  if (rec && ['예약확정', '작업완료', '취소'].includes(rec.status)) rec = null;
  const fields = normalize(data || {});
  if (!rec) {
    rec = {
      id: 'R' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      channel, userId,
      status: kind === '방문견적' ? '방문견적요청' : '입금대기',
      createdAt: now,
      history: [],
      paymentClaimedAt: null,
      paymentVerified: false,
      paymentVerifiedAt: null,
      paymentVerifiedBy: null,
    };
  }
  Object.assign(rec, fields, { updatedAt: now });
  rec.history.push({ at: now, by: 'bot', action: kind === '방문견적' ? '방문견적 요청 접수' : '예약 안내 발송(입금 대기)' });
  await save(rec);
  await store.cmd('SET', openKey(channel, userId), rec.id);
  return rec;
}

// 고객이 입금했다고 알린 경우(실제 입금 확인 아님)
async function markPaymentClaimed({ channel, userId, depositorName }) {
  const openId = await store.cmd('GET', openKey(channel, userId));
  const rec = openId ? await get(openId) : null;
  if (!rec || !['입금대기', '입금확인요청'].includes(rec.status)) return null;
  const now = new Date().toISOString();
  rec.status = '입금확인요청';
  rec.depositorName = depositorName ? String(depositorName).slice(0, 50) : rec.depositorName || null;
  rec.paymentClaimedAt = now;
  rec.updatedAt = now;
  rec.history.push({ at: now, by: 'bot', action: `고객 입금 알림(입금자명: ${rec.depositorName || '미상'}) — 관리자 확인 필요` });
  return save(rec);
}

// 관리자 변경: 상태·필드·메모·실제 입금 확인
async function adminUpdate(id, patch, adminName) {
  return withLock(`reservation:${id}`, () => adminUpdateUnlocked(id, patch, adminName));
}

async function adminUpdateUnlocked(id, { status, fields, paymentVerified, version }, adminName) {
  const rec = await get(id);
  if (!rec) return { status: 404, error: '예약을 찾을 수 없습니다.' };
  if (version !== undefined && Number(version) !== Number(rec.version || 1)) {
    return { status: 409, error: '다른 곳에서 먼저 수정됐습니다. 새로 불러온 뒤 다시 시도해 주세요.', record: rec };
  }
  const now = new Date().toISOString();
  const actions = [];
  if (fields) {
    const f = normalize(fields);
    Object.assign(rec, f);
    if (Object.keys(f).length) actions.push('정보 수정: ' + Object.keys(f).join(', '));
  }
  if (paymentVerified !== undefined && Boolean(paymentVerified) !== rec.paymentVerified) {
    rec.paymentVerified = Boolean(paymentVerified);
    rec.paymentVerifiedAt = rec.paymentVerified ? now : null;
    rec.paymentVerifiedBy = rec.paymentVerified ? adminName : null;
    actions.push(rec.paymentVerified ? '실제 입금 확인함' : '입금 확인 취소');
  }
  if (status && status !== rec.status) {
    if (!STATUSES.includes(status)) return { status: 400, error: '알 수 없는 상태입니다.' };
    if (!(ADMIN_TRANSITIONS[rec.status] || []).includes(status)) {
      return { status: 400, error: `'${rec.status}'에서 '${status}'(으)로 바꿀 수 없습니다.` };
    }
    if (status === '예약확정' && !rec.paymentVerified) {
      return { status: 400, error: '실제 계좌 입금을 확인(체크)한 뒤에만 예약확정할 수 있습니다.' };
    }
    actions.push(`상태: ${rec.status} → ${status}`);
    rec.status = status;
  }
  rec.version = (rec.version || 1) + 1;
  rec.updatedAt = now;
  if (actions.length) rec.history.push({ at: now, by: adminName, action: actions.join(' / ') });
  await save(rec);
  return { status: 200, record: rec };
}

module.exports = { HASH_KEY, STATUSES, ADMIN_TRANSITIONS, depositFor, get, list, save, upsertFromChat, markPaymentClaimed, adminUpdate, openKey };
