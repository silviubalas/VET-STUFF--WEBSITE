const rateBuckets = new Map();

const DEFAULT_ORIGINS = [
  'https://vet-stuff.ro',
  'https://www.vet-stuff.ro',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

export function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

export function enforceOrigin(req, res) {
  const origin = req.headers?.origin;
  if (!origin) return true;

  const allowed = new Set([
    ...DEFAULT_ORIGINS,
    ...String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  ]);

  if (allowed.has(origin)) return true;
  res.status(403).json({ error: 'Origin not allowed' });
  return false;
}

export function rateLimit(req, res, name, options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const max = options.max || 20;
  const ip = getClientIp(req);
  const key = `${name}:${ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    setRateHeaders(res, max, max - 1, Math.ceil((now + windowMs) / 1000));
    return true;
  }

  bucket.count += 1;
  const remaining = Math.max(0, max - bucket.count);
  setRateHeaders(res, max, remaining, Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > max) {
    res.status(429).json({ error: 'Too many requests' });
    return false;
  }
  return true;
}

export function setNoStore(res) {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

export function enforceBodySize(req, res, maxBytes = 32 * 1024) {
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (!contentLength || contentLength <= maxBytes) return true;
  res.status(413).json({ error: 'Payload too large' });
  return false;
}

export function isHoneypotFilled(body = {}) {
  const candidates = [
    body.website,
    body.company,
    body.url,
    body._gotcha,
    body.fields?.website,
    body.fields?.company,
    body.fields?.url,
    body.fields?._gotcha,
  ];
  return candidates.some(value => String(value || '').trim().length > 0);
}

export async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) {
    return process.env.REQUIRE_TURNSTILE === '1'
      ? { ok: false, error: 'Captcha missing' }
      : { ok: true, skipped: true };
  }

  const form = new URLSearchParams({
    secret,
    response: token,
  });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    return data.success ? { ok: true } : { ok: false, error: 'Captcha failed' };
  } catch {
    return process.env.REQUIRE_TURNSTILE === '1'
      ? { ok: false, error: 'Captcha verification failed' }
      : { ok: true, skipped: true };
  }
}

export function requireInternalRequest(req, res) {
  if (process.env.ALLOW_PUBLIC_NOTIFICATION_ENDPOINTS === '1') return true;
  const expected = process.env.INTERNAL_API_TOKEN;
  const received = req.headers?.['x-internal-token'];
  if (expected && received === expected) return true;
  res.status(404).json({ error: 'Not found' });
  return false;
}

function setRateHeaders(res, limit, remaining, reset) {
  if (typeof res.setHeader !== 'function') return;
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(reset));
}
