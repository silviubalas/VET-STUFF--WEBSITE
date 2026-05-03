// Vercel Serverless Function — retrimite codul de abonament pe email
// Cauta email in tabela Abonamente din Airtable si retrimite emailul de confirmare cu QR.
// Returneaza INTOTDEAUNA 200 (nu dezvaluie daca emailul exista in sistem — securitate).

const AIRTABLE_BASE = 'appGhcW1B4iDA4cUY';
const TABLE = 'Abonamente';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
    // Cauta in Abonamente dupa email (case-insensitive)
    const escaped = safeEmail.replace(/'/g, "\\'");
    const formula = `LOWER({Email})='${escaped}'`;
    const url = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(TABLE)
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&maxRecords=1'
      + '&fields%5B%5D=Email&fields%5B%5D=Name&fields%5B%5D=Plan&fields%5B%5D=Cod&fields%5B%5D=Nume%20animal';

    const atRes = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + airtableToken },
    });

    if (!atRes.ok) {
      // Nu dezvalui eroarea Airtable clientului
      return res.status(200).json({ ok: true });
    }

    const data = await atRes.json();
    const record = (data.records && data.records[0]) || null;

    // Daca nu gasim emailul, returnam tot 200 (nu dezvaluim absenta)
    if (!record) {
      return res.status(200).json({ ok: true });
    }

    const f = record.fields || {};
    const cod    = String(f['Cod'] || '').trim();
    const nume   = String(f['Name'] || '').slice(0, 100);
    const plan   = String(f['Plan'] || '').slice(0, 80);
    const animal = String(f['Nume animal'] || '').slice(0, 80);

    if (!cod || !/^[A-Za-z0-9_-]{4,16}$/.test(cod)) {
      return res.status(200).json({ ok: true });
    }

    const statusUrl = 'https://www.vet-stuff.ro/status.html?cod=' + encodeURIComponent(cod);
    const useUrl    = 'https://www.vet-stuff.ro/u.html?cod=' + encodeURIComponent(cod);
    const qrUrl     = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=' + encodeURIComponent(useUrl);

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1f2937;line-height:1.6;">
  <div style="text-align:center;padding:24px 0;border-bottom:2px solid #b52020;">
    <h1 style="color:#b52020;margin:0;font-size:24px;">VET STUFF</h1>
    <p style="color:#6b7280;margin:6px 0 0;font-size:14px;">Clinică Veterinară Bacău</p>
  </div>

  <h2 style="color:#1f2937;margin-top:32px;">Salut${nume ? ', ' + escapeHtml(nume) : ''}!</h2>

  <p>Ai solicitat retrimierea codului de abonament${animal ? ' pentru <strong>' + escapeHtml(animal) + '</strong>' : ''}.</p>

  <div style="background:#fef2f2;border:2px dashed #b52020;border-radius:12px;padding:20px;margin:24px 0;text-align:center;">
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Codul tău unic</p>
    <p style="margin:0;font-size:28px;font-weight:bold;color:#b52020;letter-spacing:2px;font-family:'Menlo','Courier New',monospace;">${escapeHtml(cod)}</p>
    <p style="margin:8px 0 0;font-size:13px;color:#6b7280;">Pachet: ${escapeHtml(plan)}</p>
  </div>

  <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin:24px 0;text-align:center;">
    <p style="margin:0 0 12px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Codul QR pentru clinică</p>
    <img src="${qrUrl}" alt="Cod QR abonament" width="240" height="240" style="display:block;margin:0 auto;background:#fff;padding:10px;border-radius:8px;border:1px solid #e5e7eb;">
    <p style="margin:12px 0 0;color:#6b7280;font-size:13px;line-height:1.5;">La fiecare vizită, arată acest QR medicului.<br>El va înregistra serviciile folosite pe loc.</p>
  </div>

  <div style="text-align:center;margin:32px 0;">
    <a href="${statusUrl}" style="display:inline-block;background:#b52020;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Verifică status abonament</a>
  </div>

  <p style="font-size:14px;color:#6b7280;">Sau accesează: <a href="${statusUrl}" style="color:#b52020;">${statusUrl}</a></p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;">
  <p style="font-size:13px;color:#9ca3af;text-align:center;">
    VET STUFF — Clinică Veterinară Bacău<br>
    Dacă ai întrebări, ne poți contacta la +40 7XX XXX XXX
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
        subject: 'Codul tău VET STUFF — ' + cod,
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
