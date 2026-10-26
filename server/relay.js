#!/usr/bin/env node
/**
 * tank-battle relay server —— 零依赖（只用 Node 内置模块）
 *
 *  职责：
 *   1) 静态文件服务：把仓库根目录下的游戏文件发出去（这样对方只需打开一个地址）
 *   2) WebSocket 中继：按房间号把两台客户端配对，之后原样转发双方消息
 *
 *  协议（JSON 文本帧）：
 *    client -> server : {t:'join', room:'123456', role:'host'|'guest'}
 *                       {t:'leave'}
 *                       其他任意 {t:...} 消息 → 原样转发给房间里的另一端
 *    server -> client : {t:'ready', role}      配对成功
 *                       {t:'peer-left'}       对端断开
 *                       {t:'error', message}  参数/冲突错误
 *
 *  用法：node server/relay.js [--port 8000] [--root .] [--host 0.0.0.0]
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------- 参数 ----------------
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = parseInt(argOf('port', process.env.PORT || '8000'), 10);
const HOST = argOf('host', '0.0.0.0');
const ROOT = path.resolve(argOf('root', path.join(__dirname, '..')));
const WS_PATH = '/ws';

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, relay: true, rooms: rooms.size, peers: peers.size, ts: Date.now() }));
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (_) {
    res.writeHead(400); res.end('bad url'); return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { // 目录穿越
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60'
    });
    res.end(data);
  });
}

// ---------------- 房间与连接 ----------------
/** peer: { socket, role, room, alive } */
const peers = new Set();
/** room -> { host: peer|null, guest: peer|null } */
const rooms = new Map();

function roomOf(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, guest: null });
  return rooms.get(code);
}

function dropRoomIfEmpty(code) {
  const r = rooms.get(code);
  if (r && !r.host && !r.guest) rooms.delete(code);
}

// ---------------- WebSocket 帧编解码 ----------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, data]);
}

const OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;

function makePeer(socket) {
  const peer = {
    socket,
    role: null,
    room: null,
    alive: true,
    buf: Buffer.alloc(0),
    frag: [],           // 分片累积
    fragOp: 0,
    send(obj) {
      if (!peer.alive) return false;
      try {
        socket.write(encodeFrame(JSON.stringify(obj), OP_TEXT));
        return true;
      } catch (_) { return false; }
    },
    sendRaw(buf, opcode) {
      try { socket.write(encodeFrame(buf, opcode)); } catch (_) {}
    },
    close() {
      try { socket.end(encodeFrame(Buffer.alloc(0), OP_CLOSE)); } catch (_) {}
      peer.alive = false;
      peers.delete(peer);
      detach(peer);
    }
  };
  return peer;
}

function detach(peer) {
  if (!peer.room) return;
  const r = rooms.get(peer.room);
  if (!r) return;
  if (r.host === peer) r.host = null;
  if (r.guest === peer) r.guest = null;
  const other = r.host || r.guest;
  if (other) other.send({ t: 'peer-left' });
  dropRoomIfEmpty(peer.room);
  peer.room = null;
  peer.role = null;
}

function handleMessage(peer, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'join') {
    const room = String(msg.room || '');
    if (!/^\d{4,8}$/.test(room)) { peer.send({ t: 'error', message: '房间号需为 4~8 位数字' }); return; }
    if (peer.room) detach(peer);

    const r = roomOf(room);
    let role = msg.role === 'guest' ? 'guest' : 'host';
    if (r[role]) { // 该位置已占用，尝试另一个位置
      const alt = role === 'host' ? 'guest' : 'host';
      if (r[alt]) { peer.send({ t: 'error', message: '房间已满' }); return; }
      role = alt;
    }
    r[role] = peer;
    peer.room = room;
    peer.role = role;
    peer.send({ t: 'ready', role });

    const other = role === 'host' ? r.guest : r.host;
    if (other && other.alive) { other.send({ t: 'peer-joined' }); }
    return;
  }

  if (msg.t === 'leave') { detach(peer); return; }

  // 其余全部转发给房间另一端
  if (peer.room) {
    const r = rooms.get(peer.room);
    if (r) {
      const other = (r.host === peer) ? r.guest : r.host;
      if (other && other.alive) other.send(msg);
    }
  }
}

function consume(peer, chunk) {
  peer.buf = Buffer.concat([peer.buf, chunk]);
  for (;;) {
    const b = peer.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return;
      const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
      len = hi * 4294967296 + lo; off = 10;
    }
    if (len > 2 * 1024 * 1024) { peer.close(); return; }      // 防御：单帧上限 2MB
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return;

    let payload = b.slice(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = b.slice(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    peer.buf = b.slice(off + maskLen + len);

    if (opcode === OP_CLOSE) { peer.close(); return; }
    if (opcode === OP_PING) { peer.sendRaw(payload, OP_PONG); continue; }
    if (opcode === OP_PONG) { peer.alive = true; continue; }

    if (opcode === 0x0) { // 续帧
      peer.frag.push(payload);
      if (fin) {
        const full = Buffer.concat(peer.frag);
        const op = peer.fragOp;
        peer.frag = []; peer.fragOp = 0;
        if (op === OP_TEXT) handleMessage(peer, full.toString('utf8'));
      }
      continue;
    }
    if (opcode === OP_TEXT || opcode === OP_BIN) {
      if (!fin) { peer.frag = [payload]; peer.fragOp = opcode; continue; }
      if (opcode === OP_TEXT) handleMessage(peer, payload.toString('utf8'));
      continue;
    }
    // 未知 opcode：忽略
  }
}

// ---------------- HTTP / Upgrade ----------------
const server = http.createServer(serveStatic);

server.on('upgrade', (req, socket) => {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== WS_PATH) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key)
  ];
  socket.write(headers.join('\r\n') + '\r\n\r\n');
  socket.setNoDelay(true);

  const peer = makePeer(socket);
  peers.add(peer);

  socket.on('data', (chunk) => {
    try { consume(peer, chunk); } catch (_) { peer.close(); }
  });
  socket.on('close', () => { peer.alive = false; peers.delete(peer); detach(peer); });
  socket.on('error', () => { peer.alive = false; peers.delete(peer); detach(peer); });
});

// 心跳：每 25 秒 ping 一次，两次没回应就断开
setInterval(() => {
  for (const peer of peers) {
    if (!peer.alive) continue;
    peer.alive = false;
    peer.sendRaw(Buffer.alloc(0), OP_PING);
  }
}, 25000).unref();

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lanIps = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) lanIps.push(ni.address);
    }
  }
  console.log('tank-battle relay server');
  console.log('  root :', ROOT);
  console.log('  local: http://127.0.0.1:' + PORT + '/');
  lanIps.forEach((ip) => console.log('  LAN  : http://' + ip + ':' + PORT + '/'));
  console.log('  ws   : ws://<host>:' + PORT + WS_PATH);
  console.log('  health:', 'http://127.0.0.1:' + PORT + '/health');
});
