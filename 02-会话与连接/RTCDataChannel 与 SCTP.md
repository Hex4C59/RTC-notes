---
aliases: [RTCDataChannel, WebRTC 数据通道]
tags: [rtc/concept, rtc/data-channel, rtc/transport]
type: concept
---

# RTCDataChannel 与 SCTP

## 定义

`RTCDataChannel` 是 WebRTC 对等连接上的应用数据通道。它不承载 RTP 媒体，而是在已建立的 ICE 路径和 DTLS 安全层上运行 SCTP 关联，再通过 DCEP 协商通道参数。SCTP 提供面向消息、多流、可靠或部分可靠以及有序或无序传输能力。

## 核心机制

- 默认 `negotiated: false` 时，一端通过 `createDataChannel()` 创建通道，另一端经 DCEP 收到 `datachannel` 事件；`negotiated: true` 时，双方需预先约定相同的通道 ID 和参数。
- `ordered` 控制消息是否按发送顺序交付；`maxRetransmits` 或 `maxPacketLifeTime` 允许部分可靠传输，二者不能同时设置。可靠有序更像 TCP，部分可靠或无序更适合时效性数据，但底层仍是 SCTP。
- SCTP 关联由 DTLS 保护，并复用 ICE 建立的传输路径。连接建立不代表通道已经打开，应等待 `readyState === "open"`。
- `bufferedAmount` 反映尚未交给底层发送的数据量；`bufferedAmountLowThreshold` 和 `bufferedamountlow` 可用于应用层背压。

## 工程要点

- 限制单条消息大小和发送速率，分块传输文件或大对象，并在接收端做边界和超时校验；不要把 DataChannel 当作无限缓冲队列。
- 发送前检查 `readyState`，关闭时取消生产任务；把通道关闭、PeerConnection 关闭和业务房间离开分别记录。
- 需要低延迟时明确选择无序/部分可靠，并验证实际丢包、重传和延迟；不应只依据选项名称推断 QoE。
- DataChannel 与媒体共享底层路径和拥塞资源，压力测试应同时观测媒体质量、SCTP 缓冲和选中候选对。

## 解决的问题

在同一条 WebRTC 对等连接上承载聊天、控制、文件或状态消息，并让应用根据时效性选择可靠/部分可靠、有序/无序交付。

## 工作流程或状态流

1. PeerConnection 完成或准备 ICE/DTLS 传输；一端创建 DataChannel，默认由 DCEP 通知对端。
2. SCTP association 在 DTLS 之上建立，通道获得 label、stream ID 和可靠性参数。
3. 通道从 connecting 进入 open，应用在 open 后发送消息，并依据 bufferedAmount 做背压。
4. 对端按通道参数交付 message；网络拥塞、部分可靠策略或过期时间可能使消息丢弃。
5. 应用关闭通道或 PeerConnection 关闭，进入 closing/closed，生产任务和缓冲必须停止。

## 关键对象、字段与报文

- RTCDataChannel 的 label、id、protocol、ordered、negotiated、maxRetransmits 和 maxPacketLifeTime 是通道契约。
- readyState、bufferedAmount、bufferedAmountLowThreshold、binaryType 和事件回调描述应用可见状态。
- SCTP association、stream ID、message、chunk、拥塞窗口和重传计数属于传输实现状态。
- DCEP 的 OPEN/ACK 建立非 negotiated 通道；应用消息随后作为 SCTP 数据承载在 DTLS 记录中。

## 原理细节

SCTP 面向消息并支持多流，每条通道可选择有序或无序、可靠或部分可靠传输。无序或部分可靠能降低过期数据阻塞，但不能让大消息无成本通过；SCTP/DTLS 仍共享 ICE 路径和拥塞资源。DataChannel 的安全性来自 DTLS 传输保护，不能等同于应用层身份授权。

## 工程实现与取舍

- 聊天和文件元数据通常需要可靠有序；实时指针、位置或临时状态可考虑无序/部分可靠，并定义业务丢失语义。
- 发送循环监控 bufferedAmount，超过阈值暂停生产，收到 low 事件或低于阈值后恢复；不要只依赖内存 GC。
- 大文件按应用块分片，带文件 ID、块序号、长度、校验和、取消/重试状态，避免单条消息占满发送队列。
- 通道和媒体共享拥塞控制，压测文件传输时同时检查音频断续、视频码率和 selected pair。

## 常见误区与失败表现

- createDataChannel 返回对象就立即 send：readyState 尚未 open 时会失败或丢失。
- 把 ordered=false 当成“永不重排”：它只允许无序交付，应用仍需处理重复、过期和业务关联。
- 同时设置 maxRetransmits 和 maxPacketLifeTime：参数互斥，且不同实现对边界有差异。
- 只观察 channel open：底层 SCTP 缓冲或拥塞可能让消息延迟极高，媒体质量也会下降。

## 可观测指标与验证

- 记录 channel label/id、readyState、消息大小/速率、bufferedAmount、低水位事件和关闭原因。
- 关联 SCTP association 状态、重传、拥塞窗口、消息延迟、丢弃数、ICE selected pair 和 DTLS 状态。
- 用丢包、带宽限制、乱序、大消息、通道关闭和 PeerConnection restart 验证可靠性与背压。
- 文件传输测试必须校验块序、文件校验和、取消清理以及媒体 QoE 不下降。

## 示例场景

屏幕协作应用用可靠有序通道发送控制命令，用无序且短生命周期的通道发送鼠标位置。鼠标位置过期后无需重传；控制命令则等待 open、受 bufferedAmount 限制，并带序号防止旧状态覆盖新状态。

## 图谱关系

- 会话依赖：[[WebRTC 会话生命周期]]先完成 PeerConnection 和传输路径的建立。
- 网络路径：[[ICE 连通性检查与选路]]为 SCTP 提供可达的底层通道。
- 安全承载：[[DTLS]]保护 SCTP 关联的机密性、完整性和身份。
- 应用控制：[[信令服务器]]可交换通道创建所需的会话业务信息，但不转发通道数据。

## 参考资料

- 《Learning WebRTC》第 6 章“使用 WebRTC 发送数据”：`90-参考资料/音视频与 WebRTC 书库/learning-webrtc/translation/06-sending-data-with-webrtc.md`
- 《Learning WebRTC》第 7 章“文件共享”：`90-参考资料/音视频与 WebRTC 书库/learning-webrtc/translation/07-file-sharing.md`
- 《WebRTC 权威指南》第 7 章“数据通道”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/07-data-channels.md`
- 《WebRTC 权威指南》第 10 章“协议”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/10-protocols.md`
