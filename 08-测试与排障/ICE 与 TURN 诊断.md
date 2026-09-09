---
tags: [rtc/concept, rtc/troubleshooting, rtc/connectivity]
type: concept
status: growing
---

# ICE 与 TURN 诊断

## 一句话说明

ICE 与 TURN 诊断通过候选收集、连通性检查、候选对切换和 TURN allocation 生命周期，区分本地配置、DNS/网络阻断、鉴权、中继容量与路径质量问题。

## 核心机制

- 候选收集阶段确认 host、server-reflexive 和 relay 候选是否按预期出现。
- 检查阶段确认请求/响应、角色、提名及最终 selected candidate pair。
- 使用 relay 候选时继续检查 TURN 凭据、allocation、permission、channel 和生命周期刷新。

## 分阶段检查

### 1. 配置与解析

- STUN/TURN URI、端口、transport 参数和凭据是否送达客户端。
- DNS A/AAAA/SRV（若使用）是否在问题网络正确解析，系统代理或私有 DNS 是否改变结果。
- TURN 证书域名、有效期和信任链是否匹配；`turns:` 与普通 `turn:` 的传输方式不能混淆。
- 临时凭据的用户名、签名和过期时间是否考虑客户端与服务端时钟偏差。

### 2. 候选收集

记录每个候选的类型、地址族、协议、相关地址、优先级、foundation 和代次。诊断重点不是候选越多越好，而是预期的路径是否出现：

- 没有 host：设备/浏览器策略、接口或权限可能受限。
- 有 host 无 srflx：STUN 不可达、响应被阻断或 NAT 行为异常。
- 有 srflx 无 relay：TURN 配置、鉴权、传输或 allocation 失败。
- 只有 TCP/TLS relay：UDP 可能被网络策略阻断，但仍需验证该回退能否实际连通。

### 3. 连通性检查与提名

- 候选是否通过信令交换到对端，ufrag/pwd 是否属于同一 ICE 代次。
- 是否形成候选对并进入检查，STUN Binding 请求有没有响应。
- controlling/controlled 角色及 tie-breaker 冲突是否正确解决。
- nominated/selected pair 是哪一对，是否发生后续切换。
- consent freshness 失败是否导致已连接路径被关闭。

### 4. TURN 生命周期

TURN relay 候选出现只证明 Allocation 曾成功。媒体持续通过还依赖 permission、可能的 channel binding、allocation 刷新和服务容量。服务日志应能区分 401 challenge、438 stale nonce、配额拒绝、permission 失败和 allocation 到期。

具体错误码与事务语义应按 RFC 8656 和所用 TURN 实现版本核对。

## 工程要点

- 分别测试直连与强制中继，不能用直连成功推断 TURN 可用。
- 在受限 UDP、仅 TCP/TLS、IPv4/IPv6 和网络切换场景下记录候选对变化。
- 将浏览器状态、TURN 服务日志、抓包和 Stats 中候选对象对齐。

## 测试矩阵

至少分开覆盖：

- 正常双向 UDP 网络。
- 直连 UDP 受限但 TURN/UDP 可用。
- 仅 TCP 或 TLS 出站可用。
- IPv4、IPv6 和双栈切换。
- Wi-Fi/蜂窝切换后 ICE restart。
- 强制 `relay` 策略，验证 TURN 而不是让直连掩盖问题。
- 长时间通话，验证 allocation、permission 和凭据刷新。

## 证据对齐

| 证据 | 能回答的问题 |
| --- | --- |
| 客户端 ICE 事件 | 候选何时出现、状态在哪一步停留 |
| WebRTC Stats | 最终 selected pair、协议、候选类型、RTT 和字节 |
| 客户端抓包 | STUN/TURN 请求是否发出、响应是否回来 |
| TURN 日志 | 鉴权、allocation、permission、channel 与刷新结果 |
| SFU/远端日志 | 检查是否到达另一端、媒体是否沿所选路径进入 |

NAT 后地址不同是正常现象，关联事务时优先使用 STUN transaction ID、时间和客户端会话标识，不要只按公网五元组猜测。

## 常见结论示例

- “ICE failed”过于笼统；更有用的结论是“企业网中仅允许 TCP 443，客户端未获得 TURN/TLS relay 候选，所有 UDP 候选对检查超时”。
- “TURN 不通”也需细化，例如“Allocation 成功，但临时凭据在 10 分钟后过期且刷新被 401 拒绝，长通话随后断流”。
- candidate pair 显示 relay 不代表两端都通过同一 TURN 节点，也不能据此推断媒体质量良好。

## 安全与隐私

候选与抓包可能包含内网/公网地址，TURN 日志可能包含用户名和 realm。导出前按团队策略脱敏；不要在日志中保存长期密钥或完整认证口令。

## 图谱关系

- 主题：[[测试与排障地图]]
- 选路：[[ICE 连通性检查与选路]]
- 中继：[[TURN]]
- 报文：[[抓包分析]]
- 状态：[[WebRTC 状态机诊断]]

## 参考资料

- RFC 8445、RFC 8489、RFC 8656。
- 《WebRTC 权威指南》第 9 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/09-nat-firewall-traversal.md`
