// Vercel Serverless Function — retrimite TOATE codurile de abonament pentru un email
// Cauta in tabela Abonamente toate inregistrarile cu acel email si trimite un singur email
// cu lista completa de coduri (un proprietar poate avea mai multe animale).
// Returneaza INTOTDEAUNA 200 (nu dezvaluie daca emailul exista in sistem — securitate).

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE = 'Abonamente';

import { enforceOrigin, getClientIp, isHoneypotFilled, rateLimit, verifyTurnstile } from './_security.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!enforceOrigin(req, res)) return;
  if (!rateLimit(req, res, 'resend-code', { max: 3, windowMs: 60 * 60 * 1000 })) return;
  if (isHoneypotFilled(req.body || {})) return res.status(200).json({ ok: true });

  const captcha = await verifyTurnstile(req.body?.turnstileToken, getClientIp(req));
  if (!captcha.ok) {
    return res.status(400).json({ error: captcha.error || 'Captcha failed' });
  }

  const airtableToken = process.env.AIRTABLE_TOKEN;
  const resendToken   = process.env.RESEND_API_KEY;
  if (!airtableToken || !resendToken) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ error: 'Email invalid' });
  }
  const safeEmail = String(email).slice(0, 254).toLowerCase();

  try {
    // Cauta in Abonamente TOATE inregistrarile cu acel email (case-insensitive)
    const escaped = safeEmail.replace(/'/g, "\\'");
    const formula = `LOWER({Email})='${escaped}'`;
    const url = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(TABLE)
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&pageSize=100'
      + '&fields%5B%5D=Email&fields%5B%5D=Name&fields%5B%5D=Plan&fields%5B%5D=Cod&fields%5B%5D=Nume%20animal';

    const atRes = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + airtableToken },
    });

    if (!atRes.ok) {
      // Nu dezvalui eroarea Airtable clientului
      return res.status(200).json({ ok: true });
    }

    const data = await atRes.json();
    const records = (data.records || []).filter(r => {
      const c = String((r.fields || {}).Cod || '').trim();
      return c && /^[A-Za-z0-9_-]{4,32}$/.test(c);
    });

    // Daca nu gasim nimic, returnam tot 200 (nu dezvaluim absenta)
    if (records.length === 0) {
      return res.status(200).json({ ok: true });
    }

    // Numele primului record (pentru salut). Daca proprietarii au facut inscrieri pe nume diferite, alegem primul.
    const firstFields = records[0].fields || {};
    const nume = String(firstFields['Name'] || '').slice(0, 100);

    // Construim lista de carduri — cate unul pentru fiecare animal/cod
    const cardsHtml = records.map(r => {
      const f = r.fields || {};
      const cod    = String(f['Cod'] || '').trim();
      const plan   = String(f['Plan'] || '').slice(0, 80);
      const animal = String(f['Nume animal'] || '').slice(0, 80);
      const statusUrl = 'https://www.vet-stuff.ro/status.html?cod=' + encodeURIComponent(cod);
      const useUrl    = 'https://www.vet-stuff.ro/u.html?cod=' + encodeURIComponent(cod);
      const qrUrl     = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=8&data=' + encodeURIComponent(useUrl);
      return `
  <div style="background:#fef2f2;border:2px dashed #b52020;border-radius:12px;padding:18px;margin:18px 0;">
    <div style="text-align:center;">
      <p style="margin:0 0 6px;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;">${animal ? escapeHtml(animal) + ' · ' : ''}${escapeHtml(plan)}</p>
      <p style="margin:0;font-size:24px;font-weight:bold;color:#b52020;letter-spacing:2px;font-family:'Menlo','Courier New',monospace;">${escapeHtml(cod)}</p>
    </div>
    <div style="text-align:center;margin-top:14px;">
      <img src="${qrUrl}" alt="QR ${escapeHtml(cod)}" width="180" height="180" style="background:#fff;padding:8px;border-radius:8px;border:1px solid #e5e7eb;display:inline-block;">
    </div>
    <div style="text-align:center;margin-top:10px;">
      <a href="${statusUrl}" style="font-size:13px;color:#b52020;text-decoration:underline;">Verifică status →</a>
    </div>
  </div>`;
    }).join('');

    const subject = records.length === 1
      ? 'Codul tău VET STUFF'
      : 'Codurile tale VET STUFF (' + records.length + ' abonamente)';

    const intro = records.length === 1
      ? 'Ai solicitat retrimierea codului de abonament. Mai jos ai codul + QR-ul pentru clinică.'
      : 'Ai solicitat codurile abonamentelor tale. Mai jos găsești toate cele <strong>' + records.length + '</strong> abonamente înregistrate pe acest email — fiecare animal are propriul cod și QR.';

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1f2937;line-height:1.6;">
  <div style="text-align:center;padding:24px 0;border-bottom:2px solid #b52020;">
    <h1 style="color:#b52020;margin:0;font-size:24px;">VET STUFF</h1>
    <p style="color:#6b7280;margin:6px 0 0;font-size:14px;">Clinică Veterinară Bacău</p>
  </div>

  <h2 style="color:#1f2937;margin-top:32px;">Salut${nume ? ', ' + escapeHtml(nume) : ''}!</h2>

  <p>${intro}</p>

  ${cardsHtml}

  <p style="font-size:14px;color:#6b7280;margin-top:24px;">La fiecare vizită, arată QR-ul potrivit medicului. El înregistrează serviciile folosite pe loc.</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;">
  <p style="font-size:13px;color:#9ca3af;text-align:center;">
    VET STUFF — Clinică Veterinară Bacău<br>
    Pentru întrebări, răspunde la acest email sau scrie-ne pe Messenger.
  </p>
</body>
</html>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'VET STUFF <noreply@vet-stuff.ro>',
        to: [safeEmail],
        subject,
        html,
      }),
    });

    // Returnam 200 indiferent de rezultatul Resend (nu dezvaluim erori interne)
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: true });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
