import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_UA = 'Mozilla/5.0 (compatible; NautilusVM/0.1; lost-media-archival)';

export interface TorOptions {
  /** Tor SOCKS5 host. Default 127.0.0.1. */
  host?: string;
  /** Tor SOCKS5 port. Default 9050. */
  port?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface TorResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
}

/** SOCKS5 CONNECT through Tor, letting the proxy resolve the host (so .onion works). */
function socksConnect(socksHost: string, socksPort: number, destHost: string, destPort: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socksPort, socksHost);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (m: string) => {
      socket.destroy();
      reject(new Error(m));
    };
    socket.setTimeout(timeoutMs, () => fail('SOCKS timeout'));
    socket.once('error', (e) => reject(e));
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00]))); // VER, 1 method, NO-AUTH

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf.readUInt8(0) !== 0x05 || buf.readUInt8(1) !== 0x00) return fail('SOCKS5 auth negotiation failed');
        buf = buf.subarray(2);
        stage = 1;
        const host = Buffer.from(destHost, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), // CONNECT, ATYP=domain
          host,
          Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
        ]);
        socket.write(req);
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf.readUInt8(0) !== 0x05) return fail('bad SOCKS5 reply');
        const rep = buf.readUInt8(1);
        if (rep !== 0x00) return fail(`SOCKS5 connect failed (reply ${rep})`);
        const atyp = buf.readUInt8(3);
        let addrLen: number;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          addrLen = 1 + buf.readUInt8(4);
        } else return fail('bad SOCKS5 ATYP');
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        socket.removeAllListeners('data');
        socket.setTimeout(0);
        resolve(socket);
      }
    });
  });
}

function dechunk(body: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf('\r\n', i);
    if (nl === -1) break;
    const size = parseInt(body.subarray(i, nl).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = nl + 2;
    out.push(body.subarray(start, start + size));
    i = start + size + 2; // skip trailing CRLF
  }
  return Buffer.concat(out);
}

function parseHttpResponse(buf: Buffer, finalUrl: string): TorResponse {
  const sep = buf.indexOf('\r\n\r\n');
  const headPart = sep === -1 ? buf : buf.subarray(0, sep);
  let body = sep === -1 ? Buffer.alloc(0) : buf.subarray(sep + 4);
  const lines = headPart.toString('latin1').split('\r\n');
  const status = parseInt(lines[0]?.split(' ')[1] ?? '0', 10) || 0;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) body = dechunk(body);
  return { status, headers, body, finalUrl };
}

/**
 * Minimal HTTP(S)-over-Tor client. Routes a single GET through the Tor SOCKS5
 * proxy so .onion services resolve and load. No redirect following (rare for
 * hidden services); use the returned headers to chase a Location yourself.
 */
export class TorClient {
  #host: string;
  #port: number;
  #timeout: number;
  #ua: string;

  constructor(opts: TorOptions = {}) {
    this.#host = opts.host ?? '127.0.0.1';
    this.#port = opts.port ?? 9050;
    this.#timeout = opts.timeoutMs ?? 30_000;
    this.#ua = opts.userAgent ?? DEFAULT_UA;
  }

  /** Is the Tor SOCKS port reachable? */
  available(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.connect(this.#port, this.#host);
      s.setTimeout(3000);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
      s.once('timeout', () => {
        s.destroy();
        resolve(false);
      });
    });
  }

  async fetch(url: string): Promise<TorResponse> {
    const u = new URL(url);
    const https = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : https ? 443 : 80;

    const raw = await socksConnect(this.#host, this.#port, u.hostname, port, this.#timeout);
    let stream: net.Socket | tls.TLSSocket = raw;
    if (https) {
      stream = tls.connect({ socket: raw, servername: u.hostname, rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => {
        (stream as tls.TLSSocket).once('secureConnect', () => resolve());
        stream.once('error', reject);
      });
    }

    const path = `${u.pathname}${u.search}` || '/';
    stream.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: ${this.#ua}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.setTimeout(this.#timeout, () => {
        stream.destroy();
        reject(new Error('Tor read timeout'));
      });
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });

    return parseHttpResponse(Buffer.concat(chunks), url);
  }
}
