// 로컬 터미널에서 크리너리 상담봇과 실제로 대화해보는 테스트 스크립트.
// 카카오/버셀/Redis 없이, lib/business-info.js의 시스템 프롬프트 + OpenRouter만으로 동작합니다.
// 실행: node local-chat-test.js
// 필요: .env 파일에 OPENROUTER_API_KEY=실제키 값을 채워넣어야 합니다.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SYSTEM_PROMPT } = require('./lib/business-info');

// 아주 단순한 .env 로더 (외부 패키지 설치 없이 동작)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}
loadEnv();

if (!process.env.OPENROUTER_API_KEY) {
  console.error('❌ .env 파일에 OPENROUTER_API_KEY 값이 비어있어요. .env 파일을 열어서 키를 채워넣고 다시 실행해주세요.');
  process.exit(1);
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-haiku-4.5';
const SPLIT_MARKER = '===메시지분리===';

let history = [];

async function ask(utterance) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: utterance },
  ];

  const r = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      temperature: 0.4,
      messages,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`OpenRouter 요청 실패 (status ${r.status}): ${text}`);
  }

  const data = await r.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('OpenRouter 응답에 답변 내용이 없습니다.');

  history.push({ role: 'user', content: utterance });
  history.push({ role: 'assistant', content: answer });

  return answer;
}

function printBotReply(answer) {
  const bubbles = answer.split(SPLIT_MARKER).map((p) => p.trim()).filter(Boolean);
  for (const bubble of bubbles.length ? bubbles : [answer]) {
    console.log('\n🤖 크리너리 봇:');
    console.log(bubble);
  }
}

console.log('=== 크리너리 상담봇 로컬 테스트 ===');
console.log('카카오톡 대화라고 생각하고 메시지를 입력하세요. 종료하려면 "종료" 또는 Ctrl+C.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '나: ' });
rl.prompt();

// 입력 스트림이 파이프로 들어올 때(예: echo "..." | node local-chat-test.js), 마지막 줄 처리 중
// EOF로 'close'가 먼저 발생해 응답이 오기 전에 종료돼버리는 것을 막기 위해, 처리 중인 작업을
// 체이닝해서 'close' 시점에 끝까지 기다립니다.
let pendingWork = Promise.resolve();
let closed = false;

rl.on('line', (line) => {
  const text = line.trim();
  if (text === '종료' || text === 'exit') {
    rl.close();
    return;
  }
  if (!text) {
    if (!closed) rl.prompt();
    return;
  }
  pendingWork = pendingWork.then(async () => {
    try {
      const answer = await ask(text);
      printBotReply(answer);
    } catch (e) {
      console.error('⚠️ 오류:', e.message);
    }
    console.log('');
    if (!closed) rl.prompt();
  });
});

rl.on('close', async () => {
  closed = true;
  await pendingWork;
  console.log('\n테스트 종료.');
  process.exit(0);
});
