import type net from 'node:net';
import type { SMTPServer } from 'smtp-server';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { Store } from './store/index.js';
import { createSmtpServer } from './smtp/index.js';
import { createImapServer } from './imap/index.js';
import { createPop3Server } from './pop3/index.js';
import { createApi } from './api/index.js';
import type { LineServer } from './net.js';

export interface Mailk {
  store: Store;
  ports: Record<string, number>;
  close(): Promise<void>;
}

const listen = (srv: net.Server, port: number, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve((srv.address() as net.AddressInfo).port));
  });

const listenSmtp = (srv: SMTPServer, port: number, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    srv.server.once('error', reject);
    srv.listen(port, host, () => resolve((srv.server.address() as net.AddressInfo).port));
  });

export async function startMailk(config: Config): Promise<Mailk> {
  const store = new Store(config.dbPath);
  const ports: Record<string, number> = {};
  const closers: (() => Promise<void>)[] = [];
  const closeNet = (s: net.Server) => () =>
    new Promise<void>((r) => {
      s.close(() => r());
      (s as LineServer).destroyAll();
    });

  const smtp = createSmtpServer(config, store, false);
  ports.smtp = await listenSmtp(smtp, config.ports.smtp, config.host);
  closers.push(() => new Promise<void>((r) => smtp.close(() => r())));

  const imap = createImapServer(config, store, false);
  ports.imap = await listen(imap, config.ports.imap, config.host);
  closers.push(closeNet(imap));

  const pop3 = createPop3Server(config, store, false);
  ports.pop3 = await listen(pop3, config.ports.pop3, config.host);
  closers.push(closeNet(pop3));

  if (config.tls) {
    const smtps = createSmtpServer(config, store, true);
    ports.smtps = await listenSmtp(smtps, config.ports.smtps, config.host);
    closers.push(() => new Promise<void>((r) => smtps.close(() => r())));
    const imaps = createImapServer(config, store, true);
    ports.imaps = await listen(imaps, config.ports.imaps, config.host);
    closers.push(closeNet(imaps));
    const pop3s = createPop3Server(config, store, true);
    ports.pop3s = await listen(pop3s, config.ports.pop3s, config.host);
    closers.push(closeNet(pop3s));
  }

  const api: FastifyInstance = createApi(config, store);
  await api.listen({ port: config.ports.http, host: config.host });
  ports.http = (api.server.address() as net.AddressInfo).port;
  closers.push(() => api.close());

  return {
    store,
    ports,
    async close() {
      for (const c of closers.reverse()) await c();
      store.close();
    }
  };
}
