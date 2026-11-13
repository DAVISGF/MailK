import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Group {
  id: number;
  name: string;
  createdAt: string;
}

export interface Account {
  id: number;
  address: string;
  group: string;
  password: string;
  tags: string[];
  relayTo: string | null;
  createdAt: string;
  /** Total de correos del buzón. */
  messages: number;
  /** Correos sin leer. */
  unseen: number;
}

export interface MessageMeta {
  id: number;
  accountId: number;
  account: string;
  group: string;
  from: string;
  to: string;
  subject: string;
  tags: string[];
  size: number;
  seen: boolean;
  deleted: boolean;
  receivedAt: string;
}

export interface MessageFilter {
  group?: string;
  account?: string;
  tag?: string;
  q?: string;
  limit?: number;
}

const splitTags = (s: string | null): string[] => (s ? s.split(',').filter(Boolean) : []);
const joinTags = (t?: string[]): string =>
  [...new Set((t ?? []).map((x) => x.trim()).filter(Boolean))].join(',');

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        address TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        relay_to TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        mail_from TEXT NOT NULL,
        mail_to TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        raw BLOB NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        seen INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- grupos ----
  ensureGroup(name: string): Group {
    this.db.prepare('INSERT OR IGNORE INTO groups(name) VALUES (?)').run(name);
    return this.getGroup(name)!;
  }

  createGroup(name: string): Group {
    this.db.prepare('INSERT INTO groups(name) VALUES (?)').run(name);
    return this.getGroup(name)!;
  }

  getGroup(name: string): Group | undefined {
    const r = this.db.prepare('SELECT id, name, created_at AS createdAt FROM groups WHERE name = ?').get(name);
    return r as Group | undefined;
  }

  listGroups(): (Group & { accounts: number; messages: number; unseen: number })[] {
    return this.db
      .prepare(
        `SELECT g.id, g.name, g.created_at AS createdAt,
           (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id) AS accounts,
           (SELECT COUNT(*) FROM messages m JOIN accounts a ON a.id = m.account_id WHERE a.group_id = g.id) AS messages,
           (SELECT COUNT(*) FROM messages m JOIN accounts a ON a.id = m.account_id WHERE a.group_id = g.id AND m.seen = 0) AS unseen
         FROM groups g ORDER BY g.name`
      )
      .all() as (Group & { accounts: number; messages: number; unseen: number })[];
  }

  deleteGroup(name: string): boolean {
    return this.db.prepare('DELETE FROM groups WHERE name = ?').run(name).changes > 0;
  }

  // ---- cuentas ----
  private mapAccount(r: any): Account {
    return {
      id: r.id,
      address: r.address,
      group: r.groupName,
      password: r.password,
      tags: splitTags(r.tags),
      relayTo: r.relay_to,
      createdAt: r.created_at,
      messages: r.messageCount ?? 0,
      unseen: r.unseenCount ?? 0
    };
  }

  private static ACCOUNT_SQL = `SELECT a.*, g.name AS groupName,
      (SELECT COUNT(*) FROM messages m WHERE m.account_id = a.id) AS messageCount,
      (SELECT COUNT(*) FROM messages m WHERE m.account_id = a.id AND m.seen = 0) AS unseenCount
    FROM accounts a JOIN groups g ON g.id = a.group_id`;

  createAccount(input: {
    address: string;
    group: string;
    password?: string;
    tags?: string[];
    relayTo?: string | null;
  }): Account {
    const address = input.address.trim().toLowerCase();
    const g = this.ensureGroup(input.group);
    this.db
      .prepare('INSERT INTO accounts(group_id, address, password, tags, relay_to) VALUES (?,?,?,?,?)')
      .run(g.id, address, input.password ?? address, joinTags(input.tags), input.relayTo ?? null);
    return this.getAccount(address)!;
  }

  getAccount(address: string): Account | undefined {
    const r = this.db.prepare(`${Store.ACCOUNT_SQL} WHERE a.address = ?`).get(address.trim().toLowerCase());
    return r ? this.mapAccount(r) : undefined;
  }

  listAccounts(group?: string): Account[] {
    const rows = group
      ? this.db.prepare(`${Store.ACCOUNT_SQL} WHERE g.name = ? ORDER BY a.address`).all(group)
      : this.db.prepare(`${Store.ACCOUNT_SQL} ORDER BY a.address`).all();
    return rows.map((r) => this.mapAccount(r));
  }

  updateAccount(
    address: string,
    patch: { group?: string; password?: string; tags?: string[]; relayTo?: string | null }
  ): Account | undefined {
    const a = this.getAccount(address);
    if (!a) return undefined;
    const gid = patch.group ? this.ensureGroup(patch.group).id : this.getGroup(a.group)!.id;
    this.db
      .prepare('UPDATE accounts SET group_id=?, password=?, tags=?, relay_to=? WHERE id=?')
      .run(
        gid,
        patch.password ?? a.password,
        patch.tags ? joinTags(patch.tags) : joinTags(a.tags),
        patch.relayTo === undefined ? a.relayTo : patch.relayTo,
        a.id
      );
    return this.getAccount(address);
  }

  deleteAccount(address: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE address = ?').run(address.trim().toLowerCase()).changes > 0;
  }

  // ---- mensajes ----
  addMessage(input: {
    accountId: number;
    from: string;
    to: string;
    subject: string;
    raw: Buffer;
    tags?: string[];
  }): number {
    const r = this.db
      .prepare('INSERT INTO messages(account_id, mail_from, mail_to, subject, raw, tags) VALUES (?,?,?,?,?,?)')
      .run(input.accountId, input.from, input.to, input.subject, input.raw, joinTags(input.tags));
    return Number(r.lastInsertRowid);
  }

  private static MSG_SQL = `SELECT m.id, m.account_id AS accountId, a.address AS account, g.name AS groupName,
      m.mail_from AS mailFrom, m.mail_to AS mailTo, m.subject, m.tags, length(m.raw) AS size,
      m.seen, m.deleted, m.received_at AS receivedAt
    FROM messages m JOIN accounts a ON a.id = m.account_id JOIN groups g ON g.id = a.group_id`;

  private mapMeta(r: any): MessageMeta {
    return {
      id: r.id,
      accountId: r.accountId,
      account: r.account,
      group: r.groupName,
      from: r.mailFrom,
      to: r.mailTo,
      subject: r.subject,
      tags: splitTags(r.tags),
      size: r.size,
      seen: !!r.seen,
      deleted: !!r.deleted,
      receivedAt: r.receivedAt
    };
  }

  listMessages(f: MessageFilter = {}): MessageMeta[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.group) {
      where.push('g.name = ?');
      params.push(f.group);
    }
    if (f.account) {
      where.push('a.address = ?');
      params.push(f.account.toLowerCase());
    }
    if (f.tag) {
      where.push("(',' || m.tags || ',') LIKE ?");
      params.push(`%,${f.tag},%`);
    }
    if (f.q) {
      where.push('(m.subject LIKE ? OR m.mail_from LIKE ? OR m.mail_to LIKE ? OR CAST(m.raw AS TEXT) LIKE ?)');
      const like = `%${f.q}%`;
      params.push(like, like, like, like);
    }
    const sql = `${Store.MSG_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT ?`;
    params.push(f.limit ?? 500);
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => this.mapMeta(r));
  }

  /** Próximo UID global que se asignará (AUTOINCREMENT). */
  nextUid(): number {
    const r = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as
      | { seq: number }
      | undefined;
    return (r?.seq ?? 0) + 1;
  }

  /** Mensajes de un buzón en orden ascendente (para IMAP/POP3). */
  mailbox(accountId: number): MessageMeta[] {
    return this.db
      .prepare(`${Store.MSG_SQL} WHERE m.account_id = ? ORDER BY m.id ASC`)
      .all(accountId)
      .map((r) => this.mapMeta(r));
  }

  getMessage(id: number): MessageMeta | undefined {
    const r = this.db.prepare(`${Store.MSG_SQL} WHERE m.id = ?`).get(id);
    return r ? this.mapMeta(r) : undefined;
  }

  getRaw(id: number): Buffer | undefined {
    const r = this.db.prepare('SELECT raw FROM messages WHERE id = ?').get(id) as { raw: Buffer } | undefined;
    return r?.raw;
  }

  setFlags(id: number, flags: { seen?: boolean; deleted?: boolean }): void {
    if (flags.seen !== undefined) this.db.prepare('UPDATE messages SET seen=? WHERE id=?').run(flags.seen ? 1 : 0, id);
    if (flags.deleted !== undefined)
      this.db.prepare('UPDATE messages SET deleted=? WHERE id=?').run(flags.deleted ? 1 : 0, id);
  }

  deleteMessage(id: number): boolean {
    return this.db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
  }

  deleteMessages(f: { group?: string; account?: string }): number {
    if (f.account) {
      return this.db
        .prepare('DELETE FROM messages WHERE account_id IN (SELECT id FROM accounts WHERE address = ?)')
        .run(f.account.toLowerCase()).changes;
    }
    if (f.group) {
      return this.db
        .prepare(
          'DELETE FROM messages WHERE account_id IN (SELECT a.id FROM accounts a JOIN groups g ON g.id=a.group_id WHERE g.name = ?)'
        )
        .run(f.group).changes;
    }
    return this.db.prepare('DELETE FROM messages').run().changes;
  }
}
