// 3·4단계 자동 회귀시험: 상담 품질 규칙 + 예약 구조화
// 9/28 전수조사의 시나리오(빌라 예약·입금 / 견적 전 예약·조기입금 / 정기청소 / 사무실 방문견적 / 장난 반복 종료)를
// 카카오·홈페이지 두 경로로 돌리고(총 10개), 조사에서 발견된 실패 사례를 추가했습니다.
// AI 응답은 대본(가짜 AI)으로 고정해 "코드가 보장해야 하는 동작"을 매번 같은 결과로 검증합니다.
// (실제 AI 품질은 test/live-scenarios.js 로 별도 확인)
const test = require('node:test');
const assert = require('node:assert/strict');
const { call, resetStore, store } = require('./helpers');

process.env.OPENROUTER_API_KEY = 'test-key-not-real';
const kakao = require('../api/kakao-skill');
const webChat = require('../handlers/web-chat');
const rules = require('../lib/consult-rules');
const reservations = require('../lib/reservations');

// ---------------- 가짜 AI / 가짜 외부 호출 ----------------
let script = [];
let seenPrompts = [];
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('openrouter.ai')) {
    const body = JSON.parse(init.body);
    seenPrompts.push(body.messages);
    const next = script.length ? script.shift() : '면적이 어떻게 되세요?';
    const text = typeof next === 'function' ? await next(body.messages) : next;
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  }
  if (u.startsWith('https://callback.test/')) {
    callbacks.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  }
  if (u.includes('ntfy.sh') || u.includes('kakao.com')) throw new Error('실제 알림 발송 시도 — 시험에서 금지');
  return realFetch(url, init);
};
let callbacks = [];

test.beforeEach(() => {
  resetStore();
  script = [];
  seenPrompts = [];
  callbacks = [];
});

// 두 경로를 같은 방식으로 부르는 도우미
const CHANNELS = {
  kakao: async (user, text) => {
    const r = await call(kakao, { method: 'POST', body: { userRequest: { utterance: text, user: { id: user } } } });
    return (r.body.template.outputs || []).map((o) => o.simpleText.text);
  },
  web: async (user, text) => {
    const r = await call(webChat, { method: 'POST', body: { sessionId: 'sess-user-' + user, message: text } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    return r.body.messages;
  },
};
const channelKey = (ch, user) => (ch === 'kakao' ? user : `web:sess-user-${user}`);

async function notifications() {
  return ((await store.cmd('LRANGE', 'cleanery:admin:notifications', '0', '-1')) || []).map((j) => JSON.parse(j));
}

const TEMPLATE = (date = '2026-10-10(토)') => `【 입주청소 예약 안내 】
♥ 청소일자 : ${date}   예약되셨읍니다.
♥ 고객명  :  홍길동
♥ 연락처 :  010-1234-5678
♥ 주   소 :    서울 마포구 망원로 10, 301호
♥ 청소금액 :       230,000원(VAT별도)
♥ 예 약 금  :       50,000원
♥  잔  금    :        180,000원
 은행명 : 새마을금고
 계좌번호 : 9003-1501-2107-4
 예금주 : 전윤정
★★★ 예약금 입금시 예약이 확정 되십니다.★★★
===메시지분리===
현장에서 금액이 추가되는 경우 …
[[예약정보: {"kind":"예약","customerName":"홍길동","phone":"010-1234-5678","address":"서울 마포구 망원로 10, 301호","desiredDate":"2026-10-10","cleaningType":"입주청소","buildingType":"빌라","areaPyeong":23,"quoteAmount":230000,"deposit":50000,"balance":180000,"notes":null}]]`;

for (const ch of ['kakao', 'web']) {
  // 시나리오 1: 빌라 예약·입금
  test(`[${ch}] 시나리오1 빌라 예약→입금: 예약 구조화 저장, 입금은 '확인요청'일 뿐 확정 아님, 호수 있는 주소 재질문 없음, 요일 교정`, async () => {
    const say = CHANNELS[ch];
    script = [
      '좋습니다! 빌라군요. 신축인가요, 거주 중인가요?',
      '면적이 어떻게 되세요?',
      '예상 견적은 약 230,000원(VAT별도)입니다.',
      '예약 진행을 위해 고객명, 연락처, 주소, 희망 날짜를 알려주시겠어요?',
      TEMPLATE('2026-10-10(수)'),
      '입금 알려주셔서 감사합니다.\n담당자가 계좌 입금을 확인한 뒤 예약이 최종 확정되며, 확인되면 따로 안내드리겠읍니다.\n참, 방문 전 정확한 주소(동/호수 등 상세 위치)를 한 번 더 알려주시겠어요?\n[[관리자알림: 입금자명 확인 필요 - 홍길동]]',
    ];
    const first = await say('u1', '빌라 청소요');
    assert.equal(first[0], '신축인가요, 거주 중인가요?', '되풀이 문구 제거');
    await say('u1', '신축이요');
    await say('u1', '58제곱미터');
    await say('u1', '예약할게요');
    const tpl = await say('u1', '홍길동 010-1234-5678 서울 마포구 망원로 10, 301호 10월 10일');
    assert.equal(tpl.length, 2, '예약 안내 + 추가요금 말풍선 2개');
    assert.match(tpl[0], /2026-10-10\(토\)/, '틀린 요일(수)을 실제 요일(토)로 교정');
    assert.doesNotMatch(tpl.join('\n'), /\[\[/, '마커는 고객에게 안 보임');
    const list = await reservations.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, '입금대기');
    assert.equal(list[0].quoteAmount, 230000);
    assert.equal(list[0].deposit, 50000);
    assert.equal(list[0].balance, 180000);
    assert.equal(list[0].desiredDate, '2026-10-10');
    const paid = await say('u1', '입금했어요 홍길동');
    assert.doesNotMatch(paid.join('\n'), /정확한 주소|동\/호수/, '호수 있는 주소는 재확인 질문 제거');
    assert.doesNotMatch(paid.join('\n'), /입금 확인 되었/, '실제 확인 전 "입금 확인됨" 표현 금지');
    const after = (await reservations.list())[0];
    assert.equal(after.status, '입금확인요청');
    assert.equal(after.paymentVerified, false, '관리자 승인 전 자동 확정 금지');
    assert.equal(after.depositorName, '홍길동');
    const notes = await notifications();
    assert.ok(notes.some((n) => n.reason.includes('입금자명 확인 필요 - 홍길동') && n.delivered === false));
  });

  // 시나리오 2: 견적 전 예약·조기 입금
  test(`[${ch}] 시나리오2 견적 전 예약/입금 시도: AI 가 계좌를 먼저 보내면 차단, 템플릿 전 입금 접수 차단`, async () => {
    const say = CHANNELS[ch];
    script = [
      TEMPLATE(), // 견적 없이 바로 예약 안내 → 위반
      TEMPLATE(), // 재작성에서도 위반 → 안전 문구
      '입금 알려주셔서 감사합니다.\n[[관리자알림: 입금자명 확인 필요 - 김철수]]', // 템플릿 전 입금 접수 → 위반
      '입금 알려주셔서 감사합니다.\n[[관리자알림: 입금자명 확인 필요 - 김철수]]',
    ];
    const a = await say('u2', '예약할게요');
    assert.doesNotMatch(a.join('\n'), /계좌번호/, '견적 전 계좌 안내 차단');
    assert.match(a.join('\n'), /견적/);
    const b = await say('u2', '입금했어요 김철수');
    assert.doesNotMatch(b.join('\n'), /감사합니다\.\n?$/);
    assert.equal((await reservations.list()).length, 0);
    assert.equal((await notifications()).length, 0, '템플릿 전 입금 알림은 관리자에게 보내지 않음');
    // AI 에게 상태 안내가 전달됐는지
    const sys = seenPrompts[0].filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(sys, /아직 고객에게 견적 금액/);
    assert.match(sys, /아직 \[예약 안내 템플릿\]/);
  });

  // 시나리오 3: 정기청소
  test(`[${ch}] 시나리오3 정기청소: 연락처를 받은 뒤 관리자 알림(번호 포함), 한 번만`, async () => {
    const say = CHANNELS[ch];
    script = [
      '정기청소 관련 상담은 연락처를 주시면 저희 팀장님께서 따로 연락드릴 거예요. 연락처를 알려주시겠어요?',
      '팀장님께서 곧 연락드릴게요.\n[[관리자알림: 팀장 연락 필요 - 정기청소 문의, 연락처 010-2222-3333]]',
    ];
    await say('u3', '정기청소 주기 어떻게 돼요?');
    assert.equal((await notifications()).length, 0);
    const b = await say('u3', '010-2222-3333');
    assert.doesNotMatch(b.join(''), /관리자알림/);
    const notes = await notifications();
    assert.equal(notes.length, 1);
    assert.match(notes[0].reason, /010-2222-3333/);
  });

  // 시나리오 4: 사무실 방문견적
  test(`[${ch}] 시나리오4 사무실 방문견적: 마커를 AI 가 빠뜨려도 관리자 알림 + 방문견적 예약 생성`, async () => {
    const say = CHANNELS[ch];
    script = [
      '상가·사무실은 인원 기준으로 최소 약 350,000원부터 시작해요. 정확한 금액은 현장 방문 확인 후 결정됩니다. 희망 방문 일시와 주소, 연락처를 알려주시겠어요?',
      '10월 2일(수) 오후 2시 방문 상담으로 예약해 둘게요.\n[[예약정보: {"kind":"방문견적","phone":"010-4444-5555","address":"서울 강남구 테헤란로 1, 3층","visitAt":"2026-10-02 14:00","buildingType":"사무실"}]]',
    ];
    await say('u4', '사무실 청소 견적이요');
    const b = await say('u4', '10월 2일 오후 2시, 강남구 테헤란로 1 3층, 010-4444-5555');
    assert.match(b[0], /10월 2일\(금\)/, '요일 교정(수→금)');
    const list = await reservations.list();
    assert.equal(list[0].status, '방문견적요청');
    assert.equal(list[0].phone, '010-4444-5555');
    const notes = await notifications();
    assert.equal(notes.length, 1, '마커 누락에도 방문견적 알림');
    assert.match(notes[0].reason, /010-4444-5555/);
    assert.match(notes[0].reason, /2026-10-02 14:00/);
  });

  // 시나리오 5: 장난 반복 → 종료 → 재시작
  test(`[${ch}] 시나리오5 종료 후: 무응답이며 저장 안 함(보관기간 연장 없음), "상담 다시 시작"으로 재시작, 옛 대화 보관`, async () => {
    const say = CHANNELS[ch];
    script = ['상담이 필요없으신것으로 간주하고 상담을 종료 하겠읍니다.'];
    await say('u5', 'ㅋㅋㅋ');
    const key = `cleanery:session:${channelKey(ch, 'u5')}`;
    const before = await store.cmd('GET', key);
    assert.ok(JSON.parse(before).terminatedAt);
    const silent = await say('u5', '메롱');
    assert.equal(silent.length, 0, '종료 후 무응답');
    assert.equal(await store.cmd('GET', key), before, '무응답 중에는 저장하지 않음');
    const restart = await say('u5', '상담 다시 시작할게요');
    assert.match(restart[0], /상담을 새로 시작/);
    const archives = [...store._memDump().data.keys()].filter((k) => k.startsWith(`cleanery:session-archive:${channelKey(ch, 'u5')}:`));
    assert.equal(archives.length, 1, '옛 대화는 지우지 않고 보관');
    script = ['어떤 건물인가요?'];
    const again = await say('u5', '아파트요');
    assert.equal(again.length, 1, '재시작 후 정상 응답');
  });
}

// ---------------- 추가 실패 사례 ----------------
test('종료 24시간 뒤 새 메시지는 자동으로 새 상담', async () => {
  await store.cmd('SET', 'cleanery:session:old1', JSON.stringify({
    messages: [{ role: 'user', content: 'ㅋ' }, { role: 'assistant', content: '상담이 필요없으신것으로 간주하고 상담을 종료 하겠읍니다.' }],
    terminatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
  }));
  script = ['건물 유형을 알려주세요.'];
  const out = await CHANNELS.kakao('old1', '청소 문의요');
  assert.equal(out[0], '건물 유형을 알려주세요.');
});

test('서버가 계산한 오늘 날짜·요일과 달력이 AI 에게 전달됨(한국시간)', () => {
  const ctx = rules.dateContext(new Date('2026-09-28T16:30:00Z')); // 한국시간 9/29 01:30
  assert.match(ctx, /오늘: 2026년 9월 29일 \(화요일\)/);
  assert.match(ctx, /10\/10\(토\)/);
});

test('요일 교정: 여러 표기, 맞는 요일은 그대로, 없는 날짜는 건드리지 않음', () => {
  const now = new Date('2026-09-28T03:00:00Z');
  assert.equal(rules.fixWeekdays('2026-10-10(수) 예약', now).text, '2026-10-10(토) 예약');
  assert.equal(rules.fixWeekdays('10월 10일(수)', now).text, '10월 10일(토)');
  assert.equal(rules.fixWeekdays('10월 10일 수요일', now).text, '10월 10일 토요일');
  assert.equal(rules.fixWeekdays('10월 10일(토)', now).fixes, 0);
  assert.equal(rules.fixWeekdays('2월 30일(월)', now).fixes, 0);
  assert.equal(rules.fixWeekdays('1월 5일(월)', now).text, '1월 5일(화)', '지난 달은 내년으로 계산(2027-01-05 화)');
});

test('되풀이 문구 제거: "34평 아파트군요", "좋습니다!", 질문은 보존, 전부 지워지면 원문 유지', () => {
  assert.equal(rules.stripEcho('34평 아파트군요. 방 개수가 어떻게 되세요?').text, '방 개수가 어떻게 되세요?');
  assert.equal(rules.stripEcho('좋습니다! 면적을 알려주세요.').text, '면적을 알려주세요.');
  assert.equal(rules.stripEcho('네, 알겠습니다. 희망 날짜를 알려주세요.').text, '희망 날짜를 알려주세요.');
  assert.equal(rules.stripEcho('신축이신가요?').text, '신축이신가요?');
  assert.equal(rules.stripEcho('좋습니다!').text, '좋습니다!');
});

test('주소 재확인: 호수·층이 없으면 질문 유지', () => {
  const hist = [{ role: 'user', content: '강남구 테헤란로 13길 23-3' }];
  const t = '참, 방문 전 정확한 주소(동/호수 등 상세 위치)를 한 번 더 알려주시겠어요?';
  assert.equal(rules.removeAddressReask(t, hist).text, t);
  assert.equal(rules.removeAddressReask(t, [{ role: 'user', content: '망원동 12-3 501호' }]).removed, true);
});

test('카카오 콜백 경로: 4.2초 초과 시 콜백으로 전송(가짜 콜백 주소)', async () => {
  script = [() => new Promise((r) => setTimeout(() => r('면적이 어떻게 되세요?'), 4400))];
  const res = await call(kakao, { method: 'POST', body: { userRequest: { utterance: '아파트요', user: { id: 'cb1' }, callbackUrl: 'https://callback.test/abc' } } });
  assert.equal(res.body.useCallback, true);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].template.outputs[0].simpleText.text, '면적이 어떻게 되세요?');
});

test('홈페이지 채팅: 세션 형식·길이·남용 제한, 다른 사이트 요청 차단', async () => {
  assert.equal((await call(webChat, { method: 'POST', body: { sessionId: 'x', message: 'hi' } })).statusCode, 400);
  assert.equal((await call(webChat, { method: 'POST', body: { sessionId: 'sess-abcdef12', message: 'a'.repeat(1001) } })).statusCode, 400);
  assert.equal((await call(webChat, { method: 'POST', headers: { origin: 'https://evil.example' }, body: { sessionId: 'sess-abcdef12', message: 'hi' } })).statusCode, 403);
  let last;
  for (let i = 0; i < 26; i++) last = await call(webChat, { method: 'POST', body: { sessionId: 'sess-flood001', message: '문의 ' + i }, ip: '10.2.2.' + i });
  assert.equal(last.statusCode, 429);
});

test('예약 관리: 실제 입금 확인 없이 예약확정 불가, 허용 안 된 상태 변경 거부, 기록 남김', async () => {
  const r = await reservations.upsertFromChat({ channel: 'web', userId: 'x1', data: { customerName: '(시험)', quoteAmount: 450000 }, kind: '예약' });
  assert.equal(r.deposit, 100000, '40만원 이상 예약금 10만원');
  assert.equal(r.balance, 350000);
  let out = await reservations.adminUpdate(r.id, { status: '예약확정' }, 'admin');
  assert.equal(out.status, 400);
  out = await reservations.adminUpdate(r.id, { status: '작업완료' }, 'admin');
  assert.equal(out.status, 400);
  out = await reservations.adminUpdate(r.id, { paymentVerified: true, status: '예약확정', fields: { adminMemo: '통장 확인' } }, 'admin');
  assert.equal(out.status, 200);
  assert.equal(out.record.status, '예약확정');
  assert.equal(out.record.paymentVerifiedBy, 'admin');
  assert.ok(out.record.history.some((h) => /실제 입금 확인함/.test(h.action)));
  const stale = await reservations.adminUpdate(r.id, { fields: { adminMemo: 'x' }, version: 1 }, 'admin');
  assert.equal(stale.status, 409, '오래된 화면에서 저장하면 충돌 안내');
});

test('클린메니저 연동 인터페이스: 확정 예약만 create_event 형식으로 변환, 수동 복사 유지', async () => {
  const bridge = require('../lib/cleanmanager-bridge');
  const r = await reservations.upsertFromChat({ channel: 'kakao', userId: 'cm1', data: { customerName: '(시험) 최테스트', phone: '010-0000-0009', address: '(시험) 서울 은평구 예시로 3, 201호', desiredDate: '2026-10-10', cleaningType: '입주청소', quoteAmount: 230000 }, kind: '예약' });
  assert.throws(() => bridge.toCleanManagerEvent(r), /예약확정/);
  const ok = (await reservations.adminUpdate(r.id, { paymentVerified: true, status: '예약확정' }, 'admin')).record;
  const ev = bridge.toCleanManagerEvent(ok);
  assert.equal(ev.start, '2026-10-10');
  assert.equal(ev.allDay, true);
  assert.equal(ev.contact, '010-0000-0009');
  assert.match(ev.title, /^\[입주청소\] \(시험\) 최테스트/);
  for (const k of Object.keys(ev)) assert.ok(['title', 'start', 'end', 'allDay', 'startTime', 'endTime', 'place', 'contact', 'description', 'team'].includes(k), k);
  const copy = await bridge.ManualCopySink.send(ok);
  assert.match(copy.text, /2026-10-10\(토\)/);
  assert.equal((await bridge.CleanManagerApiSink.send(ok)).ok, false, '자동 연동은 아직 비활성');
});
