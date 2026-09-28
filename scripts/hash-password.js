// 관리자 비밀번호 해시 만들기 — 결과를 Vercel 환경변수 ADMIN_PASSWORD_HASH 에 넣습니다.
// 사용: node scripts/hash-password.js            (비밀번호를 화면에 보이지 않게 입력)
//       node scripts/hash-password.js --secret   (ADMIN_SESSION_SECRET 용 무작위 값도 함께 출력)
const crypto = require('crypto');
const readline = require('readline');
const { hashPassword } = require('../lib/auth');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const pw = await askHidden('새 관리자 비밀번호(10자 이상): ');
  const again = await askHidden('한 번 더 입력: ');
  if (pw !== again) {
    console.error('두 비밀번호가 다릅니다.');
    process.exit(1);
  }
  console.log('\nADMIN_PASSWORD_HASH=' + (await hashPassword(pw)));
  if (process.argv.includes('--secret')) console.log('ADMIN_SESSION_SECRET=' + crypto.randomBytes(48).toString('base64url'));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
