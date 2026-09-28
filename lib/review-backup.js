// 가상 상담 검토 자동 백업 (이 PC 검토 프로그램 전용)
// CLEANERY_REVIEW_BACKUP_DIR 가 있으면, 저장·복원·가져오기가 성공할 때마다 전체 검토 상태를
// 내보내기(JSON)와 같은 형식으로 백업 폴더에 남깁니다. 이 파일은 [JSON 가져오기]로 그대로 되돌릴 수 있습니다.
// - 작업 백업: review-YYYYMMDD-HHMMSS-<사유>.json, 최근 KEEP_RECENT 개만 보관
// - 일일 백업: daily-YYYYMMDD.json, 하루 1개(그날 마지막 상태), KEEP_DAILY 일치 보관
const fs = require('fs');
const path = require('path');
const review = require('./review');
const exporter = require('./review-export');

const KEEP_RECENT = 50;
const KEEP_DAILY = 90;

function dir() {
  return process.env.CLEANERY_REVIEW_BACKUP_DIR || '';
}

function enabled() {
  return !!dir();
}

function stamp(d = new Date()) {
  // 파일 이름은 한국 시각 기준
  const k = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
  return { day: k.slice(0, 10).replace(/-/g, ''), time: k.slice(11, 19).replace(/:/g, '') };
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function prune(prefix, keep) {
  const files = fs.readdirSync(dir()).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir(), f));
}

async function snapshot(reason = '저장') {
  if (!enabled()) return null;
  fs.mkdirSync(dir(), { recursive: true });
  const data = exporter.toJson(await review.allStates());
  data.backupReason = reason;
  const text = JSON.stringify(data, null, 2);
  const { day, time } = stamp();
  const safe = String(reason).replace(/[^0-9A-Za-z가-힣_-]/g, '').slice(0, 20) || 'backup';
  const name = `review-${day}-${time}-${safe}.json`;
  writeAtomic(path.join(dir(), name), text);
  writeAtomic(path.join(dir(), `daily-${day}.json`), text);
  prune('review-', KEEP_RECENT);
  prune('daily-', KEEP_DAILY);
  return name;
}

function list() {
  if (!enabled() || !fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => /^(review|daily)-.*\.json$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir(), f));
      return { name: f, size: st.size, savedAt: st.mtime.toISOString(), kind: f.startsWith('daily-') ? '일일' : '작업' };
    })
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

function read(name) {
  if (!enabled() || !/^(review|daily)-[0-9A-Za-z가-힣_-]+\.json$/.test(name)) return null;
  const f = path.join(dir(), name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

module.exports = { enabled, snapshot, list, read, dir };
