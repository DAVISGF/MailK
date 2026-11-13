import Fastify, { type FastifyInstance } from 'fastify';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Archivos de la interfaz web (src/web/static en desarrollo, dist/web/static tras compilar). */
const WEB_DIR = fileURLToPath(new URL('../web/static/', import.meta.url));
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' }
};

const nameRe = /^[\w.\-]{1,64}$/;
const addrRe = /^[^\s@]+@[^\s@]+$/;

export function createApi(config: Config, store: Store): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (!config.auth) return;
    if (!req.url.startsWith('/api/')) return;
    const h = req.headers.authorization;
    if (h !== `Bearer ${config.apiToken}`) {
      return reply.code(401).send({ error: 'No autorizado' });
    }
  });

  for (const [route, { file, type }] of Object.entries(STATIC_FILES)) {
    const body = readFileSync(WEB_DIR + file);
    app.get(route, async (_req, reply) => reply.type(type).header('cache-control', 'no-cache').send(body));
  }
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({
    auth: config.auth,
    autoCreate: config.autoCreate,
    defaultGroup: config.defaultGroup,
    ports: config.ports,
    tls: !!config.tls,
    publicHost: config.publicHost ?? null,
    // Solo el usuario SMTP (nunca la clave): la UI lo muestra en «Conectar tu app».
    smtpUser: config.auth ? config.smtpUser ?? null : null,
    relay: !!config.relayUrl
  }));

  // ---- grupos ----
  app.get('/api/groups', async () => store.listGroups());
  app.post('/api/groups', async (req, reply) => {
    const b = z.object({ name: z.string().regex(nameRe) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'name inválido' });
    if (store.getGroup(b.data.name)) return reply.code(409).send({ error: 'El grupo ya existe' });
    return reply.code(201).send(store.createGroup(b.data.name));
  });
  app.delete<{ Params: { g: string } }>('/api/groups/:g', async (req, reply) => {
    return store.deleteGroup(req.params.g) ? { deleted: true } : reply.code(404).send({ error: 'No existe' });
  });
  app.delete<{ Params: { g: string } }>('/api/groups/:g/messages', async (req) => ({
    deleted: store.deleteMessages({ group: req.params.g })
  }));
  app.get<{ Params: { g: string } }>('/api/groups/:g/accounts', async (req) => store.listAccounts(req.params.g));

  // ---- cuentas ----
  const accountBody = z.object({
    address: z.string().regex(addrRe),
    group: z.string().regex(nameRe).optional(),
    password: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    relayTo: z.string().regex(addrRe).nullable().optional()
  });
  app.get<{ Querystring: { group?: string } }>('/api/accounts', async (req) => store.listAccounts(req.query.group));
  app.post('/api/accounts', async (req, reply) => {
    const b = accountBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos inválidos', details: b.error.issues });
    if (store.getAccount(b.data.address)) return reply.code(409).send({ error: 'La cuenta ya existe' });
    const acc = store.createAccount({ ...b.data, group: b.data.group ?? config.defaultGroup });
    return reply.code(201).send(acc);
  });
  app.patch<{ Params: { address: string } }>('/api/accounts/:address', async (req, reply) => {
    const b = accountBody.partial().omit({ address: true }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos inválidos' });
    const acc = store.updateAccount(req.params.address, b.data);
    return acc ?? reply.code(404).send({ error: 'No existe' });
  });
  app.delete<{ Params: { address: string } }>('/api/accounts/:address', async (req, reply) =>
    store.deleteAccount(req.params.address) ? { deleted: true } : reply.code(404).send({ error: 'No existe' })
  );
  app.delete<{ Params: { address: string } }>('/api/accounts/:address/messages', async (req) => ({
    deleted: store.deleteMessages({ account: req.params.address })
  }));

  // ---- mensajes ----
  app.get<{ Querystring: { group?: string; account?: string; tag?: string; q?: string; limit?: string } }>(
    '/api/messages',
    async (req) => {
      const { limit, ...rest } = req.query;
      return store.listMessages({ ...rest, limit: limit ? Number(limit) : undefined });
    }
  );
  app.get<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const meta = store.getMessage(id);
    const raw = store.getRaw(id);
    if (!meta || !raw) return reply.code(404).send({ error: 'No existe' });
    const p = await simpleParser(raw);
    return {
      ...meta,
      cc: p.cc ? (Array.isArray(p.cc) ? p.cc.map((x) => x.text) : [p.cc.text]) : [],
      date: p.date ?? null,
      messageId: p.messageId ?? null,
      text: p.text ?? '',
      html: p.html || null,
      attachments: p.attachments.map((a, i) => ({
        index: i,
        filename: a.filename ?? `adjunto-${i}`,
        contentType: a.contentType,
        size: a.size
      }))
    };
  });
  app.get<{ Params: { id: string } }>('/api/messages/:id/raw', async (req, reply) => {
    const raw = store.getRaw(Number(req.params.id));
    if (!raw) return reply.code(404).send({ error: 'No existe' });
    return reply.type('message/rfc822').send(raw);
  });
  app.get<{ Params: { id: string; n: string } }>('/api/messages/:id/attachments/:n', async (req, reply) => {
    const raw = store.getRaw(Number(req.params.id));
    if (!raw) return reply.code(404).send({ error: 'No existe' });
    const p = await simpleParser(raw);
    const a = p.attachments[Number(req.params.n)];
    if (!a) return reply.code(404).send({ error: 'Adjunto inexistente' });
    return reply
      .type(a.contentType)
      .header('content-disposition', `attachment; filename="${a.filename ?? 'adjunto'}"`)
      .send(a.content);
  });
  app.patch<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) => {
    const b = z.object({ seen: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Datos inválidos' });
    const id = Number(req.params.id);
    if (!store.getMessage(id)) return reply.code(404).send({ error: 'No existe' });
    store.setFlags(id, { seen: b.data.seen });
    return store.getMessage(id);
  });
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (req, reply) =>
    store.deleteMessage(Number(req.params.id)) ? { deleted: true } : reply.code(404).send({ error: 'No existe' })
  );

  return app;
}
