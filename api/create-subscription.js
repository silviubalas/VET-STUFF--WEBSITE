import { randomInt } from 'node:crypto';
import { notifySubscriptionLead, sendSubscriptionConfirmationEmail, sendSubscriptionSms } from './_notifications.js';
import { enforceOrigin, getClientIp, isHoneypotFilled, rateLimit, verifyTurnstile } from './_security.js';

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE_SUBSCRIPTIONS = 'Abonamente';
const TABLE_USAGE = 'UtilizareAbonamente';
const PLANS = new Set(['Silver', 'Gold', 'Platinum']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!enforceOrigin(req, res)) return;
  if (!rateLimit(req, res, 'create-subscription', { max: 6, windowMs: 30 * 60 * 1000 })) return;

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

  const input = sanitizeInput(req.body || {});
  if (!input) {
    return res.status(400).json({ error: 'Date abonament invalide' });
  }

  try {
    const cod = await generateUniqueCode(token, input.nume, input.animal);

    await createRecord(token, TABLE_SUBSCRIPTIONS, {
      'Name': input.nume,
      'Plan': input.plan,
      'Telefon': input.tel,
      'Email': input.email,
      'Nume animal': input.animal,
      'Specie si rasa': input.rasa,
      'Mesaj': input.mesaj,
      'Cod': cod,
    });

    const usageFields = {
      'Cod client': cod,
      'Nume client': input.nume + ' - ' + input.animal,
      'Tip pachet': input.plan,
      'Consultatie folosita': false,
      'Vaccin folosit': false,
      'Deparazitari interne folosite': 0,
      'Deparazitari externe folosite': 0,
      'Urgenta folosita': false,
      'Activ': false,
    };

    if (input.plan === 'Platinum') {
      usageFields['Vaccin tuse canisa folosit'] = false;
      usageFields['A 2-a consultatie folosita'] = false;
      usageFields['Consultatie de specialitate folosita'] = false;
      usageFields['A 2-a ecografie folosita'] = false;
      usageFields['Urgente folosite'] = 0;
      usageFields['Anestezie detartraj folosita'] = false;
    }

    await createRecord(token, TABLE_USAGE, usageFields);

    const notificationResults = await Promise.allSettled([
      notifySubscriptionLead({
        '_subject': 'Abonament — cerere nouă (' + cod + ')',
        'Cod abonament': cod,
        'Plan': input.plan,
        'Nume': input.nume,
        'Telefon': input.tel,
        'Email': input.email,
        'Animal': input.animal,
        'Rasă': input.rasa,
        'Mesaj': input.mesaj,
      }),
      sendSubscriptionConfirmationEmail({
        email: input.email,
        nume: input.nume,
        plan: input.plan,
        animal: input.animal,
        cod,
      }),
      sendSubscriptionSms({
        tel: input.tel,
        cod,
        plan: input.plan,
        animal: input.animal,
      }),
    ]);

    notificationResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value?.ok !== false) return;
      const label = ['formspree', 'email', 'sms'][index] || 'notification';
      const error = result.status === 'rejected' ? result.reason : result.value;
      console.error('[create-subscription] notification failed', label, error);
    });

    return res.status(200).json({ ok: true, cod });
  } catch (err) {
    console.error('[create-subscription]', err.message);
    return res.status(502).json({ error: 'Nu am putut salva abonamentul' });
  }
}

function sanitizeInput(body) {
  const plan = String(body.plan || '').trim();
  const nume = String(body.nume || '').trim().slice(0, 120);
  const tel = String(body.tel || '').trim().slice(0, 40);
  const email = String(body.email || '').trim().slice(0, 254);
  const animal = String(body.animal || '').trim().slice(0, 120);
  const rasa = String(body.rasa || '').trim().slice(0, 160);
  const mesaj = String(body.mesaj || '').trim().slice(0, 2000);

  if (!PLANS.has(plan) || !nume || !tel || !animal) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

  return { plan, nume, tel, email, animal, rasa, mesaj };
}

async function generateUniqueCode(token, nume, animal) {
  for (let i = 0; i < 5; i++) {
    const cod = buildCode(nume, animal);
    if (!(await codeExists(token, cod))) return cod;
  }
  throw new Error('Could not generate unique subscription code');
}

function buildCode(nume, animal) {
  const clean = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const t = new Date();
  const dd = String(t.getDate()).padStart(2, '0');
  const mm = String(t.getMonth() + 1).padStart(2, '0');
  const yyyy = t.getFullYear();
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return clean(nume) + clean(animal) + dd + mm + yyyy + suffix;
}

async function codeExists(token, cod) {
  const formula = `UPPER({Cod client})=UPPER('${cod}')`;
  const url = airtableUrl(TABLE_USAGE)
    + '?filterByFormula=' + encodeURIComponent(formula)
    + '&maxRecords=1';
  const response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!response.ok) throw new Error('Airtable lookup failed');
  const data = await response.json();
  return Array.isArray(data.records) && data.records.length > 0;
}

async function createRecord(token, table, fields) {
  const response = await fetch(airtableUrl(table), {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable create failed for ${table}: ${response.status} ${text.slice(0, 300)}`);
  }
}

function airtableUrl(table) {
  return 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(table);
}
