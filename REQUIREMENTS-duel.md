# 双人开房对战 · 技术规格（v1）

> 由 DSH 编写，作为 TRAE 与 Qoder 并行实现的唯一接口依据。**两边的改动范围严格分开，不要越界修改对方的文件。**

## 0. 需求

1. 两台设备打开同一网页，**一方输入 6 位房间号开房，另一方输入同一房间号加入**，即可对战。
2. 对战双方各 **3 条命**。
3. **任意一方坦克被击毁一次 → 该方扣 1 命 → 立即更换一张新地图（换场景），双方满血复位继续**。
4. 一方 3 命耗尽 → 对战结束，显示胜负，可按 R/按钮重开。
5. **单人模式必须完全不受影响**：不联网时双击 `index.html` 仍可正常玩。
6. 不做鉴权/防作弊/防恶意报文，房间号冲突、非法输入做最基础兜底即可。

## 1. 文件与归属（硬边界）

| 文件 | 负责人 | 说明 |
|---|---|---|
| `vendor/peerjs.min.js` | **TRAE** | 从 `https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js` 下载并落地到仓库（93KB）。不要用 CDN 在线引用 |
| `net.js` | **TRAE** | 全部 P2P 逻辑，暴露下面第 3 节的 `window.Net` |
| `index.html` / `style.css` | **TRAE** | 大厅 UI（开始/加入房间、房间号输入、连接状态、对战 HUD 的 DOM 部分） |
| `game.js` | **Qoder** | 双人对战玩法、主机权威模拟、快照渲染、HUD 画布绘制、单人模式回归 |

> 双方都**不要**改对方的文件。`game.js` 里如需 UI 元素（房间号输入框等），只通过 `document.getElementById(...)` 按第 4 节的 id 约定取。

## 2. 传输方案

- 用 **PeerJS 公共云信令**（`new Peer(...)` 默认 0.peerjs.com:443）建立 WebRTC DataChannel。
- 房间号 `code`：6 位数字字符串。Peer id 固定为 `tank-battle-<code>`。
- 开房方 = **主机（host）**，加入方 = **客机（guest）**。
- 只用一条 DataConnection，消息体为 JSON 对象。

## 3. `net.js` 对外的 API（TRAE 实现，Qoder 按此调用）

```js
window.Net = {
  // 开房：code 为 6 位数字；成功后触发 'open'
  host(code),
  // 加入：成功连上主机后触发 'open'
  join(code),
  // 关闭连接、销毁 Peer
  close(),
  // 发送对象（自动 JSON），返回是否发出
  send(obj),
  // 事件：'open' | 'peer' | 'leave' | 'data' | 'error'
  // fn 收到的 payload：data -> 解析后的对象；error -> {code, message}
  on(evt, fn),
  // 状态：'idle' | 'connecting' | 'connected' | 'error'
  status(),
  // 是否主机
  isHost,
};
```

要求：
- 所有回调异常不得中断游戏主循环（内部 try/catch）。
- 连接断开要触发 `'leave'`，并把 `status()` 置为 `'idle'`。
- 同一时刻只允许一个连接；重复 `host/join` 前先 `close()`。

## 4. 消息协议（两边共同遵守）

全部为 JSON 对象，字段 `t` 表示类型：

| 方向 | 消息 | 说明 |
|---|---|---|
| guest → host | `{t:'in', k:{u,d,l,r,f}, seq}` | 客机按键状态，**30Hz** 发送，`k` 的值为 0/1 |
| guest → host | `{t:'hi', role:'guest'}` | 连上后立即发一次 |
| host → guest | `{t:'hello', role:'host', scene}` | 收到 `hi` 后回一次，`scene` 为当前场景编号 |
| host → guest | `{t:'st', scene, mapRev, players, bullets, lives, state, winner}` | 状态快照，**20Hz** |
| host → guest | `{t:'ev', kind, x, y}` | 事件（开火/爆炸/命中），用于客机放音 |
| 任意 | `{t:'bye'}` | 主动离开 |

`st` 字段：
```js
players: [ {x,y,dir,alive,inv,cd}, {x,y,dir,alive,inv,cd} ]   // 0=host方, 1=guest方
bullets: [ {x,y,dir} ]
lives:   [hostLives, guestLives]      // 各 3 起始
mapRev:  整数，地图换了一张就 +1
state:   'playing' | 'paused' | 'over'
winner:  0 | 1 | null
```
地图本身**不放进快照**：`scene` 变化时客机用同一套 `generateMap(scene)` 自行生成（双方种子一致）。

## 5. 玩法规格（Qoder 实现）

- 新增模式：`mode = 'solo' | 'duel-host' | 'duel-guest'`。默认 `'solo'`，行为与现在**完全一致**。
- 双人模式场地：无 AI 敌人、无基地。只有两辆坦克对战。
- 出生点：0 号在左下区，1 号在右上区，互相面对。
- 生命：`lives = [3,3]`。
- 命中判定：子弹击中对方 → 对方扣 1 命、爆炸、**立即换场景**：
  1. `scene++`，用该编号 `generateMap(scene)` 重新生成地图；
  2. 双方复位到出生点，给 1.5 秒无敌；
  3. HUD 短暂显示「换场景」提示（1 秒左右）；
  4. 若某方 lives 归 0 → `state='over'`，显示胜负。
- 单人模式的子弹/道具/音效/最高分逻辑一律保留，不要为双人改坏它们。
- 主机权威：host 跑完整 `update`，按 20Hz 调 `Net.send({t:'st',...})`；guest **只做渲染**（不跑物理），并 30Hz 发自己的按键。
- guest 渲染插值：直接使用快照位置即可，必要时做 100ms 线性插值（可选，不做也不算错）。
- 音效：host 正常本地播放；guest 依据收到的 `ev` 与 `st` 变化播放对应音效（可简化为只播开火/爆炸）。

## 6. 大厅 UI（TRAE 实现，Qoder 只需知道 id）

`index.html` 内新增（默认隐藏，`start` 界面模式下显示）：

| id | 元素 | 说明 |
|---|---|---|
| `lobby` | 容器 | 大厅面板 |
| `room-input` | input | 房间号输入（6 位数字，`inputmode="numeric"`，`maxlength=6`） |
| `btn-host` | button | 开房间 |
| `btn-join` | button | 加入房间 |
| `net-status` | div | 连接状态文案 |

交互：
- 点「开房间」→ `Net.host(code)`；点「加入房间」→ `Net.join(code)`。
- 连接成功 → 隐藏 `lobby`，调用 `window.__game && window.__game.startDuel(isHost)`（Qoder 暴露此方法）。
- 失败/超时 → `net-status` 显示原因，可重试。
- 单人模式入口保持原样（按任意键开始）。

## 7. 验收（DSH 执行）

1. `node --check game.js net.js`
2. 单人模式回归：开始界面、移动、开火、道具、音效、最高分不退化
3. 双人联机实测：同一台机器开两个浏览器实例，A 开房、B 输同一房间号加入 → 双方能看到对方坦克移动/开火 → 击毁一方 → 地图更换、双方满血复位、生命 -1 → 打空 3 命出现胜负界面
4. 断线场景：对方关闭页面，己方应回到可重试状态而不是卡死

## 8. 交付格式

各自完成后，在**自己的工作树根目录**写一份 `REPORT-<名字>.md`（中文 ≤ 15 行）：改了哪些文件、关键实现、如何自测、遗留问题。然后回复 `DONE` + 一句话总结。
