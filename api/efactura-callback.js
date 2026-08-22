// Callback OAuth ANAF e-Factura — rulează pe Node (Vercel), NU pe Supabase Edge.
// Motiv: Supabase Edge (Deno/rustls) nu poate face handshake TLS cu serverul ANAF
// (logincert.anaf.ro folosește cifruri legacy pe TLS 1.2). Node/OpenSSL le acceptă.
//
// Flux: ANAF redirecționează browserul aici cu ?code=...&state=... -> consumăm
// state-ul (single-use, în DB) -> clinica și mediul vin DOAR din el -> schimbăm
// codul pe token-uri (POST către ANAF din Node) -> stocăm în efactura_tokens
// scope-uit pe (clinic_id, environment) -> redirect în CRM.
//
// AUD-P0-03: înainte, acest fișier citea `efactura_config` global, ordonat după
// `updated_at desc`, și ștergea/scria tokenuri filtrând DOAR după `environment`.
// Cu două clinici, cine se conecta al doilea suprascria tokenurile primei, iar
// codul primit de la ANAF era acceptat fără nicio legătură cu cine pornise
// fluxul. Acum nimic nu se atinge înainte ca state-ul să fie consumat cu succes.
//
// Env necesare (Vercel, proiectul website):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (deja există)
//   EFACTURA_CLIENT_SECRET                   (valoarea din portalul ANAF)

import { supabaseEnv } from './_accounts.js';
import { setNoStore } from './_security.js';

const OAUTH_TOKEN_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/token';
const CALLBACK_URL = process.env.EFACTURA_CALLBACK_URL || 'https://www.vet-stuff.ro/api/efactura-callback';
const CRM_BASE = process.env.EFACTURA_CRM_BASE || 'https://crm.vet-stuff.ro';

function redirectToCrm(res, status, detail) {
  const extra = detail ? `&detail=${encodeURIComponent(String(detail).slice(0, 300))}` : '';
  res.statusCode = 302;
  res.setHeader('Location', `${CRM_BASE}/administrativ/integrari?efactura=${status}${extra}`);
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

// Consumă state-ul emis de `create_efactura_oauth_state` (numai adminii clinicii
// îl pot emite). RPC-ul face verificarea și marcarea într-un singur
// `update ... returning`, deci un nonce nu poate fi folosit de două ori nici
// dacă două callbackuri sosesc simultan.
//
// Nu distingem „expirat" de „deja folosit" de „inexistent": diferența nu ajută
// utilizatorul legitim, dar i-ar spune unui atacator dacă nonce-ul a existat.
async function consumeOAuthState(rawState, env) {
  const nonce = String(rawState ?? '').trim();
  if (!/^[0-9a-f]{32,128}$/i.test(nonce)) return null;

  const rpcRes = await sb('rpc/consume_efactura_oauth_state', {
    method: 'POST',
    body: JSON.stringify({ p_nonce: nonce }),
  }, env);

  if (!rpcRes.ok) {
    console.error('consume_efactura_oauth_state failed', rpcRes.status, await rpcRes.text().catch(() => ''));
    return null;
  }

  const rows = await rpcRes.json().catch(() => null);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.clinic_id) return null;

  return {
    clinicId: row.clinic_id,
    environment: row.environment === 'prod' ? 'prod' : 'test',
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  try {
    const oauthError = req.query?.error;
    if (oauthError) return redirectToCrm(res, 'error', oauthError);

    const env = supabaseEnv();
    if (!env.configured) return redirectToCrm(res, 'server_error', 'Supabase env lipsă');

    // Pasul 0, înaintea oricărei alte atingeri de date: fără un state valid nu
    // știm pentru ce clinică vine acest callback, deci nu avem ce autoriza.
    const state = await consumeOAuthState(req.query?.state, env);
    if (!state) return redirectToCrm(res, 'state_invalid');
    const { clinicId, environment } = state;

    const code = req.query?.code;
    if (!code) return redirectToCrm(res, 'error');

    const clientSecret = process.env.EFACTURA_CLIENT_SECRET || '';
    if (!clientSecret) return redirectToCrm(res, 'no_secret');

    // Configul se caută pe (clinic_id, environment) — pereche unică din 0092.
    // Înainte se lua `order=updated_at.desc&limit=1`, adică al oricui era mai
    // recent, indiferent de clinică.
    const cfgRes = await sb(
      `efactura_config?select=client_id&clinic_id=eq.${encodeURIComponent(clinicId)}&environment=eq.${encodeURIComponent(environment)}&limit=1`,
      {},
      env,
    );
    if (!cfgRes.ok) return redirectToCrm(res, 'server_error', `config ${cfgRes.status}`);
    const cfgRows = await cfgRes.json().catch(() => []);
    const cfg = Array.isArray(cfgRows) ? cfgRows[0] : null;
    if (!cfg?.client_id) return redirectToCrm(res, 'no_config');

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
      if (!tokRes.ok) return redirectToCrm(res, 'token_failed', `ANAF ${tokRes.status}: ${text.slice(0, 200)}`);
      try { tokens = JSON.parse(text); } catch { return redirectToCrm(res, 'token_failed', `răspuns ne-JSON: ${text.slice(0, 200)}`); }
    } catch (e) {
      return redirectToCrm(res, 'token_failed', `conexiune ANAF: ${String(e).slice(0, 200)}`);
    }
    if (!tokens?.access_token) return redirectToCrm(res, 'token_failed', 'ANAF nu a returnat access_token');

    const expiresAt = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString() : null;

    // Un singur set de tokenuri per (clinică, mediu) — indexul unic
    // `efactura_tokens_clinic_environment_key` din 0092 garanteaza asta.
    // Ștergerea era înainte `environment=eq.X` fără clinică, deci conectarea
    // unei clinici arunca tokenurile tuturor celorlalte pe același mediu.
    const clinicFilter = `clinic_id=eq.${encodeURIComponent(clinicId)}&environment=eq.${encodeURIComponent(environment)}`;

    const delRes = await sb(`efactura_tokens?${clinicFilter}`, { method: 'DELETE' }, env);
    if (!delRes.ok) return redirectToCrm(res, 'server_error', `token cleanup ${delRes.status}`);

    const insRes = await sb('efactura_tokens', {
      method: 'POST',
      body: JSON.stringify({
        clinic_id: clinicId,
        environment,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }),
    }, env);
    // Dacă insertul eșuează după ce ștergerea a reușit, clinica rămâne fără
    // tokenuri. Spunem asta explicit, în loc să raportăm „connected".
    if (!insRes.ok) {
      console.error('efactura token insert failed', insRes.status, await insRes.text().catch(() => ''));
      return redirectToCrm(res, 'server_error', 'tokenurile nu au putut fi salvate — reia conectarea');
    }

    await sb(`efactura_config?${clinicFilter}`, {
      method: 'PATCH',
      body: JSON.stringify({ connected: true, connected_at: new Date().toISOString(), token_expires_at: expiresAt, updated_at: new Date().toISOString() }),
    }, env);

    return redirectToCrm(res, 'connected');
  } catch (err) {
    return redirectToCrm(res, 'server_error', String(err));
  }
}
