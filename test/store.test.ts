import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/index.js';
import { loadConfig } from '../src/config.js';
import { tokenize, seqPredicate } from '../src/imap/index.js';

describe('store', () => {
  it('agrupa cuentas y borra por grupo', () => {
    const s = new Store(':memory:');
    const a = s.createAccount({ address: 'A@x.test', group: 'proy-a', tags: ['qa'] });
    s.createAccount({ address: 'b@x.test', group: 'proy-b' });
    expect(a.address).toBe('a@x.test');
    expect(s.listAccounts('proy-a')).toHaveLength(1);
    s.addMessage({ accountId: a.id, from: 'f@x', to: a.address, subject: 'hola', raw: Buffer.from('Subject: hola\r\n\r\ncuerpo'), tags: ['qa', 'x'] });
    expect(s.listMessages({ group: 'proy-a', tag: 'x' })).toHaveLength(1);
    expect(s.listMessages({ q: 'cuerpo' })).toHaveLength(1);
    expect(s.deleteMessages({ group: 'proy-a' })).toBe(1);
    expect(s.deleteGroup('proy-b')).toBe(true);
    expect(s.listAccounts('proy-b')).toHaveLength(0);
  });
});

describe('config', () => {
  it('exige token y credenciales SMTP con auth=on', () => {
    expect(() => loadConfig({ MAILK_AUTH: 'on' })).toThrow();
    expect(
      loadConfig({ MAILK_AUTH: 'on', MAILK_API_TOKEN: 't', MAILK_SMTP_USER: 'u', MAILK_SMTP_PASS: 'p' }).auth
    ).toBe(true);
  });
});

describe('imap utils', () => {
  it('tokeniza comillas y paréntesis', () => {
    expect(tokenize('"a b" c (d e) BODY[HEADER.FIELDS (X Y)]')).toEqual(['a b', 'c', '(d e)', 'BODY[HEADER.FIELDS (X Y)]']);
  });
  it('interpreta conjuntos de secuencia', () => {
    const p = seqPredicate('1:2,5,7:*', 9);
    expect([1, 2, 3, 5, 6, 8].map(p)).toEqual([true, true, false, true, false, true]);
  });
});
