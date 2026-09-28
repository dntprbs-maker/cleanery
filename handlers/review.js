// 가상 상담 검토 API — 관리자 로그인 필요
// GET  /api/review?action=list                         -> 100건 목록 + 검토 현황
// GET  /api/review?action=case&id=C001                 -> 사례 + 수정 상태 + 이전 버전 목록
// PUT  /api/review?action=save&id=C001                 -> body { version, edits, notes, caseNote, status }
// POST /api/review?action=restore&id=C001              -> body { targetVersion, version }
// POST /api/review?action=import                       -> body (JSON 내보내기 파일) : 수정·상태만 반영
// GET  /api/review?action=export&format=json|csv|docx[&only=approved]
// GET  /api/review?action=standards[&format=json|md|docx|draft]  -> 검토 완료 사례에서만 기준 후보 추출
const review = require('../lib/review');
const exporter = require('../lib/review-export');
const standards = require('../lib/standards');
const store = require('../lib/store');
const { requireAdmin } = require('../lib/auth');
const { jsonBody, isSameSiteWrite } = require('../lib/http');

function storageInfo() {
  if (!store.isMemory()) return { kind: 'redis', durable: true, message: '서버 저장소에 저장됩니다.' };
  if (process.env.CLEANERY_DEV_STORE_FILE) return { kind: 'file', durable: true, message: '이 PC의 개발 서버 파일에 저장됩니다(이 서버를 통해서만 보임).' };
  return { kind: 'memory', durable: false, message: '⚠ 이 환경은 임시 저장소입니다. 서버가 재시작되면 수정 내용이 사라질 수 있으니 JSON으로 내려받아 보관하세요.' };
}

function send(res, buf, type, filename) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.status(200).send(buf);
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const action = q.action || 'list';
  const today = new Date().toISOString().slice(0, 10);

  try {
    if (req.method === 'GET' && action === 'list') {
      const rows = await review.allStates();
      res.status(200).json({
        items: rows.map(({ case: c, state }) => ({
          id: c.id, no: c.no, title: c.title, category: c.category, channel: c.channel, difficulty: c.difficulty,
          status: state.status, edited: Object.keys(state.edits).length, updatedAt: state.updatedAt, policy: c.policy.length,
        })),
        stats: review.stats(rows),
        statuses: review.STATUSES,
        storage: storageInfo(),
      });
      return;
    }
    if (req.method === 'GET' && action === 'case') {
      const c = review.getCase(String(q.id || ''));
      if (!c) { res.status(404).json({ ok: false, error: '사례를 찾을 수 없습니다.' }); return; }
      const state = await review.getState(c.id);
      const history = (await review.getHistory(c.id)).map((h) => ({ version: h.version, status: h.status, edited: Object.keys(h.edits || {}).length, updatedAt: h.updatedAt, updatedBy: h.updatedBy, archivedAt: h.archivedAt, archivedReason: h.archivedReason }));
      res.status(200).json({ case: c, state, turns: review.finalTurns(c, state), history, storage: storageInfo() });
      return;
    }
    if (req.method === 'GET' && action === 'export') {
      const rows = exporter.filterRows(await review.allStates(), q.only);
      const suffix = q.only === 'approved' ? '_검토완료' : '';
      if (q.format === 'csv') return send(res, exporter.toCsv(rows), 'text/csv; charset=utf-8', `크리너리_가상상담${suffix}_${today}.csv`);
      if (q.format === 'docx') return send(res, exporter.toDocx(rows, { title: q.only === 'approved' ? '크리너리 가상 상담 — 검토 완료 사례' : undefined }), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', `크리너리_가상상담${suffix}_${today}.docx`);
      return send(res, JSON.stringify(exporter.toJson(rows), null, 2), 'application/json; charset=utf-8', `크리너리_가상상담${suffix}_${today}.json`);
    }
    if (req.method === 'GET' && action === 'standards') {
      const x = await standards.extract();
      if (q.format === 'md') return send(res, standards.toMarkdown(x), 'text/markdown; charset=utf-8', `크리너리_상담기준후보_${today}.md`);
      if (q.format === 'docx') return send(res, standards.toDocx(x), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', `크리너리_상담기준후보_${today}.docx`);
      if (q.format === 'draft') return send(res, JSON.stringify(standards.toBotDraft(x), null, 2), 'application/json; charset=utf-8', `크리너리_상담봇규칙초안_${today}.json`);
      res.status(200).json(x);
      return;
    }

    if (!isSameSiteWrite(req)) {
      res.status(403).json({ ok: false, error: '허용되지 않은 요청입니다.' });
      return;
    }
    const body = jsonBody(req);

    if (req.method === 'PUT' && action === 'save') {
      const out = await review.save(String(q.id || ''), body, admin.username);
      res.status(out.status).json(out.status === 200 ? { ok: true, state: out.state } : { ok: false, error: out.error, state: out.state });
      return;
    }
    if (req.method === 'POST' && action === 'restore') {
      const out = await review.restore(String(q.id || ''), body.targetVersion, body.version, admin.username);
      res.status(out.status).json(out.status === 200 ? { ok: true, state: out.state } : { ok: false, error: out.error, state: out.state });
      return;
    }
    if (req.method === 'POST' && action === 'import') {
      if (body.format !== 'cleanery-review-export' || !Array.isArray(body.items)) {
        res.status(400).json({ ok: false, error: '크리너리 검토 내보내기(JSON) 파일이 아닙니다.' });
        return;
      }
      const results = [];
      for (const it of body.items) {
        const cur = await review.getState(String(it.id));
        // 가져오는 파일의 버전이 현재보다 오래됐으면 덮어쓰지 않음(다른 기기 수정 보호)
        if (Number(it.version || 0) < cur.version) { results.push({ id: it.id, result: '건너뜀(서버 쪽이 더 최신)' }); continue; }
        const out = await review.save(String(it.id), { version: cur.version, edits: it.edits || {}, notes: it.notes || {}, caseNote: it.caseNote || '', status: it.status }, admin.username, { reason: '가져오기 전 상태' });
        results.push({ id: it.id, result: out.status === 200 ? '반영' : out.error });
      }
      res.status(200).json({ ok: true, results, applied: results.filter((r) => r.result === '반영').length });
      return;
    }
    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[review] 실패:', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : '검토 처리 중 오류가 발생했습니다.' });
  }
};
