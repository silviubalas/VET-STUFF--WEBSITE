// Helper partajat pentru conturile de client (booking online).
//
// Principii (vezi planul Faza 2):
//   * Clienții se autentifică prin Supabase Auth, dar NU primesc sesiune de DB
//     în browser. Login-ul se face server-side; întoarcem animalele + un token
//     semnat HMAC (ownerIds, exp). La programare token-ul e re-verificat și
//     patient_id ales e validat că aparține acelui owner.
//   * Datele clinice (owners/patients) se citesc cu SERVICE ROLE, scoped pe email.
//   * NU se creează niciodată owner sau patient de aici.

import crypto from 'node:crypto';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min

export function supabaseEnv() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  return { url, anon, service, configured: Boolean(url && anon && service) };
}

const TOKEN_SECRET = process.env.BOOKING_TOKEN_SECRET
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SERVICE_KEY
  || '';

export function signAccountToken(payload) {
  if (!TOKEN_SECRET) return null;
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAccountToken(token) {
  if (!token || typeof token !== 'string' || !TOKEN_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

export function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
export function cleanString(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function cleanPhone(value) {
  let phone = String(value || '').replace(/[^\d+]/g, '');
  if (phone.startsWith('0040')) phone = `+40${phone.slice(4)}`; // 0040... -> +40...
  if (phone.startsWith('+400')) phone = `+40${phone.slice(4)}`; // +40 0... (0 redundant) -> +40...
  if (phone.startsWith('0')) phone = `+40${phone.slice(1)}`;    // 07... -> +407...
  return /^\+40[0-9]{9}$/.test(phone) ? phone : '';
}

function accountRedirectUrl() {
  return process.env.CLIENT_ACCOUNT_RESET_REDIRECT_URL
    || process.env.CLIENT_ACCOUNT_INVITE_REDIRECT_URL
    || 'https://www.vet-stuff.ro/reset-parola.html';
}

async function authFetch(env, path, { method = 'POST', token, body } = {}) {
  const res = await fetch(`${env.url}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: env.anon,
      Authorization: `Bearer ${token || env.anon}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, json, text };
}

async function restFetch(env, path, { method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: env.service,
    Authorization: `Bearer ${env.service}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${env.url}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// Verifică dacă există deja un cont (după client_accounts).
export async function accountExists(env, email) {
  const rows = await restFetch(env, `client_accounts?select=id&email=ilike.${encodeURIComponent(email)}&limit=1`);
  return Array.isArray(rows) && rows.length > 0;
}

// Creează cont nou (Supabase Auth + client_accounts). NU creează owner/patient.
export async function createClientAccount(env, { email, password, fullName, phone }) {
  if (await accountExists(env, email)) {
    return { ok: false, code: 'exists', error: 'Există deja un cont cu acest email. Folosește „Client existent".' };
  }
  const signup = await authFetch(env, 'signup', {
    body: { email, password, data: { full_name: fullName, phone } },
  });
  if (!signup.ok) {
    const msg = String(signup.json?.msg || signup.json?.error_description || signup.json?.error || '');
    if (/registered|exists/i.test(msg)) {
      return { ok: false, code: 'exists', error: 'Există deja un cont cu acest email. Folosește „Client existent".' };
    }
    if (/password/i.test(msg)) return { ok: false, code: 'weak', error: 'Parola trebuie să aibă minim 6 caractere.' };
    if (/email/i.test(msg)) return { ok: false, code: 'email', error: 'Email invalid sau respins. Folosește o adresă reală.' };
    return { ok: false, code: 'auth', error: 'Contul nu a putut fi creat. Încearcă din nou.' };
  }
  const userId = signup.json?.id || signup.json?.user?.id;
  if (userId) {
    const now = new Date().toISOString();
    await restFetch(env, 'client_accounts', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: { id: userId, email, full_name: fullName, phone, status: 'invited', invited_at: now, updated_at: now },
    });
  }
  return { ok: true, needsConfirmation: !signup.json?.session };
}

// Login + încărcare animale ale clientului (după email verificat). Întoarce token semnat.
export async function loginClientAccount(env, { email, password }) {
  const login = await authFetch(env, 'token?grant_type=password', { body: { email, password } });
  if (!login.ok) {
    const code = String(login.json?.error_code || login.json?.error || '');
    const msg = String(login.json?.msg || login.json?.error_description || '');
    if (/not.?confirmed/i.test(code) || /not.?confirmed/i.test(msg)) {
      return { ok: false, code: 'unconfirmed', error: 'Confirmă emailul (verifică inbox-ul) înainte de a te conecta.' };
    }
    return { ok: false, code: 'invalid', error: 'Email sau parolă incorecte.' };
  }
  const verifiedEmail = cleanEmail(login.json?.user?.email) || email;
  const userId = login.json?.user?.id;
  if (userId) {
    await restFetch(env, 'client_accounts', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: { id: userId, email: verifiedEmail, status: 'active', updated_at: new Date().toISOString() },
    });
  }
  const owners = await restFetch(env, `owners?select=id,full_name,phone&email=ilike.${encodeURIComponent(verifiedEmail)}`);
  const ownerList = Array.isArray(owners) ? owners : [];
  const ownerIds = ownerList.map(o => o.id).filter(Boolean);

  let pets = [];
  if (ownerIds.length) {
    const rows = await restFetch(env, `patients?select=id,name,species,breed&owner_id=in.(${ownerIds.join(',')})&order=name.asc`);
    pets = (Array.isArray(rows) ? rows : []).map(p => ({ id: p.id, name: p.name, species: p.species, breed: p.breed }));
  }
  const token = signAccountToken({ ownerIds, email: verifiedEmail });
  return {
    ok: true,
    token,
    email: verifiedEmail,
    ownerName: ownerList[0]?.full_name || '',
    ownerPhone: ownerList[0]?.phone || '',
    linked: ownerIds.length > 0,
    pets,
  };
}

// Trimite emailul de recuperare parolă prin Supabase Auth.
export async function recoverClientAccount(env, { email }) {
  const redirect = encodeURIComponent(accountRedirectUrl());
  const recover = await authFetch(env, `recover?redirect_to=${redirect}`, { body: { email } });
  return { ok: recover.ok, status: recover.status };
}

// Validează că un patient ales aparține owner-ilor din token. Folosit la programare.
export async function patientBelongsToOwners(env, patientId, ownerIds) {
  if (!patientId || !Array.isArray(ownerIds) || !ownerIds.length) return null;
  const safeIds = ownerIds.filter(id => /^[0-9a-f-]{36}$/i.test(id));
  if (!safeIds.length || !/^[0-9a-f-]{36}$/i.test(patientId)) return null;
  const rows = await restFetch(env, `patients?select=id,owner_id&id=eq.${patientId}&owner_id=in.(${safeIds.join(',')})&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
