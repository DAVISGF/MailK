import net from 'node:net';
import { loadConfig, type Config } from '../src/config.js';
import { startMailk, type Mailk } from '../src/app.js';

export async function boot(env: Record<string, string> = {}): Promise<{ app: Mailk; config: Config; http: string }> {
  const config = loadConfig({
    MAILK_DB: ':memory:',
    MAILK_HOST: '127.0.0.1',
    MAILK_SMTP_PORT: '0',
    MAILK_IMAP_PORT: '0',
    MAILK_POP3_PORT: '0',
    MAILK_HTTP_PORT: '0',
    ...env
  });
  const app = await startMailk(config);
  return { app, config, http: `http://127.0.0.1:${app.ports.http}` };
}

/** Cliente de línea simple para probar POP3. */
export function lineClient(port: number) {
  const sock = net.connect(port, '127.0.0.1');
  sock.setEncoding('utf8');
  let buf = '';
  const waiters: (() => void)[] = [];
  sock.on('data', (d: string) => {
    buf += d;
    waiters.splice(0).forEach((w) => w());
  });
  const waitFor = (done: (b: string) => boolean): Promise<string> =>
    new Promise((resolve) => {
      const check = () => {
        if (done(buf)) {
          const out = buf;
          buf = '';
          resolve(out);
        } else waiters.push(check);
      };
      check();
    });
  return {
    greeting: () => waitFor((b) => b.includes('\r\n')),
    cmd: async (line: string, multi = false) => {
      sock.write(line + '\r\n');
      return waitFor((b) => (multi ? /\r\n\.\r\n$/.test(b) && b.startsWith('+OK') : b.endsWith('\r\n')));
    },
    close: () => sock.destroy()
  };
}
