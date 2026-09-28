// 개발 미리보기용 가짜 데이터 (실제 고객 아님 — 이름·번호·주소 모두 지어낸 시험값)
function iso(daysFromNow, hour = 10) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  d.setUTCHours(hour - 9, 0, 0, 0);
  return d.toISOString();
}
function ymd(daysFromNow) {
  return iso(daysFromNow).slice(0, 10);
}

async function seed(store) {
  const now = new Date().toISOString();
  const rs = [
    { id: 'RDEMO001', channel: 'kakao', userId: 'demo-kakao-1', status: '입금대기', customerName: '(시험) 김가상', phone: '010-0000-0001', address: '(시험) 서울 마포구 가상로 12, 301호', desiredDate: ymd(9), cleaningType: '입주청소', buildingType: '빌라', areaPyeong: 23, quoteAmount: 230000, deposit: 50000, balance: 180000, adminMemo: '', notes: '' },
    { id: 'RDEMO002', channel: 'web', userId: 'demo-web-1', status: '입금확인요청', customerName: '(시험) 이테스트', phone: '010-0000-0002', address: '(시험) 경기 성남시 분당구 예시로 5, 1203동 1502호', desiredDate: ymd(12), cleaningType: '이사청소', buildingType: '아파트', areaPyeong: 34, quoteAmount: 340000, deposit: 50000, balance: 290000, depositorName: '이테스트', paymentClaimedAt: now, adminMemo: '', notes: '베란다 확장' },
    { id: 'RDEMO003', channel: 'kakao', userId: 'demo-kakao-2', status: '방문견적요청', customerName: null, phone: '010-0000-0003', address: '(시험) 서울 강남구 샘플대로 100, 2층', visitAt: iso(3, 14).slice(0, 16).replace('T', ' '), buildingType: '사무실', adminMemo: '', notes: '층고 3m, 유리창 많음' },
    { id: 'RDEMO004', channel: 'kakao', userId: 'demo-kakao-3', status: '예약확정', customerName: '(시험) 박예시', phone: '010-0000-0004', address: '(시험) 서울 송파구 모의길 7, 5층', desiredDate: ymd(5), cleaningType: '입주청소', buildingType: '아파트', areaPyeong: 25, quoteAmount: 250000, deposit: 50000, balance: 200000, depositorName: '박예시', paymentClaimedAt: now, paymentVerified: true, paymentVerifiedAt: now, paymentVerifiedBy: 'admin', adminMemo: '팀장 배정 전' },
  ];
  for (const r of rs) {
    const rec = { paymentClaimedAt: null, paymentVerified: false, paymentVerifiedAt: null, paymentVerifiedBy: null, depositorName: null, ...r, createdAt: now, updatedAt: now, version: 1, history: [{ at: now, by: 'demo', action: '가짜 시험 데이터' }] };
    await store.cmd('HSET', 'cleanery:reservations', rec.id, JSON.stringify(rec));
  }
  const tracker = [
    { id: 'demo-t1', date: ymd(-10), site: '(시험) 역삼동 A사무실', type: '사무실', area: '45', floors: '3', height: '2.6', workers: '3', hours: '8', dirt: '4', neglect: '6', glass: '있음', elevator: '있음', parking: '가능', special: '곰팡이 약간', quote: 350000, final: 420000, cost: 300000, satisfaction: '만족', memo: '가짜 시험 데이터' },
    { id: 'demo-t2', date: ymd(-4), site: '(시험) 성수 공장', type: '공장', area: '120', floors: '1', height: '5', workers: '5', hours: '8', dirt: '5', neglect: '12', glass: '없음', elevator: '없음', parking: '가능', special: '기름때', quote: 1000000, final: 1100000, cost: 750000, satisfaction: '', memo: '가짜 시험 데이터' },
  ];
  await store.cmd('SET', 'cleanery:tracker:records', JSON.stringify(tracker));
  const conv = [
    ['demo-kakao-1', [['user', '빌라 입주청소 견적 문의드려요'], ['assistant', '신축인가요, 거주 중인 곳인가요?'], ['user', '신축이고 58㎡예요'], ['assistant', '예상 견적은 약 230,000원(VAT별도)입니다.']]],
    ['web:demo-web-1', [['user', '34평 아파트 이사청소요'], ['assistant', '예상 견적은 약 340,000원(VAT별도)입니다.'], ['user', '입금했어요 이테스트']]],
  ];
  for (const [id, msgs] of conv) {
    await store.cmd('SET', `cleanery:session:${id}`, JSON.stringify({ messages: msgs.map(([role, content]) => ({ role, content })) }), 'EX', 5184000);
    await store.cmd('ZADD', 'cleanery:sessions:index', String(Date.now()), id);
  }
  await store.cmd('LPUSH', 'cleanery:admin:notifications', JSON.stringify({ at: now, reason: '입금자명 확인 필요 - 이테스트', detail: '(가짜 시험 데이터)', delivered: false }));
}

module.exports = { seed };
