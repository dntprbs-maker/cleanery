// 저장소 공용 모듈 — Upstash Redis(운영) 또는 메모리 저장소(개발·시험)를 같은 방식으로 씁니다.
//
// - 운영: KV_REST_API_URL / KV_REST_API_TOKEN 이 있으면 Upstash REST API 로 명령을 보냅니다.
//   값이 길어도 URL 길이 제한에 걸리지 않도록 명령을 JSON 배열 본문(POST)으로 보냅니다.
// - 개발·시험: 위 환경변수가 없거나 CLEANERY_STORE=memory 이면 프로세스 메모리에 저장합니다.
//   CLEANERY_DEV_STORE_FILE 이 있으면 그 JSON 파일에 저장해 개발 서버를 재시작해도 유지됩니다.
//
// 지원 명령(메모리 저장소 기준): GET SET(EX/NX) DEL EXISTS INCR EXPIRE TTL
//   ZADD ZREVRANGE(WITHSCORES) ZREM ZSCORE HSET HSETNX HGET HGETALL HDEL HLEN LPUSH LRANGE LTRIM
const fs = require('fs');

// 운영(production)이 아닌 Vercel 배포(미리보기 등)는 운영 Redis 키가 설정돼 있더라도 절대 쓰지 않습니다.
// 미리보기에서 운영 고객·견적 데이터를 읽거나 바꾸는 사고를 코드 차원에서 막기 위한 장치입니다.
function isNonProductionDeploy() {
  return !!process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production';
}

function useMemory() {
  if (process.env.CLEANERY_STORE === 'memory') return true;
  if (isNonProductionDeploy()) return true;
  return !(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// ---------------- Upstash ----------------
async function upstashCommand(args) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const r = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String)),
  });
  if (!r.ok) throw new Error(`Upstash 요청 실패 (status ${r.status})`);
  const data = await r.json();
  if (data && data.error) throw new Error(`Upstash 오류: ${data.error}`);
  return data ? data.result : null;
}

// ---------------- 메모리 저장소 ----------------
const mem = { data: new Map(), expires: new Map(), loaded: false };

function memParse(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.data !== 'object') throw new Error('저장소 형식이 아닙니다');
  const data = new Map();
  for (const [k, v] of Object.entries(raw.data || {})) {
    if (v && v.t === 'hash') data.set(k, new Map(Object.entries(v.v)));
    else if (v && v.t === 'zset') data.set(k, new Map(Object.entries(v.v).map(([m, s]) => [m, Number(s)])));
    else if (v && v.t === 'list') data.set(k, [...v.v]);
    else data.set(k, v && v.v);
  }
  const expires = new Map(Object.entries(raw.expires || {}).map(([k, t]) => [k, Number(t)]));
  return { data, expires };
}

// 파일이 깨졌을 때(비정상 종료·디스크 문제 등) 빈 저장소로 시작해 덮어쓰면 아빠의 수정 기록이 사라집니다.
// 그래서 깨진 파일은 .corrupt-<시각> 으로 따로 보관하고, 직전 정상본(.bak)에서 복구합니다.
// 둘 다 읽을 수 없으면 쓰기를 막아(readOnly) 남은 파일을 더 이상 건드리지 않습니다.
function memLoad() {
  if (mem.loaded) return;
  mem.loaded = true;
  const file = process.env.CLEANERY_DEV_STORE_FILE;
  if (!file) return;
  const candidates = [file, file + '.bak'].filter((f) => fs.existsSync(f));
  if (!candidates.length) return;
  for (const f of candidates) {
    try {
      const { data, expires } = memParse(f);
      mem.data = data;
      mem.expires = expires;
      if (f !== file) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${stamp}`);
        fs.copyFileSync(f, file);
        mem.recovered = f;
        console.error(`[store] 저장소 파일이 손상돼 직전 정상본(${f})으로 복구했습니다. 손상된 파일은 .corrupt 로 보관했습니다.`);
      }
      return;
    } catch (e) {
      console.error(`[store] 저장소 파일(${f})을 읽지 못했습니다:`, e.message);
    }
  }
  mem.readOnly = true;
  console.error('[store] 저장소 파일과 백업을 모두 읽지 못해 쓰기를 막았습니다. 파일을 확인해 주세요:', file);
}

function memStatus() {
  memLoad();
  return { readOnly: !!mem.readOnly, recovered: mem.recovered || null };
}

function memSave() {
  const file = process.env.CLEANERY_DEV_STORE_FILE;
  if (!file) return;
  const data = {};
  for (const [k, v] of mem.data) {
    if (v instanceof Map) {
      const isZ = [...v.values()].every((x) => typeof x === 'number');
      data[k] = { t: isZ && v.size ? 'zset' : 'hash', v: Object.fromEntries(v) };
    } else if (Array.isArray(v)) data[k] = { t: 'list', v };
    else data[k] = { t: 'string', v };
  }
  // 임시 파일에 끝까지 쓰고 디스크에 확정(fsync)한 뒤 교체 → 도중에 꺼져도 기존 파일은 온전합니다.
  // 교체 직전의 정상본은 .bak 로 남겨 다음 실행 때 손상 복구에 씁니다.
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify({ data, expires: Object.fromEntries(mem.expires) }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

function memAlive(key) {
  const exp = mem.expires.get(key);
  if (exp && exp <= Date.now()) {
    mem.data.delete(key);
    mem.expires.delete(key);
  }
  return mem.data.has(key);
}

const WRITE_CMDS = new Set(['SET', 'DEL', 'INCR', 'EXPIRE', 'ZADD', 'ZREM', 'HSET', 'HSETNX', 'HDEL', 'LPUSH', 'LTRIM']);

function memContainer(key, kind) {
  memAlive(key);
  let v = mem.data.get(key);
  if (v === undefined) {
    v = kind === 'list' ? [] : new Map();
    mem.data.set(key, v);
  }
  return v;
}

function memCommand(args) {
  memLoad();
  const [cmdRaw, key, ...rest] = args.map((a) => (a === undefined || a === null ? a : String(a)));
  const cmd = cmdRaw.toUpperCase();
  if (mem.readOnly && WRITE_CMDS.has(cmd)) {
    const err = new Error('저장소 파일이 손상돼 쓰기를 막았습니다. 관리자에게 알려 주세요.');
    err.status = 503;
    throw err;
  }
  let result = null;
  let changed = false;
  switch (cmd) {
    case 'GET':
      result = memAlive(key) ? mem.data.get(key) : null;
      break;
    case 'SET': {
      const opts = rest.slice(1).map((x) => x.toUpperCase());
      if (opts.includes('NX') && memAlive(key)) { result = null; break; }
      mem.data.set(key, rest[0]);
      mem.expires.delete(key);
      const exIdx = opts.indexOf('EX');
      if (exIdx >= 0) mem.expires.set(key, Date.now() + Number(rest[exIdx + 2]) * 1000);
      result = 'OK'; changed = true;
      break;
    }
    case 'DEL': {
      let n = 0;
      for (const k of [key, ...rest]) { if (memAlive(k)) { mem.data.delete(k); mem.expires.delete(k); n++; } }
      result = n; changed = n > 0;
      break;
    }
    case 'EXISTS': result = memAlive(key) ? 1 : 0; break;
    case 'INCR': {
      const cur = memAlive(key) ? Number(mem.data.get(key)) : 0;
      mem.data.set(key, String(cur + 1)); result = cur + 1; changed = true;
      break;
    }
    case 'EXPIRE':
      if (memAlive(key)) { mem.expires.set(key, Date.now() + Number(rest[0]) * 1000); result = 1; changed = true; } else result = 0;
      break;
    case 'TTL': {
      if (!memAlive(key)) { result = -2; break; }
      const exp = mem.expires.get(key);
      result = exp ? Math.ceil((exp - Date.now()) / 1000) : -1;
      break;
    }
    case 'ZADD': {
      const z = memContainer(key, 'zset');
      for (let i = 0; i < rest.length; i += 2) z.set(rest[i + 1], Number(rest[i]));
      result = rest.length / 2; changed = true;
      break;
    }
    case 'ZREVRANGE': {
      const z = memAlive(key) ? mem.data.get(key) : new Map();
      const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]);
      const start = Number(rest[0]);
      const stop = Number(rest[1]) < 0 ? sorted.length + Number(rest[1]) : Number(rest[1]);
      const slice = sorted.slice(start, stop + 1);
      result = rest[2] && rest[2].toUpperCase() === 'WITHSCORES' ? slice.flatMap(([m, s]) => [m, String(s)]) : slice.map(([m]) => m);
      break;
    }
    case 'ZREM': {
      const z = memAlive(key) ? mem.data.get(key) : new Map();
      let n = 0; for (const m of rest) if (z.delete(m)) n++;
      result = n; changed = n > 0;
      break;
    }
    case 'ZSCORE': {
      const z = memAlive(key) ? mem.data.get(key) : new Map();
      result = z.has(rest[0]) ? String(z.get(rest[0])) : null;
      break;
    }
    case 'HSET': {
      const h = memContainer(key, 'hash');
      let n = 0;
      for (let i = 0; i < rest.length; i += 2) { if (!h.has(rest[i])) n++; h.set(rest[i], rest[i + 1]); }
      result = n; changed = true;
      break;
    }
    case 'HSETNX': {
      const h = memContainer(key, 'hash');
      if (h.has(rest[0])) result = 0; else { h.set(rest[0], rest[1]); result = 1; changed = true; }
      break;
    }
    case 'HGET': { const h = memAlive(key) ? mem.data.get(key) : null; result = h && h.has(rest[0]) ? h.get(rest[0]) : null; break; }
    case 'HGETALL': { const h = memAlive(key) ? mem.data.get(key) : new Map(); result = [...h.entries()].flat(); break; }
    case 'HDEL': { const h = memAlive(key) ? mem.data.get(key) : new Map(); let n = 0; for (const f of rest) if (h.delete(f)) n++; result = n; changed = n > 0; break; }
    case 'HLEN': { const h = memAlive(key) ? mem.data.get(key) : new Map(); result = h.size; break; }
    case 'LPUSH': { const l = memContainer(key, 'list'); l.unshift(...rest.reverse()); result = l.length; changed = true; break; }
    case 'LRANGE': {
      const l = memAlive(key) ? mem.data.get(key) : [];
      const stop = Number(rest[1]) < 0 ? l.length + Number(rest[1]) : Number(rest[1]);
      result = l.slice(Number(rest[0]), stop + 1);
      break;
    }
    case 'LTRIM': {
      const l = memAlive(key) ? mem.data.get(key) : [];
      const stop = Number(rest[1]) < 0 ? l.length + Number(rest[1]) : Number(rest[1]);
      mem.data.set(key, l.slice(Number(rest[0]), stop + 1)); result = 'OK'; changed = true;
      break;
    }
    default:
      throw new Error(`메모리 저장소가 지원하지 않는 명령: ${cmd}`);
  }
  if (changed) memSave();
  return result;
}

async function cmd(...args) {
  const flat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return useMemory() ? memCommand(flat) : upstashCommand(flat);
}

function pairsToObject(flat) {
  const out = {};
  for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

// 시험용: 메모리 저장소 초기화
function _resetMemory() {
  mem.data = new Map();
  mem.expires = new Map();
  mem.loaded = false;
  mem.readOnly = false;
  mem.recovered = null;
}

module.exports = {
  cmd,
  isMemory: useMemory,
  isNonProductionDeploy,
  pairsToObject,
  _resetMemory,
  _memDump: () => mem,
  memStatus,
};
