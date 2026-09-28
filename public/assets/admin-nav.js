// 관리자 화면 공통: 상단 메뉴(예약·상담내역·견적프로그램·로그아웃) + 로그인 만료 시 로그인 화면으로 이동
(function () {
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return realFetch(input, init).then(function (res) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (res.status === 401 && url.indexOf('/api/') !== -1 && url.indexOf('/api/admin') === -1) {
        location.href = '/admin/login?next=' + encodeURIComponent(location.pathname);
      }
      return res;
    });
  };

  function build() {
    if (document.getElementById('cln-admin-nav')) return;
    var style = document.createElement('style');
    style.textContent =
      '#cln-admin-nav{position:sticky;top:0;z-index:50;display:flex;gap:6px;align-items:center;flex-wrap:wrap;' +
      'padding:8px 12px;background:#0f2a4a;font:600 14px/1.2 system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}' +
      '#cln-admin-nav a,#cln-admin-nav button{color:#fff;text-decoration:none;padding:8px 10px;border-radius:8px;border:0;' +
      'background:transparent;font:inherit;cursor:pointer;min-height:36px}' +
      '#cln-admin-nav a[aria-current=page]{background:#14a3a3}' +
      '#cln-admin-nav .sp{flex:1}#cln-admin-nav .who{color:#b8c7d9;font-weight:500;font-size:12px}';
    document.head.appendChild(style);
    var nav = document.createElement('nav');
    nav.id = 'cln-admin-nav';
    nav.setAttribute('aria-label', '관리자 메뉴');
    var links = [['/admin/reservations', '예약 목록'], ['/admin/conversations', '상담내역'], ['/admin/tracker', '견적 프로그램'], ['/admin/review', '상담 검토']];
    links.forEach(function (l) {
      var a = document.createElement('a');
      a.href = l[0];
      a.textContent = l[1];
      if (location.pathname === l[0]) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    });
    var sp = document.createElement('span');
    sp.className = 'sp';
    nav.appendChild(sp);
    var who = document.createElement('span');
    who.className = 'who';
    nav.appendChild(who);
    var out = document.createElement('button');
    out.type = 'button';
    out.textContent = '로그아웃';
    out.onclick = function () {
      realFetch('/api/admin?action=logout', { method: 'POST', headers: { 'X-Cleanery-Admin': '1' } }).finally(function () {
        location.href = '/admin/login';
      });
    };
    nav.appendChild(out);
    document.body.insertBefore(nav, document.body.firstChild);
    realFetch('/api/admin?action=me').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) who.textContent = d.username + ' 로그인됨';
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
