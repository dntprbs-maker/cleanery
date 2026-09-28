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
const backup = require('../lib/review-backup');
const { requireAdmin } = require('../lib/auth');
const { jsonBody, isSameSiteWrite } = require('../lib/http');

function storageInfo() {
  if (!store.isMemory()) return { kind: 'redis', durable: true, message: '서버 저장소에 저장됩니다.' };
  const st = store.memStatus();
  if (st.readOnly) return { kind: 'file', durable: false, readOnly: true, message: '⚠ 저장 파일이 손상돼 저장을 막았습니다. 기존 파일은 그대로 보관돼 있습니다. 코드디에게 알려 주세요.' };
  if (process.env.CLEANERY_REVIEW_LOCAL === '1') {
    return { kind: 'file', durable: true, local: true, backups: backup.enabled(), recovered: !!st.recovered,
      message: (st.recovered ? '⚠ 저장 파일이 손상돼 직전 정상본으로 복구했습니다. ' : '') + '이 PC에 저장됩니다. 저장할 때마다 자동 백업이 만들어집니다.' };
  }
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
          issues: c.turns.filter((t) => t.issue).length, persona: c.persona, turns: c.turns.length,
          search: [c.title, c.situation, c.persona, ...c.tags, ...c.turns.map((t) => t.text), ...Object.values(state.edits), state.caseNote].join(' '),
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
    if (req.method === 'GET' && action === 'backups') {
      res.status(200).json({ enabled: backup.enabled(), items: backup.list().slice(0, 30) });
      return;
    }
    if (req.method === 'GET' && action === 'backup-file') {
      const text = backup.read(String(q.name || ''));
      if (!text) { res.status(404).json({ ok: false, error: '백업 파일을 찾을 수 없습니다.' }); return; }
      return send(res, text, 'application/json; charset=utf-8', String(q.name));
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
      if (out.status === 200) await backup.snapshot(String(q.id || '')).catch((e) => console.error('[review] 백업 실패:', e.message));
      res.status(out.status).json(out.status === 200 ? { ok: true, state: out.state } : { ok: false, error: out.error, state: out.state });
      return;
    }
    if (req.method === 'POST' && action === 'restore') {
      const out = await review.restore(String(q.id || ''), body.targetVersion, body.version, admin.username);
      if (out.status === 200) await backup.snapshot(`${q.id}복원`).catch((e) => console.error('[review] 백업 실패:', e.message));
      res.status(out.status).json(out.status === 200 ? { ok: true, state: out.state } : { ok: false, error: out.error, state: out.state });
      return;
    }
    if (req.method === 'POST' && action === 'import') {
      // 1) 파일 전체 검사 — 하나라도 이상하면 아무것도 바꾸지 않음
      const problems = review.checkImport(body);
      if (problems.length) {
        res.status(400).json({ ok: false, error: '가져오지 않았습니다(기존 데이터는 그대로입니다). ' + problems.slice(0, 5).join(' / ') + (problems.length > 5 ? ` 외 ${problems.length - 5}건` : ''), problems });
        return;
      }
      // 2) 가져오기 직전 상태를 백업
      const before = await backup.snapshot('가져오기전').catch((e) => { console.error('[review] 백업 실패:', e.message); return null; });
      if (backup.enabled() && !before) {
        res.status(500).json({ ok: false, error: '가져오기 전 백업을 만들지 못해 중단했습니다(기존 데이터는 그대로입니다).' });
        return;
      }
      const results = [];
      for (const it of body.items) {
        const cur = await review.getState(String(it.id));
        const incoming = { status: it.status || '미검토', edits: it.edits || {}, notes: it.notes || {}, caseNote: it.caseNote || '' };
        if (review.sameContent(cur, incoming)) { results.push({ id: it.id, result: '변경 없음' }); continue; }
        // 가져오는 파일의 버전이 현재보다 오래됐으면 덮어쓰지 않음(다른 기기·나중 수정 보호)
        // 단, 아빠가 "백업 시점으로 되돌리기"를 확인한 경우(overwriteNewer)는 반영 — 직전 상태는 위에서 백업했고 이전 버전 목록에도 남음
        if (Number(it.version || 0) < cur.version && q.overwriteNewer !== '1') { results.push({ id: it.id, result: '건너뜀(지금 저장된 쪽이 더 최신)' }); continue; }
        const out = await review.save(String(it.id), { version: cur.version, ...incoming }, admin.username, { reason: '가져오기 전 상태' });
        results.push({ id: it.id, result: out.status === 200 ? '반영' : out.error });
      }
      if (results.some((r) => r.result === '반영')) await backup.snapshot('가져오기후').catch(() => null);
      res.status(200).json({
        ok: true, results, backup: before,
        applied: results.filter((r) => r.result === '반영').length,
        skipped: results.filter((r) => r.result.startsWith('건너뜀')).length,
        unchanged: results.filter((r) => r.result === '변경 없음').length,
      });
      return;
    }
    if (req.method === 'POST' && action === 'backup') {
      if (!backup.enabled()) { res.status(400).json({ ok: false, error: '이 환경은 자동 백업 폴더가 없습니다. [JSON 전체(백업)]으로 내려받아 보관하세요.' }); return; }
      res.status(200).json({ ok: true, name: await backup.snapshot('수동백업') });
      return;
    }
    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[review] 실패:', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : '검토 처리 중 오류가 발생했습니다.' });
  }
};
