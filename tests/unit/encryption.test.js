const { encrypt, decrypt } = require('../../utils/encryption');

describe('encrypt/decrypt round-trip', () => {
  test('a real plaintext value encrypts and decrypts back to itself', () => {
    const encrypted = encrypt('9999999999');
    expect(encrypted).not.toBe('9999999999');
    expect(decrypt(encrypted)).toBe('9999999999');
  });

  test('two real encryptions of the same value produce different ciphertext (random IV)', () => {
    const a = encrypt('9999999999');
    const b = encrypt('9999999999');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('9999999999');
    expect(decrypt(b)).toBe('9999999999');
  });

  test('encrypted output is real cipher:iv:tag format (3 colon-separated parts)', () => {
    const encrypted = encrypt('hello');
    expect(encrypted.split(':')).toHaveLength(3);
  });
});

describe('encrypt — passthrough cases', () => {
  test('a real empty/null plaintext passes through unchanged', () => {
    expect(encrypt('')).toBe('');
    expect(encrypt(null)).toBe(null);
    expect(encrypt(undefined)).toBe(undefined);
  });

  test('a real already-encrypted value (3 colon-separated parts) is not double-encrypted', () => {
    const already = 'YWJj:ZGVm:Z2hp';
    expect(encrypt(already)).toBe(already);
  });
});

describe('decrypt — edge cases', () => {
  test('a real empty/null ciphertext passes through unchanged', () => {
    expect(decrypt('')).toBe('');
    expect(decrypt(null)).toBe(null);
  });

  test('a real malformed ciphertext (wrong number of parts) is returned as-is', () => {
    expect(decrypt('not-encrypted-plain-text')).toBe('not-encrypted-plain-text');
  });

  test('a real corrupted ciphertext (valid shape, garbage data) fails closed to an empty string', () => {
    expect(decrypt('Zm9v:YmFy:YmF6')).toBe('');
  });
});
