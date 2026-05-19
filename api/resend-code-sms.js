// Vercel Serverless Function — retrimite codurile abonamentelor prin SMS.
// Returneaza intentionat 200 chiar daca telefonul nu exista, ca sa nu expuna date.

import { getSmsLinkConfig, phoneLastNine, sendSmsLink } from './_smslink.js';

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE = 'Abonamente';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!getSmsLinkConfig().configured) {
    return res.status(200).json({ ok: true, smsConfigured: false });
  }

  const airtableToken = process.env.AIRTABLE_TOKEN;
  if (!airtableToken) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { tel } = req.body || {};
  const lastNine = phoneLastNine(tel);
  if (!lastNine) {
    return res.status(400).json({ error: 'Numar de telefon invalid' });
  }

  try {
    const records = await findSubscriptionsByPhone(airtableToken, lastNine);
    if (records.length === 0) {
      return res.status(200).json({ ok: true });
    }

    const body = buildSms(records);
    const result = await sendSmsLink({ to: tel, body });
    if (!result.ok) {
      console.error('[resend-code-sms] SMSlink error', result);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[resend-code-sms]', err.message);
    return res.status(200).json({ ok: true });
  }
}

async function findSubscriptionsByPhone(token, lastNine) {
  // Compara ultimele 9 cifre ca sa accepte 07..., +407..., 00407... si numere cu spatii.
  const normalizedPhone = `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Telefon}, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')`;
  const formula = `RIGHT(${normalizedPhone}, 9)='${lastNine}'`;
  const url = airtableUrl(TABLE)
    + '?filterByFormula=' + encodeURIComponent(formula)
    + '&pageSize=100'
    + '&fields%5B%5D=Telefon&fields%5B%5D=Name&fields%5B%5D=Plan&fields%5B%5D=Cod&fields%5B%5D=Nume%20animal';

  const response = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + token },
  });

  if (!response.ok) {
    throw new Error('Airtable lookup failed');
  }

  const data = await response.json();
  return (data.records || []).filter(r => {
    const cod = String((r.fields || {}).Cod || '').trim();
    return cod && /^[A-Za-z0-9_-]{4,32}$/.test(cod);
  });
}

function buildSms(records) {
  const lines = records.slice(0, 6).map(r => {
    const f = r.fields || {};
    const animal = String(f['Nume animal'] || 'Animal').slice(0, 24);
    const plan = String(f.Plan || '').slice(0, 16);
    const cod = String(f.Cod || '').trim();
    return `${animal}${plan ? ' (' + plan + ')' : ''}: ${cod}`;
  });

  return [
    'VET STUFF: codurile abonamentelor tale',
    ...lines,
    records.length > 6 ? `+ inca ${records.length - 6} coduri pe email/status.` : '',
    'Status: https://vet-stuff.ro/status.html'
  ].filter(Boolean).join('\n');
}

function airtableUrl(table) {
  return 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(table);
}
