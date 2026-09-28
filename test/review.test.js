// 가상 상담 검토 시스템 자동시험
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { call, setupAdmin, loginCookie, resetStore, ADMIN_WRITE } = require('./helpers');
const reviewApi = require('../handlers/review');
const review = require('../lib/review');

test.beforeEach(async () => {
  resetStore();
  await setupAdmin();
});

const get = (cookie, query) => call(reviewApi, { cookie, query });
const save = (cookie, id, body) => call(reviewApi, { method: 'PUT', cookie, headers: ADMIN_WRITE, query: { action: 'save', id }, body });

test('로그인하지 않으면 목록·사례·내보내기·기준·저장 모두 차단', async () => {
  for (const q of [{ action: 'list' }, { action: 'case', id: 'C001' }, { action: 'export', format: 'docx' }, { action: 'standards' }]) {
    assert.equal((await get(undefined, q)).statusCode, 401, JSON.stringify(q));
  }
  assert.equal((await call(reviewApi, { method: 'PUT', headers: ADMIN_WRITE, query: { action: 'save', id: 'C001' }, body: {} })).statusCode, 401);
});

test('100건 목록: 번호·제목·유형·분류·난이도·상태, 현황 통계', async () => {
  const cookie = await loginCookie();
  const r = await get(cookie, { action: 'list' });
  assert.equal(r.body.items.length, 100);
  assert.deepEqual(r.body.items.map((i) => i.no), Array.from({ length: 100 }, (_, i) => i + 1));
  for (const k of ['id', 'no', 'title', 'category', 'channel', 'difficulty', 'status']) assert.ok(k in r.body.items[0], k);
  assert.equal(r.body.stats.total, 100);
  assert.equal(r.body.stats['미검토'], 100);
  assert.equal(r.body.stats.progressPercent, 0);
  assert.equal(new Set(r.body.items.map((i) => i.category)).size, 10);
  assert.equal(r.body.storage.durable, false, '시험(메모리) 환경은 임시 저장소라고 경고');
});

test('답변 수정 저장 → 다시 불러와도 유지, 원본 고객 발언·원본 파일은 불변', async () => {
  const cookie = await loginCookie();
  const before = fs.readFileSync(path.join(__dirname, '..', 'review', 'cases', '01-move-in.json'), 'utf8');
  const c = (await get(cookie, { action: 'case', id: 'C001' })).body;
  const staff = c.turns.find((t) => t.speaker === 'staff');
  const r = await save(cookie, 'C001', { version: 0, edits: { [staff.id]: '네, 크리너리입니다. 건물 유형부터 여쭤볼게요.' }, notes: { [staff.id]: '더 짧게' }, caseNote: '좋은 기본 사례' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.state.status, '수정 중', '미검토에서 수정하면 자동으로 수정 중');
  const again = (await get(cookie, { action: 'case', id: 'C001' })).body;
  const t = again.turns.find((x) => x.id === staff.id);
  assert.equal(t.final, '네, 크리너리입니다. 건물 유형부터 여쭤볼게요.');
  assert.equal(t.original, staff.original, '원본 보존');
  assert.equal(t.edited, true);
  assert.equal(t.note, '더 짧게');
  assert.equal(again.state.caseNote, '좋은 기본 사례');
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'review', 'cases', '01-move-in.json'), 'utf8'), before, '원본 파일 변경 없음');
});

test('고객 발언 수정 시도는 거부', async () => {
  const cookie = await loginCookie();
  const c = (await get(cookie, { action: 'case', id: 'C002' })).body;
  const cust = c.turns.find((t) => t.speaker === 'customer');
  const r = await save(cookie, 'C002', { version: 0, edits: { [cust.id]: '고객 말 바꾸기' } });
  assert.equal(r.statusCode, 400);
});

test('동시 수정: 오래된 버전으로 저장하면 409', async () => {
  const cookie = await loginCookie();
  const c = (await get(cookie, { action: 'case', id: 'C003' })).body;
  const sid = c.turns.find((t) => t.speaker === 'staff').id;
  assert.equal((await save(cookie, 'C003', { version: 0, edits: { [sid]: 'A 기기' } })).statusCode, 200);
  assert.equal((await save(cookie, 'C003', { version: 0, edits: { [sid]: 'B 기기' } })).statusCode, 409);
});

test('이전 버전 복원: 복원도 새 버전이 되고, 복원 전 상태도 이력에 남음', async () => {
  const cookie = await loginCookie();
  const c = (await get(cookie, { action: 'case', id: 'C004' })).body;
  const sid = c.turns.find((t) => t.speaker === 'staff').id;
  await save(cookie, 'C004', { version: 0, edits: { [sid]: '1차 수정' } });
  await save(cookie, 'C004', { version: 1, edits: { [sid]: '2차 수정' }, status: '검토 완료' });
  let d = (await get(cookie, { action: 'case', id: 'C004' })).body;
  assert.equal(d.state.version, 2);
  assert.equal(d.history[0].version, 1);
  const r = await call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'restore', id: 'C004' }, body: { targetVersion: 1, version: 2 } });
  assert.equal(r.statusCode, 200);
  d = (await get(cookie, { action: 'case', id: 'C004' })).body;
  assert.equal(d.state.version, 3);
  assert.equal(d.turns.find((t) => t.id === sid).final, '1차 수정');
  assert.equal(d.state.status, '수정 중');
  assert.ok(d.history.some((h) => h.version === 2 && h.status === '검토 완료'), '복원 전 상태 보관');
});

test('수정을 원문과 같게 되돌리면 수정 표시 해제', async () => {
  const cookie = await loginCookie();
  const c = (await get(cookie, { action: 'case', id: 'C005' })).body;
  const st = c.turns.find((t) => t.speaker === 'staff');
  await save(cookie, 'C005', { version: 0, edits: { [st.id]: '임시' } });
  await save(cookie, 'C005', { version: 1, edits: { [st.id]: st.original } });
  const d = (await get(cookie, { action: 'case', id: 'C005' })).body;
  assert.equal(d.turns.find((t) => t.id === st.id).edited, false);
});

test('내보내기: JSON·CSV(엑셀 BOM)·DOCX(유효한 워드 파일), 검토 완료만 필터', async () => {
  const cookie = await loginCookie();
  const c = (await get(cookie, { action: 'case', id: 'C006' })).body;
  const sid = c.turns.find((t) => t.speaker === 'staff').id;
  await save(cookie, 'C006', { version: 0, edits: { [sid]: '아빠가 고친 답변 <특수&문자>' }, status: '검토 완료' });
  const json = JSON.parse((await get(cookie, { action: 'export', format: 'json' })).body);
  assert.equal(json.items.length, 100);
  const approved = JSON.parse((await get(cookie, { action: 'export', format: 'json', only: 'approved' })).body);
  assert.deepEqual(approved.items.map((i) => i.no), [6]);
  const csv = (await get(cookie, { action: 'export', format: 'csv' })).body;
  assert.ok(csv.startsWith('﻿번호,제목'));
  assert.match(csv, /아빠가 고친 답변 <특수&문자>/);
  const docx = (await get(cookie, { action: 'export', format: 'docx' }));
  assert.match(docx.headers['content-type'], /wordprocessingml/);
  const buf = docx.body;
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const tmp = path.join(os.tmpdir(), `cln-${Date.now()}.docx`);
  fs.writeFileSync(tmp, buf);
  const py = `import zipfile,sys,xml.dom.minidom as m\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\nx=z.read('word/document.xml').decode('utf-8');m.parseString(x)\nprint(x.count('<w:p>')+x.count('<w:p '), '아빠가 고친 답변 &lt;특수&amp;문자&gt;' in x, '001. 신축 아파트' in x)`;
  const out = execFileSync('python', ['-c', py, tmp], { encoding: 'utf8' }).trim().split(' ');
  assert.ok(Number(out[0]) > 1000, '문단 수');
  assert.equal(out[1], 'True', '수정본 포함·특수문자 이스케이프');
  assert.equal(out[2], 'True');
});

test('가져오기: JSON 으로 다른 기기 수정 반영, 서버가 더 최신이면 건너뜀, 형식 아니면 거부', async () => {
  const cookie = await loginCookie();
  const c = (await get(cookie, { action: 'case', id: 'C007' })).body;
  const sid = c.turns.find((t) => t.speaker === 'staff').id;
  const file = { format: 'cleanery-review-export', items: [{ id: 'C007', version: 0, edits: { [sid]: '가져온 수정' }, notes: {}, status: '보류' }] };
  const r = await call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'import' }, body: file });
  assert.equal(r.body.applied, 1);
  const d = (await get(cookie, { action: 'case', id: 'C007' })).body;
  assert.equal(d.state.status, '보류');
  assert.equal(d.turns.find((t) => t.id === sid).final, '가져온 수정');
  await save(cookie, 'C007', { version: 1, edits: { [sid]: '서버에서 더 고침' } });
  const r2 = await call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'import' }, body: file });
  assert.equal(r2.body.applied, 0);
  assert.equal((await call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'import' }, body: { hello: 1 } })).statusCode, 400);
});

test('상담 기준 추출: 검토 완료 사례만 포함, 미검토·수정 중·보류는 제외, 봇에 자동 적용 안 함', async () => {
  const cookie = await loginCookie();
  const pick = async (id) => (await get(cookie, { action: 'case', id })).body;
  const c26 = await pick('C026');
  await save(cookie, 'C026', { version: 0, edits: { [c26.turns.find((t) => t.speaker === 'staff').id]: '정찰제라 할인은 어렵습니다(아빠 승인 문구).' }, status: '검토 완료' });
  const c47 = await pick('C047');
  await save(cookie, 'C047', { version: 0, status: '검토 완료' });
  const c48 = await pick('C048');
  await save(cookie, 'C048', { version: 0, edits: { [c48.turns.find((t) => t.speaker === 'staff').id]: '보류 사례 문구' }, status: '보류' });
  await save(cookie, 'C030', { version: 0, status: '수정 중' });
  const x = (await get(cookie, { action: 'standards' })).body;
  assert.deepEqual(x.approvedCases.sort((a, b) => a - b), [26, 47]);
  assert.equal(x.appliedToBot, false);
  const all = JSON.stringify(x);
  assert.match(all, /정찰제라 할인은 어렵습니다\(아빠 승인 문구\)/);
  assert.doesNotMatch(all, /보류 사례 문구/);
  assert.ok(!x.topics.some((t) => t.groups.some((g) => g.members.some((m) => m.caseNo === 30 || m.caseNo === 48))));
  const md = (await get(cookie, { action: 'standards', format: 'md' })).body;
  assert.match(md, /아빠 승인 전에는 상담봇 운영 규칙에 적용하지 않습니다/);
  const draft = JSON.parse((await get(cookie, { action: 'standards', format: 'draft' })).body);
  assert.equal(draft.tests.length, 2);
  // 상담봇 프롬프트는 이 과정에서 바뀌지 않음
  const { SYSTEM_PROMPT } = require('../lib/business-info');
  assert.doesNotMatch(SYSTEM_PROMPT, /아빠 승인 문구/);
});

test('상담 기준 추출: 서로 다른 며칠 전 기준이나 가능/불가가 섞이면 충돌로 표시', () => {
  const { findConflicts } = require('../lib/standards');
  const c = findConflicts([
    { ref: '#1-t2', text: '취소는 3일 전까지 환불됩니다.' },
    { ref: '#2-t4', text: '취소는 5일 전까지 환불됩니다.' },
    { ref: '#3-t2', text: '할인은 어렵습니다.' },
    { ref: '#4-t2', text: '할인 가능합니다.' },
  ]);
  assert.ok(c.some((x) => x.kind === '며칠 전 기준'));
  assert.ok(c.some((x) => x.kind.includes('할인')));
});

test('사례 데이터 무결성: 100건 모두 상담직원 답변과 고객 발언이 있고 실제 같은 번호 없음', () => {
  const cases = review.loadCases();
  assert.equal(cases.length, 100);
  for (const c of cases) {
    assert.ok(c.turns.some((t) => t.speaker === 'staff'), c.id);
    assert.ok(c.turns.some((t) => t.speaker === 'customer'), c.id);
    assert.ok(['전화', '문자'].includes(c.channel));
    assert.ok(['하', '중', '상'].includes(c.difficulty));
  }
  const phones = JSON.stringify(cases).match(/01[016789]-?\d{3,4}-?\d{4}/g) || [];
  assert.ok(phones.every((p) => /^010-0000-/.test(p)), '가상 번호(010-0000-xxxx)만 사용');
});
