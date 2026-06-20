// Callback OAuth ANAF e-Factura — rulează pe Node (Vercel), NU pe Supabase Edge.
// Motiv: Supabase Edge (Deno/rustls) nu poate face handshake TLS cu serverul ANAF
// (logincert.anaf.ro folosește cifruri legacy pe TLS 1.2). Node/OpenSSL le acceptă.
//
// Flux: ANAF redirecționează browserul aici cu ?code=... -> schimbăm codul pe token-uri
// (POST către ANAF din Node) -> stocăm în efactura_tokens (service role) -> redirect în CRM.
//
// Env necesare (Vercel, proiectul website):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (deja există)
//   EFACTURA_CLIENT_SECRET                   (de setat — valoarea din portalul ANAF)

import { supabaseEnv } from './_accounts.js';

const OAUTH_TOKEN_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/token';
const CALLBACK_URL = process.env.EFACTURA_CALLBACK_URL || 'https://www.vet-stuff.ro/api/efactura-callback';
const CRM_BASE = process.env.EFACTURA_CRM_BASE || 'https://crm.vet-stuff.ro';
const DEFAULT_CLINIC_ID = '00000000-0000-0000-0000-000000000001';

function cleanUuid(value) {
  const raw = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : '';
}

function parseState(state) {
  const raw = String(state || '');
  const clinicMatch = raw.match(/clinic:([0-9a-f-]{36})/i);
  const envMatch = raw.match(/env:(test|prod)/i);
  return {
    clinicId: cleanUuid(clinicMatch?.[1]),
    environment: envMatch?.[1] === 'prod' ? 'prod' : envMatch?.[1] === 'test' ? 'test' : '',
  };
}

function resolveClinicId(query = {}) {
  const state = parseState(query.state);
  return cleanUuid(query.clinicId)
    || cleanUuid(query.clinic_id)
    || state.clinicId
    || DEFAULT_CLINIC_ID;
}

function resolveEnvironment(query = {}) {
  const state = parseState(query.state);
  const raw = query.env || query.environment || state.environment || 'test';
  return raw === 'prod' ? 'prod' : 'test';
}

function redirectToCrm(res, status, detail, clinicId) {
  const extra = detail ? `&detail=${encodeURIComponent(String(detail).slice(0, 300))}` : '';
  const clinic = clinicId ? `&clinicId=${encodeURIComponent(clinicId)}` : '';
  res.statusCode = 302;
  res.setHeader('Location', `${CRM_BASE}/administrativ/integrari?efactura=${status}${extra}${clinic}`);
  res.end();
}

async function sb(path, init, env) {
  return fetch(`${env.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.service,
      Authorization: `Bearer ${env.service}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  try {
    const code = req.query?.code;
    const oauthError = req.query?.error;
    const clinicId = resolveClinicId(req.query || {});
    const environment = resolveEnvironment(req.query || {});
    if (oauthError) return redirectToCrm(res, 'error', oauthError, clinicId);
    if (!code) return redirectToCrm(res, 'error', undefined, clinicId);

    const clientSecret = process.env.EFACTURA_CLIENT_SECRET || '';
    if (!clientSecret) return redirectToCrm(res, 'no_secret', undefined, clinicId);

    const env = supabaseEnv();
    if (!env.configured) return redirectToCrm(res, 'server_error', 'Supabase env lipsă', clinicId);

    // config: client_id + environment
    const cfgRes = await sb([
      'efactura_config',
      '?select=client_id,environment',
      `&clinic_id=eq.${encodeURIComponent(clinicId)}`,
      `&environment=eq.${encodeURIComponent(environment)}`,
      '&limit=1',
    ].join(''), {}, env);
    const cfgRows = await cfgRes.json().catch(() => []);
    const cfg = Array.isArray(cfgRows) ? cfgRows[0] : null;
    if (!cfg?.client_id) return redirectToCrm(res, 'no_config', undefined, clinicId);
    const resolvedEnvironment = cfg.environment || environment;

    // schimb cod -> token (Node/OpenSSL, merge cu ANAF)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.client_id,
      client_secret: clientSecret,
      redirect_uri: CALLBACK_URL,
      token_content_type: 'jwt',
    });
    let tokens;
    try {
      const tokRes = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'VetStuffCRM/1.0' },
        body: body.toString(),
      });
      const text = await tokRes.text();
      if (!tokRes.ok) return redirectToCrm(res, 'token_failed', `ANAF ${tokRes.status}: ${text.slice(0, 200)}`, clinicId);
      try { tokens = JSON.parse(text); } catch { return redirectToCrm(res, 'token_failed', `răspuns ne-JSON: ${text.slice(0, 200)}`, clinicId); }
    } catch (e) {
      return redirectToCrm(res, 'token_failed', `conexiune ANAF: ${String(e).slice(0, 200)}`, clinicId);
    }
    if (!tokens?.access_token) return redirectToCrm(res, 'token_failed', 'ANAF nu a returnat access_token', clinicId);

    const expiresAt = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null;

    // stocăm token-urile (un set per clinică + mediu): ștergem vechiul, inserăm noul
    await sb(`efactura_tokens?clinic_id=eq.${encodeURIComponent(clinicId)}&environment=eq.${encodeURIComponent(resolvedEnvironment)}`, { method: 'DELETE' }, env);
    await sb('efactura_tokens', {
      method: 'POST',
      body: JSON.stringify({ clinic_id: clinicId, environment: resolvedEnvironment, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt, updated_at: new Date().toISOString() }),
    }, env);
    await sb(`efactura_config?clinic_id=eq.${encodeURIComponent(clinicId)}&environment=eq.${encodeURIComponent(resolvedEnvironment)}`, {
      method: 'PATCH',
      body: JSON.stringify({ connected: true, connected_at: new Date().toISOString(), token_expires_at: expiresAt, updated_at: new Date().toISOString() }),
    }, env);

    return redirectToCrm(res, 'connected', undefined, clinicId);
  } catch (err) {
    return redirectToCrm(res, 'server_error', String(err));
  }
}
