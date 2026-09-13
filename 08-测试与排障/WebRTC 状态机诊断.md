---
aliases: [PeerConnection State Diagnosis, 状态机排障]
tags: [rtc/concept, rtc/troubleshooting, rtc/webrtc]
type: concept
status: growing
---

# WebRTC 状态机诊断

> [!tip] 阅读提示
> **前置：** [[测试与排障地图]]、[[WebRTC 会话生命周期]]；ICE 轴见 [[ICE 状态机]]、[[信令与 PeerConnection 状态机]]。
> **初读：** 先读「一句话说明」「问题边界」「独立状态轴」和「卡点判断」。
> **深入：** 重协商与冲突、超时设计与日志格式，在联调卡死或误杀连接时再读。

## 一句话说明

把业务会话、信令、ICE、DTLS 和媒体收发看成相互关联但**独立**的状态轴，用转移和时间线定位“卡在哪一层”。某一层成功只说明该层条件成立——例如 ICE connected 不证明编解码匹配或远端正在发送。

## 问题边界

- **上游：** 各轴状态回调、协商/ICE 代次、单调时间与会话 ID。
- **下游：** 卡点阶段结论、分层超时错误码、可对齐的诊断时间线。
- **易混淆：**
  - `signalingState=stable` ≠ 已连通。  
  - `connectionState=connected` ≠ 某条视频轨有数据。  
  - ICE restart ≠ 必须新建 PeerConnection。  
  - `disconnected` 短暂抖动 ≠ 立刻销毁。

## 核心机制

1. 记录 signaling、ICE gathering/connection、PeerConnection、SCTP 等状态及时间。  
2. 将 Offer/Answer、候选、选中 pair、DTLS、首包/首帧对齐到同一会话时间线。  
3. 每层成功只证明该层；媒体阶段另看 RTP/解码/呈现证据。  
4. 重协商与旧回调用**代次**隔离，防止污染。

## 独立状态轴

| 状态轴 | 关注点 | 成功意味着什么 |
| --- | --- | --- |
| 业务会话 | 房间、权限、参与者 | 业务允许继续建联 |
| signalingState | Offer/Answer 与描述设置 | 本轮信令转换合法 |
| iceGatheringState | 本地候选收集 | 收集阶段进度 |
| iceConnectionState | ICE 检查与可达性 | 至少有路径检查结果 |
| connectionState | ICE/DTLS 等聚合 | PC 传输整体状态 |
| DTLS/SRTP | 握手与密钥 | 路径上可保护媒体 |
| transceiver/track | 方向、关联、轨道生命期 | 媒体意图与对象状态 |
| RTP/媒体 | 发收、解码、呈现 | 实际媒体阶段进度 |
| SCTP/DataChannel | association 与 channel | 数据通道状态 |

## 标准时间线

1. 创建 PeerConnection 与 Transceiver/Track  
2. 创建并设置本地 Offer  
3. 远端设置 Offer、返回 Answer  
4. 双方设置远端描述；交换/逐步添加 candidates（Trickle 允许 SDP 后继续到）  
5. 候选对检查成功并被选中  
6. DTLS 完成，SRTP 可用  
7. 首个 outbound/inbound RTP  
8. 首个解码块/帧与首次实际呈现  

每个里程碑记录事务/代次。不要假设固定的单线同步流程。

```text
create PC/tracks
  -> local offer set
  -> remote answer set
  -> candidates / checks
  -> DTLS
  -> first RTP
  -> first decoded / presented
```

## 重协商与冲突

- Track 增删、方向变化等触发 negotiation needed；多次变化可合并。  
- 双方同时 Offer → glare，按约定协商模式处理。  
- 旧异步回调可能在新一轮后到达 → 查会话与事务代次。  
- ICE restart 更新凭据并启动新检查，≠ 必须新 PC。  
- 短暂 `disconnected` 后可恢复；超时策略应**分层**，避免瞬时故障被放大成销毁。

## 卡点判断

| 观察到 | 优先查 |
| --- | --- |
| 有本地 Offer，无远端 Answer | 信令传递、远端处理、事务关联 |
| 描述均 stable，无 candidate | ICE 配置、收集策略、权限 |
| 有 candidate，无检查成功 | 未交换、阻断、凭据/代次、角色 |
| ICE connected，DTLS 未完成 | 指纹、DTLS role、报文路径、实现 |
| DTLS 完成，无 outbound RTP | 轨道方向、sender、编码器、业务静音 |
| inbound RTP 涨，无 frame | 负载映射、参数集、参考帧、解码器 |

## 工程要点

- 每次状态变化记：旧值、新值、触发、会话 ID、单调时间。  
- 分层超时，不用一个“连接失败”盖所有根因。  
- 重连/重协商区分新事务，避免旧候选/旧回调污染。  
- 修复后验证：正常建联、重协商、ICE restart、切网、远端离开、本地关闭；查重复回调、旧状态复活、泄漏。

## 日志格式

```text
wall_time, monotonic_time, session_id, peer_connection_id,
negotiation_generation, ice_generation, state_axis,
old_state, new_state, trigger, error_code
```

SDP/候选含敏感信息：生产日志存摘要与关键差异；完整内容只在受控诊断包按策略采集。

## 超时设计

分别为：信令响应、候选收集、首次候选对、DTLS、首包、首帧设观测阈值，错误里报告**具体阶段**。一个笼统的“30 秒连接超时”会丢掉最有价值的信息。

## 观测与验证

- **最小时间线：** 上表八个里程碑是否出现、卡在哪两个之间。  
- **互证：** 状态说 connected 时，Stats/抓包是否有对应 RTP。  
- **注入：** glare、快速进退房、切网 restart、故意延迟 Answer。


## 与业务错误码的映射建议

不要只抛 `CONNECT_FAILED`。至少区分：

| 阶段超时 | 建议错误码语义 |
| --- | --- |
| 等 Answer | SIGNALING_TIMEOUT |
| 无候选 / 收集超时 | ICE_GATHER_TIMEOUT |
| 检查无成功 | ICE_CHECK_FAILED |
| DTLS 未完成 | DTLS_HANDSHAKE_TIMEOUT |
| 无首包 | MEDIA_FIRST_PACKET_TIMEOUT |
| 有包无首帧 | MEDIA_FIRST_FRAME_TIMEOUT |

上层 UI 文案可以粗，但日志与工单必须细。

## 生命周期（诊断视角）

```text
axes instruments on
  -> milestones stamped with generations
  -> stall detector per axis
  -> hypothesis at gap between milestones
  -> prove with stats/pcap
  -> close or escalate
```

## 阅读导航

- **上一篇：** [[RTC 故障树]]
- **下一篇：** [[ICE 与 TURN 诊断]]
- **所属专题：** [[00-知识地图/专题说明/16 测试、测量、排障与性能|16 测试、测量、排障与性能]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[测试与排障地图]]
- 主线：[[WebRTC 会话生命周期]]
- 机制笔记：[[ICE 状态机]]、[[信令与 PeerConnection 状态机]]
- 网络阶段：[[ICE 连通性检查与选路]]、[[ICE 与 TURN 诊断]]
- 安全阶段：[[DTLS]]
- 证据：[[WebRTC Stats]]、[[webrtc-internals]]

## 参考资料

- 《WebRTC 实时通信》第 5、6 章，`90-参考资料/音视频与 WebRTC 书库/real-time-communication-with-webrtc/translation/`
- W3C WebRTC API，PeerConnection 状态定义
