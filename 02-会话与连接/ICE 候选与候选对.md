---
aliases: [ICE Candidate, ICE Candidate Pair]
tags: [rtc/concept, rtc/connectivity]
type: concept
---

# ICE 候选与候选对

## 定义

ICE 候选是一个端点可用于接收数据的传输地址及其属性，通常包括 IP、端口、传输协议、类型、优先级、foundation 和所属媒体组件。候选对由本地候选与远端候选组成，是 ICE 实际检查一条网络路径的最小单位。

## 核心机制

- `host` 候选来自本机接口；`srflx` 候选是 STUN 服务器观察到的 NAT 映射；`relay` 候选来自 TURN 分配；`prflx` 候选则可能在连通性检查响应中动态发现。
- ICE Agent 为候选分配优先级和 foundation，并将本地候选与远端同一组件、兼容协议的候选组合成候选对。BUNDLE 和 RTCP mux 会减少实际组件数量，但不改变候选对需要匹配可用媒体段的约束。
- 候选通过 SDP 或 Trickle ICE 传给对端；`sdpMid`/`sdpMLineIndex` 将候选绑定到媒体段，end-of-candidates 表示该代候选收集完成。
- 候选对是否优先不等于是否可用，最终仍需经过连接检查和提名；成功的候选对可能不是地址字典序上的第一对。

## 工程要点

- 不要在业务层手工假定 host 一定优于 relay；让 ICE 根据优先级、检查结果、策略和网络环境选择，并记录最终 selected pair。
- 处理 IPv4/IPv6、mDNS host 候选、TCP/TLS 回退、候选池和多网卡；候选到达顺序也可能与 SDP 到达顺序不同。
- 候选属于 ICE generation。重启后旧候选不能和新凭据混用；服务端转发时保留会话、媒体段和代次上下文。
- 日志和诊断中对公网地址、用户名和候选信息做访问控制；候选可暴露网络拓扑，不应无条件写入业务日志。

## 解决的问题

把端点可能使用的多种地址表达成可交换、可比较和可检查的路径单元，并保留它们与媒体段、协议和 ICE 代次的关系。

## 工作流程或状态流

1. ICE Agent 从本地接口生成 host candidate，向 STUN 查询映射并生成 srflx，向 TURN Allocate 并生成 relay。
2. 本地候选通过 SDP 或 Trickle ICE 发送；远端候选到达后按 sdpMid、组件和协议建立候选对。
3. 兼容候选对进入检查清单，经历等待、检查成功/失败和提名；运行中还可能发现 prflx。
4. selected pair 与传输绑定，其他候选保留为故障切换或诊断依据，代次结束后统一清理。

## 关键对象、字段与报文

- candidate 字段通常包括 foundation、component、protocol、priority、地址、端口和 type；扩展还可能含 tcp-type、related address 等。
- candidate pair 由 local candidate 与 remote candidate 组成，有 pair priority、状态、最近检查时间和 RTT。
- sdpMid、sdpMLineIndex、ufrag 和 generation 把候选绑定到媒体段和协商代次。
- end-of-candidates 表示该代收集结束，不表示所有候选对都检查成功。

## 原理细节

host、srflx、relay 反映地址取得方式，而非简单的“好/坏”等级；prflx 可在对端检查时动态产生。候选优先级和 pair priority 用于安排检查和提名，但真正可用性由双向 STUN 检查决定。BUNDLE/RTCP mux 会让多个媒体段共享传输，候选与 mid 的映射仍不可丢失。

## 工程实现与取舍

- 保留候选原始字符串和结构化字段，解析失败时报告错误，不要通过字符串截取猜字段。
- 服务器转发保持消息顺序上下文、来源和代次；重连后丢弃旧会话候选。
- 隐私要求较高时关注 mDNS host、候选脱敏和日志访问控制；诊断工具应明确谁可见公网地址。
- 地址族、传输类型和候选策略会影响连接成功率与延迟，比较时固定服务器配置和网络条件。

## 常见误区与失败表现

- 看到 srflx 就认为一定直连：NAT 过滤可能阻止对端回包。
- 手工按 host/srflx/relay 排序并强制使用：可能绕过 ICE 的策略和实际可达性。
- 将 candidate 到达顺序当作优先级：Trickle ICE 的到达顺序受网络和信令调度影响。
- 忽略 sdpMid 或 generation：候选可能被加到错误媒体段，表现为 addIceCandidate 失败或无媒体。

## 可观测指标与验证

- 统计各类型/地址族/协议候选数、收集耗时、解析失败、candidate 消息延迟和 end-of-candidates 时间。
- 对每个 pair 记录 local/remote type、状态、priority、RTT、失败原因和是否 selected。
- 抓包将 STUN Binding 的源/目的地址与候选 pair 对照，确认服务端转发内容和端点实际使用一致。
- 在多网卡、IPv4/IPv6、强制 relay、UDP 阻断和 mDNS 环境分别验证候选策略。

## 示例场景

办公室端点同时产生 host、srflx 和 relay 候选。host pair 因企业防火墙失败，srflx pair 检查超时，relay pair 成功并被提名；诊断记录应说明每类候选的失败阶段，而不是只留下“ICE 连接成功”。

## 图谱关系

- 框架归属：[[ICE]]定义候选收集、组合和检查的整体流程。
- 地址来源：[[STUN]]发现 server-reflexive 候选并参与检查。
- 中继来源：[[TURN]]提供 relay 候选作为受限网络的路径。
- 网络前提：[[NAT 映射与过滤行为]]影响候选能否互相到达。
- 描述承载：[[SDP]]或增量信令携带候选及其媒体段归属。

## 参考资料

- 《WebRTC 权威指南》第 9 章“NAT 与防火墙穿越”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/09-nat-firewall-traversal.md`
- 《Learning WebRTC》第 3 章“创建基本的 WebRTC 应用”：`90-参考资料/音视频与 WebRTC 书库/learning-webrtc/translation/03-creating-a-basic-webrtc-application.md`
- 《Learning WebRTC》第 5 章“连接客户端”：`90-参考资料/音视频与 WebRTC 书库/learning-webrtc/translation/05-connecting-clients-together.md`
- 《WebRTC Cookbook》第 1 章“对等连接”：`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/01-peer-connections.md`
