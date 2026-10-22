#!/usr/bin/env node
// Prints the port of an already running LCEDA2Altium server (or 0).
// Used by run.cmd so the console launcher reuses a windowless instance
// instead of starting a second server on another port.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
// tools/probe.mjs -> project root. Do not reuse another copy's server.
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const normRoot = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const START = 43180;
const END = 43200;
const TIMEOUT_MS = 500;

function request(port, path) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const req = http.get({ host: HOST, port, path, timeout: TIMEOUT_MS, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      res.on('end', () => finish({ status: res.statusCode, body }));
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

async function isOurApp(port) {
  const health = await request(port, '/api/health');
  if (health && health.status === 200) {
    try {
      const h = JSON.parse(health.body);
      if (h && h.app === 'lceda2altium') {
        return !h.root || normRoot(h.root) === normRoot(APP_ROOT);
      }
    } catch { /* not JSON */ }
  }
  // Older build without /api/health: identify by the UI's build button.
  const home = await request(port, '/');
  return Boolean(home && home.status === 200 && home.body.includes('id="build-btn"'));
}

const ports = [];
const fromEnv = Number(process.env.PORT);
if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) ports.push(fromEnv);
for (let port = START; port <= END; port++) {
  if (!ports.includes(port)) ports.push(port);
}

for (const port of ports) {
  if (await isOurApp(port)) {
    process.stdout.write(String(port));
    process.exit(0);
  }
}
process.stdout.write('0');
