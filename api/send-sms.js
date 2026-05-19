// Vercel Serverless Function — trimite SMS de confirmare catre client cu codul de abonament
// Foloseste SMSlink.ro REST API. Credentialele sunt in variabile de mediu.

import { getSmsLinkConfig, sendSmsLink } from './_smslink.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Daca SMSlink nu e configurat, ignora silentios
  if (!getSmsLinkConfig().configured) {
    return res.status(200).json({ ok: false, reason: 'SMS not configured' });
  }

  const { tel, cod, animal, plan } = req.body || {};

  if (!tel || !cod) {
    return res.status(400).json({ error: 'tel si cod sunt obligatorii' });
  }

  // Validare cod — doar alfanumerice (format generat de frontend)
  if (!/^[A-Z0-9]{4,32}$/.test(cod)) {
    return res.status(400).json({ error: 'Format cod invalid' });
  }

  const statusUrl = 'https://vet-stuff.ro/status.html?cod=' + encodeURIComponent(cod);
  const animalLine = animal ? 'Pentru: ' + String(animal).slice(0, 50) : '';
  const planLine = plan ? 'Plan: ' + String(plan).slice(0, 30) : '';

  const body = [
    'VET STUFF: Abonamentul a fost inregistrat.',
    planLine,
    animalLine,
    'Cod: ' + cod,
    'Status: ' + statusUrl
  ].filter(Boolean).join('\n');

  try {
    const result = await sendSmsLink({ to: tel, body });
    if (!result.ok) {
      console.error('SMSlink error:', result);
      return res.status(result.status || 500).json({ error: result.error || 'SMSlink error' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('SMS fetch error:', err);
    return res.status(500).json({ error: 'Network error' });
  }
}
