// 관리자 화면 전달 — 로그인한 관리자에게만 HTML 을 보냅니다.
// /admin/tracker, /admin/conversations, /admin/reservations 주소가 vercel.json 에서 이 함수로 연결됩니다.
// 화면 파일은 공개 폴더(public)가 아닌 admin-pages/ 에 있어 직접 주소로는 열리지 않습니다.
const fs = require('fs');
const path = require('path');
const { getSession } = require('../lib/auth');

const PAGES = {
  tracker: 'tracker.html',
  conversations: 'conversations.html',
  reservations: 'reservations.html',
  review: 'review.html',
};

module.exports = async (req, res) => {
  const page = String((req.query && req.query.page) || 'reservations');
  const file = PAGES[page];
  res.setHeader('Cache-Control', 'no-store');
  if (!file) {
    res.status(404).send('Not found');
    return;
  }
  const session = await getSession(req).catch(() => null);
  if (!session) {
    res.statusCode = 302;
    res.setHeader('Location', `/admin/login?next=${encodeURIComponent('/admin/' + page)}`);
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin-pages', file), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).send(html);
};
