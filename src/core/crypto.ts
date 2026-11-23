import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Vault: every answer and API key is stored encrypted with AES-256-GCM.
 * The key comes from the master password (scrypt, N=2^17) and only lives in memory.
 */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT);
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

export function decrypt(key: Buffer, payload: string): string {
  const [v, iv, tag, data] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Formato de dado criptografado inválido');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** A known value encrypted at setup; decrypting it proves the password is right. */
export const CHECK_VALUE = 'flashhire-vault-ok';

export function verifyKey(key: Buffer, checkPayload: string): boolean {
  try {
    const out = Buffer.from(decrypt(key, checkPayload));
    const expected = Buffer.from(CHECK_VALUE);
    return out.length === expected.length && timingSafeEqual(out, expected);
  } catch {
    return false;
  }
}
