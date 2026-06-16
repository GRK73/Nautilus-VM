import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TorClient } from '../src/index.ts';

/** A minimal SOCKS5 proxy: NO-AUTH handshake, ATYP=domain CONNECT, then pipe. */
function fakeSocks(): Promise<{ server: net.Server; port: number; connects: string[] }> {
  const connects: string[] = [];
  const server = net.createServer((client) => {
    let phase = 0;
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', (d) => {
      if (phase >= 2) return;
      buf = Buffer.concat([buf, d]);
      if (phase === 0) {
        if (buf.length < 3) return;
        client.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(3);
        phase = 1;
      }
      if (phase === 1) {
        if (buf.length < 5) return;
        const dl = buf.readUInt8(4);
        if (buf.length < 5 + dl + 2) return;
        const host = buf.subarray(5, 5 + dl).toString();
        const port = buf.readUInt16BE(5 + dl);
        connects.push(`${host}:${port}`);
        const rest = buf.subarray(5 + dl + 2);
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          phase = 2;
          client.removeAllListeners('data');
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, connects })));
}

function httpTarget(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/chunked') {
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
      res.write('hidden ');
      res.end('service');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Onion Mirror</title>lost tape archive</html>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

test('fetches through a SOCKS5 proxy and parses the response', async () => {
  const socks = await fakeSocks();
  const target = await httpTarget();
  try {
    const tor = new TorClient({ host: '127.0.0.1', port: socks.port });
    const res = await tor.fetch(`http://127.0.0.1:${target.port}/page`);
    assert.equal(res.status, 200);
    assert.match(res.body.toString(), /lost tape archive/);
    assert.equal(res.headers['content-type'], 'text/html');
    // the proxy was asked to connect to the destination (Tor would resolve .onion here)
    assert.equal(socks.connects[0], `127.0.0.1:${target.port}`);
  } finally {
    socks.server.close();
    target.server.close();
  }
});

test('decodes chunked transfer-encoding', async () => {
  const socks = await fakeSocks();
  const target = await httpTarget();
  try {
    const tor = new TorClient({ host: '127.0.0.1', port: socks.port });
    const res = await tor.fetch(`http://127.0.0.1:${target.port}/chunked`);
    assert.equal(res.body.toString(), 'hidden service');
  } finally {
    socks.server.close();
    target.server.close();
  }
});

test('available() is false when no proxy is listening', async () => {
  // port 1 is virtually never an open SOCKS proxy
  const tor = new TorClient({ host: '127.0.0.1', port: 1 });
  assert.equal(await tor.available(), false);
});
