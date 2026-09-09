---
tags: [rtc/concept, rtc/troubleshooting, rtc/webrtc]
type: concept
status: growing
---

# WebRTC 状态机诊断

## 一句话说明

WebRTC 状态机诊断把业务会话、信令、ICE、DTLS 和媒体收发看作相互关联但独立的状态轴，用状态转移和时间线定位“卡在哪一层”。

## 核心机制

- 记录 signaling、ICE gathering、ICE connection、PeerConnection 和 SCTP 等状态及其时间。
- 将 offer/answer、候选收集、候选对选中、安全握手和首个媒体包对齐到同一会话时间线。
- 某层成功只说明该层条件成立，例如 ICE connected 不证明编解码器匹配或远端正在发送。

## 独立状态轴

| 状态轴 | 关注点 | 成功意味着什么 |
| --- | --- | --- |
| 业务会话 | 房间、权限、参与者 | 业务允许继续建联 |
| signalingState | Offer/Answer 与描述设置 | 本轮信令转换合法 |
| iceGatheringState | 本地候选收集 | 候选收集阶段进度 |
| iceConnectionState | ICE 检查与可达性 | 至少有路径检查结果 |
| connectionState | ICE/DTLS 等聚合连接 | PeerConnection 传输整体状态 |
| DTLS/SRTP | 握手与密钥 | 路径上可保护媒体 |
| transceiver/track | 方向、关联和轨道生命期 | 媒体意图与对象状态 |
| RTP/媒体 | 发包、收包、解码、呈现 | 实际媒体阶段进度 |
| SCTP/DataChannel | association 与 channel | 数据消息通道状态 |

这些轴之间有关联，却不能用一个轴替代另一个轴。`signalingState=stable` 可能对应尚未连通，也可能对应正在正常通话；`connectionState=connected` 也不保证某条视频轨道有数据。

## 标准时间线

一次正常流程可按以下里程碑记录：

1. 创建 PeerConnection 和 Transceiver/Track。
2. 创建并设置本地 Offer。
3. 远端设置 Offer、创建并返回 Answer。
4. 双方设置远端描述，交换或逐步添加 ICE candidates。
5. 候选对检查成功并被选中。
6. DTLS 握手完成，SRTP 上下文可用。
7. 首个 outbound/inbound RTP 包。
8. 首个解码音频块/视频帧与首次实际呈现。

时间线需要记录每个里程碑的事务/代次。Trickle ICE 允许候选在 SDP 之后继续到达，因此不能用固定的单线同步流程假设实现。

## 重协商与冲突

- Track 增删、方向变化和某些参数变化会触发 negotiation needed，但多次变化可合并。
- 双方同时发起 Offer 会产生 glare，需要由应用遵守的协商模式处理。
- 旧异步回调可能在新一轮协商后到达，必须检查会话和事务代次。
- ICE restart 更新 ICE 凭据并启动新检查，不等于必须创建新的 PeerConnection。
- 网络短暂抖动可经历 disconnected 后恢复，立即销毁会放大瞬时故障；超时策略应分层。

## 工程要点

- 每次状态变化记录旧值、新值、触发事件、会话 ID 和单调时间。
- 对长时间停留设置分层超时，不使用一个“连接失败”覆盖所有根因。
- 重连和重新协商要区分新一轮事务，避免旧候选或旧回调污染当前状态。

## 日志格式

建议每条状态事件包含：

```text
wall_time, monotonic_time, session_id, peer_connection_id,
negotiation_generation, ice_generation, state_axis,
old_state, new_state, trigger, error_code
```

SDP 和候选可能包含敏感地址与能力信息，生产日志应保存摘要、方向和关键差异，完整内容只在受控诊断包中按策略采集。

## 卡点判断

- 有本地 Offer，无远端 Answer：信令传递、远端处理或事务关联。
- 描述均 stable，无 candidate：ICE 配置、收集策略或权限。
- 有 candidate，无检查成功：候选未交换、网络阻断、凭据/代次或角色。
- ICE connected，DTLS 未完成：指纹、DTLS role、报文路径或实现错误。
- DTLS 完成，无 outbound RTP：轨道方向、sender、编码器或业务静音。
- inbound RTP 增长，无 frame：负载映射、参数集、参考帧或解码器。

## 超时设计

为信令响应、候选收集、首次候选对、DTLS、首包和首帧分别设置观测阈值，并在错误中报告具体阶段。一个覆盖全流程的“30 秒连接超时”只会丢失最有价值的信息。

修复后要验证正常建联、重新协商、ICE restart、网络切换、远端离开和本地关闭，尤其检查是否出现重复回调、旧状态复活或对象泄漏。

## 图谱关系

- 主题：[[测试与排障地图]]
- 主线：[[WebRTC 会话生命周期]]
- 网络阶段：[[ICE 连通性检查与选路]]
- 安全阶段：[[DTLS]]
- 证据：[[WebRTC Stats]]

## 参考资料

- 《WebRTC 实时通信》第 5、6 章，`90-参考资料/音视频与 WebRTC 书库/real-time-communication-with-webrtc/translation/`
- W3C WebRTC API，PeerConnection 状态定义。
