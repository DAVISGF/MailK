import net from 'node:net';
import tls from 'node:tls';
import type { Config } from './config.js';

export interface Conn {
  write(data: string | Buffer): void;
  end(): void;
}

/** Crea un servidor TCP (o TLS) que entrega líneas completas al handler. */
export function createLineServer(
  config: Config,
  secure: boolean,
  onConnection: (conn: Conn, hooks: { onLine: (cb: (line: string) => void | Promise<void>) => void }) => void
): net.Server {
  const handler = (socket: net.Socket) => {
    let buf = '';
    let queue: Promise<void> = Promise.resolve();
    let lineCb: (line: string) => void | Promise<void> = () => {};
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        // serializa el procesamiento para respetar el orden de comandos
        queue = queue
          .then(() => lineCb(line))
          .catch(() => {
            socket.destroy();
          });
      }
    });
    onConnection(
      { write: (d) => socket.write(d), end: () => socket.end() },
      { onLine: (cb) => (lineCb = cb) }
    );
  };
  let server: net.Server;
  if (secure) {
    if (!config.tls) throw new Error('TLS no configurado');
    server = tls.createServer({ cert: config.tls.cert, key: config.tls.key }, handler);
  } else {
    server = net.createServer(handler);
  }
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  (server as LineServer).destroyAll = () => sockets.forEach((s) => s.destroy());
  return server;
}

export type LineServer = net.Server & { destroyAll(): void };
