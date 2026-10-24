/* ============================================================
 * 坦克大战 - 纯原生 JS 实现
 * 逻辑分辨率 800x600，网格化 20x15（每格 40px）
 * 无外部资源，所有图形由 Canvas 绘制
 * ============================================================ */

// ==================== 常量配置 ====================
const TILE = 40;
const COLS = 20;
const ROWS = 15;
const WIDTH = TILE * COLS;   // 800
const HEIGHT = TILE * ROWS;  // 600

const TANK_SIZE = 36;        // 略小于一格，便于在 1 格通道中通行
const BULLET_SIZE = 8;

const PLAYER_SPEED = 150;    // px / 秒
const ENEMY_SPEED = 85;
const BULLET_SPEED = 340;

const PLAYER_LIVES = 3;
const INVINCIBLE_TIME = 2;   // 重生无敌秒数
const MAX_LEVEL = 5;         // 通关总关卡数

const HIGH_SCORE_KEY = 'tank-battle-highscore';

const POWERUP_DROP_CHANCE = 0.2;
const POWERUP_SIZE = 24;
const POWERUP_TTL = 12;            // 道具存在秒数，避免不可达道具堆积
const MAX_POWERUPS_ON_MAP = 6;     // 同屏道具上限
const POWERUP_TYPES = ['shield', 'speed', 'supply'];
const SHIELD_DURATION = 5;
const SPEED_DURATION = 8;
const SPEED_MULTIPLIER = 1.3;
const MAX_LIVES = 5;
const POWERUP_COLORS = { shield: '#60a5fa', speed: '#fbbf24', supply: '#34d399' };
const POWERUP_LABELS = { shield: '护盾', speed: '加速', supply: '补给' };

// ==================== 双人对战常量 ====================
const DUEL_LIVES = 3;                 // 每方初始生命
const DUEL_INVINCIBLE = 1.5;          // 换场景复位后的无敌秒数
const DUEL_NOTICE_TIME = 1.0;         // 「换场景」提示显示时长
const SNAPSHOT_INTERVAL = 1 / 20;     // 主机状态快照 20Hz
const INPUT_INTERVAL = 1 / 30;        // 客机按键上行 30Hz

// 出生点：0 号左下、1 号右上，各自朝向来敌方向
const DUEL_SPAWN_TILES = [{ r: 12, c: 2 }, { r: 2, c: 17 }];
const DUEL_SPAWNS = DUEL_SPAWN_TILES.map(({ r, c }) => ({
  x: c * TILE + (TILE - TANK_SIZE) / 2,
  y: r * TILE + (TILE - TANK_SIZE) / 2
}));
const DUEL_SPAWN_DIRS = ['up', 'down'];

const TILE_EMPTY = 0;
const TILE_BRICK = 1;
const TILE_STEEL = 2;
const TILE_BASE = 3;
const TILE_BASE_RUIN = 4; // 基地被摧毁后的废墟

const DIR_VEC = {
  up:    { x:  0, y: -1 },
  down:  { x:  0, y:  1 },
  left:  { x: -1, y:  0 },
  right: { x:  1, y:  0 }
};
const DIR_ORDER = ['up', 'down', 'left', 'right'];

const COLORS = {
  bg:        '#1a1a2e',
  grid:      '#22223a',
  brick:     '#c0622a',
  brickDark: '#7a3a14',
  steel:     '#9aa0a6',
  steelDark: '#4b5056',
  player:    '#4ade80',
  playerDark:'#15803d',
  enemy:     '#f87171',
  enemyDark: '#991b1b',
  bullet:    '#fde047',
  base:      '#facc15',
  baseDark:  '#a16207',
  hud:       '#ffffff',
  overlayBg: 'rgba(0,0,0,0.72)'
};

// ==================== 工具函数 ====================
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// 网络按键状态归一化：任何输入都收敛成 0/1，避免非法报文污染物理
function normInput(k) {
  if (!k || typeof k !== 'object') return { u: 0, d: 0, l: 0, r: 0, f: 0 };
  const n = (v) => (v ? 1 : 0);
  return { u: n(k.u), d: n(k.d), l: n(k.l), r: n(k.r), f: n(k.f) };
}

// ==================== 音效合成（WebAudio，无任何外部音频文件） ====================
class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.muted = false;
    this.lastPlay = {};   // 同类音效限流用
  }

  // 创建 / 恢复音频上下文：只在首次用户交互之后调用
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.35;
        this.master.connect(this.ctx.destination);
        this.noise = this.makeNoise();
      } catch (_) {
        this.ctx = null;
        return null;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  makeNoise() {
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  play(kind) {
    if (this.muted) return;
    // 只在首次真正创建上下文时解锁；避免每次播放都走一遍 unlock/resume
    if (!this.ctx && !this.unlock()) return;
    const t = this.ctx.currentTime;
    // 同类音效 40ms 内不重复：连发/连拾取时不会一次创建大量音频节点
    if (t - (this.lastPlay[kind] || -1) < 0.04) return;
    this.lastPlay[kind] = t;
    if (kind === 'fire') this.fire(t);
    else if (kind === 'explosion') this.explosion(t);
    else if (kind === 'hit') this.hit(t);
    else if (kind === 'clear') this.clear(t);
    else if (kind === 'powerup') this.powerup(t);
  }

  // 单个振荡器音：type 波形，freq 起始频率，freqEnd 终止频率（可省）
  tone(type, freq, t, dur, gain, freqEnd) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // 噪声爆炸音：低通滤波由亮到暗
  burst(t, dur, gain, cutoff) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  fire(t) { this.tone('square', 620, t, 0.09, 0.12, 180); }

  explosion(t) {
    this.burst(t, 0.35, 0.5, 1400);
    this.tone('sine', 110, t, 0.25, 0.28, 40);
  }

  hit(t) {
    this.burst(t, 0.28, 0.35, 900);
    this.tone('sawtooth', 240, t, 0.4, 0.22, 55);
  }

  clear(t) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone('triangle', f, t + i * 0.11, 0.16, 0.2));
  }

  powerup(t) {
    this.tone('sine', 880, t, 0.12, 0.18, 1760);
    this.tone('triangle', 1320, t + 0.08, 0.1, 0.14, 2640);
  }
}

// ==================== 实体基类 ====================
class Entity {
  constructor(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.alive = true;
  }
  get rect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
}

// ==================== 坦克 ====================
class Tank extends Entity {
  constructor(x, y, isPlayer) {
    super(x, y, TANK_SIZE, TANK_SIZE);
    this.isPlayer = isPlayer;
    this.dir = isPlayer ? 'up' : 'down';
    this.speed = isPlayer ? PLAYER_SPEED : ENEMY_SPEED;
    this.fireCooldown = 0;
    this.invincible = isPlayer ? INVINCIBLE_TIME : 0;
    // AI 专用
    this.aiTurnTimer = 0;
    this.aiFireTimer = 1.2 + Math.random() * 1.8;
    this.spawnFlash = 0.6; // 出生保护闪烁
  }
}

// ==================== 子弹 ====================
class Bullet extends Entity {
  constructor(x, y, dir, owner) {
    super(x, y, BULLET_SIZE, BULLET_SIZE);
    this.dir = dir;
    this.owner = owner; // 引用发射它的坦克
  }
}

// ==================== 游戏主体 ====================
class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.state = 'start'; // start | playing | paused | gameover | win | over
    this.mode = 'solo';   // solo | duel-host | duel-guest
    this.keys = {};
    this.level = 1;
    this.score = 0;
    this.lives = PLAYER_LIVES;
    this.highScore = this.loadHighScore();

    // ---- 双人对战状态（solo 下全部闲置） ----
    this.tanks = null;            // [0]=host方, [1]=guest方
    this.localSide = 0;           // 本机操控的坦克编号
    this.duelLives = [DUEL_LIVES, DUEL_LIVES];
    this.duelScene = 1;
    this.duelMapRev = 0;
    this.duelWinner = null;
    this.duelNotice = '';
    this.duelNoticeT = 0;
    this.remoteInput = { u: 0, d: 0, l: 0, r: 0, f: 0 };
    this.inputSeq = 0;
    this.netAcc = 0;              // 快照发送累加器
    this.inputAcc = 0;            // 按键上行累加器
    this._netBound = false;
    this._boundNet = null;

    // 音效（首次用户交互后才创建 AudioContext）
    this.sfx = new Sfx();

    this.map = null;
    this.player = null;
    this.enemies = [];
    this.bullets = [];
    this.explosions = [];

    this.powerups = [];
    this.activeEffects = { shield: 0, speed: 0 };
    // HUD 效果条文案缓存：只在显示值变化时重建，避免每帧分配字符串
    this._hudEffectText = '无';
    this._hudEffectColor = '#888';
    this._hudShieldTenth = 0;
    this._hudSpeedTenth = 0;

    this.enemiesToSpawn = 0;  // 本关剩余待生成敌人数
    this.enemiesAlive = 0;    // 当前场上敌人数
    this.spawnTimer = 0;
    this.maxOnField = 4;      // 同屏最多敌人数

    this.baseFlashTimer = 0;  // 基地被摧毁后的闪烁计时
    this.baseWarn = false;    // 敌方接近基地告警
    this.baseWarnTimer = 0;   // 告警闪烁计时

    // 触屏相关
    this.isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    this.joystick = { active: false, pointerId: null, baseX: 0, baseY: 0 };
    this.fireBtnPressed = false;

    this.lastTime = 0;
    this.setupCanvasDPR();
    this.bindInput();
    this.bindAudioUnlock();
    this.bindTouch();
    this.bindResize();
    requestAnimationFrame((t) => this.loop(t));
  }

  // HiDPI 清晰渲染：把画布后备存储放大到 dpr，绘制坐标仍用逻辑 800x600
  setupCanvasDPR() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(WIDTH * dpr);
    this.canvas.height = Math.round(HEIGHT * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  bindResize() {
    window.addEventListener('resize', () => this.setupCanvasDPR());
    window.addEventListener('orientationchange', () => this.setupCanvasDPR());
  }

  // ---------------- 音效与最高分 ----------------
  // 首次用户交互后才创建 AudioContext（浏览器自动播放策略要求）
  bindAudioUnlock() {
    const unlock = () => this.sfx.unlock();
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  toggleMute() {
    return this.sfx.toggleMute();
  }

  loadHighScore() {
    try {
      const v = parseInt(window.localStorage.getItem(HIGH_SCORE_KEY), 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_) {
      return 0; // file:// 下部分浏览器禁用 localStorage
    }
  }

  // 仅在刷新纪录时写盘
  commitHighScore() {
    if (this.score <= this.highScore) return;
    this.highScore = this.score;
    try {
      window.localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
    } catch (_) {}
  }

  // ---------------- 地图生成 ----------------
  generateMap(seed) {
    const rng = mulberry32(seed);
    const map = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
          row.push(TILE_STEEL); // 四周边界钢墙
        } else {
          const v = rng();
          if (v < 0.18) row.push(TILE_BRICK);
          else if (v < 0.23) row.push(TILE_STEEL);
          else row.push(TILE_EMPTY);
        }
      }
      map.push(row);
    }
    // 清空指定格子周围 3x3，保证出生点/重生点不会卡在墙里
    const clearAround = (r, c) => {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr > 0 && rr < ROWS - 1 && cc > 0 && cc < COLS - 1) {
            map[rr][cc] = TILE_EMPTY;
          }
        }
      }
    };

    if (this.mode !== 'solo') {
      // 双人对战场地：无基地、无敌人出生点，只清两辆坦克的出生区
      // 双方用同一个 seed（场景编号）生成，客机据此还原同一张地图
      for (const { r, c } of DUEL_SPAWN_TILES) clearAround(r, c);
      return map;
    }

    // 清空玩家出生点与敌人出生点附近
    const clearSpots = [
      [12, 4], [12, 6], [12, 8],        // 玩家底部区域
      [1, 1], [1, 6], [1, 10], [1, 15], [1, 18] // 顶部敌人出生点
    ];
    for (const [r, c] of clearSpots) clearAround(r, c);

    // 基地：底部中央，占两格
    map[13][9] = TILE_BASE;
    map[13][10] = TILE_BASE;
    // 基地围护：上方与左右改为砖墙（可打穿），仅两个上角保留钢墙作点缀
    map[12][9] = TILE_BRICK;
    map[12][10] = TILE_BRICK;
    map[13][8] = TILE_BRICK;
    map[13][11] = TILE_BRICK;
    map[12][8] = TILE_STEEL;  // 左上角
    map[12][11] = TILE_STEEL; // 右上角
    return map;
  }

  // ---------------- 关卡启动 ----------------
  startLevel(level) {
    this.level = level;
    this.map = this.generateMap(1000 + level * 37);
    this.enemies = [];
    this.bullets = [];
    this.explosions = [];
    this.powerups = [];
    this.activeEffects = { shield: 0, speed: 0 };
    this.baseFlashTimer = 0;
    this.baseWarn = false;

    const total = Math.min(10, 4 + (level - 1));
    this.enemiesToSpawn = total;
    this.enemiesAlive = 0;
    this.spawnTimer = 0;

    // 玩家出生点（底部偏左）
    const px = 4 * TILE + (TILE - TANK_SIZE) / 2;
    const py = 12 * TILE + (TILE - TANK_SIZE) / 2;
    this.player = new Tank(px, py, true);
    this.player.invincible = INVINCIBLE_TIME;
  }

  startGame() {
    this.mode = 'solo';
    this.tanks = null;
    this.score = 0;
    this.lives = PLAYER_LIVES;
    this.startLevel(1);
    this.state = 'playing';
  }

  // ---------------- 敌人生成 ----------------
  spawnEnemy() {
    const spawnCols = [1, 6, 10, 15, 18];
    // 选一个未被占用的出生点
    for (let attempt = 0; attempt < 10; attempt++) {
      const c = spawnCols[Math.floor(Math.random() * spawnCols.length)];
      const sx = c * TILE + (TILE - TANK_SIZE) / 2;
      const sy = 1 * TILE + (TILE - TANK_SIZE) / 2;
      const rect = { x: sx, y: sy, w: TANK_SIZE, h: TANK_SIZE };
      let blocked = false;
      for (const e of this.enemies) {
        if (rectsOverlap(rect, e.rect)) { blocked = true; break; }
      }
      if (this.player && rectsOverlap(rect, this.player.rect)) blocked = true;
      if (!blocked) {
        const enemy = new Tank(sx, sy, false);
        this.enemies.push(enemy);
        this.enemiesAlive++;
        this.enemiesToSpawn--;
        return;
      }
    }
  }

  // ---------------- 碰撞检测 ----------------
  collidesWithWall(rect) {
    const c1 = Math.floor(rect.x / TILE);
    const c2 = Math.floor((rect.x + rect.w - 1) / TILE);
    const r1 = Math.floor(rect.y / TILE);
    const r2 = Math.floor((rect.y + rect.h - 1) / TILE);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
        const t = this.map[r][c];
        if (t === TILE_BRICK || t === TILE_STEEL || t === TILE_BASE || t === TILE_BASE_RUIN) return true;
      }
    }
    return false;
  }

  collidesWithTank(rect, exclude) {
    // 双人模式：只有两辆坦克互相阻挡
    if (this.mode !== 'solo') {
      for (const t of this.tanks || []) {
        if (t && t !== exclude && t.alive && rectsOverlap(rect, t.rect)) return true;
      }
      return false;
    }
    if (this.player && this.player !== exclude && this.player.alive &&
        rectsOverlap(rect, this.player.rect)) return true;
    for (const e of this.enemies) {
      if (e !== exclude && e.alive && rectsOverlap(rect, e.rect)) return true;
    }
    return false;
  }

  // 尝试移动坦克（分轴检测，支持贴墙滑动）
  // 子步进移动：加速道具下位移变大时仍逐段检测碰撞，
  // 避免"整步被墙拒绝 → 原地顿一下"的抖动
  moveTank(tank, dx, dy) {
    const MAX_STEP = 2; // 每个子步最多 2px
    const substep = (axis, delta) => {
      if (!delta) return;
      const sign = delta > 0 ? 1 : -1;
      let remain = Math.abs(delta);
      while (remain > 0.0001) {
        const d = Math.min(MAX_STEP, remain) * sign;
        const rect = axis === 'x'
          ? { x: tank.x + d, y: tank.y, w: tank.w, h: tank.h }
          : { x: tank.x, y: tank.y + d, w: tank.w, h: tank.h };
        if (this.collidesWithWall(rect) || this.collidesWithTank(rect, tank)) break;
        if (axis === 'x') tank.x += d; else tank.y += d;
        remain -= Math.abs(d);
      }
    };
    substep('x', dx);
    substep('y', dy);
  }

  // ---------------- 发射子弹 ----------------
  fire(tank) {
    if (tank.fireCooldown > 0) return;
    // 玩家限制：同一时刻最多 1 发
    if (tank.isPlayer) {
      const hasBullet = this.bullets.some((b) => b.owner === tank);
      if (hasBullet) return;
    }
    const v = DIR_VEC[tank.dir];
    const cx = tank.x + tank.w / 2;
    const cy = tank.y + tank.h / 2;
    const bx = cx - BULLET_SIZE / 2 + v.x * (tank.w / 2);
    const by = cy - BULLET_SIZE / 2 + v.y * (tank.h / 2);
    const bullet = new Bullet(bx, by, tank.dir, tank);
    bullet.speed = (!tank.isPlayer && this.level >= 4) ? BULLET_SPEED * 1.1 : BULLET_SPEED;
    this.bullets.push(bullet);
    tank.fireCooldown = tank.isPlayer ? 0.25 : 0.5;
    this.sfx.play('fire');
  }

  // ---------------- 更新逻辑 ----------------
  update(dt) {
    // 基地摧毁闪烁计时（gameover 状态下仍需递减）
    if (this.baseFlashTimer > 0) this.baseFlashTimer -= dt;

    // 双人模式走各自的更新路径：host 跑物理，guest 只上行按键
    if (this.mode === 'duel-host') { this.updateDuelHost(dt); return; }
    if (this.mode === 'duel-guest') { this.updateDuelGuest(dt); return; }

    if (this.state !== 'playing') return;

    this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.updateBullets(dt);
    this.updateExplosions(dt);
    this.updatePowerUps(dt);
    this.updateSpawning(dt);
    this.checkBaseWarning(dt);
    this.checkLevelClear();
  }

  // 敌方坦克进入以基地为中心 5 格范围时，基地告警闪烁
  checkBaseWarning(dt) {
    this.baseWarnTimer += dt;
    let warn = false;
    const bcx = 9.5, bcy = 13; // 基地中心格坐标
    for (const e of this.enemies) {
      const ec = (e.x + e.w / 2) / TILE;
      const er = (e.y + e.h / 2) / TILE;
      if (Math.max(Math.abs(ec - bcx), Math.abs(er - bcy)) <= 5) {
        warn = true;
        break;
      }
    }
    this.baseWarn = warn;
  }

  updatePlayer(dt) {
    const p = this.player;
    if (!p || !p.alive) return;
    if (p.invincible > 0) p.invincible -= dt;
    if (p.fireCooldown > 0) p.fireCooldown -= dt;

    let moved = false;
    if (this.keys['ArrowUp'] || this.keys['KeyW']) { p.dir = 'up'; moved = true; }
    else if (this.keys['ArrowDown'] || this.keys['KeyS']) { p.dir = 'down'; moved = true; }
    else if (this.keys['ArrowLeft'] || this.keys['KeyA']) { p.dir = 'left'; moved = true; }
    else if (this.keys['ArrowRight'] || this.keys['KeyD']) { p.dir = 'right'; moved = true; }

    if (moved) {
      const v = DIR_VEC[p.dir];
      const spd = this.activeEffects.speed > 0 ? p.speed * SPEED_MULTIPLIER : p.speed;
      this.moveTank(p, v.x * spd * dt, v.y * spd * dt);
    }
    if (this.keys['Space'] || this.keys['KeyJ']) this.fire(p);
  }

  updateEnemies(dt) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.fireCooldown > 0) e.fireCooldown -= dt;
      if (e.spawnFlash > 0) e.spawnFlash -= dt;

      e.aiTurnTimer -= dt;
      if (e.aiTurnTimer <= 0) {
        e.aiTurnTimer = 0.6 + Math.random() * 1.4;
        e.dir = this.chooseEnemyDir(e);
      }

      const v = DIR_VEC[e.dir];
      const before = { x: e.x, y: e.y };
      this.moveTank(e, v.x * e.speed * dt, v.y * e.speed * dt);
      if (e.x === before.x && e.y === before.y) {
        e.aiTurnTimer = 0;
      }

      e.aiFireTimer -= dt;
      if (e.aiFireTimer <= 0) {
        e.aiFireTimer = 1.5 + Math.random() * 1.5;
        this.fire(e);
      }
    }
  }

  chooseEnemyDir(e) {
    const candidates = [];
    const ex = e.x + e.w / 2;
    const ey = e.y + e.h / 2;
    const ec = ex / TILE;
    const er = ey / TILE;

    const bcx = 9.5, bcy = 13;
    const distToBase = Math.sqrt((ec - bcx) ** 2 + (er - bcy) ** 2);

    if (distToBase <= 5) {
      const dx = bcx * TILE - ex;
      const dy = bcy * TILE - ey;
      if (Math.abs(dx) > Math.abs(dy)) {
        candidates.push(dx > 0 ? 'right' : 'left');
        candidates.push(dy > 0 ? 'down' : 'up');
      } else {
        candidates.push(dy > 0 ? 'down' : 'up');
        candidates.push(dx > 0 ? 'right' : 'left');
      }
    }

    if (this.player && this.player.alive) {
      const px = this.player.x + this.player.w / 2;
      const py = this.player.y + this.player.h / 2;
      const sameRow = Math.abs(ey - py) < TILE;
      const sameCol = Math.abs(ex - px) < TILE;
      if (sameRow || sameCol) {
        const dx = px - ex;
        const dy = py - ey;
        if (Math.abs(dx) > Math.abs(dy)) {
          candidates.push(dx > 0 ? 'right' : 'left');
        } else {
          candidates.push(dy > 0 ? 'down' : 'up');
        }
      }
    }

    const shuffled = [...DIR_ORDER].sort(() => Math.random() - 0.5);
    for (const dir of shuffled) {
      if (!candidates.includes(dir)) candidates.push(dir);
    }

    for (const dir of candidates) {
      if (this.canEnemyMoveDir(e, dir)) return dir;
    }
    return e.dir;
  }

  canEnemyMoveDir(e, dir) {
    const v = DIR_VEC[dir];
    const step = TILE * 0.5;
    const testRect = { x: e.x + v.x * step, y: e.y + v.y * step, w: e.w, h: e.h };
    return !this.collidesWithWall(testRect) && !this.collidesWithTank(testRect, e);
  }

  updateBullets(dt) {
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const v = DIR_VEC[b.dir];
      b.x += v.x * b.speed * dt;
      b.y += v.y * b.speed * dt;

      // 越界
      if (b.x < 0 || b.x > WIDTH || b.y < 0 || b.y > HEIGHT) {
        b.alive = false;
        continue;
      }

      // 与墙碰撞
      const c1 = Math.floor(b.x / TILE);
      const c2 = Math.floor((b.x + b.w - 1) / TILE);
      const r1 = Math.floor(b.y / TILE);
      const r2 = Math.floor((b.y + b.h - 1) / TILE);
      let hitWall = false;
      for (let r = r1; r <= r2 && !hitWall; r++) {
        for (let c = c1; c <= c2 && !hitWall; c++) {
          if (r < 0 || r >= ROWS || c < 0 || c >= COLS) { hitWall = true; break; }
          const t = this.map[r][c];
          if (t === TILE_BRICK) {
            this.map[r][c] = TILE_EMPTY; // 砖墙一发销毁
            hitWall = true;
          } else if (t === TILE_STEEL) {
            hitWall = true; // 钢墙不可摧毁
          } else if (t === TILE_BASE) {
            hitWall = true;
            this.baseDestroyed();
          }
        }
      }
      if (hitWall) { b.alive = false; continue; }

      // 与坦克碰撞
      if (b.owner.isPlayer) {
        // 玩家子弹打敌人
        for (const e of this.enemies) {
          if (e.alive && rectsOverlap(b.rect, e.rect)) {
            e.alive = false;
            b.alive = false;
            this.enemiesAlive--;
            this.score += 100;
            this.addExplosion(e.x + e.w / 2, e.y + e.h / 2);
            this.sfx.play('explosion');
            if (Math.random() < POWERUP_DROP_CHANCE) {
              const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
              const px = e.x + (e.w - POWERUP_SIZE) / 2;
              const py = e.y + (e.h - POWERUP_SIZE) / 2;
              if (this.powerups.length < MAX_POWERUPS_ON_MAP) {
                this.powerups.push({ x: px, y: py, type, alive: true, ttl: POWERUP_TTL });
              }
            }
            break;
          }
        }
      } else {
        // 敌人子弹打玩家
        const p = this.player;
        if (p && p.alive && p.invincible <= 0 && rectsOverlap(b.rect, p.rect)) {
          b.alive = false;
          this.playerHit();
        }
      }
    }
    this.bullets = this.bullets.filter((b) => b.alive);
    this.enemies = this.enemies.filter((e) => e.alive);

    const p = this.player;
    if (p && p.alive) {
      for (const pu of this.powerups) {
        if (!pu.alive) continue;
        const puRect = { x: pu.x, y: pu.y, w: POWERUP_SIZE, h: POWERUP_SIZE };
        if (rectsOverlap(p.rect, puRect)) {
          pu.alive = false;
          this.applyPowerUp(pu.type);
          this.sfx.play('powerup');
        }
      }
    }
    this.powerups = this.powerups.filter((pu) => pu.alive);
  }

  playerHit() {
    this.lives--;
    this.addExplosion(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2);
    this.sfx.play('hit');
    if (this.lives <= 0) {
      this.player.alive = false;
      this.state = 'gameover';
      this.commitHighScore();
    } else {
      // 原地重生 + 无敌
      const px = 4 * TILE + (TILE - TANK_SIZE) / 2;
      const py = 12 * TILE + (TILE - TANK_SIZE) / 2;
      this.player.x = px;
      this.player.y = py;
      this.player.dir = 'up';
      this.player.invincible = INVINCIBLE_TIME;
    }
  }

  baseDestroyed() {
    if (this.state !== 'playing') return; // 防止重复触发
    // 基地转为废墟（保留在画面中）
    this.map[13][9] = TILE_BASE_RUIN;
    this.map[13][10] = TILE_BASE_RUIN;
    // 基地区域爆炸
    this.addExplosion(9 * TILE, 13 * TILE);
    this.addExplosion(10 * TILE, 13 * TILE);
    this.addExplosion(11 * TILE, 13 * TILE);
    this.sfx.play('explosion');
    // 0.6 秒红黑闪烁后进入 gameover
    this.baseFlashTimer = 0.6;
    this.state = 'gameover';
    this.commitHighScore();
  }

  addExplosion(x, y) {
    this.explosions.push({ x, y, t: 0.4 });
  }

  updateExplosions(dt) {
    for (const ex of this.explosions) ex.t -= dt;
    this.explosions = this.explosions.filter((e) => e.t > 0);
  }

  updateSpawning(dt) {
    if (this.enemiesToSpawn > 0 && this.enemiesAlive < this.maxOnField) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnEnemy();
        let interval = 1.5;
        if (this.level >= 3) interval *= 0.8;
        this.spawnTimer = interval;
      }
    }
  }

  checkLevelClear() {
    if (this.enemiesToSpawn === 0 && this.enemiesAlive === 0 && this.enemies.length === 0) {
      this.score += 500;
      this.sfx.play('clear');
      if (this.level >= MAX_LEVEL) {
        this.state = 'win';
        this.commitHighScore();
      } else {
        this.startLevel(this.level + 1);
      }
    }
  }

  updatePowerUps(dt) {
    if (this.activeEffects.shield > 0) {
      this.activeEffects.shield -= dt;
      if (this.activeEffects.shield <= 0) this.activeEffects.shield = 0;
    }
    if (this.activeEffects.speed > 0) {
      this.activeEffects.speed -= dt;
      if (this.activeEffects.speed <= 0) this.activeEffects.speed = 0;
    }
    const p = this.player;
    if (p && p.alive && this.activeEffects.shield > 0) {
      p.invincible = Math.max(p.invincible, this.activeEffects.shield);
    }

    // 道具超时消失，避免打不到的道具长期堆积、每帧重复绘制
    for (const pu of this.powerups) {
      if (!pu.alive) continue;
      if (typeof pu.ttl === 'number') {
        pu.ttl -= dt;
        if (pu.ttl <= 0) pu.alive = false;
      }
    }
    if (this.powerups.some((pu) => !pu.alive)) this.powerups = this.powerups.filter((pu) => pu.alive);

    // HUD 文案只在显示值变化时重建（按 0.1s 粒度）
    const st = Math.max(0, Math.ceil(this.activeEffects.shield * 10));
    const sp = Math.max(0, Math.ceil(this.activeEffects.speed * 10));
    if (st !== this._hudShieldTenth || sp !== this._hudSpeedTenth) {
      this._hudShieldTenth = st;
      this._hudSpeedTenth = sp;
      const parts = [];
      if (st > 0) parts.push(`护盾 ${(st / 10).toFixed(1)}s`);
      if (sp > 0) parts.push(`加速 ${(sp / 10).toFixed(1)}s`);
      this._hudEffectText = parts.length ? parts.join('  ') : '无';
      this._hudEffectColor = st > 0 ? POWERUP_COLORS.shield : (sp > 0 ? POWERUP_COLORS.speed : '#888');
    }
  }

  applyPowerUp(type) {
    if (type === 'shield') {
      this.activeEffects.shield = SHIELD_DURATION;
      if (this.player) this.player.invincible = Math.max(this.player.invincible, SHIELD_DURATION);
    } else if (type === 'speed') {
      this.activeEffects.speed = SPEED_DURATION;
    } else if (type === 'supply') {
      if (this.lives < MAX_LIVES) this.lives++;
    }
  }

  // ---------------- 渲染 ----------------
  render() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    if (this.state === 'start') {
      this.renderStart();
      return;
    }

    if (this.mode !== 'solo') {
      this.renderDuel();
      return;
    }

    this.renderMap();
    this.renderExplosions();
    this.renderPowerUps();
    for (const b of this.bullets) this.renderBullet(b);
    for (const e of this.enemies) this.renderTank(e);
    if (this.player && this.player.alive) this.renderTank(this.player);
    this.renderHUD();

    if (this.state === 'paused') this.renderPause();
    else if (this.state === 'gameover') {
      if (this.baseFlashTimer > 0) this.renderBaseFlash();
      else this.renderGameOver();
    }
    else if (this.state === 'win') this.renderWin();

    this.syncTouchButtons();
  }

  renderMap() {
    const ctx = this.ctx;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = this.map[r][c];
        const x = c * TILE, y = r * TILE;
        if (t === TILE_BRICK) {
          ctx.fillStyle = COLORS.brick;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = COLORS.brickDark;
          // 砖纹
          ctx.fillRect(x, y + TILE / 2 - 1, TILE, 2);
          ctx.fillRect(x + TILE / 2 - 1, y, 2, TILE / 2);
          ctx.fillRect(x + TILE / 4 - 1, y + TILE / 2, 2, TILE / 2);
          ctx.fillRect(x + (TILE * 3) / 4 - 1, y + TILE / 2, 2, TILE / 2);
        } else if (t === TILE_STEEL) {
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
          ctx.fillStyle = COLORS.steelDark;
          ctx.fillRect(x + 2, y + 2, TILE - 4, 3);
          ctx.fillRect(x + 2, y + TILE - 5, TILE - 4, 3);
        } else if (t === TILE_BASE) {
          // 基地占两格（c=9,10），仅在左格处整体绘制一次
          if (c === 9) this.renderBase(x, y);
        } else if (t === TILE_BASE_RUIN) {
          // 废墟占两格，仅在左格处整体绘制一次
          if (c === 9) this.renderBaseRuin(x, y);
        }
      }
    }
  }

  // 整体基地造型：石质台座 + 金色盾牌鹰徽（占 2 格宽 × 1 格高）
  renderBase(x, y) {
    const ctx = this.ctx;
    const w = TILE * 2, h = TILE;
    const cx = x + w / 2;

    // 石质台座
    ctx.fillStyle = '#4a4a54';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#6e6e78';
    ctx.fillRect(x, y, w, 5); // 顶部高光
    ctx.fillStyle = '#2b2b32';
    ctx.fillRect(x, y + h - 4, w, 4); // 底部阴影
    // 台座左右石柱
    ctx.fillStyle = '#3a3a42';
    ctx.fillRect(x + 2, y + 5, 6, h - 9);
    ctx.fillRect(x + w - 8, y + 5, 6, h - 9);

    // 金色盾牌外框
    ctx.fillStyle = '#b8860b';
    ctx.beginPath();
    ctx.moveTo(cx, y + 6);
    ctx.lineTo(cx + 21, y + 13);
    ctx.lineTo(cx + 21, y + 25);
    ctx.lineTo(cx, y + 36);
    ctx.lineTo(cx - 21, y + 25);
    ctx.lineTo(cx - 21, y + 13);
    ctx.closePath();
    ctx.fill();
    // 盾牌内面
    ctx.fillStyle = '#f5d76e';
    ctx.beginPath();
    ctx.moveTo(cx, y + 8);
    ctx.lineTo(cx + 17, y + 14);
    ctx.lineTo(cx + 17, y + 24);
    ctx.lineTo(cx, y + 33);
    ctx.lineTo(cx - 17, y + 24);
    ctx.lineTo(cx - 17, y + 14);
    ctx.closePath();
    ctx.fill();
    // 鹰徽（星形剪影）
    ctx.fillStyle = '#7a4f00';
    ctx.beginPath();
    ctx.moveTo(cx, y + 13);
    ctx.lineTo(cx + 3, y + 21);
    ctx.lineTo(cx + 11, y + 21);
    ctx.lineTo(cx + 5, y + 26);
    ctx.lineTo(cx + 7, y + 33);
    ctx.lineTo(cx, y + 28);
    ctx.lineTo(cx - 7, y + 33);
    ctx.lineTo(cx - 5, y + 26);
    ctx.lineTo(cx - 11, y + 21);
    ctx.lineTo(cx - 3, y + 21);
    ctx.closePath();
    ctx.fill();

    // 敌方接近告警：红色半透明闪烁覆盖
    if (this.baseWarn && Math.floor(this.baseWarnTimer / 0.3) % 2 === 0) {
      ctx.fillStyle = 'rgba(220,40,40,0.5)';
      ctx.fillRect(x, y, w, h);
    }
  }

  // 基地废墟：灰黑残骸 + 余烬
  renderBaseRuin(x, y) {
    const ctx = this.ctx;
    const w = TILE * 2, h = TILE;
    ctx.fillStyle = '#1f1f1f';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#333333';
    ctx.fillRect(x + 4, y + 6, 16, 12);
    ctx.fillRect(x + 28, y + 16, 20, 14);
    ctx.fillRect(x + 54, y + 8, 18, 16);
    ctx.fillStyle = '#151515';
    ctx.fillRect(x + 8, y + 22, 10, 8);
    ctx.fillRect(x + 40, y + 30, 14, 6);
    // 余烬
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(x + 14, y + 24, 3, 3);
    ctx.fillRect(x + 44, y + 20, 3, 3);
    ctx.fillRect(x + 62, y + 14, 3, 3);
    ctx.fillStyle = '#e67e22';
    ctx.fillRect(x + 36, y + 30, 2, 2);
  }

  // 基地被摧毁：红黑交替闪烁 + 提示文字
  renderBaseFlash() {
    const ctx = this.ctx;
    const phase = Math.floor(this.baseFlashTimer / 0.1) % 2;
    ctx.fillStyle = phase === 0 ? 'rgba(180,0,0,0.55)' : 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('基 地 被 摧 毁', WIDTH / 2, HEIGHT / 2);
    ctx.textAlign = 'left';
  }

  renderTank(tank) {
    const ctx = this.ctx;
    // 无敌：柔和透明度脉动，代替"整帧不画"的硬闪烁
    // （硬闪烁在 5 秒护盾下每秒明灭 5 次，看起来就像卡顿）
    const blink = tank.isPlayer && tank.invincible > 0;
    if (blink) {
      ctx.save();
      ctx.globalAlpha = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(tank.invincible * 14));
    }

    // 双人模式：本机坦克用绿色，对手用红色，双方视角一致
    const asPlayer = this.mode === 'solo' ? tank.isPlayer : tank.side === this.localSide;
    const main = asPlayer ? COLORS.player : COLORS.enemy;
    const dark = asPlayer ? COLORS.playerDark : COLORS.enemyDark;

    const { x, y, w, h, dir } = tank;
    // 车身
    ctx.fillStyle = dark;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = main;
    ctx.fillRect(x + 3, y + 3, w - 6, h - 6);

    // 履带
    ctx.fillStyle = dark;
    if (dir === 'up' || dir === 'down') {
      ctx.fillRect(x, y + 2, 5, h - 4);
      ctx.fillRect(x + w - 5, y + 2, 5, h - 4);
    } else {
      ctx.fillRect(x + 2, y, w - 4, 5);
      ctx.fillRect(x + 2, y + h - 5, w - 4, 5);
    }

    // 炮塔
    ctx.fillStyle = dark;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    // 炮管
    ctx.fillStyle = main;
    const bw = 6, bl = 14;
    if (dir === 'up') ctx.fillRect(cx - bw / 2, cy - bl, bw, bl);
    else if (dir === 'down') ctx.fillRect(cx - bw / 2, cy, bw, bl);
    else if (dir === 'left') ctx.fillRect(cx - bl, cy - bw / 2, bl, bw);
    else ctx.fillRect(cx, cy - bw / 2, bl, bw);

    if (blink) ctx.restore();
  }

  renderBullet(b) {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bullet;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }

  renderExplosions() {
    const ctx = this.ctx;
    for (const e of this.explosions) {
      const r = (0.4 - e.t) * 60 + 6;
      ctx.fillStyle = `rgba(255,180,60,${e.t / 0.4})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  renderPowerUps() {
    const ctx = this.ctx;
    // 0.4s 一次明暗交替（原来 0.2s，视觉上过闪）
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    for (const pu of this.powerups) {
      if (!pu.alive) continue;
      // 最后 3 秒淡出提示即将消失
      const expiring = typeof pu.ttl === 'number' && pu.ttl < 3;
      if (expiring) {
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.65 * (blink ? 1 : 0.45);
      }
      const color = POWERUP_COLORS[pu.type] || '#fff';
      ctx.fillStyle = blink ? color : '#ffffff';
      ctx.fillRect(pu.x, pu.y, POWERUP_SIZE, POWERUP_SIZE);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pu.x, pu.y, POWERUP_SIZE, POWERUP_SIZE);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = pu.type === 'shield' ? 'S' : pu.type === 'speed' ? '>' : '+';
      ctx.fillText(label, pu.x + POWERUP_SIZE / 2, pu.y + POWERUP_SIZE / 2);
      ctx.textAlign = 'left';
      if (expiring) ctx.restore();
    }
  }

  renderHUD() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, WIDTH, 28);
    ctx.fillStyle = COLORS.hud;
    ctx.font = 'bold 16px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(`关卡 ${this.level}/${MAX_LEVEL}`, 12, 14);
    ctx.fillText(`敌人 ${this.enemiesToSpawn + this.enemiesAlive}`, 130, 14);
    ctx.fillText(`生命 ${'♥'.repeat(Math.max(0, this.lives))}`, 250, 14);
    ctx.fillText(`分数 ${this.score}`, 372, 14);
    ctx.fillText(`最高分 ${this.highScore}`, 500, 14);
    ctx.fillText(`音效 ${this.sfx.muted ? '关' : '开'}`, 690, 14);

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, HEIGHT - 22, WIDTH, 22);
    ctx.fillStyle = this._hudEffectColor;
    ctx.font = 'bold 13px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(`效果: ${this._hudEffectText}`, 12, HEIGHT - 11);
  }

  renderStart() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = COLORS.player;
    ctx.font = 'bold 56px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('坦 克 大 战', WIDTH / 2, 160);

    ctx.fillStyle = '#fff';
    ctx.font = '20px Consolas, monospace';
    const lines = this.isTouch ? [
      '操作说明',
      '移动：拖动左下摇杆',
      '开火：点右下按钮',
      '暂停/重开：右上按钮',
      '',
      '目标：消灭全部敌方坦克，保护基地不被击中',
      '击毁敌人 +100，通关额外 +500',
      '玩家 3 条命，被击中后原地重生并短暂无敌'
    ] : [
      '操作说明',
      '移动：W A S D 或 方向键',
      '开火：空格 或 J',
      `暂停：P    重开：R    静音：M（当前音效：${this.sfx.muted ? '关' : '开'}）`,
      '',
      '目标：消灭全部敌方坦克，保护基地不被击中',
      '击毁敌人 +100，通关额外 +500',
      '玩家 3 条命，被击中后原地重生并短暂无敌'
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, WIDTH / 2, 250 + i * 34);
    });

    ctx.fillStyle = COLORS.bullet;
    ctx.font = 'bold 22px Consolas, monospace';
    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    if (blink) {
      ctx.fillText(this.isTouch ? '点 击 屏 幕 开 始' : '按 任意键 开始游戏', WIDTH / 2, 540);
    }
    ctx.textAlign = 'left';
  }

  renderPause() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.overlayBg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = COLORS.bullet;
    ctx.font = 'bold 48px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('已 暂 停', WIDTH / 2, HEIGHT / 2 - 20);
    ctx.fillStyle = '#fff';
    ctx.font = '20px Consolas, monospace';
    ctx.fillText(this.isTouch ? '点击右上暂停按钮继续' : '按 P 继续', WIDTH / 2, HEIGHT / 2 + 30);
    ctx.textAlign = 'left';
  }

  renderGameOver() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.overlayBg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = COLORS.enemy;
    ctx.font = 'bold 56px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('游 戏 结 束', WIDTH / 2, HEIGHT / 2 - 72);
    ctx.fillStyle = '#fff';
    ctx.font = '24px Consolas, monospace';
    ctx.fillText(`最终分数：${this.score}`, WIDTH / 2, HEIGHT / 2 - 10);
    ctx.fillStyle = COLORS.bullet;
    ctx.font = '20px Consolas, monospace';
    ctx.fillText(`历史最高分：${this.highScore}`, WIDTH / 2, HEIGHT / 2 + 30);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.isTouch ? '点击右上重开按钮' : '按 R 重新开始', WIDTH / 2, HEIGHT / 2 + 75);
    ctx.textAlign = 'left';
  }

  renderWin() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.overlayBg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = COLORS.player;
    ctx.font = 'bold 56px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('通 关 胜 利', WIDTH / 2, HEIGHT / 2 - 72);
    ctx.fillStyle = '#fff';
    ctx.font = '24px Consolas, monospace';
    ctx.fillText(`最终分数：${this.score}`, WIDTH / 2, HEIGHT / 2 - 10);
    ctx.fillStyle = COLORS.bullet;
    ctx.font = '20px Consolas, monospace';
    ctx.fillText(`历史最高分：${this.highScore}`, WIDTH / 2, HEIGHT / 2 + 30);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.isTouch ? '点击右上重开按钮' : '按 R 重新开始', WIDTH / 2, HEIGHT / 2 + 75);
    ctx.textAlign = 'left';
  }

  // ---------------- 输入 ----------------
  bindInput() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  onKey(e, down) {
    const code = e.code;
    // 阻止页面滚动的按键
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyP', 'KeyR'].includes(code)) {
      e.preventDefault();
    }

    if (down) {
      const wasDown = this.keys[code];
      this.keys[code] = true;

      // M 键切换静音（按住不重复触发；开始界面也可切换且不会开局）
      if (code === 'KeyM') {
        if (!wasDown) this.toggleMute();
        if (this.state === 'start') return;
      }

      if (this.state === 'start') {
        this.startGame();
        return;
      }
      if (code === 'KeyP') this.togglePause();
      if (code === 'KeyR') this.handleRestart();
    } else {
      this.keys[code] = false;
    }
  }

  // ---------------- 触屏输入（映射到 this.keys，复用桌面逻辑） ----------------
  bindTouch() {
    if (!this.isTouch) return;
    const overlay = document.getElementById('touch-overlay');
    if (!overlay) return;
    overlay.classList.remove('touch-hidden');

    const joystickZone = document.getElementById('joystick-zone');
    const joystickBase = document.getElementById('joystick-base');
    const joystickKnob = document.getElementById('joystick-knob');
    const fireBtn = document.getElementById('fire-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const restartBtn = document.getElementById('restart-btn');
    const hint = document.getElementById('mobile-hint');
    const hintClose = document.getElementById('hint-close');
    this.restartBtn = restartBtn;

    if (hintClose) {
      hintClose.addEventListener('click', () => { if (hint) hint.classList.add('touch-hidden'); });
    }
    // 3 秒后自动隐藏提示
    setTimeout(() => { if (hint) hint.classList.add('touch-hidden'); }, 4000);

    const ctx = this; // 显式捕获，避免事件回调 this 绑定问题

    // ---- 虚拟摇杆：底座固定常显，按下高亮，摇杆头跟随手指偏移 ----
    const setBaseCenter = () => {
      const r = joystickBase.getBoundingClientRect();
      ctx.joystick.baseX = r.left + r.width / 2;
      ctx.joystick.baseY = r.top + r.height / 2;
    };

    joystickZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // 开始界面：任意点击开始游戏
      if (ctx.state === 'start') { ctx.startGame(); return; }
      if (ctx.state !== 'playing') return;
      ctx.joystick.active = true;
      ctx.joystick.pointerId = e.pointerId;
      setBaseCenter();
      joystickBase.classList.add('joystick-active');
      joystickZone.setPointerCapture(e.pointerId);
      ctx.setJoystickDir(e.clientX, e.clientY, joystickKnob);
    });

    joystickZone.addEventListener('pointermove', (e) => {
      if (!ctx.joystick.active || e.pointerId !== ctx.joystick.pointerId) return;
      e.preventDefault();
      ctx.setJoystickDir(e.clientX, e.clientY, joystickKnob);
    });

    const endJoystick = (e) => {
      if (!ctx.joystick.active || e.pointerId !== ctx.joystick.pointerId) return;
      ctx.joystick.active = false;
      ctx.joystick.pointerId = null;
      joystickBase.classList.remove('joystick-active');
      joystickKnob.style.transform = 'translate(-50%, -50%)';
      ctx.clearMoveKeys();
      try { joystickZone.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    joystickZone.addEventListener('pointerup', endJoystick);
    joystickZone.addEventListener('pointercancel', endJoystick);

    // ---- 开火按钮：按下连发，松手停止 ----
    fireBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (ctx.state === 'start') { ctx.startGame(); return; }
      ctx.fireBtnPressed = true;
      ctx.keys['Space'] = true;
      fireBtn.setPointerCapture(e.pointerId);
    });
    const endFire = (e) => {
      ctx.fireBtnPressed = false;
      ctx.keys['Space'] = false;
      try { fireBtn.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    fireBtn.addEventListener('pointerup', endFire);
    fireBtn.addEventListener('pointercancel', endFire);
    fireBtn.addEventListener('pointerleave', endFire);

    // ---- 暂停按钮 ----
    pauseBtn.addEventListener('click', () => {
      ctx.togglePause();
      ctx.syncTouchButtons();
    });

    // ---- 重开按钮 ----
    restartBtn.addEventListener('click', () => {
      ctx.handleRestart();
      ctx.syncTouchButtons();
    });

    // 开始界面：点击画布任意处也可开始
    ctx.canvas.addEventListener('pointerdown', (e) => {
      if (ctx.state === 'start') { e.preventDefault(); ctx.startGame(); }
    });
  }

  // 根据摇杆偏移计算四方向（取最近方向），同步到 this.keys
  setJoystickDir(px, py, knob) {
    const dx = px - this.joystick.baseX;
    const dy = py - this.joystick.baseY;
    const dist = Math.hypot(dx, dy);
    const radius = 44; // 摇杆活动半径
    const kx = dist > radius ? (dx / dist) * radius : dx;
    const ky = dist > radius ? (dy / dist) * radius : dy;
    knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

    this.clearMoveKeys();
    if (dist < 12) return; // 死区
    const deg = Math.atan2(dy, dx) * 180 / Math.PI;
    if (deg >= -45 && deg < 45) this.keys['ArrowRight'] = true;
    else if (deg >= 45 && deg < 135) this.keys['ArrowDown'] = true;
    else if (deg >= 135 || deg < -135) this.keys['ArrowLeft'] = true;
    else this.keys['ArrowUp'] = true;
  }

  clearMoveKeys() {
    this.keys['ArrowUp'] = false;
    this.keys['ArrowDown'] = false;
    this.keys['ArrowLeft'] = false;
    this.keys['ArrowRight'] = false;
  }

  // 同步重开按钮可见性：仅在非 playing 状态显示
  syncTouchButtons() {
    if (!this.restartBtn) return;
    if (this.state === 'playing' || this.state === 'start') this.restartBtn.classList.add('touch-hidden');
    else this.restartBtn.classList.remove('touch-hidden');
  }

  // ==================== 双人对战玩法 ====================
  // 对外入口：大厅连接成功后调用 window.__game.startDuel(isHost)
  startDuel(isHost) {
    this.mode = isHost ? 'duel-host' : 'duel-guest';
    this.localSide = isHost ? 0 : 1;
    this.player = null;
    this.enemies = [];
    this.powerups = [];
    this.activeEffects = { shield: 0, speed: 0 };
    this.baseFlashTimer = 0;
    this.baseWarn = false;
    this.ensureDuelTanks();
    this.resetDuelMatch();
    this.bindNet();
    if (this.mode === 'duel-guest') {
      this.netSend({ t: 'hi', role: 'guest' });
    } else {
      this.sendSnapshot();
    }
  }

  ensureDuelTanks() {
    if (!this.tanks) this.tanks = [null, null];
    for (let i = 0; i < 2; i++) {
      if (this.tanks[i]) continue;
      const t = new Tank(DUEL_SPAWNS[i].x, DUEL_SPAWNS[i].y, true);
      t.side = i;
      this.tanks[i] = t;
    }
  }

  resetDuelMatch() {
    this.duelLives = [DUEL_LIVES, DUEL_LIVES];
    this.duelWinner = null;
    this.duelScene = 1;
    this.duelMapRev = 0;
    this.duelNotice = '';
    this.duelNoticeT = 0;
    this.bullets = [];
    this.explosions = [];
    this.netAcc = 0;
    this.inputAcc = 0;
    this.map = this.generateMap(this.duelScene);
    this.resetDuelTanks();
    this.state = 'playing';
  }

  resetDuelTanks() {
    for (let i = 0; i < 2; i++) {
      const t = this.tanks && this.tanks[i];
      if (!t) continue;
      t.x = DUEL_SPAWNS[i].x;
      t.y = DUEL_SPAWNS[i].y;
      t.dir = DUEL_SPAWN_DIRS[i];
      t.alive = true;
      t.invincible = DUEL_INVINCIBLE;
      t.fireCooldown = 0;
    }
  }

  // ---------------- 网络桥接（window.Net 不存在时全部静默跳过） ----------------
  bindNet() {
    const Net = window.Net;
    // 大厅重连时可能换成新的 Net 对象，此时需要重新挂监听
    if (this._netBound && this._boundNet === Net) return;
    if (!Net || typeof Net.on !== 'function') return;
    this._netBound = true;
    this._boundNet = Net;
    const safe = (fn) => (...args) => { try { fn(...args); } catch (_) {} };
    try {
      Net.on('data', safe((msg) => this.handleDuelMessage(msg)));
      Net.on('leave', safe(() => this.onDuelPeerLeave()));
    } catch (_) {}
  }

  netSend(obj) {
    const Net = window.Net;
    if (!Net || typeof Net.send !== 'function') return false;
    try { return Net.send(obj) !== false; } catch (_) { return false; }
  }

  handleDuelMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'st':
        if (this.mode === 'duel-guest') this.applySnapshot(msg);
        break;
      case 'ev':
        if (this.mode === 'duel-guest') this.handleDuelEvent(msg);
        break;
      case 'in':
        if (this.mode === 'duel-host') this.remoteInput = normInput(msg.k);
        break;
      case 'hi':
        if (this.mode === 'duel-host') this.netSend({ t: 'hello', role: 'host', scene: this.duelScene });
        break;
      case 'req':
        if (this.mode === 'duel-host') this.handleDuelRequest(msg);
        break;
      case 'bye':
        this.onDuelPeerLeave();
        break;
      default:
        break;
    }
  }

  // 客机→主机的控制请求（重开/暂停）。协议表格外的唯一扩展，双方 game.js 共同实现。
  handleDuelRequest(msg) {
    if (msg.kind === 'restart') {
      if (this.state !== 'over') return;
      this.resetDuelMatch();
      this.sendSnapshot();
    } else if (msg.kind === 'pause') {
      this.togglePause();
    }
  }

  onDuelPeerLeave() {
    if (this.mode === 'solo' || this.state === 'over') return;
    this.state = 'over';
    this.duelWinner = null;
    this.duelNotice = '对手已断开';
    this.duelNoticeT = 3;
  }

  readLocalKeys() {
    const k = this.keys;
    return {
      u: (k['ArrowUp'] || k['KeyW']) ? 1 : 0,
      d: (k['ArrowDown'] || k['KeyS']) ? 1 : 0,
      l: (k['ArrowLeft'] || k['KeyA']) ? 1 : 0,
      r: (k['ArrowRight'] || k['KeyD']) ? 1 : 0,
      f: (k['Space'] || k['KeyJ']) ? 1 : 0
    };
  }

  // ---------------- 主机：物理模拟 ----------------
  applyInputToTank(tank, k, dt) {
    if (!tank || !tank.alive) return;
    const kk = k || { u: 0, d: 0, l: 0, r: 0, f: 0 };
    let moved = false;
    if (kk.u) { tank.dir = 'up'; moved = true; }
    else if (kk.d) { tank.dir = 'down'; moved = true; }
    else if (kk.l) { tank.dir = 'left'; moved = true; }
    else if (kk.r) { tank.dir = 'right'; moved = true; }

    if (moved) {
      const v = DIR_VEC[tank.dir];
      this.moveTank(tank, v.x * tank.speed * dt, v.y * tank.speed * dt);
    }
    if (kk.f) this.duelFire(tank);
  }

  duelFire(tank) {
    const before = this.bullets.length;
    this.fire(tank);
    if (this.bullets.length > before) {
      this.netSend({ t: 'ev', kind: 'fire', x: tank.x + tank.w / 2, y: tank.y + tank.h / 2 });
    }
  }

  updateDuelHost(dt) {
    if (!this.tanks) this.ensureDuelTanks();
    this.tickDuelTimers(dt);
    this.updateExplosions(dt);

    if (this.state === 'playing') {
      for (const t of this.tanks) {
        if (!t) continue;
        if (t.invincible > 0) t.invincible -= dt;
        if (t.fireCooldown > 0) t.fireCooldown -= dt;
      }
      this.applyInputToTank(this.tanks[0], this.readLocalKeys(), dt);
      this.applyInputToTank(this.tanks[1], this.remoteInput, dt);
      this.updateDuelBullets(dt);
    }

    this.netAcc += dt;
    if (this.netAcc >= SNAPSHOT_INTERVAL) {
      this.netAcc = 0;
      this.sendSnapshot();
    }
  }

  updateDuelBullets(dt) {
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (!b.alive) continue;
      const v = DIR_VEC[b.dir];
      b.x += v.x * b.speed * dt;
      b.y += v.y * b.speed * dt;

      if (b.x < 0 || b.x > WIDTH || b.y < 0 || b.y > HEIGHT) {
        b.alive = false;
        continue;
      }

      const c1 = Math.floor(b.x / TILE);
      const c2 = Math.floor((b.x + b.w - 1) / TILE);
      const r1 = Math.floor(b.y / TILE);
      const r2 = Math.floor((b.y + b.h - 1) / TILE);
      let hitWall = false;
      for (let r = r1; r <= r2 && !hitWall; r++) {
        for (let c = c1; c <= c2 && !hitWall; c++) {
          if (r < 0 || r >= ROWS || c < 0 || c >= COLS) { hitWall = true; break; }
          const tile = this.map[r][c];
          if (tile === TILE_BRICK) { this.map[r][c] = TILE_EMPTY; hitWall = true; }
          else if (tile === TILE_STEEL || tile === TILE_BASE || tile === TILE_BASE_RUIN) hitWall = true;
        }
      }
      if (hitWall) { b.alive = false; continue; }

      let hitTank = null;
      const brect = { x: b.x, y: b.y, w: b.w, h: b.h };
      for (const t of this.tanks) {
        if (!t || !t.alive || t === b.owner || t.invincible > 0) continue;
        if (rectsOverlap(brect, t.rect)) { hitTank = t; break; }
      }
      if (hitTank) {
        b.alive = false;
        this.duelHit(hitTank);
        break; // 地图与坦克已复位，本帧不再处理剩余子弹
      }
    }
    this.bullets = this.bullets.filter((b) => b.alive);
  }

  duelHit(tank) {
    const side = tank.side;
    const cx = tank.x + tank.w / 2;
    const cy = tank.y + tank.h / 2;
    this.addExplosion(cx, cy);
    this.sfx.play('explosion');
    this.netSend({ t: 'ev', kind: 'explosion', x: cx, y: cy });

    this.duelLives[side] = Math.max(0, this.duelLives[side] - 1);

    if (this.duelLives[side] <= 0) {
      this.state = 'over';
      this.duelWinner = 1 - side;
      this.duelNotice = '';
      this.duelNoticeT = 0;
      this.sendSnapshot();
      return;
    }

    // 换场景：scene+1 → 重新生成地图 → 双方复位并短暂无敌
    this.duelScene++;
    this.duelMapRev++;
    this.map = this.generateMap(this.duelScene);
    this.bullets = [];
    this.resetDuelTanks();
    this.duelNotice = '换 场 景';
    this.duelNoticeT = DUEL_NOTICE_TIME;
    this.sendSnapshot();
  }

  // ---------------- 客机：只渲染 ----------------
  updateDuelGuest(dt) {
    if (!this.tanks) this.ensureDuelTanks();
    this.tickDuelTimers(dt);
    this.updateExplosions(dt);
    if (this.state !== 'playing') return;

    this.inputAcc += dt;
    if (this.inputAcc >= INPUT_INTERVAL) {
      this.inputAcc = 0;
      this.inputSeq++;
      this.netSend({ t: 'in', k: this.readLocalKeys(), seq: this.inputSeq });
    }
  }

  applySnapshot(st) {
    if (!st || !Array.isArray(st.players)) return;

    if (typeof st.scene === 'number' && st.scene !== this.duelScene) {
      this.duelScene = st.scene;
      this.map = this.generateMap(this.duelScene);
      this.duelNotice = '换 场 景';
      this.duelNoticeT = DUEL_NOTICE_TIME;
    }
    if (typeof st.mapRev === 'number') this.duelMapRev = st.mapRev;

    for (let i = 0; i < 2; i++) {
      const p = st.players[i];
      const t = this.tanks && this.tanks[i];
      if (!p || !t) continue;
      t.x = p.x;
      t.y = p.y;
      if (p.dir) t.dir = p.dir;
      t.alive = !!p.alive;
      t.invincible = typeof p.inv === 'number' ? p.inv : 0;
      t.fireCooldown = typeof p.cd === 'number' ? p.cd : 0;
    }

    this.bullets = (st.bullets || []).map((b) => ({
      x: b.x, y: b.y, w: BULLET_SIZE, h: BULLET_SIZE, dir: b.dir, alive: true
    }));

    if (Array.isArray(st.lives)) this.duelLives = [st.lives[0] | 0, st.lives[1] | 0];
    if (st.state) this.state = st.state;
    this.duelWinner = (st.winner === 0 || st.winner === 1) ? st.winner : null;
  }

  handleDuelEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'fire') {
      this.sfx.play('fire');
    } else if (ev.kind === 'explosion' || ev.kind === 'hit') {
      if (typeof ev.x === 'number' && typeof ev.y === 'number') this.addExplosion(ev.x, ev.y);
      this.sfx.play(ev.kind === 'hit' ? 'hit' : 'explosion');
    }
  }

  buildSnapshot() {
    return {
      t: 'st',
      scene: this.duelScene,
      mapRev: this.duelMapRev,
      players: (this.tanks || []).map((t) => ({
        x: t.x,
        y: t.y,
        dir: t.dir,
        alive: !!t.alive,
        inv: Math.max(0, t.invincible),
        cd: Math.max(0, t.fireCooldown)
      })),
      bullets: this.bullets.map((b) => ({ x: b.x, y: b.y, dir: b.dir })),
      lives: [this.duelLives[0], this.duelLives[1]],
      state: this.state,
      winner: this.duelWinner
    };
  }

  sendSnapshot() {
    if (this.mode !== 'duel-host') return;
    this.netSend(this.buildSnapshot());
  }

  // ---------------- 双人模式的暂停/重开 ----------------
  togglePause() {
    if (this.mode === 'duel-guest') {
      this.netSend({ t: 'req', kind: 'pause' });
      return;
    }
    if (this.mode === 'duel-host') {
      if (this.state === 'playing') this.state = 'paused';
      else if (this.state === 'paused') this.state = 'playing';
      else return;
      this.sendSnapshot();
      return;
    }
    if (this.state === 'playing') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'playing';
  }

  handleRestart() {
    if (this.mode !== 'solo') {
      if (this.state === 'over') this.restartDuel();
      return;
    }
    if (this.state === 'paused' || this.state === 'gameover' || this.state === 'win') this.startGame();
  }

  restartDuel() {
    if (this.mode === 'duel-guest') {
      this.netSend({ t: 'req', kind: 'restart' });
      this.duelNotice = '等待主机重开';
      this.duelNoticeT = 1.5;
      return;
    }
    this.resetDuelMatch();
    this.sendSnapshot();
  }

  tickDuelTimers(dt) {
    if (this.duelNoticeT > 0) this.duelNoticeT = Math.max(0, this.duelNoticeT - dt);
  }

  // ---------------- 双人模式渲染 ----------------
  renderDuel() {
    this.renderMap();
    this.renderExplosions();
    for (const b of this.bullets) this.renderBullet(b);
    for (const t of this.tanks) if (t && t.alive) this.renderTank(t);
    this.renderDuelHUD();
    if (this.duelNoticeT > 0) this.renderDuelNotice();
    if (this.state === 'paused') this.renderPause();
    else if (this.state === 'over') this.renderDuelOver();
    this.syncTouchButtons();
  }

  renderDuelHUD() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, WIDTH, 28);
    ctx.font = 'bold 16px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    ctx.fillStyle = COLORS.hud;
    ctx.fillText(`场景 ${this.duelScene}`, 12, 14);

    const me = this.localSide;
    const foe = 1 - me;
    const hearts = (n) => '♥'.repeat(Math.max(0, n)) + '♡'.repeat(Math.max(0, DUEL_LIVES - n));

    ctx.fillStyle = COLORS.player;
    ctx.fillText(`你 ${hearts(this.duelLives[me])}`, 150, 14);
    ctx.fillStyle = COLORS.enemy;
    ctx.fillText(`对手 ${hearts(this.duelLives[foe])}`, 350, 14);

    ctx.fillStyle = COLORS.hud;
    ctx.fillText(this.mode === 'duel-host' ? '主机' : '客机', 660, 14);
  }

  renderDuelNotice() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.duelNoticeT / 0.4);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, HEIGHT / 2 - 40, WIDTH, 80);
    ctx.fillStyle = COLORS.bullet;
    ctx.font = 'bold 40px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.duelNotice, WIDTH / 2, HEIGHT / 2);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  renderDuelOver() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.overlayBg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let title = '对 战 结 束';
    let color = '#fff';
    if (this.duelWinner === this.localSide) { title = '胜 利'; color = COLORS.player; }
    else if (this.duelWinner === 1 - this.localSide) { title = '失 败'; color = COLORS.enemy; }
    else { title = '连 接 中 断'; color = COLORS.enemy; }

    ctx.fillStyle = color;
    ctx.font = 'bold 56px Consolas, monospace';
    ctx.fillText(title, WIDTH / 2, HEIGHT / 2 - 60);

    ctx.fillStyle = '#fff';
    ctx.font = '22px Consolas, monospace';
    if (this.duelWinner === null) {
      ctx.fillText('请重新进入房间', WIDTH / 2, HEIGHT / 2 + 10);
    } else {
      const mine = this.duelLives[this.localSide];
      const theirs = this.duelLives[1 - this.localSide];
      ctx.fillText(`剩余生命  你 ${mine} : ${theirs} 对手`, WIDTH / 2, HEIGHT / 2 + 10);
      ctx.fillStyle = COLORS.bullet;
      ctx.font = '20px Consolas, monospace';
      ctx.fillText(this.isTouch ? '点击右上重开按钮' : '按 R 重新开始', WIDTH / 2, HEIGHT / 2 + 55);
    }
    ctx.textAlign = 'left';
  }

  // ---------------- 主循环（deltaTime） ----------------
  loop(time) {
    if (!this.lastTime) this.lastTime = time;
    let dt = (time - this.lastTime) / 1000;
    this.lastTime = time;
    // 限制单帧最大步长，避免切后台后大跳
    if (dt > 0.05) dt = 0.05;

    this.update(dt);
    this.render();
    requestAnimationFrame((t) => this.loop(t));
  }
}

// ==================== 启动 ====================
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game');
  if (canvas) {
    window.__game = new Game(canvas);
  }
});
