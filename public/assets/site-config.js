// 홈페이지 관리자 설정 — 확인된 값만 채웁니다. null 이면 화면에 "확인 필요(관리자 설정)"로 표시됩니다.
// (가격·후기·인증·실적은 확인되지 않은 내용을 넣지 않기 위해 항목 자체를 두지 않았습니다.)
window.CLEANERY_SITE = {
  companyName: '크리너리(Cleanery)',
  kakaoChannelUrl: 'http://pf.kakao.com/_veNfX', // 확인된 카카오톡 채널 주소
  serviceArea: '서울·경기', // 상담봇 운영 기준(business-info.js)과 동일
  phone: null,
  address: null,
  businessHours: null, // AI 상담은 24시간 가능(상담봇 기준). 전화·방문 운영시간은 확인 필요
  businessRegistrationNo: null,
  representative: null,
  privacyOfficer: null,
};
