/* net.js — 双人开房对战 P2P 传输层（TRAE）
 * 仅负责收发管道，不做业务判断。对外暴露 window.Net：
 *   host(code) / join(code) / close() / send(obj) / on(evt, fn) / status() / isHost
 * 事件：'open' | 'peer' | 'leave' | 'data' | 'error'
 *   data -> 解析后的对象；error -> {code, message}；peer -> 本机 peer id 字符串
 * 状态：'idle' | 'connecting' | 'connected' | 'error'
 * 依赖 vendor/peerjs.min.js（公共云信令）；库缺失时 host/join 报 'no-lib' 错误，不影响单人游戏。
 */
(function () {
  'use strict';

  var PEER_PREFIX = 'tank-battle-';
  var CONNECT_TIMEOUT_MS = 12000;

  var state = 'idle'; // idle | connecting | connected | error
  var peer = null;
  var conn = null;
  var timer = null;
  var suppress = false; // 主动清理期间静默对端回调
  var hbTimer = null;
  var lastSeen = 0;

  var HB_INTERVAL = 2500;  // 心跳间隔
  var HB_TIMEOUT = 8000;   // 超过这个时间没收到任何数据 → 判定对端掉线

  var handlers = { open: [], peer: [], leave: [], data: [], error: [] };

  function setState(s) { state = s; }

  function emit(evt, payload) {
    var list = handlers[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (e) {
        // 回调异常绝不冒泡打断游戏主循环
        try { console.error('[Net] ' + evt + ' handler error:', e); } catch (_) {}
      }
    }
  }

  function validCode(code) { return /^\d{6}$/.test(code); }

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  var ERROR_TEXT = {
    'invalid-code': '房间号必须是 6 位数字',
    'no-lib': '联机组件未加载，无法使用联机功能',
    'unavailable-id': '房间号已被占用，请换一个',
    'peer-unavailable': '找不到该房间，请确认房间号',
    'network': '无法连接信令服务器，请检查网络',
    'server-error': '信令服务器错误，请稍后重试',
    'socket-error': '信令通道异常，请检查网络',
    'socket-closed': '信令通道已关闭，请重试',
    'browser-incompatible': '当前浏览器不支持 WebRTC',
    'timeout': '连接超时，请重试'
  };

  function errMsg(code) {
    return ERROR_TEXT[code] || ('连接出错：' + code);
  }

  // 静默清理连接与 Peer，状态回 idle（不触发任何事件）
  function cleanup() {
    clearTimer();
    stopHeartbeat();
    suppress = true;
    if (conn) { try { conn.close(); } catch (_) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
    suppress = false;
    setState('idle');
  }

  // 心跳：对端被强杀/网络断开时，DataChannel 的 close 事件可能不触发，
  // 靠"多久没收到任何数据"判定掉线，避免另一方一直以为还在连着
  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastSeen = Date.now();
    hbTimer = setInterval(function () {
      if (state !== 'connected' || !conn || !conn.open) return;
      if (Date.now() - lastSeen > HB_TIMEOUT) { onLeave(); return; }
      try { conn.send({ t: 'hb' }); } catch (_) {}
    }, HB_INTERVAL);
  }

  // 失败：清理后进入 error 状态并通知
  function fail(code) {
    cleanup();
    setState('error');
    emit('error', { code: code, message: errMsg(code) });
  }

  // 连接断开（对端离开/掉线）：清理、回 idle、触发 leave
  function onLeave() {
    cleanup();
    emit('leave');
  }

  function startTimer() {
    clearTimer();
    timer = setTimeout(function () {
      if (state === 'connecting') fail('timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  function wireConn(c) {
    conn = c;
    c.on('open', function () {
      if (suppress) return;
      clearTimer();
      setState('connected');
      startHeartbeat();
      emit('open', { id: c.peer });
    });
    c.on('data', function (d) {
      if (suppress) return;
      lastSeen = Date.now();
      emit('data', d);
    });
    c.on('close', function () {
      if (suppress) return;
      onLeave();
    });
    c.on('error', function (err) {
      if (suppress) return;
      var code = (err && err.type) || 'unknown';
      fail(code);
    });
  }

  function wirePeer(p) {
    p.on('error', function (err) {
      if (suppress) return;
      var code = (err && err.type) || 'unknown';
      fail(code);
    });
    p.on('disconnected', function () {
      // 仅信令掉线，尝试重连；DataChannel 本身不受影响
      try { if (peer && !peer.destroyed) peer.reconnect(); } catch (_) {}
    });
  }

  function prepare(code) {
    close(); // 同一时刻只允许一个连接：重复 host/join 前先 close()
    code = String(code == null ? '' : code).trim();
    if (!validCode(code)) { fail('invalid-code'); return null; }
    if (typeof Peer === 'undefined') { fail('no-lib'); return null; }
    setState('connecting');
    return code;
  }

  function host(code) {
    code = prepare(code);
    if (!code) return;
    Net.isHost = true;
    try {
      peer = new Peer(PEER_PREFIX + code);
    } catch (e) { fail('exception'); return; }
    startTimer();
    peer.on('open', function (id) {
      if (suppress) return;
      clearTimer(); // 房间已创建，之后无限期等待客机加入
      emit('peer', id);
    });
    peer.on('connection', function (c) {
      if (suppress) return;
      if (conn) { // 只保留第一条连接，后来者拒掉
        try { c.on('open', function () { try { c.close(); } catch (_) {} }); } catch (_) {}
        return;
      }
      wireConn(c);
    });
    wirePeer(peer);
  }

  function join(code) {
    code = prepare(code);
    if (!code) return;
    Net.isHost = false;
    try {
      peer = new Peer();
    } catch (e) { fail('exception'); return; }
    startTimer();
    peer.on('open', function (id) {
      if (suppress) return;
      emit('peer', id);
      var c;
      try {
        c = peer.connect(PEER_PREFIX + code, { reliable: true });
      } catch (e) { fail('exception'); return; }
      wireConn(c);
    });
    wirePeer(peer);
  }

  function close() {
    var wasConnected = (state === 'connected');
    if (conn && conn.open) {
      try { conn.send({ t: 'bye' }); } catch (_) {}
    }
    cleanup();
    if (wasConnected) emit('leave');
  }

  function send(obj) {
    if (!conn || !conn.open) return false;
    try {
      conn.send(obj);
      return true;
    } catch (e) {
      return false;
    }
  }

  function on(evt, fn) {
    if (handlers[evt] && typeof fn === 'function') handlers[evt].push(fn);
    return Net;
  }

  var Net = {
    host: host,
    join: join,
    close: close,
    send: send,
    on: on,
    status: function () { return state; },
    isHost: false
  };

  window.Net = Net;

  // 页面关闭时尽力通知对端
  try {
    window.addEventListener('beforeunload', function () {
      try { close(); } catch (_) {}
    });
  } catch (_) {}
})();
