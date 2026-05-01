// Vercel Serverless Function — trimite email de confirmare catre client cu codul de abonament
// Foloseste Resend API. Token-ul este in variabila de mediu RESEND_API_KEY (NU ajunge in browser).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.RESEND_API_KEY;
  if (!token) {
    return res.status(500).json({ error: 'Server misconfigured: missing RESEND_API_KEY' });
  }

  const { email, nume, plan, animal, cod } = req.body || {};

  // Validari minime
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalid' });
  }
  if (!cod || !/^[A-Za-z0-9_-]{4,16}$/.test(cod)) {
    return res.status(400).json({ error: 'Cod invalid' });
  }
  const safeNume   = String(nume   || '').slice(0, 100);
  const safePlan   = String(plan   || '').slice(0, 80);
  const safeAnimal = String(animal || '').slice(0, 80);
  const safeCod    = String(cod).slice(0, 16);

  const statusUrl = 'https://www.vet-stuff.ro/status.html?cod=' + encodeURIComponent(safeCod);

  const subject = 'Abonamentul tau VET STUFF — Codul: ' + safeCod;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:600px; margin:0 auto; padding:24px; color:#1f2937; line-height:1.6;">
  <div style="text-align:center; padding:24px 0; border-bottom:2px solid #b52020;">
    <h1 style="color:#b52020; margin:0; font-size:24px;">VET STUFF</h1>
    <p style="color:#6b7280; margin:6px 0 0; font-size:14px;">Clinică Veterinară Bacău</p>
  </div>

  <h2 style="color:#1f2937; margin-top:32px;">Salut${safeNume ? ', ' + escapeHtml(safeNume) : ''}!</h2>

  <p>Mulțumim că ai ales un abonament VET STUFF pentru <strong>${escapeHtml(safeAnimal) || 'animalul tău'}</strong>.</p>

  <p>Pachetul tău <strong>${escapeHtml(safePlan)}</strong> a fost înregistrat cu succes.</p>

  <div style="background:#fef2f2; border:2px dashed #b52020; border-radius:12px; padding:20px; margin:24px 0; text-align:center;">
    <p style="margin:0 0 8px; color:#6b7280; font-size:13px; text-transform:uppercase; letter-spacing:1px;">Codul tău unic</p>
    <p style="margin:0; font-size:28px; font-weight:bold; color:#b52020; letter-spacing:2px; font-family:'Menlo','Courier New',monospace;">${escapeHtml(safeCod)}</p>
  </div>

  <p>Cu acest cod poți verifica oricând statusul abonamentului — ce servicii ai folosit și ce mai ai disponibil:</p>

  <div style="text-align:center; margin:32px 0;">
    <a href="${statusUrl}" style="display:inline-block; background:#b52020; color:#fff; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:16px;">Verifică status abonament</a>
  </div>

  <p style="font-size:14px; color:#6b7280;">Sau accesează direct: <a href="${statusUrl}" style="color:#b52020;">${statusUrl}</a></p>

  <hr style="border:none; border-top:1px solid #e5e7eb; margin:32px 0;">

  <h3 style="color:#1f2937;">Ce urmează?</h3>
  <ol style="color:#4b5563;">
    <li>Te vom contacta în scurt timp pentru a stabili produsele exacte (deparazitări) și data primei consultații.</li>
    <li>Plata se face integral sau în 3 rate egale, în decurs de o lună.</li>
    <li>După prima vizită, abonamentul devine activ pentru 12 luni.</li>
  </ol>

  <hr style="border:none; border-top:1px solid #e5e7eb; margin:32px 0;">

  <p style="font-size:13px; color:#9ca3af; text-align:center;">
    Acest email a fost trimis de VET STUFF — Clinică Veterinară Bacău<br>
    Dacă ai întrebări, ne poți contacta la +40 7XX XXX XXX
  </p>
</body>
</html>`;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'VET STUFF <onboarding@resend.dev>',
        to: [email],
        subject,
        html,
      }),
    });

    const text = await resendRes.text();
    if (!resendRes.ok) {
      return res.status(resendRes.status).json({ error: 'Resend error', detail: text.slice(0, 500) });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed' });
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
