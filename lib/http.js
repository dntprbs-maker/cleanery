// 서버리스 함수 공용 HTTP 도우미 (쿠키·요청 본문·클라이언트 IP)

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (e) {
      out[k] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function isHttps(req) {
  const proto = (req.headers && req.headers['x-forwarded-proto']) || '';
  if (proto) return proto.split(',')[0].trim() === 'https';
  return !!(req.socket && req.socket.encrypted);
}

function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Strict', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  return c;
}

function clientIp(req) {
  const fwd = (req.headers && (req.headers['x-real-ip'] || req.headers['x-forwarded-for'])) || '';
  const first = String(fwd).split(',')[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Vercel 은 JSON 본문을 req.body 로 파싱해 줍니다. 문자열로 온 경우만 한 번 더 파싱합니다.
function jsonBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch (e) {
      return {};
    }
  }
  return b;
}

// 관리자 화면에서 상태를 바꾸는 요청은 같은 사이트에서 온 것만 허용합니다.
// (쿠키는 SameSite=Strict 이고, 추가로 사용자 정의 헤더를 요구해 다른 사이트의 폼 전송을 막습니다.)
function isSameSiteWrite(req) {
  if ((req.headers['x-cleanery-admin'] || '') !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

module.exports = { parseCookies, serializeCookie, isHttps, clientIp, jsonBody, isSameSiteWrite };
