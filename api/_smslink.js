// Helper comun pentru SMS-uri via SMSlink.ro (Node / Vercel Serverless).
// Port direct al `supabase/functions/_shared/providers.ts` din CRM Vet Stuff,
// ca sa pastram aceeasi logica testata si pe site.
//
// Documentatie API: https://www.smslink.ro/sms-marketing-documentatie-api-rest.html
// Endpoint: POST https://secure.smslink.ro/sms/gateway/communicate/index.php
// Body form-encoded: connection_id, password, to, message, [sender]
// Raspuns 200: "MESSAGE_ID,SUCCESS_CODE" la succes  |  "-ERROR_CODE,DESCRIPTION" la esec.

export function getSmsLinkConfig() {
  const user = process.env.SMSLINK_USER;
  const password = process.env.SMSLINK_PASSWORD;
  const senderId = process.env.SMS_SENDER_ID || '';
  return { user, password, senderId, configured: Boolean(user && password) };
}

// Normalizeaza numerele RO la formatul national 0712345678 (10 cifre cu 0 initial).
// SMSlink cere acest format pentru destinatari RO.
export function normalizeRoPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0') && digits.length === 10) return digits;
  if (digits.startsWith('400') && digits.length === 12) return '0' + digits.slice(3);
  if (digits.startsWith('40') && digits.length === 11) return '0' + digits.slice(2);
  if (digits.length === 9) return '0' + digits;
  return null;
}

// Returneaza ultimele 9 cifre din numarul normalizat (folosit pt. cautare Airtable).
export function phoneLastNine(phone) {
  const normalized = normalizeRoPhone(phone);
  return normalized ? normalized.slice(-9) : null;
}

export async function sendSmsLink({ to, body }) {
  const cfg = getSmsLinkConfig();
  if (!cfg.configured) {
    return { ok: false, skipped: true, reason: 'SMS not configured' };
  }

  const normalizedTo = normalizeRoPhone(to);
  if (!normalizedTo) {
    return { ok: false, status: 400, error: 'Numar de telefon invalid' };
  }

  const form = new URLSearchParams({
    connection_id: cfg.user,
    password: cfg.password,
    to: normalizedTo,
    message: String(body || '').slice(0, 1500),
  });
  // Sender custom doar daca e setat si aprobat in SMSlink (altfel ERROR;13).
  // Daca e gol, SMSlink foloseste sender-ul default al conexiunii (numar scurt).
  if (cfg.senderId && cfg.senderId.trim()) {
    form.set('sender', cfg.senderId.trim());
  }

  let response;
  try {
    response = await fetch('https://secure.smslink.ro/sms/gateway/communicate/index.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (err) {
    return { ok: false, status: 502, error: 'Network error', details: String(err?.message || err) };
  }

  const text = await response.text();

  // Format succes: "MESSAGE_ID,SUCCESS_CODE" (ambele numerice pozitive)
  // Format eroare: "-ERROR_CODE,DESCRIPTION"
  const isSuccess = response.ok && /^\d+,/.test(text) && !text.startsWith('-');
  if (!isSuccess) {
    return {
      ok: false,
      status: response.status || 502,
      error: text || 'SMSlink error',
      details: text,
    };
  }

  const [messageId] = text.split(',');
  return { ok: true, sid: messageId };
}
