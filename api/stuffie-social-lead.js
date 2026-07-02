// Vercel Serverless Function — creare lead securizat din STUFFIE Social (Messenger/IG).
//
// Apelat SERVER-TO-SERVER de workflow-ul n8n `stuffie-social` cu `x-internal-token`,
// DUPĂ ce brain-ul a răspuns. Închide bypass-ul anti-abuz: workflow-ul social
// trimite acum `create_crm_lead:false` (brain-ul nu mai inserează direct), iar
// lead-ul se creează aici cu ACEEAȘI securitate ca pe website (assessLeadRisk +
// dedup + blocklist + rate-limit), prin `maybeCreateStuffieLead`.
//
// Nu are Turnstile (nu e browser); protejat prin token intern + rate-limit pe
// identitatea socială (sender_id Meta), nu pe IP (toate mesajele social vin de
// la aceeași instanță n8n, deci IP-ul nu e o identitate utilă aici).

import { enforceBodySize, rateLimit, requireInternalRequest, setNoStore } from './_security.js';
import { leadSecurityContext, persistentRateLimit } from './_lead-security.js';
import { maybeCreateStuffieLead, supabaseFetch } from './_stuffie-message.js';

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireInternalRequest(req, res)) return; // 404 dacă tokenul intern lipsește/greșit
  if (!enforceBodySize(req, res, 32 * 1024)) return;
  if (!rateLimit(req, res, 'stuffie-social-lead', { max: 60, windowMs: 15 * 60 * 1000 })) return;

  const input = sanitize(req.body || {});
  if (!input.ok) return res.status(400).json({ error: input.error });

  // Identitatea de „device" pentru social = sender_id Meta (nu IP-ul n8n partajat),
  // ca rate-limit-ul și scorul de risc pe device să funcționeze per utilizator real.
  const context = leadSecurityContext(req, {
    ...req.body,
    deviceId: input.value.userId,
    user_id: input.value.userId,
  });

  const deviceLimit = await persistentRateLimit({
    supabaseFetch,
    name: 'stuffie-social-device',
    key: `${input.value.canal}:${input.value.userId}`,
    max: 20,
    windowMs: 15 * 60 * 1000,
  });
  if (!deviceLimit.ok) {
    return res.status(429).json({ ok: false, error: 'Prea multe mesaje într-un interval scurt.' });
  }

  try {
    const lead = await maybeCreateStuffieLead({
      body: { mesaj: input.value.mesaj, canal: input.value.canal, userId: input.value.userId },
      reply: input.value.raspuns,
      escalationType: input.value.escalationType,
      context,
      historyText: '',
    });
    return res.status(200).json({ ok: true, lead });
  } catch (err) {
    console.error('[stuffie-social-lead]', err?.message || err);
    return res.status(502).json({ ok: false, error: 'Lead creation failed' });
  }
}

function sanitize(body) {
  const canal = cleanKey(body.canal || 'messenger', 40) || 'messenger';
  const userId = cleanKey(body.user_id || body.userId || '', 120);
  const mesaj = String(body.mesaj || body.message || '').trim().slice(0, 3000);
  const raspuns = String(body.raspuns || body.reply || '').trim().slice(0, 8000);
  const escalationType = normalizeEscalation(body.escalation_type || body.escalationType || body.tip);

  if (!userId) return { ok: false, error: 'user_id (sender_id) lipsă' };
  if (!mesaj) return { ok: false, error: 'mesaj lipsă' };
  return { ok: true, value: { canal, userId, mesaj, raspuns, escalationType } };
}

function cleanKey(value, max = 80) {
  return String(value || '').trim().replace(/[^a-z0-9._:-]/gi, '').slice(0, max);
}

function normalizeEscalation(value) {
  const clean = String(value || '').trim().toUpperCase();
  return ['OM', 'URGENTA'].includes(clean) ? clean : '';
}
