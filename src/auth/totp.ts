import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, over HOTP, RFC 4226): the six-digit code an
 * authenticator app shows, changing every 30 seconds. HMAC-SHA1, 6 digits, 30-second steps: the
 * only combination every authenticator app supports.
 */
export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** A code from the previous or next step is accepted too, for a phone clock a few seconds off. */
export const WINDOW = 1;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string): Buffer => {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** A new secret: 20 random bytes (160 bits, the size RFC 4226 recommends), as the base32 apps expect. */
export const generateSecret = (): string => base32Encode(randomBytes(20));

/** The code for one time step. */
export const codeAt = (secret: string, step: number, digits = DIGITS): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
};

export const stepOf = (at: Date): number => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/**
 * Whether a typed code is right for this secret, and the step it matched, or null. A step at or
 * before `lastStep` is refused, so a code that was already used (or one older than the last used)
 * cannot be replayed by someone who watched it being typed.
 */
export const verifyCode = (secret: string, typed: string, at: Date, lastStep: number | null = null): { step: number } | null => {
  const code = typed.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(at);
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    const given = Buffer.from(code);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { step };
  }
  return null;
};

/** The `otpauth://` address an authenticator app reads from a QR code (or accepts typed in). */
export const otpauthUri = (secret: string, account: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ---- Keeping the secret ----

/** A key for sealing secrets, derived from the server's own secret so no second one has to be kept. */
const keyFrom = (serverSecret: string): Buffer => Buffer.from(hkdfSync('sha256', serverSecret, 'nur-platform', 'totp-secret-encryption', 32));

/**
 * The secret sealed with AES-256-GCM (`iv.tag.ciphertext`, base64), so a copy of the database
 * cannot produce anyone's codes. GCM also fails loudly if the stored value was tampered with.
 */
export const sealSecret = (secret: string, serverSecret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(serverSecret), iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
};

/** The secret back, or null if the value is not one of ours, was altered, or the server secret has changed. */
export const openSecret = (sealed: string, serverSecret: string): string | null => {
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(serverSecret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};

// ---- Recovery codes ----

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Ten-character one-time codes (`ABCDE-FGHJK`), 50 bits each: for the day the phone is lost. */
export const generateRecoveryCodes = (count = 8): string[] =>
  Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });

const normaliseRecovery = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Recovery codes are random and long, so a plain SHA-256 is enough to store them. */
export const hashRecoveryCode = (code: string): string => createHash('sha256').update(normaliseRecovery(code)).digest('hex');
export const looksLikeRecoveryCode = (typed: string): boolean => normaliseRecovery(typed).length === 10;
