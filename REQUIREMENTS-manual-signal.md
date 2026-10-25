# 手工配对（无服务器）· 技术规格 v1

> 目标：不依赖任何信令服务器、不需要外网、不需要任何设备常驻，两台设备通过**复制粘贴邀请码**建立 WebRTC 连接。
> 现有的「联网开房（PeerJS 公共云）」必须原样保留，两者并存。

## 0. 与现有代码的关系

- 只改 `net.js`、`index.html`、`style.css` 三个文件。**不要动 game.js**。
- `game.js` 只依赖 `window.Net` 的 `send / on / status / isHost`，以及连上后触发 `'open'`。这些语义不变。
- 手工模式不使用 `vendor/peerjs.min.js`，直接用浏览器原生 `RTCPeerConnection`。

## 1. 新增 API（`window.Net`）

```js
// 手工模式：主机侧
Net.createInvite()            // -> Promise<string>  邀请码（主机）
Net.acceptAnswer(answerCode)  // -> Promise<void>    粘贴对方的应答码后完成连接

// 手工模式：客机侧
Net.useInvite(inviteCode)     // -> Promise<string>  粘贴邀请码 -> 返回应答码
```

- 以上三个方法在内部把 `isHost` 设为 `true` / `false`（`createInvite` 为 true，`useInvite` 为 false）。
- 连接建立（DataChannel open）时，与联网模式一样触发 `'open'` 事件，之后 `send/on/status/leave` 行为完全一致。
- 失败时 `status()` 回到 `'idle'`，触发 `'error'`（payload `{code, message}`），并允许重试。
- 手工模式同样要有连接空闲检测：对端消失时触发 `'leave'`（可复用现有心跳思路，两侧都发）。

## 2. 编码格式

- 邀请码 / 应答码 = `base64url`（无 `+/=` 填充）编码的 JSON：`{"v":1,"t":"offer"|"answer","sdp":"..."}`。
- 必须**收集完 ICE 再编码**：等待 `iceGatheringState === 'complete'` 或最多 3 秒，保证 SDP 内嵌候选，不做 trickle。
- `iceServers` 用 `[{ urls: 'stun:stun.l.google.com:19302' }]`：有外网时更容易穿透，没外网时只拿到局域网候选也能连。
- DataChannel 标签固定 `"game"`，`ordered: true`。

## 3. 大厅 UI（index.html / style.css）

在现有大厅面板里加**模式切换**（两个小标签/按钮）：

- **联网开房**（现有行为，默认）
- **离线配对**（新增）

离线配对面板内容（id 必须完全一致）：

| id | 元素 | 说明 |
|---|---|---|
| `manual-pane` | 容器 | 离线配对面板 |
| `btn-make-invite` | button | 主机：生成邀请码 |
| `btn-use-invite` | button | 客机：用邀请码生成应答码 |
| `manual-in-invite` | textarea | 粘贴邀请码（客机用） |
| `manual-out` | textarea | 显示自己生成的码（邀请码/应答码），只读 |
| `manual-in-answer` | textarea | 主机：粘贴对方应答码 |
| `btn-accept-answer` | button | 主机：完成连接 |
| `btn-copy` | button | 复制 `manual-out` 的内容 |
| `manual-status` | div | 这一步该做什么的提示 |

交互要求：
- 主机：点「生成邀请码」→ 码出现在 `manual-out` 并自动尝试复制 → 提示对方把应答码发回来 → 粘贴到 `manual-in-answer` → 点「完成连接」。
- 客机：把邀请码粘贴到 `manual-in-invite` → 点「生成应答码」→ 码出现在 `manual-out` 并自动复制 → 提示把这个码发回给主机。
- 复制失败（无剪贴板权限）时不要报错，提示「请手动全选复制」。
- 连接成功后隐藏整个大厅，调用 `window.__game.startDuel(isHost)`（判空）。
- 码很长（几 KB），`manual-out` 用等宽小字号、可横向滚动，不要撑破面板。

## 4. 约束

- 不引入任何新的第三方库、不走 CDN。
- 联网模式（PeerJS）行为与现在完全一致，单人不联网仍不受影响。
- 所有回调内部 try/catch，异常不得冒泡打断游戏循环。
- 手工模式与联网模式同一时刻只能有一个生效；切换/重试前先 `close()`。

## 5. 自测与交付

自测：
1. `node --check net.js`
2. 本地起 `python -m http.server`，开两个标签页：A 生成邀请码 → B 粘贴生成应答码 → A 粘贴完成 → 双方进入对战（可临时在两个页面 console 里打印 `Net.status()`）。
3. 刷新页面后能重新开始，不残留旧连接。

交付：写 `REPORT-trae-manual.md`（中文 ≤ 15 行：改了哪些文件、关键实现、如何自测、遗留问题），完成后回复 `DONE` + 一句话总结。
