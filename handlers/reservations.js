// 관리자 예약 관리 API — 관리자 로그인 필요
// GET   /api/reservations                 -> { reservations: [...], notifications: [...] }
// PATCH /api/reservations?id=...          -> body { status?, fields?, paymentVerified?, version }
// 예약확정은 관리자가 실제 계좌 입금을 확인(paymentVerified)한 뒤에만 가능합니다.
const store = require('../lib/store');
const reservations = require('../lib/reservations');
const { requireAdmin } = require('../lib/auth');
const { jsonBody, isSameSiteWrite } = require('../lib/http');

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET' && req.query && req.query.schedule && req.query.id) {
      // 클린메니저 일정 생성용 정보(현재는 수동 복사 방식)
      const rec = await reservations.get(String(req.query.id));
      if (!rec) { res.status(404).json({ ok: false, error: '예약을 찾을 수 없습니다.' }); return; }
      try {
        const out = await require('../lib/cleanmanager-bridge').currentSink().send(rec);
        res.status(out.ok ? 200 : 501).json(out);
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET') {
      const list = await reservations.list();
      const notes = ((await store.cmd('LRANGE', 'cleanery:admin:notifications', '0', '29')) || []).map((j) => JSON.parse(j));
      res.status(200).json({
        reservations: list,
        notifications: notes,
        statuses: reservations.STATUSES,
        transitions: reservations.ADMIN_TRANSITIONS,
        notifyMode: store.isMemory() ? '개발 모드(실제 발송 안 함)' : '운영(실제 발송)',
      });
      return;
    }
    if (req.method === 'PATCH') {
      if (!isSameSiteWrite(req)) {
        res.status(403).json({ ok: false, error: '허용되지 않은 요청입니다.' });
        return;
      }
      const id = String((req.query && req.query.id) || '');
      const body = jsonBody(req);
      const out = await reservations.adminUpdate(id, body, admin.username);
      res.status(out.status).json(out.status === 200 ? { ok: true, record: out.record } : { ok: false, error: out.error, record: out.record });
      return;
    }
    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[reservations] 실패:', e.message);
    res.status(500).json({ ok: false, error: '예약 처리 중 오류가 발생했습니다.' });
  }
};
