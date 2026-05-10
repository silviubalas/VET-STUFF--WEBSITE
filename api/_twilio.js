// Helper comun pentru SMS-uri Twilio.
// Pastreaza validarea si trimiterea intr-un singur loc, ca endpoint-urile sa fie simple.

export function getTwilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  return { sid, token, from, configured: Boolean(sid && token && from) };
}

export function normalizeRomanianPhone(phone) {
  const raw = String(phone || '').trim();
  const clean = raw.replace(/[\s\-().]/g, '');

  if (/^\+40\d{9}$/.test(clean)) return clean;
  if (/^0040\d{9}$/.test(clean)) return '+' + clean.slice(2);
  if (/^40\d{9}$/.test(clean)) return '+' + clean;
  if (/^0\d{9}$/.test(clean)) return '+4' + clean;
  if (/^7\d{8}$/.test(clean)) return '+40' + clean;

  return null;
}

export function phoneLastNine(phone) {
  const normalized = normalizeRomanianPhone(phone);
  return normalized ? normalized.slice(-9) : null;
}

export async function sendTwilioSms({ to, body }) {
  const cfg = getTwilioConfig();
  if (!cfg.configured) {
    return { ok: false, skipped: true, reason: 'SMS not configured' };
  }

  const normalizedTo = normalizeRomanianPhone(to);
  if (!normalizedTo) {
    return { ok: false, status: 400, error: 'Numar de telefon invalid' };
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: cfg.from,
        To: normalizedTo,
        Body: String(body || '').slice(0, 1500),
      }).toString(),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data.message || 'Twilio error',
      details: data,
    };
  }

  return { ok: true, sid: data.sid };
}
