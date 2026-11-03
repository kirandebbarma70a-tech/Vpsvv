#!/usr/bin/env node
'use strict';

/**
 * render-vps tunnel client
 * ------------------------
 * Render "wss://<service>.onrender.com/ws" ko apne machine ke ek local TCP port
 * se jodta hai, taaki koi bhi SSH client (ssh, PuTTY, Termius, WinSCP...) us
 * port par normal SSH ki tarah connect kar sake.
 *
 * Usage:
 *   node client/tunnel.js wss://ssh-vps.onrender.com/ws?token=XXXX 2222
 *   node client/tunnel.js "wss://.../ws?token=XXXX" --port 2222
 *   node client/tunnel.js "wss://.../ws?token=XXXX" --stdio      # ssh ProxyCommand
 *
 * Node 22+ par kuch install nahi chahiye. Purane Node par: npm install ws
 */

const net = require('net');

/* ----------------------------- args ----------------------------- */

const argv = process.argv.slice(2);
let url = '';
let localPort = 2222;
let stdioMode = false;

function usage() {
  console.log(`
render-vps tunnel client

  node client/tunnel.js <wss-url> [local-port]
  node client/tunnel.js <wss-url> --stdio

Examples:
  node client/tunnel.js "wss://ssh-vps.onrender.com/ws?token=abc123" 2222
  ssh -p 2222 root@127.0.0.1

  # ProxyCommand mode (koi alag process nahi):
  ssh -o ProxyCommand='node client/tunnel.js "wss://host/ws?token=abc" --stdio' dummy
`);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--stdio') stdioMode = true;
  else if (a === '--port' || a === '-p') localPort = Number(argv[++i]);
  else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (!url) url = a;
  else if (!Number.isNaN(Number(a))) localPort = Number(a);
}

if (!url) { usage(); process.exit(1); }

/* -------------------------- ws factory -------------------------- */
/*
 * onOpen hone se pehle jo data aata hai use queue me rakhta hai —
 * warna SSH client ka pehla packet (protocol banner) kho jata hai.
 */
function openSocket(onData, onOpen, onClose, onError) {
  let ready = false;
  let dead = false;
  const queue = [];
  let rawSend = () => { };

  const markOpen = () => {
    ready = true;
    for (const b of queue) rawSend(b);
    queue.length = 0;
    if (onOpen) onOpen();
  };
  const die = (why) => {
    if (dead) return;
    dead = true;
    if (onClose) onClose(why);
  };

  if (typeof WebSocket !== 'undefined') {
    /* Node 22+ / browser: built-in WebSocket */
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    rawSend = (buf) => {
      if (ws.readyState !== 1) return;
      try { ws.send(buf); } catch (e) { die(e.message); }
    };

    ws.addEventListener('open', markOpen);
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      if (typeof d === 'string') onData(Buffer.from(d, 'utf8'));
      else if (d instanceof ArrayBuffer) onData(Buffer.from(new Uint8Array(d)));
      else onData(Buffer.from(d));
    });
    ws.addEventListener('close', () => die('ws closed'));
    ws.addEventListener('error', (e) => {
      if (onError) onError((e && (e.message || e.type)) || 'websocket error');
    });

    return {
      send: (buf) => { if (dead) return; if (!ready) { queue.push(buf); return; } rawSend(buf); },
      close: () => { try { ws.close(); } catch { } die('closed'); },
    };
  }

  /* Node < 22: 'ws' package */
  let WS;
  try {
    WS = require('ws');
  } catch {
    console.error('\n[!] Is Node version me built-in WebSocket nahi hai.');
    console.error('    Fix: Node 22+ install karo, ya is folder me `npm install ws` chalao.\n');
    process.exit(1);
  }

  const ws = new WS(url, { perMessageDeflate: false });

  rawSend = (buf) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(buf); } catch (e) { die(e.message); }
  };

  ws.on('open', markOpen);
  ws.on('message', (d, isBinary) => {
    onData(Buffer.isBuffer(d) ? d : Buffer.from(isBinary ? d : String(d)));
  });
  ws.on('close', () => die('ws closed'));
  ws.on('error', (e) => { if (onError) onError(e.message); });

  return {
    send: (buf) => { if (dead) return; if (!ready) { queue.push(buf); return; } rawSend(buf); },
    close: () => { try { ws.close(); } catch { } die('closed'); },
  };
}

/* --------------------------- stdio mode -------------------------- */
// ssh -o ProxyCommand="node tunnel.js 'wss://...' --stdio"

if (stdioMode) {
  const sock = openSocket(
    (data) => process.stdout.write(data),
    () => { },
    () => process.exit(0),
    (err) => { process.stderr.write('[tunnel] ' + err + '\n'); process.exit(1); }
  );
  process.stdin.on('data', (d) => sock.send(d));
  process.stdin.on('end', () => { sock.close(); process.exit(0); });
  process.stdin.resume();
  process.on('SIGINT', () => { sock.close(); process.exit(0); });
}

/* --------------------------- port mode --------------------------- */

else {
  let conns = 0;

  const server = net.createServer((client) => {
    conns++;
    const id = conns;
    let closed = false;
    let sock;

    client.setNoDelay(true);

    const end = (why) => {
      if (closed) return;
      closed = true;
      try { client.destroy(); } catch { }
      if (sock) sock.close();
      console.log(`[-] session #${id} closed${why ? ' (' + why + ')' : ''}`);
    };

    console.log(`[+] session #${id} — local ssh client connected`);

    sock = openSocket(
      (data) => { if (client.writable) client.write(data); },
      () => { },
      () => end('ws closed'),
      (err) => end(err)
    );

    client.on('data', (d) => sock.send(d));
    client.on('close', () => end());
    client.on('error', () => end('local socket error'));
  });

  server.on('error', (err) => {
    console.error(`[!] local port ${localPort} bind nahi hua: ${err.message}`);
    process.exit(1);
  });

  server.listen(localPort, '127.0.0.1', () => {
    const target = url.replace(/([?&]token=)[^&]+/, '$1***');
    console.log(`
  render-vps tunnel ready
  -----------------------
  remote : ${target}
  local  : 127.0.0.1:${localPort}

  Ab doosre terminal me:

      ssh -p ${localPort} root@127.0.0.1

  (ya PuTTY / Termius / WinSCP me host = 127.0.0.1, port = ${localPort})
  Band karne ke liye: Ctrl+C
`);
  });

  process.on('SIGINT', () => { console.log('\n[!] tunnel band'); process.exit(0); });
}
