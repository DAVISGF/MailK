import type { Config } from './config.js';
import type { Account, Store } from './store/index.js';

/**
 * Autenticación de buzón para IMAP/POP3.
 * - Modo abierto (auth=off): cualquier clave sirve; la cuenta se auto-crea si está permitido.
 * - Modo auth=on: la cuenta debe existir y la clave coincidir.
 */
export function loginMailbox(config: Config, store: Store, user: string, pass: string): Account | null {
  const address = user.trim().toLowerCase();
  let acc = store.getAccount(address);
  if (config.auth) {
    return acc && acc.password === pass ? acc : null;
  }
  if (!acc && config.autoCreate && /^[^\s@]+@[^\s@]+$/.test(address)) {
    acc = store.createAccount({ address, group: config.defaultGroup });
  }
  return acc ?? null;
}
