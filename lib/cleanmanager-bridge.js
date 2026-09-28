// 크리너리 예약 → 클린메니저 일정 연동 인터페이스 (준비 단계)
//
// 지금 동작: 수동 복사(ManualCopySink) — 관리자 화면의 "일정 생성용 복사" 텍스트. 클린메니저 운영본은 건드리지 않습니다.
// 향후 자동 연동: CleanManagerApiSink 를 구현하면 됩니다(설계: docs/clean-manager-integration.md).
//   필요한 것: 클린메니저 쪽 서버 간 인증(서비스 토큰) + 일정 생성 API. 현재 클린메니저 create_event 는
//   사람 OAuth 로그인 기반 MCP 도구라 서버에서 바로 부를 수 없습니다.
//
// 필드는 클린메니저 functions/mcp/tools/events.js 의 create_event 입력과 같게 맞췄습니다(2026-09-28 확인):
//   title, start(YYYY-MM-DD), end?, allDay?, startTime?(HH:MM), endTime?, place?, contact?, description?, team?
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function won(n) {
  return n == null || n === '' ? '-' : Number(n).toLocaleString('ko-KR') + '원';
}

// 예약 → 클린메니저 create_event 입력. 확정되지 않은 예약은 변환하지 않습니다.
function toCleanManagerEvent(r) {
  if (!r) throw new Error('예약이 없습니다.');
  const date = r.status === '방문일정확정' ? String(r.visitAt || '').slice(0, 10) : r.desiredDate;
  if (!['예약확정', '방문일정확정'].includes(r.status)) throw new Error(`'${r.status}' 상태 예약은 일정으로 보낼 수 없습니다(예약확정·방문일정확정만).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('일정 날짜(YYYY-MM-DD)가 없습니다.');
  const time = r.status === '방문일정확정' ? (String(r.visitAt || '').match(/(\d{2}:\d{2})/) || [])[1] : undefined;
  const kind = r.status === '방문일정확정' ? '방문견적' : r.cleaningType || '청소';
  const lines = [
    `[크리너리 예약 ${r.id}]`,
    r.buildingType || r.areaPyeong ? `건물: ${[r.buildingType, r.areaPyeong ? r.areaPyeong + '평' : ''].filter(Boolean).join(' ')}` : null,
    r.quoteAmount ? `청소금액: ${won(r.quoteAmount)}(VAT별도) / 예약금: ${won(r.deposit)} / 잔금: ${won(r.balance)}` : null,
    r.paymentVerified ? `예약금 입금 확인: ${String(r.paymentVerifiedAt || '').slice(0, 10)} (${r.paymentVerifiedBy})` : null,
    r.notes ? `특이사항: ${r.notes}` : null,
    r.adminMemo ? `관리자 메모: ${r.adminMemo}` : null,
  ].filter(Boolean);
  const ev = {
    title: `[${kind}] ${r.customerName || '고객'}${r.address ? ' - ' + String(r.address).slice(0, 30) : ''}`,
    start: date,
    end: date,
    allDay: !time,
    place: r.address || undefined,
    contact: r.phone || undefined,
    description: lines.join('\n'),
    team: undefined, // 담당 팀은 작업 하루 전 배정 → 관리자가 클린메니저에서 지정
  };
  if (time) ev.startTime = time;
  return ev;
}

function weekdayLabel(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// 현재 방식: 사람이 클린메니저에 붙여넣을 텍스트
const ManualCopySink = {
  name: 'manual-copy',
  async send(reservation) {
    const ev = toCleanManagerEvent(reservation);
    const text = [
      '[클린메니저 일정 생성용 정보]',
      `제목: ${ev.title}`,
      `날짜: ${ev.start}(${weekdayLabel(ev.start)})${ev.startTime ? ' ' + ev.startTime : ''}`,
      `주소: ${ev.place || '-'}`,
      `연락처: ${ev.contact || '-'}`,
      ev.description,
      '담당팀: (작업 하루 전 배정)',
    ].join('\n');
    return { ok: true, mode: 'manual', text, event: ev };
  },
};

// 향후 자동 연동 자리 (아직 구현·연결하지 않음)
const CleanManagerApiSink = {
  name: 'clean-manager-api',
  async send() {
    return { ok: false, mode: 'api', error: '클린메니저 자동 연동은 아직 설정되지 않았습니다(서버용 인증·API 필요, 아빠 결정 대기).' };
  },
};

function currentSink() {
  return process.env.CLEANMANAGER_SYNC === 'api' ? CleanManagerApiSink : ManualCopySink;
}

module.exports = { toCleanManagerEvent, ManualCopySink, CleanManagerApiSink, currentSink };
