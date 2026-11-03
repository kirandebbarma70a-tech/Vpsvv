'use strict';

/**
 * render-vps  —  ek chhota "VPS" jo Render par chalta hai
 * ---------------------------------------------------------
 *  1. Andar real sshd chalta hai (sirf 127.0.0.1:22 par bind).
 *  2. Yeh Node server Render ke HTTPS port par listen karta hai aur
 *     WebSocket ko us sshd ke TCP socket se pipe karta hai  ->  /ws
 *  3. Bonus: browser ke liye web terminal (xterm.js + ssh2)     ->  /term
 *
 * Render sirf HTTP/HTTPS (aur usi par WebSocket) expose karta hai,
 * raw TCP port nahi. Isliye SSH ko WebSocket ke andar tunnel karte hain.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Client: SSHClient } = require('ssh2');

const PORT = Number(process.env.PORT || 8080);
const SSH_HOST = '127.0.0.1';
const SSH_PORT = Number(process.env.SSH_PORT || 22);
const SSH_USER = process.env.SSH_USER || 'root';
const SSH_PASSWORD = process.env.SSH_PASSWORD || '';
const TOKEN = (process.env.WS_TOKEN || '').trim();
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').trim();
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 10);

let activeSessions = 0;

const indexTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function checkToken(req, url) {
  if (!TOKEN) return true; // token set nahi hai to auth off (testing ke liye)
  const fromQuery = url.searchParams.get('token') || '';
  const fromHeader = req.headers['x-ws-token'] || '';
  const fromAuth = (() => {
    const h = req.headers['authorization'] || '';
    if (!h.toLowerCase().startsWith('basic ')) return '';
    try {
      return Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
    } catch { return ''; }
  })();
  return safeEqual(fromQuery, TOKEN) || safeEqual(fromHeader, TOKEN) || safeEqual(fromAuth, TOKEN);
}

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

/* ------------------------------------------------------------------ */
/* http server                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const host = PUBLIC_HOST || req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      host,
      user: SSH_USER,
      tokenRequired: Boolean(TOKEN),
      passwordLogin: Boolean(SSH_PASSWORD),
      activeSessions,
      wsPaths: ['/ws', '/term'],
    }));
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = indexTemplate
      .replaceAll('{{HOST}}', host)
      .replaceAll('{{USER}}', SSH_USER);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');

  if (!['/ws', '/term'].includes(url.pathname)) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (!checkToken(req, url)) {
    log('rejected: bad token', req.socket.remoteAddress);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  if (activeSessions >= MAX_SESSIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    if (url.pathname === '/term') handleTerminal(ws);
    else handleTcpBridge(ws);
  });
});

/* ------------------------------------------------------------------ */
/* 1) raw websocket <-> tcp bridge  (asli SSH clients ke liye)         */
/* ------------------------------------------------------------------ */

function handleTcpBridge(ws) {
  activeSessions++;
  const tcp = net.connect({ host: SSH_HOST, port: SSH_PORT });
  tcp.setNoDelay(true);

  let closed = false;
  const shutdown = (why) => {
    if (closed) return;
    closed = true;
    activeSessions--;
    log('ssh session closed:', why || 'peer');
    try { tcp.destroy(); } catch { }
    try { ws.terminate(); } catch { }
  };

  tcp.on('connect', () => log('ssh session open ->', `${SSH_HOST}:${SSH_PORT}`));
  tcp.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  tcp.on('error', (err) => shutdown('tcp error: ' + err.message));
  tcp.on('close', () => shutdown('tcp closed'));

  ws.on('message', (data) => {
    if (!tcp.writable || closed) return;
    tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  ws.on('close', () => shutdown('ws closed'));
  ws.on('error', (err) => shutdown('ws error: ' + err.message));

  // Render ke proxy ko idle connection na samajh aaye, isliye ping.
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 20000);
  ws.on('close', () => clearInterval(ping));
}

/* ------------------------------------------------------------------ */
/* 2) browser web terminal  (xterm.js + ssh2)                          */
/* ------------------------------------------------------------------ */

function handleTerminal(ws) {
  activeSessions++;

  let done = false;
  const finish = (msg) => {
    if (done) return;
    done = true;
    activeSessions--;
    if (msg && ws.readyState === ws.OPEN) {
      try { ws.send('\r\n\x1b[31m' + msg + '\x1b[0m\r\n'); } catch { }
    }
    try { ws.close(); } catch { }
  };

  const conn = new SSHClient();

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
      if (err) { conn.end(); return finish('shell error: ' + err.message); }

      stream.on('data', (d) => {
        if (ws.readyState === ws.OPEN) ws.send(d.toString('utf8'));
      });
      stream.stderr.on('data', (d) => {
        if (ws.readyState === ws.OPEN) ws.send(d.toString('utf8'));
      });
      stream.on('close', () => { conn.end(); finish(); });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === 'i' && typeof msg.d === 'string') stream.write(msg.d);
        if (msg.t === 'r' && msg.c > 0 && msg.r > 0) stream.setWindow(msg.r, msg.c, 0, 0);
      });
      ws.on('close', () => { try { conn.end(); } catch { } finish(); });
    });
  });

  conn.on('error', (err) => finish('ssh error: ' + err.message));
  conn.on('close', () => finish());

  conn.connect({
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    password: SSH_PASSWORD || undefined,
    tryKeyboard: true,
    readyTimeout: 20000,
  });

  conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finishCb) => {
    finishCb(prompts.map(() => SSH_PASSWORD));
  });
}

/* ------------------------------------------------------------------ */
/* keepalive + boot                                                    */
/* ------------------------------------------------------------------ */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { }
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  log(`render-vps http+ws listening on 0.0.0.0:${PORT}  (sshd -> ${SSH_HOST}:${SSH_PORT})`);
  log(`ssh user: ${SSH_USER} | password login: ${SSH_PASSWORD ? 'on' : 'OFF'} | ws token: ${TOKEN ? 'required' : 'off'}`);
});
