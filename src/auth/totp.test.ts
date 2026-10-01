import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { base32Decode, base32Encode, codeAt, generateRecoveryCodes, generateSecret, hashRecoveryCode, looksLikeRecoveryCode, openSecret, otpauthUri, sealSecret, stepOf, verifyCode } from './totp.js';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII "12345678901234567890". The RFC lists 8-digit
// codes; the six-digit code an app shows is the last six digits of the same number.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('produces the RFC\'s test codes, so any authenticator app agrees with us', () => {
    for (const [time, expected] of RFC_VECTORS) {
      assert.equal(codeAt(RFC_SECRET, Math.floor(time / 30), 8), expected, `T=${time}`);
      assert.equal(codeAt(RFC_SECRET, Math.floor(time / 30)), expected.slice(-6), `T=${time} (6 digits)`);
    }
  });

  it('reads and writes base32 the way apps do, ignoring spaces, case and padding', () => {
    assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), Buffer.from('12345678901234567890'));
    assert.deepEqual(base32Decode(base32Encode(Buffer.from([0, 1, 2, 250, 255]))), Buffer.from([0, 1, 2, 250, 255]));
    assert.throws(() => base32Decode('not base32!'));
  });

  it('makes a new 160-bit secret each time', () => {
    const a = generateSecret();
    assert.match(a, /^[A-Z2-7]{32}$/);
    assert.notEqual(a, generateSecret());
  });

  it('accepts the current code and one step either side, and nothing further', () => {
    const at = new Date(1_700_000_000_000);
    const now = stepOf(at);
    assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now), at), { step: now });
    assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now - 1), at), { step: now - 1 });
    assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now + 1), at), { step: now + 1 });
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now - 2), at), null);
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now + 2), at), null);
  });

  it('refuses a code it has already accepted, and any older one', () => {
    const at = new Date(1_700_000_000_000);
    const now = stepOf(at);
    const code = codeAt(RFC_SECRET, now);
    const first = verifyCode(RFC_SECRET, code, at);
    assert.ok(first);
    assert.equal(verifyCode(RFC_SECRET, code, at, first.step), null, 'the same code twice');
    assert.equal(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now - 1), at, first.step), null, 'an older step');
    assert.deepEqual(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, now + 1), at, first.step), { step: now + 1 });
  });

  it('refuses anything that is not six digits', () => {
    const at = new Date(1_700_000_000_000);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) assert.equal(verifyCode(RFC_SECRET, bad, at), null, bad);
    // A code typed with a space in the middle, as some apps display it, is fine.
    const code = codeAt(RFC_SECRET, stepOf(at));
    assert.ok(verifyCode(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, at));
  });

  it('builds the address an authenticator reads from a QR code', () => {
    const uri = otpauthUri('ABC234', 'owner@nurorganics.pk', 'NUR Organics');
    assert.equal(uri, 'otpauth://totp/NUR%20Organics:owner%40nurorganics.pk?secret=ABC234&issuer=NUR%20Organics&algorithm=SHA1&digits=6&period=30');
  });
});

describe('keeping the secret', () => {
  it('seals it so the database alone cannot produce codes, and opens it with the same server secret', () => {
    const sealed = sealSecret(RFC_SECRET, 'server-secret-one');
    assert.ok(!sealed.includes(RFC_SECRET));
    assert.equal(openSecret(sealed, 'server-secret-one'), RFC_SECRET);
    assert.notEqual(sealSecret(RFC_SECRET, 'server-secret-one'), sealed, 'a fresh IV each time');
  });

  it('will not open under another server secret, or after tampering, or from garbage', () => {
    const sealed = sealSecret(RFC_SECRET, 'server-secret-one');
    assert.equal(openSecret(sealed, 'a-different-secret'), null);
    const [iv, tag, body] = sealed.split('.') as [string, string, string];
    const flipped = Buffer.from(body, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    assert.equal(openSecret([iv, tag, flipped.toString('base64')].join('.'), 'server-secret-one'), null);
    assert.equal(openSecret('garbage', 'server-secret-one'), null);
    assert.equal(openSecret('a.b.c', 'server-secret-one'), null);
  });
});

describe('recovery codes', () => {
  it('are random, long, and look like XXXXX-XXXXX', () => {
    const codes = generateRecoveryCodes(8);
    assert.equal(new Set(codes).size, 8);
    for (const c of codes) {
      assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      assert.ok(looksLikeRecoveryCode(c));
    }
  });

  it('are stored as a hash that ignores case, dashes and spaces when matched', () => {
    const [code] = generateRecoveryCodes(1) as [string];
    assert.equal(hashRecoveryCode(code), hashRecoveryCode(code.toLowerCase().replace('-', ' ')));
    assert.match(hashRecoveryCode(code), /^[0-9a-f]{64}$/);
    assert.notEqual(hashRecoveryCode(code), code);
  });

  it('are told apart from a six-digit code', () => {
    assert.equal(looksLikeRecoveryCode('123456'), false);
    assert.equal(looksLikeRecoveryCode('ABCDE-FGHJK'), true);
  });
});
