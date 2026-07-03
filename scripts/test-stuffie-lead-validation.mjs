import assert from 'node:assert/strict';
import { extractLeadDetails, maybeCreateStuffieLead } from '../api/_stuffie-message.js';

const invalid = extractLeadDetails('Vreau sa ma contacteze clinica. Alex, 0837484, Bobita');
assert.equal(invalid.ok, false);
assert.ok(invalid.invalid.includes('telefon valid in format international sau romanesc'));
assert.ok(invalid.missing.includes('nume complet (prenume si nume)'));
assert.ok(invalid.missing.includes('adresa de email valida'));
assert.ok(invalid.missing.includes('specia animalului (caine sau pisica)'));
assert.ok(invalid.missing.includes('varsta animalului'));
assert.ok(invalid.missing.includes('motivul solicitarii'));

const valid = extractLeadDetails(`
Nume complet: Alex Ionescu
Telefon: 0722123456
Email: alex.ionescu@example.com
Specie: caine
Numele animalului: Bobita
Varsta: 4 ani
Motiv: schioapata de ieri si vreau sa fie vazut de medic
`);

assert.equal(valid.ok, true);
assert.equal(valid.ownerName, 'Alex Ionescu');
assert.equal(valid.phone, '+40722123456');
assert.equal(valid.email, 'alex.ionescu@example.com');
assert.equal(valid.species, 'câine');
assert.equal(valid.petName, 'Bobita');
assert.equal(valid.petAge, '4 ani');
assert.match(valid.reason, /schioapata/i);

const intl = extractLeadDetails(`
Nume complet: Maria Popescu
Telefon: +4915112345678
Email: maria@example.de
Specie: pisica
Numele animalului: Luna
Varsta: 8 luni
Motiv: are varsaturi repetate si nu mananca
`);

assert.equal(intl.ok, true);
assert.equal(intl.phone, '+4915112345678');
assert.equal(intl.species, 'pisică');

const compact = extractLeadDetails('Silviu Balas 0752273839 silviu@example.com, câine, zorita, 9 zile, consult');
assert.equal(compact.ok, true);
assert.equal(compact.ownerName, 'Silviu Balas');
assert.equal(compact.phone, '+40752273839');
assert.equal(compact.email, 'silviu@example.com');
assert.equal(compact.species, 'câine');
assert.equal(compact.petName, 'zorita');
assert.equal(compact.petAge, '9 zile');
assert.equal(compact.reason, 'consult');

const compactSplitAcrossTurns = extractLeadDetails(`
Client: Cristian ion, 0742870000, silviu.balas@icloud.com, spike, 7 ani, consultație
Client: caine
`);
assert.equal(compactSplitAcrossTurns.ok, true);
assert.equal(compactSplitAcrossTurns.ownerName, 'Cristian ion');
assert.equal(compactSplitAcrossTurns.phone, '+40742870000');
assert.equal(compactSplitAcrossTurns.email, 'silviu.balas@icloud.com');
assert.equal(compactSplitAcrossTurns.species, 'câine');
assert.equal(compactSplitAcrossTurns.petName, 'spike');
assert.equal(compactSplitAcrossTurns.petAge, '7 ani');
assert.equal(compactSplitAcrossTurns.reason, 'consultație');

const splitHistory = `
Client: Cristian ion, 0742870000, silviu.balas@icloud.com, spike, 7 ani, consultație
Client: caine
`;
const confirmationGate = await maybeCreateStuffieLead({
  body: { canal: 'website', userId: 'test-confirmation-gate', mesaj: 'caine' },
  reply: '',
  escalationType: 'OM',
  context: {},
  historyText: splitHistory,
  requireConfirmation: true,
});
assert.equal(confirmationGate.created, false);
assert.equal(confirmationGate.needs_confirmation, true);
assert.equal(confirmationGate.reason, 'awaiting_client_confirmation');
assert.equal(confirmationGate.details.petName, 'spike');
assert.match(confirmationGate.details.rawClientText, /Cristian ion/);

const declinedConfirmation = await maybeCreateStuffieLead({
  body: { canal: 'website', userId: 'test-confirmation-declined', mesaj: 'nu' },
  reply: '',
  escalationType: 'OM',
  context: {},
  historyText: `${splitHistory}\nSTUFFIE: Confirmi că transmit exact aceste date către clinică?`,
  requireConfirmation: true,
});
assert.equal(declinedConfirmation.created, false);
assert.equal(declinedConfirmation.confirmation_declined, true);
assert.equal(declinedConfirmation.reason, 'confirmation_declined');

const withAssistantHistory = extractLeadDetails(`
Client: Vreau sa ma sune clinica. Alex, 0837484, Bobita
Client: Nume complet: Andrei Testescu. Telefon: +40722123456. Email: codex.stuffie.test@example.com. Specie: caine. Numele animalului: Rex. Varsta: 4 ani. Motiv: consult general si verificare stare de sanatate.
`);
assert.equal(withAssistantHistory.ok, true);
assert.equal(withAssistantHistory.ownerName, 'Andrei Testescu');
assert.equal(withAssistantHistory.phone, '+40722123456');
assert.equal(withAssistantHistory.email, 'codex.stuffie.test@example.com');
assert.equal(withAssistantHistory.petName, 'Rex');

console.log('STUFFIE lead validation tests passed');
