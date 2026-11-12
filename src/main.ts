import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { startMailk } from './app.js';

const config = loadConfig();
// MAILK_TLS_CERT / MAILK_TLS_KEY pueden ser rutas a archivos PEM o el contenido PEM directamente.
if (config.tls) {
  const read = (v: string) => (v.includes('BEGIN') ? v : readFileSync(v, 'utf8'));
  config.tls = { cert: read(config.tls.cert), key: read(config.tls.key) };
}

const app = await startMailk(config);
console.log(`MailK activo (auth=${config.auth ? 'on' : 'off'}, autoCreate=${config.autoCreate})`);
console.log(JSON.stringify(app.ports));

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
