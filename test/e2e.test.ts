import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { boot, lineClient } from './helpers.js';

let ctx: Awaited<ReturnType<typeof boot>>;

beforeAll(async () => {
  ctx = await boot();
});
afterAll(async () => {
  await ctx.app.close();
});

const send = (to: string, subject: string, extra: Record<string, unknown> = {}) =>
  nodemailer
    .createTransport({ host: '127.0.0.1', port: ctx.app.ports.smtp, secure: false, tls: { rejectUnauthorized: false } })
    .sendMail({ from: 'app@proyecto.test', to, subject, text: `cuerpo de ${subject}`, ...extra });

describe('flujo completo', () => {
  it('SMTP -> API con auto-creación, grupos y etiquetas', async () => {
    await send('ana@a.test', 'Bienvenida', { headers: { 'X-MailK-Group': 'proyecto-a', 'X-MailK-Tags': 'registro' } });
    const accs = await (await fetch(`${ctx.http}/api/accounts?group=proyecto-a`)).json();
    expect(accs.map((a: any) => a.address)).toEqual(['ana@a.test']);
    const msgs = await (await fetch(`${ctx.http}/api/messages?group=proyecto-a&tag=registro`)).json();
    expect(msgs).toHaveLength(1);
    const detail = await (await fetch(`${ctx.http}/api/messages/${msgs[0].id}`)).json();
    expect(detail.text).toContain('cuerpo de Bienvenida');
  });

  it('sirve la interfaz web (HTML, CSS, JS e ícono)', async () => {
    const html = await fetch(`${ctx.http}/`);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('/app.js');
    for (const [path, type] of [['/app.js', 'javascript'], ['/app.css', 'text/css'], ['/favicon.svg', 'svg']]) {
      const r = await fetch(ctx.http + path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain(type);
    }
    const js = await (await fetch(`${ctx.http}/app.js`)).text();
    expect(js).toContain('Nueva cuenta');
    expect(js).toContain('Nuevo proyecto');
  });

  it('cuentas y proyectos informan correos y no leídos; un correo se marca como leído', async () => {
    await send('cont@cont.test', 'Uno', { headers: { 'X-MailK-Group': 'contadores' } });
    await send('cont@cont.test', 'Dos');
    const accs = await (await fetch(`${ctx.http}/api/accounts?group=contadores`)).json();
    expect(accs[0]).toMatchObject({ address: 'cont@cont.test', messages: 2, unseen: 2 });
    const msgs = await (await fetch(`${ctx.http}/api/messages?account=cont@cont.test`)).json();
    const r = await fetch(`${ctx.http}/api/messages/${msgs[0].id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seen: true })
    });
    expect((await r.json()).seen).toBe(true);
    const groups = await (await fetch(`${ctx.http}/api/groups`)).json();
    expect(groups.find((g: any) => g.name === 'contadores')).toMatchObject({ messages: 2, unseen: 1 });
    const bad = await fetch(`${ctx.http}/api/messages/${msgs[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"seen":"si"}' });
    expect(bad.status).toBe(400);
  });

  it('/api/config expone el host público pero nunca la clave SMTP', async () => {
    const s = await boot({ MAILK_PUBLIC_HOST: '203.0.113.7', MAILK_AUTH: 'on', MAILK_API_TOKEN: 't', MAILK_SMTP_USER: 'u', MAILK_SMTP_PASS: 'clave-smtp-secreta' });
    try {
      const r = await fetch(`${s.http}/api/config`, { headers: { authorization: 'Bearer t' } });
      const text = await r.text();
      expect(JSON.parse(text)).toMatchObject({ publicHost: '203.0.113.7', smtpUser: 'u', auth: true });
      expect(text).not.toContain('clave-smtp-secreta');
    } finally {
      await s.app.close();
    }
  });

  it('crea cuentas por API y limpia por grupo', async () => {
    const r = await fetch(`${ctx.http}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'bob@b.test', group: 'proyecto-b', password: 'pw' })
    });
    expect(r.status).toBe(201);
    await send('bob@b.test', 'Hola');
    const del = await (await fetch(`${ctx.http}/api/groups/proyecto-b/messages`, { method: 'DELETE' })).json();
    expect(del.deleted).toBe(1);
  });

  it('lee por IMAP (fetch, search, flags, expunge)', async () => {
    await send('carla@c.test', 'Uno');
    await send('carla@c.test', 'Dos');
    const c = new ImapFlow({ host: '127.0.0.1', port: ctx.app.ports.imap, secure: false, auth: { user: 'carla@c.test', pass: 'x' }, logger: false });
    await c.connect();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const subjects: string[] = [];
      for await (const m of c.fetch('1:*', { envelope: true, source: true })) {
        subjects.push(m.envelope!.subject!);
        expect(m.source!.toString()).toContain('cuerpo de');
      }
      expect(subjects).toEqual(['Uno', 'Dos']);
      expect(await c.search({ subject: 'Dos' })).toEqual([2]);
      await c.messageFlagsAdd('1', ['\\Deleted']);
      await c.messageDelete('1');
      expect(c.mailbox && (c.mailbox as any).exists).toBe(1);
    } finally {
      lock.release();
    }
    await c.logout();
    const left = await (await fetch(`${ctx.http}/api/messages?account=carla@c.test`)).json();
    expect(left.map((m: any) => m.subject)).toEqual(['Dos']);
  });

  it('lee y borra por POP3', async () => {
    await send('dani@d.test', 'Pop');
    const p = lineClient(ctx.app.ports.pop3);
    await p.greeting();
    expect(await p.cmd('USER dani@d.test')).toMatch(/^\+OK/);
    expect(await p.cmd('PASS x')).toMatch(/^\+OK 1/);
    expect(await p.cmd('STAT')).toMatch(/^\+OK 1 /);
    expect(await p.cmd('RETR 1', true)).toContain('cuerpo de Pop');
    expect(await p.cmd('DELE 1')).toMatch(/^\+OK/);
    await p.cmd('QUIT');
    p.close();
    const left = await (await fetch(`${ctx.http}/api/messages?account=dani@d.test`)).json();
    expect(left).toHaveLength(0);
  });
});

describe('modo auth=on', () => {
  it('exige token en la API, AUTH en SMTP y clave en IMAP', async () => {
    const s = await boot({
      MAILK_AUTH: 'on',
      MAILK_API_TOKEN: 'tok',
      MAILK_SMTP_USER: 'u',
      MAILK_SMTP_PASS: 'p',
      MAILK_AUTO_CREATE: 'off'
    });
    try {
      expect((await fetch(`${s.http}/api/groups`)).status).toBe(401);
      expect((await fetch(`${s.http}/api/groups`, { headers: { authorization: 'Bearer tok' } })).status).toBe(200);
      const mk = (auth?: { user: string; pass: string }) =>
        nodemailer.createTransport({ host: '127.0.0.1', port: s.app.ports.smtp, secure: false, auth, tls: { rejectUnauthorized: false } });
      await expect(mk().sendMail({ from: 'a@x.test', to: 'z@z.test', text: 'x' })).rejects.toThrow();
      s.app.store.createAccount({ address: 'z@z.test', group: 'g', password: 'secreto' });
      await mk({ user: 'u', pass: 'p' }).sendMail({ from: 'a@x.test', to: 'z@z.test', text: 'x', subject: 's' });
      await expect(mk({ user: 'u', pass: 'p' }).sendMail({ from: 'a@x.test', to: 'nadie@z.test', text: 'x' })).rejects.toThrow();
      const bad = new ImapFlow({ host: '127.0.0.1', port: s.app.ports.imap, secure: false, auth: { user: 'z@z.test', pass: 'mal' }, logger: false });
      await expect(bad.connect()).rejects.toThrow();
      const good = new ImapFlow({ host: '127.0.0.1', port: s.app.ports.imap, secure: false, auth: { user: 'z@z.test', pass: 'secreto' }, logger: false });
      await good.connect();
      await good.logout();
    } finally {
      await s.app.close();
    }
  });
});
