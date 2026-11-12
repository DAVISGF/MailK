import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';

function headerTags(parsed: Awaited<ReturnType<typeof simpleParser>>): string[] {
  const h = parsed.headers.get('x-mailk-tags');
  return typeof h === 'string' ? h.split(',').map((s) => s.trim()) : [];
}

function headerGroup(parsed: Awaited<ReturnType<typeof simpleParser>>): string | undefined {
  const h = parsed.headers.get('x-mailk-group');
  return typeof h === 'string' && h.trim() ? h.trim() : undefined;
}

export function createSmtpServer(config: Config, store: Store, secure: boolean): SMTPServer {
  const relay = config.relayUrl ? nodemailer.createTransport(config.relayUrl) : undefined;

  return new SMTPServer({
    secure,
    ...(config.tls ? { key: config.tls.key, cert: config.tls.cert } : {}),
    authOptional: !config.auth,
    allowInsecureAuth: true,
    // STARTTLS solo si hay certificado propio (evita el certificado por defecto de la librería)
    disabledCommands: secure || !config.tls ? ['STARTTLS'] : [],
    size: 50 * 1024 * 1024,
    onAuth(auth, _session, cb) {
      if (!config.auth) return cb(null, { user: auth.username });
      if (auth.username === config.smtpUser && auth.password === config.smtpPass) {
        return cb(null, { user: auth.username });
      }
      return cb(new Error('Credenciales inválidas'));
    },
    onRcptTo(address, _session, cb) {
      const rcpt = address.address.toLowerCase();
      if (!store.getAccount(rcpt) && !config.autoCreate) {
        const err: Error & { responseCode?: number } = new Error(`Buzón desconocido: ${rcpt}`);
        err.responseCode = 550;
        return cb(err);
      }
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('error', cb);
      stream.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks);
          const parsed = await simpleParser(raw);
          const msgTags = headerTags(parsed);
          const group = headerGroup(parsed) ?? config.defaultGroup;
          const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
          for (const r of session.envelope.rcptTo) {
            const addr = r.address.toLowerCase();
            let acc = store.getAccount(addr);
            if (!acc) {
              if (!config.autoCreate) continue;
              acc = store.createAccount({ address: addr, group });
            }
            store.addMessage({
              accountId: acc.id,
              from,
              to: addr,
              subject: parsed.subject ?? '',
              raw,
              tags: [...acc.tags, ...msgTags]
            });
            if (acc.relayTo && relay) {
              await relay.sendMail({ envelope: { from, to: acc.relayTo }, raw });
            }
          }
          cb();
        } catch (e) {
          cb(e as Error);
        }
      });
    }
  });
}
