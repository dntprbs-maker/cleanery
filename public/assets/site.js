// 크리너리 홈페이지: 관리자 설정 표시, 모바일 메뉴, AI 상담 채팅 위젯(/api/web-chat)
(function () {
  var cfg = window.CLEANERY_SITE || {};
  var NEED = '확인 필요(관리자 설정)';

  // 관리자 설정 값 표시 (null 이면 "확인 필요" 배지)
  document.querySelectorAll('[data-cfg]').forEach(function (el) {
    var v = cfg[el.getAttribute('data-cfg')];
    if (v) el.textContent = v;
    else {
      var s = document.createElement('span');
      s.className = 'need';
      s.textContent = NEED;
      el.appendChild(s);
    }
  });
  document.querySelectorAll('[data-kakao]').forEach(function (a) {
    if (cfg.kakaoChannelUrl) a.href = cfg.kakaoChannelUrl;
    else a.hidden = true;
  });

  // 모바일 메뉴
  var menuBtn = document.querySelector('.menu-btn');
  var nav = document.getElementById('nav');
  menuBtn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') {
      nav.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // ---------------- 채팅 ----------------
  var chat = document.getElementById('chat');
  var log = document.getElementById('chat-log');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-text');
  var sendBtn = form.querySelector('button');
  var KEY = 'cleanery_web_chat_id';
  var memoryId = null;
  var started = false;
  var lastFocus = null;

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function getId() {
    try {
      var v = localStorage.getItem(KEY);
      if (!v) { v = newId(); localStorage.setItem(KEY, v); }
      return v;
    } catch (e) {
      if (!memoryId) memoryId = newId();
      return memoryId;
    }
  }
  function setId(v) {
    memoryId = v;
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function bubble(text, who) {
    var d = document.createElement('div');
    d.className = 'msg ' + who;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function greet() {
    bubble('안녕하세요, 크리너리입니다. 청소 종류와 건물 유형, 면적을 알려주시면 예상 견적을 안내해 드릴게요.', 'bot');
  }

  function openChat() {
    lastFocus = document.activeElement;
    chat.hidden = false;
    document.documentElement.style.overflow = window.innerWidth < 900 ? 'hidden' : '';
    if (!started) {
      started = true;
      post({ sessionId: getId(), history: true }).then(function (d) {
        if (d.ok && d.history && d.history.length) {
          bubble('이전 상담 내용을 불러왔어요.', 'sys');
          d.history.forEach(function (m) { bubble(m.text, m.role === 'bot' ? 'bot' : 'me'); });
        } else greet();
      }).catch(greet);
    }
    setTimeout(function () { input.focus(); }, 50);
  }
  function closeChat() {
    chat.hidden = true;
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.querySelectorAll('[data-open-chat]').forEach(function (b) { b.addEventListener('click', openChat); });
  chat.querySelector('.chat-x').addEventListener('click', closeChat);
  chat.querySelector('[data-close-chat]').addEventListener('click', closeChat);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !chat.hidden) closeChat(); });

  function busy(on) {
    input.disabled = on;
    sendBtn.disabled = on;
  }

  function post(body) {
    return fetch('/api/web-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function retryBubble(text) {
    var d = document.createElement('div');
    d.className = 'msg sys';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = '↻ 다시 보내기';
    b.style.cssText = 'border:1px solid #cfd8e3;background:#fff;border-radius:10px;min-height:40px;padding:0 14px;font:inherit;cursor:pointer';
    b.onclick = function () { d.remove(); send(text, true); };
    d.appendChild(b);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text, false);
  });

  function send(text, isRetry) {
    if (!isRetry) bubble(text, 'me');
    busy(true);
    var wait = bubble('답변 작성 중…', 'sys');
    post({ sessionId: getId(), message: text }).then(function (d) {
      wait.remove();
      if (d.ok) {
        (d.messages || []).forEach(function (m) { bubble(m, 'bot'); });
        if (d.hint) bubble(d.hint, 'sys');
      } else {
        bubble(d.error || '잠시 후 다시 시도해 주세요.', 'sys');
        retryBubble(text);
      }
    }).catch(function () {
      wait.remove();
      bubble('연결이 불안정해요. 잠시 후 다시 보내 주세요.', 'sys');
      retryBubble(text);
    }).then(function () {
      busy(false);
      input.focus();
    });
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
    }
  });

  chat.querySelector('.chat-new').addEventListener('click', function () {
    busy(true);
    post({ sessionId: getId(), reset: true }).then(function (d) {
      setId(d.sessionId || newId());
    }).catch(function () {
      setId(newId());
    }).then(function () {
      log.textContent = '';
      bubble('새 상담을 시작합니다.', 'sys');
      greet();
      busy(false);
    });
  });
})();
