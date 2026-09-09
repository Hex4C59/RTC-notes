---
aliases: [Session Traversal Utilities for NAT, NAT 会话穿越实用工具]
tags: [rtc/concept, rtc/connectivity]
type: concept
---

# STUN

## 定义

STUN（Session Traversal Utilities for NAT）是一组用于发现外部映射、执行 Binding 请求和承载 ICE 检查的工具协议。它能帮助端点获得 server-reflexive 地址，但不保证任意 NAT、防火墙或对端组合都能直连。

## 核心机制

- 端点向 STUN Server 发送 Binding Request，服务端从收到的报文观察源地址，并在 Binding Response 中返回 XOR-MAPPED-ADDRESS 等结果。
- ICE 使用会话级短期用户名和密码保护检查请求；FINGERPRINT、MESSAGE-INTEGRITY 等属性帮助区分和验证 STUN 消息。
- 同一个端点经不同目的地发送请求时，NAT 可能创建不同映射。因此从一个 STUN Server 看到的地址只是一条路径上的观察结果。
- STUN 反射地址是候选来源之一。直连失败时，应由 ICE 选择 TURN relay，而不是让应用把 STUN 当成通用中继。

## 工程要点

- 监测 Binding 成功率、响应 RTT、错误码和地址族；超时应区分服务器不可达、出站 UDP 被限制和返回包被过滤。
- STUN 服务只帮助发现和检查，不能替代 TURN 的带宽容量、鉴权、权限和 allocation 生命周期管理。
- 对公网部署时限制速率、校验来源并保护日志；候选地址、ICE 用户名和端口信息可能暴露网络拓扑。
- 不要用单次 STUN 结果给 NAT 打标签；应结合候选对检查、实际 selected pair 和不同网络环境验证。

## 解决的问题

让端点发现自身在外部网络看到的地址，并提供轻量的请求/响应机制验证路径和持续的对端许可。

## 工作流程或状态流

1. ICE Agent 为 STUN 请求选择本地接口和服务器地址，生成 transaction ID 并发送 Binding Request。
2. STUN server 从收到的数据报观察源地址，返回 XOR-MAPPED-ADDRESS 等结果；客户端把结果转换成 srflx 候选。
3. ICE 连通性检查复用 STUN 消息，使用会话级 ufrag/pwd 验证请求和响应，必要时携带优先级、角色和提名属性。
4. 连接建立后按周期发送 consent freshness；超时或错误响应使上层重新检查、切换 relay 或 restart。
5. 事务成功、失败、超时和关闭时分别释放事务表与定时器。

## 关键对象、字段与报文

- STUN header 包含 message type、message length、magic cookie 和 transaction ID，决定解析和请求匹配。
- Binding Request/Response 可能带 XOR-MAPPED-ADDRESS、USERNAME、MESSAGE-INTEGRITY、FINGERPRINT 和 ERROR-CODE。
- ICE 检查还涉及 PRIORITY、USE-CANDIDATE、ICE-CONTROLLING/CONTROLLED 等属性。
- 事务状态、发送次数、超时、响应 RTT、服务器地址族和观察到的映射地址应进入诊断记录。

## 原理细节

STUN 是工具协议，不是“打洞成功”的保证。服务器只能告诉端点某个具体来源看到的映射，端点之间的候选检查还受到另一端映射、过滤、防火墙和返回方向影响。ICE 的短期凭据用于验证属于当前会话的检查请求；公网 STUN 服务不应被当成任意第三方数据中继。

## 工程实现与取舍

- 配置多个 STUN 地址时控制查询并发和超时，避免启动阶段把大量请求打到同一服务。
- 对错误码、响应超时、地址族失败和服务器不可达做不同处理；必要时转向 TURN，而不是无限重试 STUN。
- STUN/TURN 服务端实施速率限制和来源校验，客户端日志对公网地址、凭据和 transaction ID 做访问控制。
- 在 NAT 类型复杂或移动网络中，使用真实候选对检查验证，而不是依据一次映射结果硬编码策略。

## 常见误区与失败表现

- STUN response 返回公网地址就认为对端可连：它只证明 server-reflexive 映射被观察到。
- 把 STUN Binding 与媒体数据混为一谈：Binding 是检查/发现报文，媒体仍走 RTP/RTCP 或 DataChannel。
- 忽略 transaction ID：并发请求响应可能被错误匹配，造成假超时或错误映射。
- 把所有超时归因于服务器：回程被过滤、UDP 受限和本地线程阻塞也会导致无响应。

## 可观测指标与验证

- 统计请求成功率、超时率、错误码、RTT、事务重传、地址族、映射变化和 server 分布。
- 将 STUN transaction 与 candidate pair、ICE generation、selected pair 和 consent 状态关联。
- 抓包核对 magic cookie、transaction ID、Binding 请求/响应方向和 MESSAGE-INTEGRITY。
- 在不同 NAT、UDP 阻断、IPv4/IPv6、服务器故障和高并发连接下验证回退和限流。

## 示例场景

客户端向两个 STUN server 查询，分别看到相同和不同的外部端口。应用不直接选择其中一个“更像公网”的地址，而是把结果作为候选交给 ICE；若对端检查无法回包，最终使用 TURN relay，并保留查询差异供 NAT 诊断。

## 图谱关系

- 地址行为：[[NAT 映射与过滤行为]]决定 STUN 观察到的映射和回包是否可达。
- 候选来源：[[ICE 候选与候选对]]使用 STUN 结果形成 server-reflexive 候选。
- 检查用途：[[ICE 连通性检查与选路]]使用 STUN Binding 验证候选对。
- 中继回退：[[TURN]]在 STUN 直连路径不可行时转发流量。
- 所属地图：[[连接与安全地图]]组织 NAT 穿越和传输安全知识。

## 参考资料

- 《WebRTC 权威指南》第 9 章“NAT 与防火墙穿越”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/09-nat-firewall-traversal.md`
- 《WebRTC 权威指南》第 10 章“协议”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/10-protocols.md`
- 《WebRTC 教程》第 6 章“即时通信协议”：`90-参考资料/音视频与 WebRTC 书库/webrtc-tutorial-zh/content/06-chapter-6.md`
- 《WebRTC Cookbook》第 1 章“对等连接”：`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/01-peer-connections.md`
