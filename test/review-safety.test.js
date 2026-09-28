// 아빠 검토 기록 보호 시험: 파일 손상·비정상 종료·잘못된 백업 가져오기·자동 백업·재실행 후 유지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { call, setupAdmin, loginCookie, resetStore, ADMIN_WRITE, store } = require('./helpers');
const reviewApi = require('../handlers/review');

let tmp;
test.beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cln-review-'));
  process.env.CLEANERY_DEV_STORE_FILE = path.join(tmp, 'store.json');
  process.env.CLEANERY_REVIEW_BACKUP_DIR = path.join(tmp, 'backups');
  resetStore();
  await setupAdmin();
});
test.afterEach(() => {
  delete process.env.CLEANERY_DEV_STORE_FILE;
  delete process.env.CLEANERY_REVIEW_BACKUP_DIR;
  resetStore();
});

const save = (cookie, id, body) => call(reviewApi, { method: 'PUT', cookie, headers: ADMIN_WRITE, query: { action: 'save', id }, body });
const getCase = (cookie, id) => call(reviewApi, { cookie, query: { action: 'case', id } });
const imp = (cookie, body) => call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'import' }, body });
const restart = () => { store._resetMemory(); }; // 프로그램 종료 후 다시 실행 = 메모리 비우고 파일에서 다시 읽기

async function staffTurn(cookie, id) {
  const r = await getCase(cookie, id);
  return r.body.turns.find((t) => t.speaker === 'staff').id;
}

test('저장 → 프로그램 종료·재실행 → 수정·메모·상태 그대로', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C005');
  assert.equal((await save(cookie, 'C005', { version: 0, edits: { [tid]: '아빠가 고친 답변' }, notes: { [tid]: '너무 딱딱함' }, caseNote: '사례 메모', status: '수정 중' })).statusCode, 200);
  restart();
  const cookie2 = await loginCookie(); // 세션도 파일에 있지만 새로 로그인해도 무방
  const r = await getCase(cookie2, 'C005');
  const t = r.body.turns.find((x) => x.id === tid);
  assert.equal(t.final, '아빠가 고친 답변');
  assert.equal(t.note, '너무 딱딱함');
  assert.equal(r.body.state.caseNote, '사례 메모');
  assert.equal(r.body.state.status, '수정 중');
});

test('화면이 상태 "미검토"를 그대로 보내도, 답변을 고치면 자동으로 "수정 중"', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C006');
  const r = await save(cookie, 'C006', { version: 0, edits: { [tid]: '고침' }, notes: {}, caseNote: '', status: '미검토' });
  assert.equal(r.body.state.status, '수정 중');
  // 이미 다른 상태를 고른 경우는 그대로
  const r2 = await save(cookie, 'C006', { version: 1, edits: { [tid]: '또 고침' }, status: '보류' });
  assert.equal(r2.body.state.status, '보류');
});

test('여러 사례 연속 수정 후 재실행 — 서로 섞이지 않고 모두 유지', async () => {
  const cookie = await loginCookie();
  const ids = ['C001', 'C010', 'C050', 'C099'];
  for (const id of ids) {
    const tid = await staffTurn(cookie, id);
    assert.equal((await save(cookie, id, { version: 0, edits: { [tid]: `${id} 수정본` } })).statusCode, 200);
  }
  restart();
  const cookie2 = await loginCookie();
  for (const id of ids) {
    const r = await getCase(cookie2, id);
    assert.ok(r.body.turns.some((t) => t.final === `${id} 수정본`), id);
    assert.equal(r.body.state.status, '수정 중');
  }
});

test('저장 파일이 깨지면 직전 정상본(.bak)으로 복구, 깨진 파일은 따로 보관', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C002');
  await save(cookie, 'C002', { version: 0, edits: { [tid]: '첫 저장' } });
  await save(cookie, 'C002', { version: 1, edits: { [tid]: '두 번째 저장' } });
  // 비정상 종료로 본 파일이 반쯤 써진 상황
  fs.writeFileSync(process.env.CLEANERY_DEV_STORE_FILE, '{"data":{"cleanery:rev');
  restart();
  const cookie2 = await loginCookie();
  const r = await getCase(cookie2, 'C002');
  assert.ok(['첫 저장', '두 번째 저장'].includes(r.body.turns.find((t) => t.id === tid).final), '직전 정상본의 수정 내용이 남아 있어야 함');
  assert.ok(fs.readdirSync(tmp).some((f) => f.includes('.corrupt-')), '깨진 파일 보관');
  assert.equal(store.memStatus().recovered !== null, true);
});

test('본 파일·백업 모두 깨지면 쓰기를 막고 파일을 건드리지 않음(빈 데이터로 덮어쓰기 금지)', async () => {
  fs.writeFileSync(process.env.CLEANERY_DEV_STORE_FILE, 'garbage-1');
  fs.writeFileSync(process.env.CLEANERY_DEV_STORE_FILE + '.bak', 'garbage-2');
  restart();
  await assert.rejects(() => store.cmd('SET', 'x', '1'), /손상/);
  assert.equal(fs.readFileSync(process.env.CLEANERY_DEV_STORE_FILE, 'utf8'), 'garbage-1');
  assert.equal(store.memStatus().readOnly, true);
});

test('쓰다 만 임시파일(.tmp)이 남아 있어도 기존 저장 내용에 영향 없음', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C003');
  await save(cookie, 'C003', { version: 0, edits: { [tid]: '안전하게 저장됨' } });
  fs.writeFileSync(process.env.CLEANERY_DEV_STORE_FILE + '.tmp', '{"broken');
  restart();
  const r = await getCase(await loginCookie(), 'C003');
  assert.equal(r.body.turns.find((t) => t.id === tid).final, '안전하게 저장됨');
});

test('저장할 때마다 자동 백업이 생기고, 그 백업을 가져오면 되돌릴 수 있음', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C004');
  await save(cookie, 'C004', { version: 0, edits: { [tid]: '백업될 수정' }, status: '검토 완료' });
  const list = await call(reviewApi, { cookie, query: { action: 'backups' } });
  assert.ok(list.body.items.length >= 2, '작업 백업 + 일일 백업');
  const name = list.body.items.find((b) => b.kind === '작업').name;
  const file = await call(reviewApi, { cookie, query: { action: 'backup-file', name } });
  const backupJson = JSON.parse(file.body);
  assert.equal(backupJson.format, 'cleanery-review-export');
  // 이후 실수로 수정을 지워버림
  await save(cookie, 'C004', { version: 1, edits: { [tid]: (await getCase(cookie, 'C004')).body.turns.find((t) => t.id === tid).original }, status: '미검토' });
  // 백업으로 되돌리기: 버전이 낮아서 기본은 건너뜀(최신 보호) → 버전을 현재로 맞춘 파일로 복원하는 흐름은 '이전 버전 복원'으로 제공
  const r = await imp(cookie, backupJson);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.skipped, 1, '더 최신 저장을 덮어쓰지 않음');
  assert.equal((await getCase(cookie, 'C004')).body.state.status, '미검토');
  // 아빠가 "백업 시점으로 되돌리기"를 확인하면 반영
  const r2 = await call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'import', overwriteNewer: '1' }, body: backupJson });
  assert.equal(r2.body.applied, 1);
  const back = await getCase(cookie, 'C004');
  assert.equal(back.body.turns.find((t) => t.id === tid).final, '백업될 수정');
  assert.equal(back.body.state.status, '검토 완료');
  assert.ok(back.body.history.some((h) => h.status === '미검토'), '되돌리기 직전 상태도 이전 버전에 남음');
  // 경로 조작 차단
  assert.equal((await call(reviewApi, { cookie, query: { action: 'backup-file', name: '../store.json' } })).statusCode, 404);
});

test('백업 JSON 내보내기 → 새 PC(빈 저장소)에서 가져오기 → 모두 복원', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C007');
  await save(cookie, 'C007', { version: 0, edits: { [tid]: '이전할 수정' }, notes: { [tid]: '이유' }, status: '검토 완료', caseNote: '메모' });
  const exported = JSON.parse((await call(reviewApi, { cookie, query: { action: 'export', format: 'json' } })).body);
  // 새 환경
  fs.unlinkSync(process.env.CLEANERY_DEV_STORE_FILE);
  fs.rmSync(process.env.CLEANERY_DEV_STORE_FILE + '.bak', { force: true });
  restart();
  await setupAdmin();
  const c2 = await loginCookie();
  const r = await imp(c2, exported);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applied, 1);
  assert.equal(r.body.unchanged, 99);
  const got = await getCase(c2, 'C007');
  assert.equal(got.body.turns.find((t) => t.id === tid).final, '이전할 수정');
  assert.equal(got.body.state.status, '검토 완료');
  assert.equal(got.body.state.caseNote, '메모');
});

test('잘못된 백업 파일은 한 건도 반영하지 않고 기존 데이터 보호', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C008');
  await save(cookie, 'C008', { version: 0, edits: { [tid]: '지켜야 할 수정' } });
  const good = JSON.parse((await call(reviewApi, { cookie, query: { action: 'export', format: 'json' } })).body);
  const c8 = good.items.find((i) => i.id === 'C008');
  const custTurn = c8.turns.find((t) => t.speaker === '고객').id;
  const badFiles = [
    { hello: 1 },
    { ...good, items: [] },
    { ...good, items: [{ ...c8, edits: { [tid]: '덮어쓰기 시도' } }, { id: 'C999' }] }, // 없는 사례 섞임
    { ...good, items: [{ ...c8, version: 99, edits: { [custTurn]: '고객 말 조작' } }] }, // 고객 발언 수정 시도
    { ...good, items: [{ ...c8, version: 99, status: '아무거나' }] },
    { ...good, items: [c8, c8] }, // 중복
    { ...good, items: [{ ...c8, version: 99, edits: ['배열'] }] },
  ];
  for (const f of badFiles) {
    const r = await imp(cookie, f);
    assert.equal(r.statusCode, 400, JSON.stringify(f).slice(0, 80));
    assert.match(r.body.error, /가져오지 않았습니다|파일이 아닙니다|사례가 없습니다/);
  }
  const after = await getCase(cookie, 'C008');
  assert.equal(after.body.turns.find((t) => t.id === tid).final, '지켜야 할 수정');
  assert.equal(after.body.state.version, 1, '버전도 그대로');
});

test('기준 후보: 고치지 않은 "검토 포인트" 답변은 제외하고 따로 알림, 고친 답변은 포함', async () => {
  const cookie = await loginCookie();
  const c5 = await getCase(cookie, 'C005');
  const flagged = c5.body.turns.find((t) => t.issue);
  assert.ok(flagged, 'C005 에 검토 포인트가 있어야 함');
  await save(cookie, 'C005', { version: 0, status: '검토 완료' }); // 고치지 않고 완료
  let s = (await call(reviewApi, { cookie, query: { action: 'standards' } })).body;
  const allRefs = s.topics.flatMap((t) => t.groups.flatMap((g) => g.members.map((m) => m.ref)));
  assert.ok(!allRefs.includes(`#5-${flagged.id}`), '고치지 않은 문제 답변은 기준 후보 아님');
  assert.ok(s.unfixedIssues.some((u) => u.ref === `#5-${flagged.id}`));
  await save(cookie, 'C005', { version: 1, edits: { [flagged.id]: '팀장님 확인 후 문자로 남기겠습니다' }, status: '검토 완료' });
  s = (await call(reviewApi, { cookie, query: { action: 'standards' } })).body;
  assert.ok(s.topics.flatMap((t) => t.groups.flatMap((g) => g.members)).some((m) => m.ref === `#5-${flagged.id}` && m.edited));
  assert.equal(s.unfixedIssues.length, 0);
  assert.equal(s.appliedToBot, false);
});

test('아빠가 고친 뒤 사례 원본 문장이 바뀌면 "원본이 바뀐 수정"으로 표시', async () => {
  const review = require('../lib/review');
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C010');
  await save(cookie, 'C010', { version: 0, edits: { [tid]: '아빠 수정' } });
  let t = (await getCase(cookie, 'C010')).body.turns.find((x) => x.id === tid);
  assert.equal(t.originChanged, false);
  const turn = review.getCase('C010').turns.find((x) => x.id === tid);
  const before = turn.text;
  turn.text = '나중에 바뀐 원본 문장';
  try {
    t = (await getCase(cookie, 'C010')).body.turns.find((x) => x.id === tid);
    assert.equal(t.originChanged, true);
    assert.equal(t.editedFrom, before);
    assert.equal(t.final, '아빠 수정', '아빠 수정은 그대로 보존');
  } finally { turn.text = before; }
});

test('이전 버전 복원도 재실행 후 유지', async () => {
  const cookie = await loginCookie();
  const tid = await staffTurn(cookie, 'C009');
  await save(cookie, 'C009', { version: 0, edits: { [tid]: 'A안' } });
  await save(cookie, 'C009', { version: 1, edits: { [tid]: 'B안' } });
  const rr = await call(reviewApi, { method: 'POST', cookie, headers: ADMIN_WRITE, query: { action: 'restore', id: 'C009' }, body: { targetVersion: 1, version: 2 } });
  assert.equal(rr.statusCode, 200);
  restart();
  const r = await getCase(await loginCookie(), 'C009');
  assert.equal(r.body.turns.find((t) => t.id === tid).final, 'A안');
  assert.ok(r.body.history.length >= 2);
});
