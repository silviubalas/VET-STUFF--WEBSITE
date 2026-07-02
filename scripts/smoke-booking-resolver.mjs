// Smoke test pentru resolverul de booking public (/api/booking).
// Verifică: rezolvarea clinicii (după Host), structura răspunsului, fereastra
// de zile (inclusiv 60), fallback pe clinica default pentru slug necunoscut și
// header-ul de cache edge. Rulează contra producției implicit; override cu
// BOOKING_URL (ex. un preview Vercel).
//
// Notă multi-tenant: cu o singură clinică (VET STUFF) se poate testa doar calea
// default. Testul real per-clinică (2 clinici + domenii) se face la nivel de DB
// cu ../vet-stuff-crm/docs/BOOKING_RESOLVER_SMOKE_TEST.sql după onboarding.

const baseUrl = (process.env.BOOKING_URL || 'https://www.vet-stuff.ro/api/booking').replace(/\/+$/, '');
const DEFAULT_CLINIC_ID = '00000000-0000-0000-0000-000000000001';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function getJson(qs) {
  const res = await fetch(`${baseUrl}${qs}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  return { res, body };
}

// 1) Structura de bază: rezolvă clinica default + servicii + medici + o zi.
{
  const { res, body } = await getJson('?days=1');
  assert(res.status === 200, `days=1: aștept 200, am ${res.status}`);
  assert(body?.ok === true && body?.configured === true, `days=1: ok/configured false: ${JSON.stringify(body)}`);
  assert('clinicId' in body, 'days=1: lipsește clinicId (cod vechi nedeployat?)');
  assert(Array.isArray(body.services) && body.services.length > 0, 'days=1: fără servicii');
  assert(Array.isArray(body.doctors) && body.doctors.length > 0, 'days=1: fără medici');
  assert(Array.isArray(body.days) && body.days.length === 1, `days=1: aștept 1 zi, am ${body.days?.length}`);
}

// 2) Fereastra lărgită: 60 zile, cu sloturi prezente.
{
  const { res, body } = await getJson('?days=60');
  assert(res.status === 200 && body?.ok === true, `days=60: răspuns invalid ${res.status}`);
  assert(body.days.length === 60, `days=60: aștept 60 zile, am ${body.days.length}`);
  const slots = body.days.reduce((n, d) => n + (d.slots?.length || 0), 0);
  assert(slots > 0, 'days=60: 0 sloturi pe 60 zile (suspect)');
}

// 3) Slug necunoscut → fallback pe clinica default (nu 500, nu clinică străină).
{
  const { res, body } = await getJson('?days=1&clinic=inexistent-xyz-999');
  assert(res.status === 200 && body?.ok === true, `clinic necunoscut: răspuns invalid ${res.status}`);
  assert(body.clinicId === DEFAULT_CLINIC_ID, `clinic necunoscut: aștept fallback default, am ${body.clinicId}`);
}

// 4) Calea de cache edge activă (Cache-Control public, nu no-store).
let vercelCache = '(n/a)';
{
  const res = await fetch(`${baseUrl}?days=7`, { headers: { Accept: 'application/json' } });
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  assert(cc.includes('public') && !cc.includes('no-store'), `cache-control neașteptat: "${cc}"`);
  vercelCache = res.headers.get('x-vercel-cache') || '(absent)';
}

console.log('Booking resolver smoke passed');
console.log(`- base: ${baseUrl}`);
console.log(`- x-vercel-cache (days=7): ${vercelCache}`);
