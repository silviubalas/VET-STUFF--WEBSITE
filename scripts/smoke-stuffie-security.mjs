const directUrl = process.env.STUFFIE_DIRECT_URL || 'https://stuffie.vet-stuff.ro/webhook/stuffie-brain';
const gatewayUrl = process.env.STUFFIE_GATEWAY_URL || 'https://www.vet-stuff.ro/api/booking?intent=stuffie';

const direct = await fetch(directUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ canal: 'smoke', user_id: 'direct-deny', mesaj: 'test' }),
});

if (direct.status !== 404) {
  throw new Error(`Expected direct n8n call without token to return 404, got ${direct.status}`);
}

const gateway = await fetch(gatewayUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    canal: 'website',
    user_id: `smoke-${Date.now()}`,
    deviceId: `smoke-device-${Date.now()}`,
    mesaj: 'Care este programul clinicii?',
  }),
});

const body = await gateway.json().catch(() => null);
if (gateway.status !== 200 || body?.ok !== true || !body?.raspuns) {
  throw new Error(`Expected gateway STUFFIE response to be OK, got ${gateway.status}: ${JSON.stringify(body)}`);
}

console.log('STUFFIE security smoke passed');
console.log(`- direct without token: ${direct.status}`);
console.log(`- gateway response: ${gateway.status}`);
