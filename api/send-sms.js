// Vercel Serverless Function — trimite SMS de confirmare catre client cu codul de abonament
// Foloseste Twilio REST API cu fetch() nativ. Credentialele sunt in variabile de mediu.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM;

  // Daca Twilio nu e configurat, ignora silentios
  if (!sid || !token || !from) {
    return res.status(200).json({ ok: false, reason: 'SMS not configured' });
  }

  const { tel, cod } = req.body || {};

  if (!tel || !cod) {
    return res.status(400).json({ error: 'tel si cod sunt obligatorii' });
  }

  // Validare cod — doar alfanumerice (format generat de frontend)
  if (!/^[A-Z0-9]{4,32}$/.test(cod)) {
    return res.status(400).json({ error: 'Format cod invalid' });
  }

  // Normalizare numar la E.164 (+40XXXXXXXXX)
  function toE164(nr) {
    const clean = (nr || '').replace(/[\s\-()+]/g, '');
    if (clean.startsWith('40')) return '+' + clean;
    if (clean.startsWith('0'))  return '+4' + clean;
    return '+40' + clean;
  }

  const to = toE164(tel);

  // Validare: +40 urmat de exact 9 cifre
  if (!/^\+40\d{9}$/.test(to)) {
    return res.status(400).json({ error: 'Numar de telefon invalid' });
  }

  const statusUrl = 'vet-stuff.ro/status.html?cod=' + encodeURIComponent(cod);

  const body = [
    'VET STUFF: Abonamentul tau a fost inregistrat!',
    'Cod: ' + cod,
    'Status: ' + statusUrl,
    'Ne vedem la clinica!'
  ].join('\n');

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Twilio error:', data);
      return res.status(500).json({ error: data.message || 'Twilio error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('SMS fetch error:', err);
    return res.status(500).json({ error: 'Network error' });
  }
}
