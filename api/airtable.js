// Vercel Serverless Function — proxy spre Airtable
// Tokenul Airtable este pastrat ca variabila de mediu AIRTABLE_TOKEN si nu ajunge niciodata in browser.

import { enforceOrigin, getClientIp, isHoneypotFilled, rateLimit, verifyTurnstile } from './_security.js';
import { notifyFormspree, sendClinicFormEmail } from './_notifications.js';

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const FIELD_RULES = {
  Programari: {
    'Name': 'string',
    'Telefon': 'string',
    'Email': 'emailOptional',
    'Nume animal': 'string',
    'Tip animal': 'string',
    'Serviciu': 'string',
    'Data preferata': 'dateOptional',
    'Data preferată': 'dateOptional',
    'Descriere': 'longString',
  },
  Newsletter: {
    'Name': 'stringOptional',
    'Email': 'email',
  },
  Feedback: {
    'Name': 'stringOptional',
    'Email': 'emailOptional',
    'Telefon': 'stringOptional',
    'Tip feedback': 'stringOptional',
    'Evaluare': 'stringOptional',
    'Rating': 'numberOptional',
    'Nume animal': 'stringOptional',
    'Tip animal': 'stringOptional',
    'Data vizitei': 'dateOptional',
    'Motivul vizitei': 'stringOptional',
    'Mesaj': 'longString',
    'Mesaj / Sugestii': 'longString',
    'Evaluari detaliate': 'longString',
    'Evaluări detaliate': 'longString',
    'Permisiune publicare': 'booleanOptional',
  },
  'Mesaje contact': {
    'Nume': 'string',
    'Email': 'email',
    'Telefon': 'stringOptional',
    'Subiect': 'stringOptional',
    'Mesaj': 'longString',
    'Sursa': 'stringOptional',
  },
};
const ALLOWED_TABLES = new Set(Object.keys(FIELD_RULES));
const REQUIRED_FIELDS = {
  Programari: ['Name', 'Telefon', 'Nume animal', 'Tip animal', 'Serviciu'],
  Newsletter: ['Email'],
  'Mesaje contact': ['Nume', 'Email', 'Mesaj'],
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!enforceOrigin(req, res)) return;
  if (!rateLimit(req, res, 'airtable', { max: 12, windowMs: 15 * 60 * 1000 })) return;

  if (isHoneypotFilled(req.body || {})) {
    return res.status(200).json({ ok: true });
  }

  const captcha = await verifyTurnstile(req.body?.turnstileToken, getClientIp(req));
  if (!captcha.ok) {
    return res.status(400).json({ error: captcha.error || 'Captcha failed' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server misconfigured: missing AIRTABLE_TOKEN' });
  }

  const { table, fields } = req.body || {};

  if (!table || !ALLOWED_TABLES.has(table)) {
    return res.status(400).json({ error: 'Invalid table' });
  }
  if (!fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'Invalid fields' });
  }

  const cleanFields = sanitizeFields(table, fields);
  if (!cleanFields) {
    return res.status(400).json({ error: 'Invalid fields' });
  }
  const missing = (REQUIRED_FIELDS[table] || []).filter(key => !cleanFields[key]);
  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Marime maxima a payload-ului (anti-abuz)
  const bodyStr = JSON.stringify(cleanFields);
  if (bodyStr.length > 8000) {
    return res.status(413).json({ error: 'Payload too large' });
  }

  try {
    const airtableRes = await fetch(
      'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(table),
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: cleanFields }),
      }
    );

    if (!airtableRes.ok) {
      const text = await airtableRes.text();
      console.error('[airtable] error', airtableRes.status, text.slice(0, 500));
      return res.status(airtableRes.status).json({ error: 'Airtable error' });
    }

    // IMPORTANT: pe Vercel funcția se îngheață după răspuns → notificările pornite
    // fără await nu se executau (clinica nu primea email la contact/feedback/newsletter).
    // Trimitem email direct prin Resend (sigur) + Formspree (backup), awaited.
    const replyToEmail = cleanFields.Email || cleanFields.email || '';
    const [clinicEmail, formspree] = await Promise.allSettled([
      sendClinicFormEmail({
        subject: formSubject(table),
        heading: formHeading(table),
        fields: cleanFields,
        replyToEmail,
      }),
      notifyFormspree(formSubject(table), cleanFields),
    ]);
    if (clinicEmail.status === 'rejected' || clinicEmail.value?.ok === false) {
      console.error('[airtable] clinic email failed', clinicEmail.reason || clinicEmail.value?.error);
    }
    if (formspree.status === 'rejected' || formspree.value?.ok === false) {
      console.error('[airtable] formspree failed', formspree.reason || formspree.value?.status);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}

function formSubject(table) {
  return {
    Programari: 'Programare online — VET STUFF',
    Newsletter: 'Newsletter — abonare nouă',
    Feedback: 'Feedback — VET STUFF',
    'Mesaje contact': 'Mesaj contact — VET STUFF',
  }[table] || `Formular ${table} — VET STUFF`;
}

function formHeading(table) {
  return {
    Programari: 'Cerere nouă de programare',
    Newsletter: 'Abonare nouă la newsletter',
    Feedback: 'Feedback nou de la un client',
    'Mesaje contact': 'Mesaj nou din formularul de contact',
  }[table] || 'Mesaj nou de pe website';
}

function sanitizeFields(table, fields) {
  const rules = FIELD_RULES[table];
  const clean = {};

  for (const [key, value] of Object.entries(fields)) {
    const rule = rules[key];
    if (!rule) continue;
    const normalized = normalizeValue(value, rule);
    if (normalized !== undefined) clean[key] = normalized;
  }

  return Object.keys(clean).length ? clean : null;
}

function normalizeValue(value, rule) {
  if (rule === 'booleanOptional') return value === undefined ? undefined : !!value;

  if (rule === 'numberOptional') {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  if (rule === 'dateOptional') {
    if (value === undefined || value === null || value === '') return undefined;
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  }

  if (rule === 'email' || rule === 'emailOptional') {
    if (value === undefined || value === null || value === '') {
      return rule === 'emailOptional' ? undefined : undefined;
    }
    const email = String(value).trim().slice(0, 254);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
  }

  if (rule === 'string' || rule === 'stringOptional' || rule === 'longString') {
    if (value === undefined || value === null || value === '') {
      return rule === 'stringOptional' ? undefined : '';
    }
    const max = rule === 'longString' ? 2000 : 200;
    return String(value).trim().slice(0, max);
  }

  return undefined;
}
