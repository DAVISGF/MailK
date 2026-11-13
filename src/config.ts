import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)));

const schema = z.object({
  MAILK_AUTH: bool,
  MAILK_API_TOKEN: z.string().optional(),
  MAILK_SMTP_USER: z.string().optional(),
  MAILK_SMTP_PASS: z.string().optional(),
  MAILK_DB: z.string().default('./data/mailk.db'),
  MAILK_HOST: z.string().default('0.0.0.0'),
  MAILK_SMTP_PORT: num(1025),
  MAILK_IMAP_PORT: num(1143),
  MAILK_POP3_PORT: num(1110),
  MAILK_HTTP_PORT: num(8025),
  MAILK_SMTPS_PORT: num(1465),
  MAILK_IMAPS_PORT: num(1993),
  MAILK_POP3S_PORT: num(1995),
  MAILK_TLS_CERT: z.string().optional(),
  MAILK_TLS_KEY: z.string().optional(),
  MAILK_AUTO_CREATE: bool,
  MAILK_DEFAULT_GROUP: z.string().default('default'),
  MAILK_RELAY_URL: z.string().optional(),
  MAILK_PUBLIC_HOST: z.string().optional()
});

export interface Config {
  auth: boolean;
  apiToken?: string;
  smtpUser?: string;
  smtpPass?: string;
  dbPath: string;
  host: string;
  ports: { smtp: number; imap: number; pop3: number; http: number; smtps: number; imaps: number; pop3s: number };
  tls?: { cert: string; key: string };
  autoCreate: boolean;
  defaultGroup: string;
  relayUrl?: string;
  /** Host o IP públicos que las apps usan para conectarse (se muestra en la UI). */
  publicHost?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = schema.parse(env);
  const auth = e.MAILK_AUTH ?? false;
  if (auth && !e.MAILK_API_TOKEN) {
    throw new Error('MAILK_AUTH=on requiere MAILK_API_TOKEN');
  }
  if (auth && (!e.MAILK_SMTP_USER || !e.MAILK_SMTP_PASS)) {
    throw new Error('MAILK_AUTH=on requiere MAILK_SMTP_USER y MAILK_SMTP_PASS');
  }
  if (!!e.MAILK_TLS_CERT !== !!e.MAILK_TLS_KEY) {
    throw new Error('MAILK_TLS_CERT y MAILK_TLS_KEY deben definirse juntos');
  }
  return {
    auth,
    apiToken: e.MAILK_API_TOKEN,
    smtpUser: e.MAILK_SMTP_USER,
    smtpPass: e.MAILK_SMTP_PASS,
    dbPath: e.MAILK_DB,
    host: e.MAILK_HOST,
    ports: {
      smtp: e.MAILK_SMTP_PORT,
      imap: e.MAILK_IMAP_PORT,
      pop3: e.MAILK_POP3_PORT,
      http: e.MAILK_HTTP_PORT,
      smtps: e.MAILK_SMTPS_PORT,
      imaps: e.MAILK_IMAPS_PORT,
      pop3s: e.MAILK_POP3S_PORT
    },
    tls: e.MAILK_TLS_CERT && e.MAILK_TLS_KEY ? { cert: e.MAILK_TLS_CERT, key: e.MAILK_TLS_KEY } : undefined,
    autoCreate: e.MAILK_AUTO_CREATE ?? true,
    defaultGroup: e.MAILK_DEFAULT_GROUP,
    relayUrl: e.MAILK_RELAY_URL,
    publicHost: e.MAILK_PUBLIC_HOST?.trim() || undefined
  };
}
