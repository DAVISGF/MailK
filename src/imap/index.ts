import type net from 'node:net';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { Config } from '../config.js';
import { loginMailbox } from '../auth.js';
import { createLineServer } from '../net.js';
import type { MessageMeta, Store } from '../store/index.js';

const UIDVALIDITY = 1;

/** Divide en tokens respetando comillas, paréntesis y corchetes. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') {
      i++;
      continue;
    }
    if (s[i] === '"') {
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        val += s[j++];
      }
      out.push(val);
      i = j + 1;
      continue;
    }
    let depth = 0;
    let j = i;
    while (j < s.length && (s[j] !== ' ' || depth > 0)) {
      if (s[j] === '(' || s[j] === '[') depth++;
      if (s[j] === ')' || s[j] === ']') depth--;
      j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

/** Convierte "1:3,5,7:*" en un predicado sobre números. */
export function seqPredicate(set: string, max: number): (n: number) => boolean {
  const ranges = set.split(',').map((part) => {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

const q = (s: string | null | undefined): string =>
  s == null ? 'NIL' : '"' + s.replace(/[\r\n]+/g, ' ').replace(/(["\\])/g, '\\$1') + '"';

function addrList(a: AddressObject | AddressObject[] | undefined): string {
  const list = a ? (Array.isArray(a) ? a.flatMap((x) => x.value) : a.value) : [];
  if (!list.length) return 'NIL';
  return (
    '(' +
    list
      .map((x) => {
        const [mb, host] = (x.address ?? '').split('@');
        return `(${q(x.name || null)} NIL ${q(mb)} ${q(host ?? '')})`;
      })
      .join('') +
    ')'
  );
}

function envelope(p: ParsedMail): string {
  return (
    '(' +
    [
      q(p.date ? p.date.toUTCString() : null),
      q(p.subject ?? ''),
      addrList(p.from),
      addrList(p.from),
      addrList(p.replyTo ?? p.from),
      addrList(p.to),
      addrList(p.cc),
      addrList(p.bcc),
      q((p.inReplyTo as string | undefined) ?? null),
      q(p.messageId ?? null)
    ].join(' ') +
    ')'
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function internalDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `"${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}:${p(d.getUTCSeconds())} +0000"`;
}

function splitMessage(raw: Buffer): { head: Buffer; body: Buffer } {
  const s = raw.toString('latin1');
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: raw, body: Buffer.alloc(0) };
  return { head: raw.subarray(0, m.index + m[0].length), body: raw.subarray(m.index + m[0].length) };
}

function headerFields(head: Buffer, names: string[], not: boolean): Buffer {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const lines = head.toString('latin1').replace(/\r?\n\r?\n$/, '').split(/\r?\n/);
  const fields: string[] = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && fields.length) fields[fields.length - 1] += '\r\n' + l;
    else fields.push(l);
  }
  const kept = fields.filter((f) => set.has(f.split(':')[0].toLowerCase()) !== not);
  return Buffer.from(kept.join('\r\n') + (kept.length ? '\r\n' : '') + '\r\n', 'latin1');
}

function section(raw: Buffer, spec: string): Buffer {
  const { head, body } = splitMessage(raw);
  const s = spec.trim();
  if (s === '') return raw;
  const upper = s.toUpperCase();
  if (upper === 'HEADER' || upper.endsWith('.MIME')) return head;
  if (upper === 'TEXT' || /^\d+(\.\d+)*$/.test(upper)) return body;
  const m = /^HEADER\.FIELDS(\.NOT)?\s*\(([^)]*)\)$/i.exec(s);
  if (m) return headerFields(head, m[2].split(/\s+/).filter(Boolean), !!m[1]);
  return Buffer.alloc(0);
}

function flagsOf(m: MessageMeta): string {
  return [m.seen ? '\\Seen' : '', m.deleted ? '\\Deleted' : ''].filter(Boolean).join(' ');
}

/** Servidor IMAP mínimo: una sola carpeta (INBOX) por cuenta. */
export function createImapServer(config: Config, store: Store, secure: boolean): net.Server {
  return createLineServer(config, secure, (conn, { onLine }) => {
    let accountId = 0;
    let selected = false;
    let readOnly = false;
    let snap: MessageMeta[] = [];
    const send = (s: string) => conn.write(s + '\r\n');

    const sync = () => {
      if (!accountId) return;
      const fresh = store.mailbox(accountId);
      const grew = fresh.length > snap.length;
      snap = fresh;
      if (grew) send(`* ${snap.length} EXISTS`);
    };

    async function fetchOne(m: MessageMeta, seq: number, itemsRaw: string, forceUid: boolean): Promise<Buffer> {
      let items = itemsRaw.trim();
      if (/^all$/i.test(items)) items = 'FLAGS INTERNALDATE RFC822.SIZE ENVELOPE';
      else if (/^fast$/i.test(items)) items = 'FLAGS INTERNALDATE RFC822.SIZE';
      else if (/^full$/i.test(items)) items = 'FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODY';
      if (items.startsWith('(') && items.endsWith(')')) items = items.slice(1, -1);
      const wanted = items.match(/BODY(?:\.PEEK)?\[[^\]]*(?:\([^)]*\))?[^\]]*\](?:<\d+\.\d+>)?|[A-Za-z0-9.]+/g) ?? [];
      const raw = store.getRaw(m.id)!;
      const parts: Buffer[] = [];
      let hasUid = false;
      let setSeen = false;
      let parsed: ParsedMail | undefined;

      for (const w of wanted) {
        const key = w.toUpperCase();
        const bm = /^BODY(\.PEEK)?\[(.*)\](?:<(\d+)\.(\d+)>)?$/is.exec(w);
        if (bm) {
          let data = section(raw, bm[2]);
          let label = `BODY[${bm[2]}]`;
          if (bm[3] !== undefined) {
            const off = Number(bm[3]);
            data = data.subarray(off, off + Number(bm[4]));
            label += `<${off}>`;
          }
          if (!bm[1] && !m.seen) setSeen = true;
          parts.push(Buffer.concat([Buffer.from(`${label} {${data.length}}\r\n`), data]));
        } else if (key === 'UID') {
          hasUid = true;
          parts.push(Buffer.from(`UID ${m.id}`));
        } else if (key === 'FLAGS') {
          parts.push(Buffer.from(`FLAGS (${flagsOf(m)})`));
        } else if (key === 'RFC822.SIZE') {
          parts.push(Buffer.from(`RFC822.SIZE ${m.size}`));
        } else if (key === 'INTERNALDATE') {
          parts.push(Buffer.from(`INTERNALDATE ${internalDate(m.receivedAt)}`));
        } else if (key === 'ENVELOPE') {
          parsed ??= await simpleParser(raw);
          parts.push(Buffer.from(`ENVELOPE ${envelope(parsed)}`));
        } else if (key === 'BODYSTRUCTURE' || key === 'BODY') {
          const lines = raw.toString('latin1').split('\n').length;
          const { body } = splitMessage(raw);
          parts.push(
            Buffer.from(`${key} ("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "8BIT" ${body.length} ${lines})`)
          );
        } else if (key === 'RFC822' || key === 'RFC822.HEADER' || key === 'RFC822.TEXT') {
          const data = key === 'RFC822' ? raw : section(raw, key === 'RFC822.HEADER' ? 'HEADER' : 'TEXT');
          if (key !== 'RFC822.HEADER' && !m.seen) setSeen = true;
          parts.push(Buffer.concat([Buffer.from(`${key} {${data.length}}\r\n`), data]));
        }
      }
      if (setSeen && !readOnly) {
        store.setFlags(m.id, { seen: true });
        m.seen = true;
        parts.push(Buffer.from(`FLAGS (${flagsOf(m)})`));
      }
      if (forceUid && !hasUid) parts.unshift(Buffer.from(`UID ${m.id}`));

      const inner: Buffer[] = [];
      parts.forEach((p, i) => {
        if (i) inner.push(Buffer.from(' '));
        inner.push(p);
      });
      return Buffer.concat([Buffer.from(`* ${seq} FETCH (`), ...inner, Buffer.from(')\r\n')]);
    }

    function searchMatch(m: MessageMeta, seq: number, toks: string[]): boolean {
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i].toUpperCase();
        const arg = () => (toks[++i] ?? '').toLowerCase();
        const raw = () => store.getRaw(m.id)!.toString('utf8').toLowerCase();
        switch (t) {
          case 'ALL':
            break;
          case 'UNSEEN':
            if (m.seen) return false;
            break;
          case 'SEEN':
            if (!m.seen) return false;
            break;
          case 'DELETED':
            if (!m.deleted) return false;
            break;
          case 'UNDELETED':
            if (m.deleted) return false;
            break;
          case 'SUBJECT':
            if (!m.subject.toLowerCase().includes(arg())) return false;
            break;
          case 'FROM':
            if (!m.from.toLowerCase().includes(arg())) return false;
            break;
          case 'TO':
            if (!m.to.toLowerCase().includes(arg())) return false;
            break;
          case 'TEXT':
          case 'BODY':
            if (!raw().includes(arg())) return false;
            break;
          case 'UID':
            if (!seqPredicate(toks[++i] ?? '', Number.MAX_SAFE_INTEGER)(m.id)) return false;
            break;
          default:
            if (/^[\d*:,]+$/.test(t) && !seqPredicate(t, snap.length)(seq)) return false;
        }
      }
      return true;
    }

    async function handle(tag: string, cmdRaw: string, args: string): Promise<void> {
      let cmd = cmdRaw.toUpperCase();
      const ok = (t: string) => send(`${tag} OK ${t}`);
      const no = (t: string) => send(`${tag} NO ${t}`);
      const bad = (t: string) => send(`${tag} BAD ${t}`);
      let uid = false;
      let a = args;

      if (cmd === 'UID') {
        uid = true;
        const sp = a.indexOf(' ');
        cmd = (sp < 0 ? a : a.slice(0, sp)).toUpperCase();
        a = sp < 0 ? '' : a.slice(sp + 1);
      }

      if (cmd === 'CAPABILITY') {
        send('* CAPABILITY IMAP4rev1');
        return ok('CAPABILITY completed');
      }
      if (cmd === 'NOOP' || cmd === 'CHECK') {
        sync();
        return ok(`${cmd} completed`);
      }
      if (cmd === 'LOGOUT') {
        send('* BYE MailK cierra la conexión');
        ok('LOGOUT completed');
        return conn.end();
      }
      if (cmd === 'LOGIN') {
        const [user, pass] = tokenize(a);
        const acc = user !== undefined && pass !== undefined ? loginMailbox(config, store, user, pass) : null;
        if (!acc) return no('[AUTHENTICATIONFAILED] Credenciales inválidas');
        accountId = acc.id;
        return ok('LOGIN completed');
      }
      if (!accountId) return no('Autentícate primero');

      switch (cmd) {
        case 'LIST':
        case 'LSUB': {
          const [ref, pat] = tokenize(a);
          if (pat === '' && ref !== undefined) {
            send(`* ${cmd} (\\Noselect) "/" ""`);
          } else {
            const re = new RegExp('^' + (pat ?? '*').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*') + '$', 'i');
            if (re.test('INBOX')) send(`* ${cmd} (\\HasNoChildren) "/" "INBOX"`);
          }
          return ok(`${cmd} completed`);
        }
        case 'SELECT':
        case 'EXAMINE': {
          const [name] = tokenize(a);
          if (!name || name.toUpperCase() !== 'INBOX') return no('Solo existe INBOX');
          snap = store.mailbox(accountId);
          selected = true;
          readOnly = cmd === 'EXAMINE';
          send(`* ${snap.length} EXISTS`);
          send('* 0 RECENT');
          send(`* OK [UIDVALIDITY ${UIDVALIDITY}] UIDs válidos`);
          send(`* OK [UIDNEXT ${store.nextUid()}] Próximo UID`);
          send('* FLAGS (\\Seen \\Deleted)');
          send('* OK [PERMANENTFLAGS (\\Seen \\Deleted)] Flags permitidas');
          return ok(`[${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed`);
        }
        case 'STATUS': {
          const [name, itemsRaw] = tokenize(a);
          if (!name || name.toUpperCase() !== 'INBOX') return no('Solo existe INBOX');
          const box = store.mailbox(accountId);
          const vals: Record<string, number> = {
            MESSAGES: box.length,
            RECENT: 0,
            UIDNEXT: store.nextUid(),
            UIDVALIDITY,
            UNSEEN: box.filter((m) => !m.seen).length
          };
          const want = (itemsRaw ?? '').replace(/[()]/g, '').split(/\s+/).filter(Boolean);
          send(`* STATUS "INBOX" (${want.map((k) => `${k.toUpperCase()} ${vals[k.toUpperCase()] ?? 0}`).join(' ')})`);
          return ok('STATUS completed');
        }
        case 'SUBSCRIBE':
        case 'UNSUBSCRIBE':
          return ok(`${cmd} completed`);
        case 'CREATE':
        case 'DELETE':
        case 'RENAME':
        case 'APPEND':
        case 'COPY':
          return no('Operación no soportada en MailK');
        case 'CLOSE':
        case 'UNSELECT':
        case 'EXPUNGE': {
          if (!selected) return no('Ninguna carpeta seleccionada');
          if (cmd === 'EXPUNGE' || (cmd === 'CLOSE' && !readOnly)) {
            if (readOnly) return no('Carpeta en solo lectura');
            for (let i = 0; i < snap.length; ) {
              if (snap[i].deleted) {
                store.deleteMessage(snap[i].id);
                snap.splice(i, 1);
                if (cmd === 'EXPUNGE') send(`* ${i + 1} EXPUNGE`);
              } else i++;
            }
          }
          if (cmd !== 'EXPUNGE') {
            selected = false;
            snap = [];
          }
          return ok(`${cmd} completed`);
        }
        case 'FETCH': {
          if (!selected) return no('Ninguna carpeta seleccionada');
          const sp = a.indexOf(' ');
          const set = a.slice(0, sp);
          const items = a.slice(sp + 1);
          const maxVal = uid ? Math.max(0, ...snap.map((m) => m.id)) : snap.length;
          const match = seqPredicate(set, maxVal);
          for (let i = 0; i < snap.length; i++) {
            if (match(uid ? snap[i].id : i + 1)) conn.write(await fetchOne(snap[i], i + 1, items, uid));
          }
          return ok('FETCH completed');
        }
        case 'SEARCH': {
          if (!selected) return no('Ninguna carpeta seleccionada');
          const toks = tokenize(a.replace(/^CHARSET\s+\S+\s+/i, ''));
          const hits = snap
            .map((m, i) => ({ m, seq: i + 1 }))
            .filter((x) => searchMatch(x.m, x.seq, toks))
            .map((x) => (uid ? x.m.id : x.seq));
          send(`* SEARCH${hits.length ? ' ' + hits.join(' ') : ''}`);
          return ok('SEARCH completed');
        }
        case 'STORE': {
          if (!selected) return no('Ninguna carpeta seleccionada');
          if (readOnly) return no('Carpeta en solo lectura');
          const sp = a.indexOf(' ');
          const set = a.slice(0, sp);
          const [mode, flagsRaw] = tokenize(a.slice(sp + 1));
          const silent = /\.SILENT$/i.test(mode ?? '');
          const op = (mode ?? '').startsWith('+') ? 'add' : (mode ?? '').startsWith('-') ? 'del' : 'set';
          const flags = (flagsRaw ?? '').replace(/[()]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
          const maxVal = uid ? Math.max(0, ...snap.map((m) => m.id)) : snap.length;
          const match = seqPredicate(set, maxVal);
          snap.forEach((m, i) => {
            if (!match(uid ? m.id : i + 1)) return;
            const has = (f: string) => flags.includes(f);
            const seen = op === 'set' ? has('\\seen') : has('\\seen') ? op === 'add' : m.seen;
            const del = op === 'set' ? has('\\deleted') : has('\\deleted') ? op === 'add' : m.deleted;
            store.setFlags(m.id, { seen, deleted: del });
            m.seen = seen;
            m.deleted = del;
            if (!silent) send(`* ${i + 1} FETCH (FLAGS (${flagsOf(m)})${uid ? ` UID ${m.id}` : ''})`);
          });
          return ok('STORE completed');
        }
        default:
          return bad(`Comando desconocido: ${cmdRaw}`);
      }
    }

    send('* OK [CAPABILITY IMAP4rev1] MailK IMAP listo');

    onLine(async (line) => {
      const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!m) return send('* BAD Comando mal formado');
      try {
        await handle(m[1], m[2], m[3] ?? '');
      } catch (e) {
        send(`${m[1]} BAD Error interno: ${(e as Error).message}`);
      }
    });
  });
}
