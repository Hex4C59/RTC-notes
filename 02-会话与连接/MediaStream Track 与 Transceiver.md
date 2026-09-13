---
aliases: [MediaStreamTrack, RTCRtpTransceiver]
tags: [rtc/concept, rtc/media, rtc/signaling]
type: concept
status: growing
---

# MediaStream Track 与 Transceiver

> [!tip] 阅读提示
> **前置：** 无强前置；可先从本篇一句话说明读起。
> **初读：** 先读「一句话说明」和「核心机制」，弄清 MediaStream Track 与 Transceiver 解决什么问题、不负责什么。
> **深入：** 「工程要点」、「工作流程或状态流」、「工程实现与取舍」 在实现、联调或排障时再读。

## 一句话说明

`MediaStream` 是用于分组媒体轨道的容器；`MediaStreamTrack` 表示一个音频或视频源的逻辑输出；`RTCRtpSender` 和 `RTCRtpReceiver` 分别连接发送、接收媒体；`RTCRtpTransceiver` 则把同一个 `m=` 媒体段的发送器和接收器及其方向绑定起来。它们不是同一层的“流”对象。

## 核心机制

- `addTrack(track, stream)` 将轨道交给 PeerConnection，并把轨道与一个或多个 `MediaStream` 的 `msid` 关系带入协商；`ontrack` 在远端轨道可用时通知接收端。
- `addTransceiver(kind)` 或 `addTransceiver(track)` 显式创建一个收发单元。`direction` 可为 `sendrecv`、`sendonly`、`recvonly` 或 `inactive`，它对应 SDP 媒体段的意图。
- `sender.replaceTrack()` 可在同一发送单元内更换相同媒体类型的源，常用于换摄像头或屏幕源；若改变方向、编码能力或需要新增/移除媒体段，仍要重新协商。
- `track.enabled` 适合暂时静音/停画；`track.stop()` 结束底层源。停止本地轨道、移除发送器和关闭 Transceiver 是不同的生命周期操作。

```mermaid
flowchart LR
    SRC["摄像头、麦克风或屏幕源"] --> T["MediaStreamTrack<br/>一条逻辑媒体轨道"]
    T -. "分组关系 msid" .-> MS["MediaStream<br/>轨道容器"]
    T --> S["RTCRtpSender"]
    S --> X["RTCRtpTransceiver<br/>mid + direction"]
    X --> R["RTCRtpReceiver"]
    R --> RT["远端 MediaStreamTrack"]
    X -. "对应" .-> M["SDP m= 媒体段"]
```

这是一张对象关系图，不代表媒体字节必须依次复制经过所有 JavaScript 对象。`MediaStream` 主要提供轨道分组，真正的发送关系由 sender、transceiver、协商结果和底层 transport 共同决定。

## 工程要点

- 业务层同时保存 `track.id`、sender、receiver、transceiver 和 `mid`，不要仅凭 `MediaStream.id` 判断传输关系。
- 用 `replaceTrack` 做设备切换时检查 `readyState`、编码器兼容性和权限；换成不同媒体类型不能绕过协商约束。
- `transceiver.direction`、新增轨道和停用媒体段会触发协商需求。应用必须处理 `negotiationneeded` 与同时 Offer 冲突。
- 远端 `ontrack` 的到达不等于首帧已渲染，播放、解码和渲染状态应由客户端另行观测。

## 阅读导航

- **上一篇：** [[SDP]]
- **下一篇：** [[WebRTC 会话生命周期]]
- **所属专题：** [[00-知识地图/专题说明/02 信令与 SDP 协商|02 信令与 SDP 协商]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

## 解决的问题

把本地媒体源、轨道、RTP 发送/接收器和 SDP 媒体段区分开，使加轨、换设备、静音、方向变更和停止操作可预测。

## 工作流程或状态流

1. 设备或其他源产生 MediaStreamTrack，应用决定是否启用、分组和发送。
2. addTrack 或 addTransceiver 建立 sender/transceiver，并产生需要协商的媒体意图。
3. Offer/Answer 为 transceiver 分配或确认 mid、方向和编解码能力；sender 根据协商参数发送。
4. 对端创建 receiver 并触发 ontrack，轨道进入远端应用的播放或处理链。
5. replaceTrack、set direction、remove/stop 或关闭连接时更新对应状态；不再使用的源和接收器要释放。

## 关键对象、字段与报文

- MediaStreamTrack 的 id、kind、enabled、muted、readyState 和 source 状态描述轨道本身。
- MediaStream 的 id 和 msid 关系用于把多个轨道分组，不等于 RTP 连接或网络会话。
- RTCRtpSender 的 track、parameters、encodings 和 transport 影响发送；Receiver 的 track、jitter/codec 状态影响接收。
- Transceiver 的 mid、direction、currentDirection、sender、receiver 和 stopped 对应一个协商媒体段。

## 原理细节

Track 是媒体源的逻辑输出，Sender/Receiver 是 RTP 方向的端点，Transceiver 是协商上的收发单元。enabled 更像发送/播放内容开关，stop 会结束源；direction 改变则表达协商意图，通常需要重新协商。replaceTrack 适合同类型源替换，但编码能力、分辨率或安全策略变化可能仍触发协商或失败。

## 工程实现与取舍

- 业务模型同时保存 track、sender、receiver、transceiver、mid 和业务订阅 ID，避免只用 stream ID 查找。
- 摄像头切换优先评估 replaceTrack，以减少协商和画面中断；屏幕共享、媒体类型变化和方向变化要走明确协商流程。
- 远端 track 到达后，播放设备、解码器和渲染线程要有独立生命周期；停止发送不应误杀其他共享同一源的轨道。
- 对多路轨道采用稳定的 transceiver/mid 映射，避免反复加减 m-line 导致 SDP 漂移和远端状态混乱。

## 常见误区与失败表现

- 把 MediaStream 当成网络流：它只是轨道分组容器，网络状态要看 PeerConnection/transport。
- 调用 track.stop 就期待对端收到“停止消息”：远端需要通过协商、轨道事件或业务信令感知变化。
- replaceTrack 后分辨率或编码器能力不兼容：可能静默降级、发送失败或需要重新协商。
- 看到 ontrack 就认为用户已看到画面：解码、自动播放策略和渲染仍可能阻塞。

## 可观测指标与验证

- 记录每条轨道的 id/kind/readyState/enabled、sender/receiver/transceiver 的 mid 和 direction。
- 关联 negotiationneeded、Offer/Answer 版本、ontrack 时间、首个解码帧、首帧渲染和 replaceTrack 结果。
- 观察发送/接收 SSRC、编码层、帧率、分辨率、解码失败和渲染状态，区分轨道停用与传输失败。
- 测试加轨、静音、换摄像头、屏幕共享、移除、网络重连和关闭，验证重复操作的幂等性。

## 示例场景

视频会议中用户从摄像头切换到屏幕共享。应用保留原视频 transceiver，调用 replaceTrack 仅适用于同类源且编码约束兼容；若方向或能力变化触发协商，则通过新的 Offer/Answer 更新媒体段，并在远端收到 ontrack/首帧后确认切换完成。

- 会话承载：[[WebRTC 会话生命周期]]管理轨道和收发单元的创建、更新与销毁。
- 协商表达：[[Offer Answer]]把方向、媒体能力和 `mid` 写入双方描述。
- 描述字段：[[SDP]]承载 `m=`、方向、编解码和 `msid` 等协商结果。
- 本地设备：[[采集与渲染]]提供轨道源并负责播放端输出。
- 时间关系：[[音视频同步]]处理不同轨道到达和播放时的时钟对齐。

## 参考资料

- 《WebRTC 权威指南》第 5 章“对等媒体”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/05-peer-media.md`
- 《WebRTC 权威指南》第 6 章“对等连接与 Offer/Answer”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/06-peer-connection-offer-answer.md`
- 《WebRTC 权威指南》第 3 章“本地媒体”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/03-local-media.md`
- 《Learning WebRTC》第 3 章“创建基本的 WebRTC 应用”：`90-参考资料/音视频与 WebRTC 书库/learning-webrtc/translation/03-creating-a-basic-webrtc-application.md`
