// 크리너리 견적 프로그램(현장기록) API — 관리자 로그인 필요
//
// GET    /api/tracker            -> { records: [...] }            (삭제 표시된 기록 제외)
// POST   /api/tracker            -> body { record }               새 기록 1건 추가
// PUT    /api/tracker?id=...     -> body { record, version }      기록 1건 수정 (버전이 다르면 409)
// DELETE /api/tracker?id=...     -> body { version }              기록 1건 삭제 표시(데이터는 보존)
//
// [저장 구조 변경 2026-09-28] 예전에는 전체 배열을 통째로 덮어써서, 두 기기에서 동시에 저장하면
// 한쪽 내용이 사라지거나 빈 배열 한 번으로 전부 지워질 수 있었습니다. 이제 기록마다 따로 저장합니다.
// - 새 저장소: 해시 cleanery:tracker:v2 (필드=기록 id, 값=기록 JSON + _version 등)
// - 예전 저장소 cleanery:tracker:records 는 읽기만 하고 절대 수정·삭제하지 않습니다(백업 역할).
//   처음 조회할 때 예전 기록을 새 저장소로 한 번 복사합니다(이미 있는 id 는 덮어쓰지 않음).
const crypto = require('crypto');
const store = require('../lib/store');
const { requireAdmin } = require('../lib/auth');
const { jsonBody, isSameSiteWrite } = require('../lib/http');

const LEGACY_KEY = 'cleanery:tracker:records';
const HASH_KEY = 'cleanery:tracker:v2';
const MIGRATED_KEY = 'cleanery:tracker:v2:migrated';
const MAX_RECORD_BYTES = 20000;
const META_FIELDS = ['_version', '_createdAt', '_updatedAt', '_updatedBy', '_deleted', '_deletedAt', '_deletedBy', '_migratedFrom'];

async function migrateLegacyOnce() {
  if (await store.cmd('GET', MIGRATED_KEY)) return;
  const raw = await store.cmd('GET', LEGACY_KEY);
  let legacy = [];
  try {
    legacy = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('[tracker] 예전 기록 해석 실패 — 복사하지 않음:', e.message);
    return; // 해석 못 하면 표시도 남기지 않아 다음에 다시 시도
  }
  const now = new Date().toISOString();
  for (const rec of Array.isArray(legacy) ? legacy : []) {
    if (!rec || !rec.id) continue;
    await store.cmd('HSETNX', HASH_KEY, String(rec.id), JSON.stringify({
      ...rec, _version: 1, _createdAt: now, _updatedAt: now, _migratedFrom: LEGACY_KEY,
    }));
  }
  await store.cmd('SET', MIGRATED_KEY, now, 'NX');
}

function cleanInput(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (k === 'id' || k.startsWith('_')) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

async function readAll() {
  const flat = await store.cmd('HGETALL', HASH_KEY);
  const map = store.pairsToObject(flat);
  return Object.entries(map).map(([id, json]) => ({ id, ...JSON.parse(json) }));
}

async function readOne(id) {
  const json = await store.cmd('HGET', HASH_KEY, id);
  return json ? { id, ...JSON.parse(json) } : null;
}

// 같은 기록을 두 요청이 동시에 고치는 것을 막는 짧은 잠금(5초)
async function withLock(id, fn) {
  const lockKey = `cleanery:tracker:v2:lock:${id}`;
  const token = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < 20; i++) {
    if (await store.cmd('SET', lockKey, token, 'NX', 'EX', 5)) {
      try {
        return await fn();
      } finally {
        if ((await store.cmd('GET', lockKey)) === token) await store.cmd('DEL', lockKey);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Object.assign(new Error('다른 저장이 진행 중입니다. 잠시 후 다시 시도해 주세요.'), { status: 423 });
}

function toSaved(rec) {
  const { id, ...rest } = rec;
  return JSON.stringify(rest);
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    await migrateLegacyOnce();

    if (req.method === 'GET') {
      const records = (await readAll()).filter((r) => !r._deleted);
      res.status(200).json({ records });
      return;
    }

    if (!isSameSiteWrite(req)) {
      res.status(403).json({ ok: false, error: '허용되지 않은 요청입니다.' });
      return;
    }
    const body = jsonBody(req);
    const now = new Date().toISOString();

    if (req.method === 'POST') {
      const data = cleanInput(body.record);
      if (!data.site || !String(data.site).trim()) {
        res.status(400).json({ ok: false, error: '현장명을 입력해 주세요.' });
        return;
      }
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const rec = { id, ...data, _version: 1, _createdAt: now, _updatedAt: now, _updatedBy: admin.username };
      if (toSaved(rec).length > MAX_RECORD_BYTES) {
        res.status(413).json({ ok: false, error: '기록 내용이 너무 깁니다.' });
        return;
      }
      await store.cmd('HSETNX', HASH_KEY, id, toSaved(rec));
      res.status(201).json({ ok: true, record: rec });
      return;
    }

    const id = String((req.query && req.query.id) || '');
    if (!id) {
      res.status(400).json({ ok: false, error: '기록 id 가 필요합니다.' });
      return;
    }

    if (req.method === 'PUT' || req.method === 'DELETE') {
      const result = await withLock(id, async () => {
        const cur = await readOne(id);
        if (!cur || cur._deleted) return { status: 404, body: { ok: false, error: '기록을 찾을 수 없습니다(이미 삭제됐을 수 있음).' } };
        if (Number(body.version) !== Number(cur._version)) {
          return { status: 409, body: { ok: false, error: '다른 곳에서 먼저 수정된 기록입니다. 새로 불러온 뒤 다시 저장해 주세요.', record: cur } };
        }
        let next;
        if (req.method === 'PUT') {
          const data = cleanInput(body.record);
          if (data.site !== undefined && !String(data.site).trim()) return { status: 400, body: { ok: false, error: '현장명을 입력해 주세요.' } };
          const meta = Object.fromEntries(Object.entries(cur).filter(([k]) => META_FIELDS.includes(k)));
          const base = Object.fromEntries(Object.entries(cur).filter(([k]) => !META_FIELDS.includes(k)));
          next = { ...base, ...data, ...meta, id, _version: cur._version + 1, _updatedAt: now, _updatedBy: admin.username };
        } else {
          next = { ...cur, _deleted: true, _deletedAt: now, _deletedBy: admin.username, _version: cur._version + 1, _updatedAt: now };
        }
        if (toSaved(next).length > MAX_RECORD_BYTES) return { status: 413, body: { ok: false, error: '기록 내용이 너무 깁니다.' } };
        await store.cmd('HSET', HASH_KEY, id, toSaved(next));
        return { status: 200, body: { ok: true, record: next } };
      });
      res.status(result.status).json(result.body);
      return;
    }

    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[tracker] 처리 실패:', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : '저장소 처리 중 오류가 발생했습니다.' });
  }
};
