// Vercel Serverless Function — trimite SMS de confirmare prin SMSlink.ro
// Credentialele sunt in variabile de mediu: SMSLINK_CONNECTION_ID, SMSLINK_PASSWORD, SMSLINK_SENDER (optional)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const connectionId = process.env.SMSLINK_CONNECTION_ID;
  const password     = process.env.SMSLINK_PASSWORD;
  const sender       = process.env.SMSLINK_SENDER || '';

  // Daca SMSlink nu e configurat, ignora silentios (nu blocheaza inregistrarea)
  if (!connectionId || !password) {
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

  // Normalizare numar la format 40XXXXXXXXX (SMSlink accepta fara +)
  function toRoFormat(nr) {
    const clean = (nr || '').replace(/[\s\-()+]/g, '');
    if (clean.startsWith('40')) return clean;
    if (clean.startsWith('0'))  return '4' + clean;
    return '40' + clean;
  }

  const to = toRoFormat(tel);

  // Validare: 40 urmat de exact 9 cifre
  if (!/^40\d{9}$/.test(to)) {
    return res.status(400).json({ error: 'Numar de telefon invalid' });
  }

  const statusUrl = 'vet-stuff.ro/status.html?cod=' + encodeURIComponent(cod);

  const body = [
    'VET STUFF: Abonamentul tau a fost inregistrat!',
    'Cod: ' + cod,
    'Status: ' + statusUrl,
    'Ne vedem la clinica!'
  ].join('\n');

  // SMSlink Gateway HTTP API
  // Doc: https://www.smslink.ro/sms-marketing-gateway-documentatie.html
  const params = new URLSearchParams({
    connection_id: connectionId,
    password: password,
    to: to,
    message: body,
  });
  if (sender) params.set('sender', sender);

  try {
    const response = await fetch(
      'https://secure.smslink.ro/sms/gateway/communicate/index.php?' + params.toString(),
      { method: 'GET' }
    );

    const text = (await response.text()).trim();

    // SMSlink raspunde "MESSAGE-ID;COD-RASPUNS" (ex: "12345;1") la succes
    // sau cu un cod de eroare numeric negativ (ex: "-1", "-2", ...) la esec.
    if (!response.ok || text.startsWith('-') || /^[-]?\d+$/.test(text) && Number(text) < 0) {
      console.error('SMSlink error:', text);
      return res.status(500).json({ error: 'SMSlink error', detail: text.slice(0, 200) });
    }

    return res.status(200).json({ ok: true, response: text.slice(0, 200) });
  } catch (err) {
    console.error('SMS fetch error:', err);
    return res.status(500).json({ error: 'Network error' });
  }
}
