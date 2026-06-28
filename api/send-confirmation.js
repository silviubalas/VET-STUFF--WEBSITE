// Vercel Serverless Function — trimite email de confirmare catre client cu codul de abonament
// Foloseste Resend API. Token-ul este in variabila de mediu RESEND_API_KEY (NU ajunge in browser).

import { sendSubscriptionConfirmationEmail } from './_notifications.js';
import { enforceBodySize, rateLimit, requireInternalRequest, setNoStore } from './_security.js';

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireInternalRequest(req, res)) return;
  if (!enforceBodySize(req, res, 16 * 1024)) return;
  if (!rateLimit(req, res, 'send-confirmation', { max: 4, windowMs: 60 * 60 * 1000 })) return;

  const result = await sendSubscriptionConfirmationEmail(req.body || {});
  if (!result.ok) {
    console.error('[send-confirmation]', result);
    return res.status(result.status || 500).json({ error: result.error || 'Email error' });
  }
  return res.status(200).json({ ok: true });
}
