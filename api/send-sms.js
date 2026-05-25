// Vercel Serverless Function — trimite SMS de confirmare catre client cu codul de abonament
// Foloseste SMSlink.ro REST API. Credentialele sunt in variabile de mediu.

import { sendSubscriptionSms } from './_notifications.js';
import { rateLimit, requireInternalRequest } from './_security.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireInternalRequest(req, res)) return;
  if (!rateLimit(req, res, 'send-sms', { max: 4, windowMs: 60 * 60 * 1000 })) return;

  try {
    const result = await sendSubscriptionSms(req.body || {});
    if (!result.ok) {
      console.error('SMSlink error:', result);
      return res.status(result.status || 500).json({ error: result.error || 'SMSlink error' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('SMS fetch error:', err);
    return res.status(500).json({ error: 'Network error' });
  }
}
