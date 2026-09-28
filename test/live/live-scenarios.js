// 실제 AI 상담 시험 (가짜 AI 회귀시험과 별개) — 실제 OpenRouter 모델로 대화하고 결과를 점검합니다.
// 운영 저장소·실제 알림은 쓰지 않습니다(메모리 저장소, 알림은 기록만). 비용이 드니 필요할 때만 실행.
// 실행: node test/live/live-scenarios.js  (.env 의 OPENROUTER_API_KEY 필요) → docs/live-ai-report.md
process.env.CLEANERY_STORE = 'memory';
process.env.CLEANERY_NOTIFY = 'log';
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NTFY_TOPIC', 'KAKAO_REST_API_KEY']) delete process.env[k];
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)$/);
  if (m) process.env.OPENROUTER_API_KEY = m[1].trim();
}
const { call } = require('../helpers');
const store = require('../../lib/store');
const webChat = require('../../handlers/web-chat');
const kakao = require('../../api/kakao-skill');
const reservations = require('../../lib/reservations');
const rules = require('../../lib/consult-rules');
const { SYSTEM_PROMPT } = require('../../lib/business-info');

let ipSeq = 0;
async function say(channel, user, text) {
  ipSeq++;
  if (channel === 'kakao') {
    const r = await call(kakao, { method: 'POST', body: { userRequest: { utterance: text, user: { id: user }, callbackUrl: undefined } }, ip: '10.9.' + (ipSeq % 250) + '.1' });
    return (r.body.template ? r.body.template.outputs : []).map((o) => o.simpleText.text).join('\n---\n');
  }
  const r = await call(webChat, { method: 'POST', body: { sessionId: 'live-' + user, message: text }, ip: '10.8.' + (ipSeq % 250) + '.1' });
  return (r.body.messages || []).join('\n---\n');
}
const notes = async () => ((await store.cmd('LRANGE', 'cleanery:admin:notifications', '0', '-1')) || []).map((j) => JSON.parse(j));
const resFor = async (user, channel) => (await reservations.list()).filter((r) => r.userId === (channel === 'kakao' ? user : 'live-' + user));
const has = (s, re) => re.test(s);
const weekdayOk = (text) => {
  const now = new Date();
  return rules.fixWeekdays(text, now).fixes === 0;
};

// 각 시나리오: { id, name, channel, turns: [...], check: async (answers, ctx) => [ [통과여부, 설명], ... ] }
const S = [];
for (const ch of ['kakao', 'web']) {
  S.push({ id: `A1-${ch}`, name: `빌라 58㎡ 예약→입금 (${ch})`, channel: ch, turns: ['빌라 입주청소 견적요', '신축이에요', '58제곱미터예요', '방2 화장실1', '예약할게요', '홍가상 010-0000-9001 가상시 가상구 한빛로 7, 301호, 10월 17일', '입금했어요 홍가상'],
    check: async (a, u) => {
      const all = a.join('\n'); const rs = await resFor(u, ch);
      return [[has(all, /23[0-9],000원|23만/), '빌라 58㎡ → 약 23만 원대 견적'], [has(a[5], /계좌번호/), '정보 받은 뒤 예약 안내(계좌)'], [rs.length === 1 && rs[0].status === '입금확인요청', `예약 기록 상태=입금확인요청 (실제: ${rs.map((r) => r.status).join(',') || '없음'})`], [!has(a[6], /입금 확인 되었|확정되었/), '입금 주장에 "확정" 표현 없음'], [!has(a[6], /정확한 주소|동\/호수/), '호수 있는 주소 재질문 없음'], [a.every(weekdayOk), '날짜·요일 일치']];
    } });
  S.push({ id: `A2-${ch}`, name: `견적 전 예약·조기입금 (${ch})`, channel: ch, turns: ['예약할게요', '입금했어요 김가상'],
    check: async (a, u) => [[!has(a.join('\n'), /계좌번호/), '견적 전 계좌 안내 없음'], [!has(a[1], /입금 확인 되었|감사합니다\.\s*담당자가 계좌/), '템플릿 전 입금 접수 안 함'], [(await notes()).filter((n) => n.detail.includes(ch === 'kakao' ? u : 'live-' + u)).length === 0, '관리자 입금 알림 없음']] });
  S.push({ id: `A3-${ch}`, name: `정기청소 (${ch})`, channel: ch, turns: ['정기청소 주기가 어떻게 돼요?', '010-0000-9003'],
    check: async (a, u) => { const n = (await notes()).filter((x) => x.detail.includes(ch === 'kakao' ? u : 'live-' + u)); return [[has(a[0], /연락처/), '연락처 요청'], [n.length === 1 && /010-0000-9003/.test(n[0].reason), `연락처 포함 알림 1건 (실제 ${n.length}건)`]]; } });
  S.push({ id: `A4-${ch}`, name: `사무실 방문견적 (${ch})`, channel: ch, turns: ['사무실 청소 견적이요 30평', '오염은 보통이고 층고 2.7미터, 엘리베이터 있어요', '10월 15일 오후 2시 방문 가능해요. 가상시 가상구 오피스로 5, 3층, 010-0000-9004'],
    check: async (a, u) => { const rs = await resFor(u, ch); const n = (await notes()).filter((x) => x.detail.includes(ch === 'kakao' ? u : 'live-' + u)); return [[!has(a[0], /\d{2,3},000원\(VAT별도\)입니다/) || has(a[0], /부터|현장/), '확정가 단정 안 함'], [rs.some((r) => r.status === '방문견적요청'), '방문견적 예약 기록'], [n.some((x) => /010-0000-9004/.test(x.reason)), '관리자 알림에 연락처 포함'], [a.every(weekdayOk), '날짜·요일 일치']]; } });
  S.push({ id: `A5-${ch}`, name: `장난 반복 → 종료 → 재시작 (${ch})`, channel: ch, turns: ['ㅋㅋㅋ', '메롱', 'ㅎㅎ 심심해', '바보', '놀자', '메롱메롱', '상담 다시 시작할게요'],
    check: async (a) => { const endIdx = a.findIndex((x) => x.includes('상담을 종료 하겠읍니다')); return [[endIdx >= 0, `종료 문구 발생 (턴 ${endIdx + 1})`], [endIdx < 0 || a.slice(endIdx + 1, 6).every((x) => x === ''), '종료 후 무응답'], [has(a[6], /새로 시작/), '재시작']]; } });
}
const C = (id, name, turns, check) => S.push({ id, name, channel: 'web', turns, check });
C('B01', '아파트 34평 신축 — 방·화장실 질문 없이 견적', ['아파트 34평 신축 입주청소 얼마예요?'], async (a) => [[has(a[0], /34[0-9],000원|34만/), '34만 원대'], [!has(a[0], /화장실[^.?]*(몇|개수)|방[^.?]*몇 개/), '방·화장실 개수 질문 안 함']]);
C('B02', '84타입 → 34평', ['84타입 아파트 신축이에요 얼마예요'], async (a) => [[has(a[0], /34평|34[0-9],000|34만/), '34평 환산']]);
C('B03', '단독주택 전용 30평', ['단독주택 입주청소요', '신축이고 등기상 30평이에요', '방3 화장실2요'], async (a) => [[has(a.join('\n'), /5[5-9]\d,000|6[0-1]\d,000|5[5-9]만|60만/), '약 59만~60만 원대(30÷0.76≈39.5평×15,000)']]);
C('B04', '상가주택 평당 12,000', ['상가주택 입주청소 단가가 어떻게 돼요?'], async (a) => [[has(a[0], /12,000|1만 2천/), '평당 12,000원 안내']]);
C('B05', '빌라 3룸 화장실 3', ['빌라 신축 전용 25평, 방3 화장실3이에요'], async (a) => [[has(a.join('\n'), /5만|50,000/), '화장실 초과 5만 원 가산'], [has(a.join('\n'), /3[7-9][0-9],000|3[7-9]만/), '약 38만 원대']]);
C('B06', '요일이 틀린 날짜 요청', ['아파트 25평 신축 25만원 맞죠? 10월 10일 수요일에 해주세요'], async (a) => [[a.every(weekdayOk), '답변 속 날짜·요일 일치'], [!has(a[0], /10월 10일\(수\)|10월 10일 수요일/), '틀린 요일 그대로 반복 안 함']]);
C('B07', '"다음 주 토요일" 날짜 계산', ['아파트 30평 신축 견적 받았고 다음 주 토요일에 예약하고 싶어요. 날짜 확인해 주세요'], async (a) => [[a.every(weekdayOk), '계산한 날짜의 요일 정확']]);
C('B08', '되풀이 문구', ['빌라예요'], async (a) => [[!has(a[0].split(/[.?!\n]/)[0], /군요|네요|좋습니다|알겠습니다/), `첫 문장 되풀이 없음: "${a[0].slice(0, 30)}"`]]);
C('B09', '말 바꾸기 25→32평', ['아파트 신축 25평이요', '아 잘못 말했어요 32평이에요'], async (a) => [[has(a[1], /32[0-9],000|32만/), '바뀐 평수로 재계산']]);
C('B10', '여러 질문 한꺼번에', ['34평 아파트 신축 얼마고요, 카드 결제 돼요? 청소하고 나온 쓰레기는 가져가세요?'], async (a) => [[has(a[0], /34[0-9],000|34만/), '견적'], [has(a[0], /계좌이체|카드[^.]*(안|어렵|불가)/), '카드 불가·계좌이체'], [has(a[0], /쓰레기[^.]*(수거하지|안|직접|고객)/), '쓰레기 미수거 안내']]);
C('B11', '할인 요구', ['아파트 34평 신축 34만원이라던데 30만원에 해주세요'], async (a) => [[!has(a[0], /할인해 ?드릴게요|30만 ?원에 (해|진행)/), '임의 할인 약속 없음'], [has(a[0], /정찰제|팀장/), '정찰제·팀장 상의 안내']]);
C('B12', '서비스 지역 밖', ['부산 해운대구 아파트 30평 입주청소 되나요'], async (a) => [[has(a[0], /서울|경기|어렵|불가/), '지역 불가 안내']]);
C('B13', '세금계산서', ['세금계산서 발행돼요?'], async (a) => [[has(a[0], /세금계산서[^.]*(안|어렵|불가)/), '세금계산서 불가'], [has(a[0], /현금영수증/), '현금영수증 가능']]);
C('B14', '취소 2일 전 환불', ['모레 예약한 청소 취소하면 예약금 돌려받을 수 있나요?'], async (a) => [[has(a[0], /3일|어렵|불가|안 됩니다|되지 않/), '3일 이내 환불 불가 안내']]);
C('B15', '공장 확정가 요구', ['공장 100평 청소 확정 금액으로 알려주세요'], async (a) => [[!has(a[0], /확정 금액은 \d/), '확정가 단정 안 함'], [has(a[0], /현장|방문/), '현장 방문 안내']]);
C('B16', '입금만 주장(템플릿 없이) 반복', ['아파트 25평이요', '입금했어요', '입금했다니까요 이가상'], async (a) => [[!has(a.join('\n'), /입금 확인 되었|예약이 확정/), '확정 표현 없음'], [(await notes()).filter((n) => /이가상/.test(n.reason)).length === 0, '관리자 입금 알림 없음']]);
C('B17', '호수 없는 주소는 재확인 허용', ['아파트 25평 신축이에요', '예약할게요', '박가상 010-0000-9017 가상시 가상구 한빛로 13, 10월 24일', '입금했어요 박가상'], async (a) => [[has(a.slice(2).join(' '), /계좌번호/), '견적 확인 후 예약 안내(계좌)'], [!has(a[3], /입금 확인 되었|확정되었/), '입금 주장에 확정 표현 없음']]);
C('B18', '상담 가능 시간', ['몇 시까지 상담돼요?'], async (a) => [[has(a[0], /24시간/), '24시간 안내']]);
C('B19', '반려동물 있는 집', ['고양이 있는 집인데 청소할 때 고양이 있어도 돼요?'], async (a) => [[has(a[0], /안 되|분리|맡기/), '작업 중 반려동물 분리 안내']]);
C('B20', '에어컨 청소 포함 여부', ['입주청소에 에어컨 청소도 포함인가요?'], async (a) => [[has(a[0], /별도|추가|포함되지/), '별도 옵션 안내']]);
C('B21', '입금 주장 후 "확정됐죠?" 재확인', ['아파트 24평 신축이요', '예약할게요', '최가상 010-0000-9021 가상시 가상구 한빛로 21, 1102호, 10월 23일', '입금했어요 최가상', '그럼 예약 확정된 거죠?'],
  async (a) => [[!has(a[4], /확정되었|확정됐습니다|확정입니다/), '실제 입금 확인 전 "확정" 단정 안 함'], [has(a[4], /확인|담당|연락/), '확인 후 연락 안내'], [a.every(weekdayOk), '날짜·요일 일치']]);
C('B22', '긴 조건 변경 — 평수·유형·날짜 한 번에 바꿈', ['아파트 신축 25평 10월 17일이요', '아 죄송해요 빌라고요 전용 20평, 날짜는 10월 24일로 바꿀게요'],
  async (a) => [[has(a[1], /26[0-9],000|26만|25[0-9],000/), '빌라 전용 20평 → 약 26만 원대 재계산'], [!has(a[1], /250,000원\(VAT별도\)입니다/), '예전 금액 그대로 안내 안 함'], [a.every(weekdayOk), '날짜·요일 일치']]);

async function runOne(sc) {
  const user = sc.id.toLowerCase().replace(/[^a-z0-9]/g, '') + Date.now().toString(36);
  const answers = [];
  const started = Date.now();
  for (const t of sc.turns) answers.push(await say(sc.channel, user, t));
  const checks = await sc.check(answers, user);
  return { ...sc, answers, checks, ms: Date.now() - started, pass: checks.every((c) => c[0]) };
}

(async () => {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY 없음');
  const results = [];
  for (let i = 0; i < S.length; i += 6) {
    results.push(...(await Promise.all(S.slice(i, i + 6).map(runOne))));
    process.stdout.write(`${results.length}/${S.length} `);
  }
  // 통신 오류(시뮬레이션): 잘못된 AI 키로 호출 → 폴백 문구, 서버 오류 없음
  const realKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'invalid-key-for-failure-test';
  const failAns = await say('web', 'failtest' + Date.now(), '아파트 30평이요');
  process.env.OPENROUTER_API_KEY = realKey;
  const failOk = /잠시 후|죄송/.test(failAns);

  const pass = results.filter((r) => r.pass).length;
  const lines = [
    '# 실제 AI 상담 시험 결과',
    '',
    `- 실행: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 모델 anthropic/claude-haiku-4.5 (OpenRouter) · 메모리 저장소 · 알림은 기록만`,
    `- 기존 10개 시나리오(5종 × 카카오·홈페이지) + 반례 ${S.length - 10}개 = **${S.length}개 중 ${pass}개 통과**`,
    `- 통신 오류(잘못된 AI 키 시뮬레이션): ${failOk ? '통과 — 폴백 안내 문구로 응답, 서버 오류 없음' : '실패'} (응답: "${failAns.slice(0, 60)}")`,
    '- 장시간 응답(4.2초 초과 → 카카오 콜백)은 가짜 AI 시험(test/consult.test.js)으로 검증',
    '',
    '| 결과 | 시나리오 | 점검 | 소요 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.pass ? '✅' : '❌'} | ${r.id} ${r.name} | ${r.checks.map((c) => (c[0] ? '✔ ' : '✘ ') + c[1]).join('<br>')} | ${(r.ms / 1000).toFixed(1)}초 |`),
    '',
    '## 대화 원문 (실패 사례 우선)',
    '',
  ];
  for (const r of [...results.filter((x) => !x.pass), ...results.filter((x) => x.pass)]) {
    lines.push(`### ${r.pass ? '✅' : '❌'} ${r.id} ${r.name}`, '');
    r.turns.forEach((t, i) => { lines.push(`- **고객:** ${t}`, `- **봇:** ${(r.answers[i] || '(무응답)').replace(/\n/g, ' ⏎ ')}`); });
    lines.push('');
  }
  fs.writeFileSync(path.join(__dirname, '..', '..', 'docs', 'live-ai-report.md'), lines.join('\n'));
  console.log(`\n실제 AI 시험: ${pass}/${S.length} 통과, 통신오류 시뮬레이션 ${failOk ? '통과' : '실패'}`);
  for (const r of results.filter((x) => !x.pass)) console.log('❌', r.id, r.name, '|', r.checks.filter((c) => !c[0]).map((c) => c[1]).join(' / '));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
