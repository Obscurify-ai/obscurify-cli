// Account codes and login keys, exactly as obscurify.ai makes them
// (https://obscurify.ai/tutorials/account_keys):
//
//   account code  20 characters of Crockford base 32: 96 random bits and a 4-bit typo check.
//                 What you sign in with. It stays on this machine.
//   login key     HMAC-SHA256("login") keyed with Argon2id(code, "obscurify-code-v1",
//                 64 MiB, 8 passes, 1 lane, 32 bytes), as hex. The only thing sent.
//
// Accounts made before account codes have a 16-digit number instead: the same
// steps under the salt "obscurify-account-v1".
import { argon2id } from '@noble/hashes/argon2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O or U

/** A new account code, `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function newAccountCode() {
  const random = randomBytes(12);
  const check = BigInt(sha256(random)[0] >> 4);
  let bits = (BigInt('0x' + random.toString('hex')) << 4n) | check;
  let code = '';
  for (let i = 0; i < 20; i++) {
    code = ALPHABET[Number(bits & 31n)] + code;
    bits >>= 5n;
  }
  return code.match(/.{5}/g).join('-');
}

/**
 * What was typed, cleaned up: `{kind: 'code', value}` (20 characters, typo
 * check passed), `{kind: 'number', value}` (16 digits), or null.
 */
export function readCredential(typed) {
  const bare = String(typed).replace(/[\s.-]/g, '');
  if (/^\d{16}$/.test(bare)) return { kind: 'number', value: bare };
  if (bare.length !== 20) return null;
  let bits = 0n;
  let code = '';
  for (const raw of bare.toUpperCase()) {
    const c = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    bits = (bits << 5n) | BigInt(v);
    code += c;
  }
  const random = Buffer.from((bits >> 4n).toString(16).padStart(24, '0'), 'hex');
  if (BigInt(sha256(random)[0] >> 4) !== (bits & 15n)) return null;
  return { kind: 'code', value: code };
}

/** The login key of an account code or 16-digit number (about 3 seconds, on purpose). */
export function loginKey(typed) {
  const credential = readCredential(typed);
  if (!credential) {
    throw new Error("That isn't an account code (20 characters) or account number (16 digits). Check each character.");
  }
  const salt = credential.kind === 'code' ? 'obscurify-code-v1' : 'obscurify-account-v1';
  const master = argon2id(utf8ToBytes(credential.value), utf8ToBytes(salt), { t: 8, m: 64 * 1024, p: 1, dkLen: 32 });
  return bytesToHex(hmac(sha256, master, utf8ToBytes('login')));
}
