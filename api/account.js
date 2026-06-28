// Endpoint conturi client: signup („Client nou") + login („Client existent").
// NU creează owner/patient — doar contul de login + (la login) întoarce animalele
// deja înregistrate în CRM pentru emailul verificat.

import { enforceBodySize, enforceOrigin, isHoneypotFilled, rateLimit, setNoStore } from './_security.js';
import {
  supabaseEnv,
  cleanEmail,
  cleanString,
  cleanPhone,
  createClientAccount,
  loginClientAccount,
  recoverClientAccount,
} from './_accounts.js';

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!enforceOrigin(req, res)) return;
  if (!enforceBodySize(req, res, 16 * 1024)) return;
  if (isHoneypotFilled(req.body || {})) return res.status(200).json({ ok: true });

  const env = supabaseEnv();
  if (!env.configured) return res.status(503).json({ ok: false, error: 'Conturile nu sunt configurate momentan.' });

  const action = String(req.body?.action || '');

  if (action === 'signup') {
    if (!rateLimit(req, res, 'account-signup', { max: 5, windowMs: 15 * 60 * 1000 })) return;
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const fullName = cleanString(req.body?.fullName, 120);
    const phone = cleanPhone(req.body?.phone);
    if (!email) return res.status(400).json({ ok: false, error: 'Email invalid.' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Parola trebuie să aibă minim 6 caractere.' });
    if (!fullName) return res.status(400).json({ ok: false, error: 'Numele este obligatoriu.' });
    if (!phone) return res.status(400).json({ ok: false, error: 'Telefon invalid.' });

    try {
      const result = await createClientAccount(env, { email, password, fullName, phone });
      if (!result.ok) return res.status(result.code === 'exists' ? 409 : 400).json(result);
      return res.status(200).json({
        ok: true,
        message: result.needsConfirmation
          ? 'Cont creat. Verifică emailul pentru confirmare.'
          : 'Cont creat.',
      });
    } catch (err) {
      console.error('[account:signup]', err?.message || err);
      return res.status(502).json({ ok: false, error: 'Contul nu a putut fi creat. Încearcă din nou.' });
    }
  }

  if (action === 'login') {
    if (!rateLimit(req, res, 'account-login', { max: 12, windowMs: 15 * 60 * 1000 })) return;
    const email = cleanEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email sau parolă incorecte.' });

    try {
      const result = await loginClientAccount(env, { email, password });
      if (!result.ok) return res.status(result.code === 'unconfirmed' ? 403 : 401).json(result);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[account:login]', err?.message || err);
      return res.status(502).json({ ok: false, error: 'Conectarea a eșuat. Încearcă din nou.' });
    }
  }

  if (action === 'recover') {
    if (!rateLimit(req, res, 'account-recover', { max: 5, windowMs: 15 * 60 * 1000 })) return;
    const email = cleanEmail(req.body?.email);
    if (!email) return res.status(400).json({ ok: false, error: 'Email invalid.' });

    try {
      await recoverClientAccount(env, { email });
    } catch (err) {
      console.error('[account:recover]', err?.message || err);
    }

    return res.status(200).json({
      ok: true,
      message: 'Dacă există un cont pentru acest email, vei primi un link de resetare.',
    });
  }

  return res.status(400).json({ ok: false, error: 'Acțiune necunoscută.' });
}
