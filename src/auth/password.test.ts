import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARGON2_PARAMS, type Argon2Params, MIN_PASSWORD_LENGTH, dummyHash, hashPassword, needsRehash, passwordProblem, verifyPassword } from './password.js';

// Cheap parameters keep these tests quick; the production parameters get one real run below.
const CHEAP: Argon2Params = { memory: 1024, passes: 1, parallelism: 1, tagLength: 32, saltLength: 16 };

describe('password hashing', () => {
  it('writes argon2id with its parameters in the hash, as a standard PHC string', async () => {
    const hash = await hashPassword('correct horse battery staple', CHEAP);
    assert.match(hash, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple', CHEAP);
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('correct horse battery stapl', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('salts every hash, so the same password never stores the same twice', async () => {
    assert.notEqual(await hashPassword('same password, twice', CHEAP), await hashPassword('same password, twice', CHEAP));
  });

  it('handles non-ASCII passwords', async () => {
    const hash = await hashPassword('پاسورڈ-بہت-لمبا-ہے-123', CHEAP);
    assert.equal(await verifyPassword('پاسورڈ-بہت-لمبا-ہے-123', hash), true);
    assert.equal(await verifyPassword('پاسورڈ-بہت-لمبا-ہے-124', hash), false);
  });

  it('never matches a hash that is malformed, from another algorithm, or empty', async () => {
    for (const bad of ['', 'plaintext', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123', '$argon2id$v=19$m=1,t=1,p=1$$', '$argon2i$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaA']) {
      assert.equal(await verifyPassword('anything at all', bad), false, bad);
    }
  });

  it('documents its parameters: argon2id, 64 MiB, 3 passes, 16-byte salt, 32-byte tag', () => {
    assert.deepEqual(ARGON2_PARAMS, { memory: 65_536, passes: 3, parallelism: 1, tagLength: 32, saltLength: 16 });
  });

  it('works at the production parameters, and records them', async () => {
    const hash = await hashPassword('a long production-strength password');
    assert.ok(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$'));
    assert.equal(await verifyPassword('a long production-strength password', hash), true);
    assert.equal(needsRehash(hash), false);
  });

  it('says when a hash was made with weaker parameters than today\'s, and still verifies it', async () => {
    const old = await hashPassword('an older, weaker hash', CHEAP);
    assert.equal(needsRehash(old), true);
    assert.equal(await verifyPassword('an older, weaker hash', old), true);
    assert.equal(needsRehash('not a hash'), true);
  });

  it('has a stand-in hash, so a missing account takes as long to check as a real one', async () => {
    const hash = await dummyHash();
    assert.ok(hash.startsWith('$argon2id$'));
    assert.equal(await verifyPassword('whatever someone typed', hash), false);
    assert.equal(await dummyHash(), hash, 'made once');
  });
});

describe('what a password must be', () => {
  it('is long enough, and no more is asked than that', () => {
    assert.equal(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1) + 'y'.slice(1)), `A password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    assert.equal(passwordProblem('correct horse battery'), null);
    assert.equal(passwordProblem('alllowercaseletters'), null, 'no composition rules');
  });

  it('refuses one character repeated, and absurd lengths', () => {
    assert.equal(passwordProblem('a'.repeat(20)), 'A password cannot be one character repeated');
    assert.equal(passwordProblem('ab'.repeat(101)), 'A password can be at most 200 characters');
  });

  it('counts characters, not bytes', () => {
    assert.equal(passwordProblem('پاسورڈ'.repeat(2)), null, '12 characters');
    assert.equal(passwordProblem('پاسورڈ'), `A password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  });
});
