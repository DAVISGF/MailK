import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import type net from 'node:net';
import { boot } from './helpers.js';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

let upstream: SMTPServer;
const received: Received[] = [];
let ctx: Awaited<ReturnType<typeof boot>>;

beforeAll(async () => {
  upstream = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString()
        });
        cb();
      });
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const port = (upstream.server.address() as net.AddressInfo).port;
  ctx = await boot({ MAILK_RELAY_URL: `smtp://127.0.0.1:${port}?ignoreTLS=true` });
});

afterAll(async () => {
  await ctx.app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const send = (to: string, subject: string) =>
  nodemailer
    .createTransport({ host: '127.0.0.1', port: ctx.app.ports.smtp, secure: false })
    .sendMail({ from: 'app@proyecto.test', to, subject, text: `cuerpo ${subject}` });

describe('relay opcional', () => {
  it('reenvía solo las cuentas con relayTo y siempre captura', async () => {
    ctx.app.store.createAccount({ address: 'con-relay@t.test', group: 'g', relayTo: 'real@externo.test' });
    ctx.app.store.createAccount({ address: 'sin-relay@t.test', group: 'g' });

    await send('con-relay@t.test', 'Reenviado');
    await send('sin-relay@t.test', 'Solo captura');

    expect(received).toHaveLength(1);
    expect(received[0].to).toEqual(['real@externo.test']);
    expect(received[0].from).toBe('app@proyecto.test');
    expect(received[0].raw).toContain('Subject: Reenviado');

    const subjects = ctx.app.store.listMessages({ group: 'g' }).map((m) => m.subject).sort();
    expect(subjects).toEqual(['Reenviado', 'Solo captura']);
  });

  it('si el relay falla, el correo igual queda capturado en MailK', async () => {
    ctx.app.store.createAccount({ address: 'otro@t.test', group: 'g2', relayTo: 'real@externo.test' });
    await new Promise<void>((r) => upstream.close(() => r()));
    // el remitente no debe ver un error: el correo se capturó correctamente
    await expect(send('otro@t.test', 'Relay caído')).resolves.toBeDefined();
    expect(ctx.app.store.listMessages({ account: 'otro@t.test' })).toHaveLength(1);
  });
});
