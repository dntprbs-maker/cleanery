// 카카오 연동 환경변수 점검 (값은 출력하지 않음)
// 사용: node scripts/check-kakao-config.js   (.env 또는 현재 환경변수 기준)
const fs = require('fs');
const path = require('path');
const { checkOAuth } = require('../lib/kakao-config');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(KAKAO_[A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch (e) {}

for (const k of ['KAKAO_REST_API_KEY', 'KAKAO_REDIRECT_URI', 'KAKAO_CLIENT_SECRET']) {
  console.log(`${k}: ${process.env[k] ? '설정됨' : '비어 있음'}`);
}
const r = checkOAuth();
console.log(r.ok ? '\n✅ 카카오 알림(OAuth) 설정 형식 정상' : '\n❌ 확인 필요:\n- ' + r.problems.join('\n- '));
process.exit(r.ok ? 0 : 1);
