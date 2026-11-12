import type net from 'node:net';
import type { Config } from '../config.js';
import { loginMailbox } from '../auth.js';
import { createLineServer } from '../net.js';
import type { MessageMeta, Store } from '../store/index.js';

/** Servidor POP3 mínimo: USER/PASS, STAT, LIST, UIDL, RETR, TOP, DELE, RSET, NOOP, QUIT. */
export function createPop3Server(config: Config, store: Store, secure: boolean): net.Server {
  return createLineServer(config, secure, (conn, { onLine }) => {
    let user = '';
    let state: 'auth' | 'trans' = 'auth';
    let accountId = 0;
    let msgs: MessageMeta[] = [];
    const marked = new Set<number>();
    const ok = (t = '') => conn.write(`+OK ${t}\r\n`);
    const err = (t = '') => conn.write(`-ERR ${t}\r\n`);
    const live = () => msgs.map((m, i) => ({ m, n: i + 1 })).filter((x) => !marked.has(x.n));
    const multiline = (lines: string[]) => conn.write(lines.join('\r\n') + (lines.length ? '\r\n' : '') + '.\r\n');
    const stuff = (raw: string) =>
      raw
        .split(/\r?\n/)
        .map((l) => (l.startsWith('.') ? '.' + l : l))
        .join('\r\n');

    ok('MailK POP3 listo');

    onLine((line) => {
      const [cmdRaw, ...rest] = line.split(' ');
      const cmd = cmdRaw.toUpperCase();
      const arg = rest.join(' ');

      if (cmd === 'QUIT') {
        if (state === 'trans') for (const n of marked) store.deleteMessage(msgs[n - 1].id);
        ok('Adiós');
        return conn.end();
      }
      if (cmd === 'CAPA') {
        conn.write('+OK\r\n');
        return multiline(['USER', 'UIDL', 'TOP', 'RESP-CODES']);
      }

      if (state === 'auth') {
        if (cmd === 'USER') {
          user = arg;
          return ok();
        }
        if (cmd === 'PASS') {
          const acc = user ? loginMailbox(config, store, user, arg) : null;
          if (!acc) return err('Autenticación fallida');
          accountId = acc.id;
          msgs = store.mailbox(accountId);
          state = 'trans';
          return ok(`${msgs.length} mensajes`);
        }
        return err('Comando no válido en este estado');
      }

      const num = Number(arg.split(' ')[0]);
      const pick = () => (Number.isInteger(num) && num >= 1 && num <= msgs.length && !marked.has(num) ? msgs[num - 1] : null);

      switch (cmd) {
        case 'NOOP':
          return ok();
        case 'STAT': {
          const l = live();
          return ok(`${l.length} ${l.reduce((s, x) => s + x.m.size, 0)}`);
        }
        case 'LIST':
        case 'UIDL': {
          const val = (x: { m: MessageMeta; n: number }) => (cmd === 'LIST' ? x.m.size : x.m.id);
          if (arg) {
            const m = pick();
            return m ? ok(`${num} ${cmd === 'LIST' ? m.size : m.id}`) : err('No existe ese mensaje');
          }
          conn.write('+OK\r\n');
          return multiline(live().map((x) => `${x.n} ${val(x)}`));
        }
        case 'RETR': {
          const m = pick();
          if (!m) return err('No existe ese mensaje');
          const raw = store.getRaw(m.id)!.toString('utf8');
          conn.write(`+OK ${m.size} octetos\r\n`);
          return conn.write(stuff(raw) + '\r\n.\r\n');
        }
        case 'TOP': {
          const m = pick();
          const lines = Number(arg.split(' ')[1] ?? 0);
          if (!m) return err('No existe ese mensaje');
          const raw = store.getRaw(m.id)!.toString('utf8');
          const sep = raw.search(/\r?\n\r?\n/);
          const head = sep >= 0 ? raw.slice(0, sep) : raw;
          const body = sep >= 0 ? raw.slice(sep).replace(/^\r?\n\r?\n/, '').split(/\r?\n/).slice(0, lines).join('\r\n') : '';
          conn.write('+OK\r\n');
          return conn.write(stuff(head + '\r\n\r\n' + body) + '\r\n.\r\n');
        }
        case 'DELE': {
          if (!pick()) return err('No existe ese mensaje');
          marked.add(num);
          return ok('Marcado');
        }
        case 'RSET':
          marked.clear();
          return ok();
        default:
          return err('Comando desconocido');
      }
    });
  });
}
