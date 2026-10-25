/* net.js — 双人开房对战 P2P 传输层（TRAE）
 * 两种模式共用同一套对外 API（window.Net）：
 *   host(code) / join(code) / close() / send(obj) / on(evt, fn) / status() / isHost
 *   createInvite() / useInvite(code) / acceptAnswer(code)   ← 离线配对（无服务器）
 * 事件：'open' | 'peer' | 'leave' | 'data' | 'error'
 *   data -> 解析后的对象；error -> {code, message}
 * 状态：'idle' | 'connecting' | 'connected' | 'error'
 * 1) 联网开房：PeerJS 公共云信令，Peer id = tank-battle-<code>
 * 2) 离线配对：原生 RTCPeerConnection + base64url 配对码，完全不依赖服务器
 */
(function () {
  'use strict';

  var PEER_PREFIX = 'tank-battle-';
  var CONNECT_TIMEOUT_MS = 12000;
  var MANUAL_CONNECT_TIMEOUT_MS = 20000;
  var ICE_WAIT_MS = 3000;
  var ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  var state = 'idle'; // idle | connecting | connected | error
  var mode = 'peerjs'; // peerjs | manual
  var peer = null;
  var conn = null; // 统一适配的连接对象（PeerJS DataConnection / 原生 DataChannel 包装）
  var pc = null; // 原生 RTCPeerConnection（仅 manual）
  var timer = null;
  var manualTimer = null;
  var pendingReject = null; // manual：失败时用于 reject 当前的 Promise
  var afterOpen = null; // manual：DataChannel open 后用于 resolve Promise
  var suppress = false; // 主动清理期间静默对端回调
  var hbTimer = null;
  var lastSeen = 0;

  var HB_INTERVAL = 2500; // 心跳间隔
  var HB_TIMEOUT = 8000; // 超过这个时间没收到任何数据 → 判定对端掉线

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

  function clearManualTimer() {
    if (manualTimer) { clearTimeout(manualTimer); manualTimer = null; }
  }

  var ERROR_TEXT = {
    'invalid-code': '房间号必须是 6 位数字',
    'no-lib': '联机组件未加载，无法使用联网开房',
    'unavailable-id': '房间号已被占用，请换一个',
    'peer-unavailable': '找不到该房间，请确认房间号',
    'network': '无法连接信令服务器，请检查网络',
    'server-error': '信令服务器错误，请稍后重试',
    'socket-error': '信令通道异常，请检查网络',
    'socket-closed': '信令通道已关闭，请重试',
    'browser-incompatible': '当前浏览器不支持 WebRTC',
    'timeout': '连接超时，请重试',
    'no-webrtc': '当前浏览器不支持 WebRTC，无法离线配对',
    'bad-code': '配对码格式不正确，请确认已完整复制',
    'rtc-failed': '直连建立失败，请重新生成配对码再试',
    'no-invite': '请先生成邀请码，再粘贴对方的应答码',
    'manual-timeout': '等待对方连接超时，请重试'
  };

  function errMsg(code) {
    return ERROR_TEXT[code] || ('连接出错：' + code);
  }

  // ---------------- base64url（无 + / =） ----------------
  function b64uEncode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64uDecode(code) {
    var s = String(code == null ? '' : code).replace(/\s+/g, '');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodePayload(type, sdp) {
    return b64uEncode(JSON.stringify({ v: 1, t: type, sdp: sdp }));
  }

  function decodePayload(code) {
    var obj = JSON.parse(b64uDecode(code));
    if (!obj || obj.v !== 1 || typeof obj.sdp !== 'string') throw new Error('bad payload');
    return obj;
  }

  // ---------------- 生命周期 ----------------
  // 静默清理连接、Peer 与 RTCPeerConnection，状态回 idle（不触发任何事件）
  function cleanup() {
    clearTimer();
    clearManualTimer();
    stopHeartbeat();
    afterOpen = null;
    pendingReject = null;
    suppress = true;
    if (conn) { try { conn.close(); } catch (_) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
    if (pc) {
      try {
        pc.onconnectionstatechange = null;
        pc.ondatachannel = null;
        pc.close();
      } catch (_) {}
      pc = null;
    }
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

  // 联网模式失败：清理后进入 error 状态并通知
  function fail(code) {
    cleanup();
    setState('error');
    emit('error', { code: code, message: errMsg(code) });
  }

  // 离线配对失败：按规格回到 idle，同时触发 error，允许重试
  function manualFail(code) {
    clearManualTimer();
    afterOpen = null;
    var rej = pendingReject;
    pendingReject = null;
    cleanup();
    setState('idle');
    var payload = { code: code, message: errMsg(code) };
    emit('error', payload);
    if (typeof rej === 'function') {
      try { rej(new Error(payload.message)); } catch (_) {}
    }
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

  // ---------------- 连接适配 ----------------
  // 把原生 DataChannel 包装成与 PeerJS DataConnection 同形的对象
  function wrapChannel(ch) {
    var listeners = { open: [], data: [], close: [], error: [] };
    var adapter = {
      peer: 'manual',
      open: false,
      send: function (obj) {
        try {
          ch.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
          return true;
        } catch (e) {
          return false;
        }
      },
      close: function () {
        try { ch.close(); } catch (_) {}
        try { if (pc) pc.close(); } catch (_) {}
      },
      on: function (evt, fn) {
        if (listeners[evt] && typeof fn === 'function') listeners[evt].push(fn);
        return adapter;
      },
      fire: function (evt, arg) {
        var list = listeners[evt] || [];
        for (var i = 0; i < list.length; i++) {
          try { list[i](arg); } catch (_) {}
        }
      }
    };

    try {
      var opened = false;
      function fireOpen() {
        if (opened) return;
        opened = true;
        adapter.open = true;
        adapter.fire('open');
      }
      ch.onopen = function () { fireOpen(); };
      ch.onclose = function () { adapter.open = false; adapter.fire('close'); };
      ch.onerror = function (e) {
        // 通道关闭瞬间也会报错，此时已由 close/心跳负责断线，不再重复报错
        if (ch.readyState === 'open') adapter.fire('error', e);
      };
      ch.onmessage = function (e) {
        var d = e && e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) {} }
        adapter.fire('data', d);
      };
      if (ch.readyState === 'open') setTimeout(fireOpen, 0);
    } catch (_) {}

    return adapter;
  }

  function wireConn(c) {
    conn = c;
    c.on('open', function () {
      if (suppress) return;
      clearTimer();
      clearManualTimer();
      setState('connected');
      startHeartbeat();
      emit('open', { id: c.peer });
      var f = afterOpen;
      afterOpen = null;
      if (f) { try { f(); } catch (_) {} }
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
      var code = (err && err.type) || (err && err.name) || 'unknown';
      if (mode === 'manual') {
        // 手工模式出错同样回 idle，避免界面卡在 error 无法重试
        cleanup();
        setState('idle');
        emit('error', { code: code, message: errMsg(code) });
      } else {
        fail(code);
      }
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

  // 收集 ICE 后再编码：等 iceGatheringState === 'complete'，最多 3 秒
  function waitIce(p) {
    return new Promise(function (resolve) {
      if (!p || p.iceGatheringState === 'complete') { resolve(); return; }
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try { p.removeEventListener('icegatheringstatechange', onChange); } catch (_) {}
        resolve();
      }
      function onChange() {
        try { if (p.iceGatheringState === 'complete') finish(); } catch (_) {}
      }
      try { p.addEventListener('icegatheringstatechange', onChange); } catch (_) {}
      setTimeout(finish, ICE_WAIT_MS);
    });
  }

  // ICE 失败或异常：已连上则按断线处理，未连上则按配对失败处理
  function pcFail() {
    if (state === 'connected') onLeave();
    else manualFail('rtc-failed');
  }

  function wirePC() {
    if (!pc) return;
    try {
      pc.onconnectionstatechange = function () {
        try {
          if (pc && pc.connectionState === 'failed') pcFail();
        } catch (_) {}
      };
    } catch (_) {}
  }

  // ---------------- 联网开房（PeerJS） ----------------
  function prepare(code) {
    close(); // 同一时刻只允许一个连接：重复 host/join 前先 close()
    mode = 'peerjs';
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

  // ---------------- 离线配对（原生 WebRTC，无服务器） ----------------
  function newPC() {
    var p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc = p;
    return p;
  }

  // 主机：生成邀请码
  function createInvite() {
    return new Promise(function (resolve, reject) {
      close();
      mode = 'manual';
      Net.isHost = true;
      if (typeof RTCPeerConnection === 'undefined') { manualFail('no-webrtc'); return; }
      pendingReject = reject;
      setState('connecting');
      var done = false;
      try {
        var p = newPC();
        wirePC();
        var ch = p.createDataChannel('game', { ordered: true });
        wireConn(wrapChannel(ch));
      } catch (e) { manualFail('rtc-failed'); return; }

      p.createOffer()
        .then(function (offer) { return p.setLocalDescription(offer); })
        .then(function () { return waitIce(p); })
        .then(function () {
          if (done || pc !== p || !p.localDescription || !p.localDescription.sdp) return;
          done = true;
          pendingReject = null;
          resolve(encodePayload('offer', p.localDescription.sdp));
        })
        .catch(function () {
          if (done) return;
          done = true;
          manualFail('rtc-failed');
        });
    });
  }

  // 客机：邀请码 → 应答码
  function useInvite(inviteCode) {
    return new Promise(function (resolve, reject) {
      close();
      mode = 'manual';
      Net.isHost = false;
      if (typeof RTCPeerConnection === 'undefined') { manualFail('no-webrtc'); return; }

      var payload;
      try { payload = decodePayload(inviteCode); } catch (e) { manualFail('bad-code'); return; }
      if (payload.t !== 'offer') { manualFail('bad-code'); return; }

      pendingReject = reject;
      setState('connecting');
      var done = false;

      try {
        var p = newPC();
        wirePC();
        p.ondatachannel = function (ev) {
          try { if (ev && ev.channel) wireConn(wrapChannel(ev.channel)); } catch (_) {}
        };
        p.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
          .then(function () { return p.createAnswer(); })
          .then(function (answer) { return p.setLocalDescription(answer); })
          .then(function () { return waitIce(p); })
          .then(function () {
            if (done || pc !== p || !p.localDescription || !p.localDescription.sdp) return;
            done = true;
            pendingReject = null;
            resolve(encodePayload('answer', p.localDescription.sdp));
          })
          .catch(function () {
            if (done) return;
            done = true;
            manualFail('rtc-failed');
          });
      } catch (e) { manualFail('rtc-failed'); }
    });
  }

  // 主机：粘贴应答码，完成连接
  function acceptAnswer(answerCode) {
    return new Promise(function (resolve, reject) {
      if (mode !== 'manual' || !pc) { manualFail('no-invite'); return; }
      var payload;
      try { payload = decodePayload(answerCode); } catch (e) { manualFail('bad-code'); return; }
      if (payload.t !== 'answer') { manualFail('bad-code'); return; }

      var p = pc;
      pendingReject = reject;
      afterOpen = function () { resolve(); };
      clearManualTimer();
      manualTimer = setTimeout(function () {
        manualTimer = null;
        manualFail('manual-timeout');
      }, MANUAL_CONNECT_TIMEOUT_MS);

      try {
        p.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
          .catch(function () {
            if (state === 'connected') return;
            manualFail('rtc-failed');
          });
      } catch (e) { manualFail('rtc-failed'); }
    });
  }

  // ---------------- 公共 API ----------------
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
    createInvite: createInvite,
    useInvite: useInvite,
    acceptAnswer: acceptAnswer,
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
