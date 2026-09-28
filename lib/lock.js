// 짧은 저장소 잠금 — 같은 기록을 두 요청이 동시에 "읽고-확인하고-쓰는" 사이에 끼어들지 못하게 합니다.
const crypto = require('crypto');
const store = require('./store');

async function withLock(key, fn, { ttlSeconds = 5, tries = 30, waitMs = 100 } = {}) {
  const lockKey = `cleanery:lock:${key}`;
  const token = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < tries; i++) {
    if (await store.cmd('SET', lockKey, token, 'NX', 'EX', ttlSeconds)) {
      try {
        return await fn();
      } finally {
        if ((await store.cmd('GET', lockKey)) === token) await store.cmd('DEL', lockKey);
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw Object.assign(new Error('다른 저장이 진행 중입니다. 잠시 후 다시 시도해 주세요.'), { status: 423 });
}

module.exports = { withLock };
