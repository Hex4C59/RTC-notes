---
aliases: [ICE Diagnostics, TURN Diagnostics, Connectivity Debug]
tags: [rtc/concept, rtc/troubleshooting, rtc/connectivity]
type: concept
status: growing
---

# ICE 与 TURN 诊断

> [!tip] 阅读提示
> **前置：** [[测试与排障地图]]；机制侧见 [[ICE 连通性检查与选路]]、[[TURN]]、[[ICE 状态机]]。
> **初读：** 先读「一句话说明」「问题边界」「分阶段检查」和「常见结论示例」。
> **深入：** TURN 生命周期、测试矩阵与证据对齐表，在复现企业网/长通话故障时再读。

## 一句话说明

ICE 与 TURN 诊断通过候选收集、连通性检查、候选对切换和 TURN allocation 生命周期，把“连不上 / 一会被中继 / 长通话掉线”拆成：本地配置、DNS/阻断、鉴权、中继容量与路径质量——而不是停在笼统的 `ICE failed`。

## 问题边界

- **上游：** ICE/TURN URI 与凭据下发、DNS、客户端策略（`iceTransportPolicy`）、网络权限与接口。
- **下游：** selected candidate pair、consent 是否保住、媒体是否沿该路径持续流动、TURN 刷新是否成功。
- **易混淆：**
  - 有 relay 候选 ≠ TURN 全程可用（allocation 成功后仍可能 permission/刷新失败）。
  - pair 显示 relay ≠ 两端共用同一 TURN 节点。
  - 直连成功 ≠ TURN 可用（必须强制 `relay` 单独验）。
  - `checking` 很久 ≠ 一定是 TURN 坏；也可能是 srflx 被墙、角色冲突、ufrag 代次错乱。

## 核心机制

1. **收集：** host / srflx / relay 是否按预期出现（类型缺口本身就是诊断信号）。  
2. **检查：** Binding 请求/响应、角色、提名、最终 selected pair。  
3. **维持：** consent freshness；网络切换后的 ICE restart。  
4. **中继：** allocation → permission / channel → 刷新；鉴权与容量错误要能从日志区分。  
5. **证据三角：** 客户端 ICE 事件 + Stats 候选对象 + 抓包/TURN 日志对齐同一时间窗。

## 分阶段检查

### 1. 配置与解析

- STUN/TURN URI、端口、`transport`、凭据是否真正送达客户端（配置中心 ≠ 运行时生效）。  
- DNS A/AAAA/SRV（若用）在问题网络是否正确；系统代理 / 私有 DNS 是否改写结果。  
- `turns:` 与 `turn:` 传输方式勿混；证书域名、有效期、信任链要匹配。  
- 临时凭据的用户名、签名、过期时间要考虑客户端与服务端时钟偏差。

### 2. 候选收集

记录每个候选的类型、地址族、协议、相关地址、优先级、foundation、代次。重点不是“越多越好”，而是**预期路径是否出现**：

| 现象 | 优先怀疑 |
| --- | --- |
| 无 host | 策略/接口/权限受限 |
| 有 host 无 srflx | STUN 不可达、响应被挡、NAT 异常 |
| 有 srflx 无 relay | TURN 配置、鉴权、传输或 allocation 失败 |
| 仅 TCP/TLS relay | UDP 被策略阻断；仍需验证该回退能否实际连通 |
| 双栈缺一条 | IPv6/IPv4 策略或 DNS 只返回单族 |

### 3. 连通性检查与提名

```text
exchange candidates (same ICE generation)
  -> form pairs / prioritize
  -> STUN Binding checks
  -> nominate / select
  -> consent freshness (keep alive path)
```

- 候选是否经信令到达对端；ufrag/pwd 是否同代。  
- 是否形成候选对并进入检查；Binding 有无响应。  
- controlling/controlled 与 tie-breaker 冲突是否解决。  
- nominated/selected 是哪一对；之后有无切换。  
- consent 失败是否关掉已连接路径。

对照 [[ICE 状态机]]：状态停在哪一步，比只看最终 `failed` 有用。

### 4. TURN 生命周期

relay 候选出现只证明 **Allocation 曾成功**。媒体持续经过还依赖：

- permission（对端地址是否被允许）  
- channel binding（若使用）  
- allocation 刷新  
- 服务容量与配额  

服务日志应能区分：401 challenge、438 stale nonce、配额拒绝、permission 失败、allocation 到期。错误码与事务语义按 RFC 8656 与所用实现版本核对。

## 测试矩阵

至少分开覆盖（直连成功不能代替）：

- 正常双向 UDP  
- 直连 UDP 受限但 TURN/UDP 可用  
- 仅 TCP 或 TLS 出站  
- IPv4 / IPv6 / 双栈切换  
- Wi-Fi ↔ 蜂窝后 ICE restart  
- 强制 `relay`，专门验 TURN  
- 长通话：allocation、permission、凭据刷新  

## 证据对齐

| 证据 | 能回答 |
| --- | --- |
| 客户端 ICE 事件 | 候选何时出现、状态停在哪一步 |
| WebRTC Stats | selected pair、协议、候选类型、RTT、字节 |
| 客户端抓包 | STUN/TURN 是否发出、响应是否回来 |
| TURN 日志 | 鉴权、allocation、permission、channel、刷新 |
| SFU/远端日志 | 检查是否到对端、媒体是否沿所选路径进入 |

NAT 后地址不同是常态。关联事务优先用 **STUN transaction ID、时间、客户端会话 ID**，不要只按公网五元组猜。

## 工程要点

- 分别测直连与强制中继；产品默认“能通就行”会掩盖 TURN 坏掉。  
- 在受限 UDP、仅 TCP/TLS、双栈与网络切换场景记录 pair 变化。  
- 把浏览器/Native 状态、TURN 日志、[[抓包分析]]、Stats 候选对象对齐到同一时间轴。  
- 对外结论写清网络假设（例如“仅放行 443/TCP”），避免只贴 `ICE failed` 截图。  
- 监控侧：allocation 成功率、刷新失败率、强制 relay 通话占比、consent 失败次数。

## 常见结论示例

- **差：** “ICE failed”。  
  **好：** “企业网仅允许 TCP 443；客户端未拿到 TURN/TLS relay；所有 UDP 候选对检查超时”。  
- **差：** “TURN 不通”。  
  **好：** “Allocation 成功，但临时凭据 10 分钟后过期且刷新被 401 拒绝，长通话随后断流”。  
- **差：** “已经是 relay 了应该没问题”。  
  **好：** “pair 为 relay，但 permission 未覆盖对端新地址；切换网络后未 restart，媒体停”。

candidate pair 显示 relay：不代表两端共用同一 TURN，也不能推断媒体质量良好。

## 常见误区与故障表现

| 表现 | 常见根因 |
| --- | --- |
| 办公室 OK、客户现场必挂 | UDP 被挡且未配/未用 TCP-TLS TURN |
| 短通话好、十几分钟掉 | allocation/凭据刷新失败 |
| 只有 IPv6 用户失败 | 单栈或 AAAA 解析/防火墙不对称 |
| 切换 Wi-Fi 后无声 | 未 ICE restart，旧 pair/consent 失效 |
| 强制 relay 仍失败 | 鉴权、证书、配额或 permission |
| Stats 有 pair 仍无媒体 | DTLS/SRTP 或上层未发；需抓包区分 |

## 观测与验证

- **最小复现：** 同一账号在“直连允许 / 强制 relay / 仅 TCP”三档各打一通，导出 ICE 事件 + Stats selected pair +（可选）TURN 日志片段。  
- **指标：** 收集耗时、checking 时长、选中候选类型分布、consent 失败、TURN 401/438/配额计数。  
- **互证：** 客户端说“在发 Binding”时，抓包是否出网；TURN 说 allocation OK 时，Stats 是否真出现 relay 候选。  
- **安全：** 候选与抓包含内外网地址；TURN 日志含用户名/realm。导出前脱敏；勿落盘长期密钥或完整口令。

## 生命周期（诊断视角）

```text
config delivered
  -> gather (host/srflx/relay)
  -> check / nominate
  -> connected + consent
  -> (optional) ICE restart on network change
  -> TURN refresh loop until close
```

任一步骤的“该出现的证据没出现”，就是下一刀切开的位置。

## 阅读导航

- **上一篇：** [[SRTP 与 SRTCP 报文保护]]
- **下一篇：** [[00-知识地图/专题说明/04 WebRTC 应用接入与源码阅读|04 WebRTC 应用接入与源码阅读]]（本专题配套详解已读完，进入下一专题说明）
- **所属专题：** [[00-知识地图/专题说明/03 ICE、STUN、TURN 与传输安全|03 ICE、STUN、TURN 与传输安全]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[测试与排障地图]]
- 选路：[[ICE 连通性检查与选路]]、[[ICE 状态机]]
- 中继：[[TURN]]
- 报文：[[抓包分析]]
- 状态：[[WebRTC 状态机诊断]]
- 互证：[[WebRTC Stats]]、[[webrtc-internals]]

## 参考资料

- RFC 8445、RFC 8489、RFC 8656
- 《WebRTC 权威指南》第 9 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/09-nat-firewall-traversal.md`
