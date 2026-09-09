---
aliases: [getStats, WebRTC 统计]
tags: [rtc/concept, rtc/client, rtc/observability]
type: concept
status: growing
---

# WebRTC Stats

## 一句话说明

WebRTC Stats 通过 `RTCPeerConnection.getStats()` 暴露候选路径、传输、RTP、编解码和证书等对象的累计状态，是把用户现象关联到协议层的端点证据。

## 核心机制

- 报告对象通过 ID 引用组成关系，例如 selected candidate pair → transport → inbound/outbound RTP → codec。
- 码率、丢包率和帧率通常要用两次累计值的差除以时间差计算，单次快照不能表达趋势。
- 字段、单位和可用性随浏览器版本演进，采集端必须记录版本并容忍缺失对象。

## 报告对象图

一次 `getStats()` 返回的是互相引用的对象集合，而非一张扁平表：

- `transport` 指向当前使用的 candidate pair 和证书等对象。
- `candidate-pair` 描述本地/远端候选、往返时间与收发字节。
- `outbound-rtp`、`inbound-rtp` 描述一条发送或接收 RTP 流。
- `remote-inbound-rtp`、`remote-outbound-rtp` 是通过 RTCP 获得的远端视角，采样时间和可用字段有限。
- `codec`、`media-source`、`track` 等对象补充编码与媒体源信息；具体对象已随规范演进。

采集程序应保存原始 `id`、`type`、时间戳和引用字段，并在派生指标层建立关系。只按字段名抓取而丢弃对象关系，很容易把两条同名 RTP 流混在一起。

## 常用区间计算

累计计数必须用相邻两次样本求差。设采样间隔为 `Δt` 秒：

```text
发送码率 = 8 × ΔbytesSent / Δt
接收码率 = 8 × ΔbytesReceived / Δt
窗口丢包率 = max(0, ΔpacketsLost) / (ΔpacketsReceived + max(0, ΔpacketsLost))
实际帧率 = ΔframesEncoded(or Decoded) / Δt
平均单帧编码耗时 = ΔtotalEncodeTime / ΔframesEncoded
```

计数器重置、对象 ID 更换或时间戳倒退时，应开始新序列，不能跨代次求差。`packetsLost` 的具体语义和是否可能调整要按当前规范处理。

## 从路径到画面逐层判断

1. candidate pair 是否 selected/succeeded，收发字节和 RTT 是否变化。
2. transport 和 RTP 对象是否绑定到预期 candidate pair。
3. outbound 的 packets/bytes 是否增长，编码帧是否增长。
4. inbound 的 packets/bytes 是否增长，丢包、抖动和 jitter buffer 是否异常。
5. framesDecoded、keyFramesDecoded 是否增长，是否存在解码丢弃。
6. framesRendered/framesDropped 或应用渲染指标是否增长。

这个顺序能把“黑屏”拆成未发送、未到达、未解码和未呈现等不同阶段。

## 工程要点

- 使用单调采样间隔，保存原始累计值和派生指标，避免重复聚合。
- 分清远端报告、本端测量、网络计数和解码/渲染计数的责任边界。
- 诊断结论需要和应用状态、日志或抓包交叉验证。

## 采集设计

- 浏览器前台诊断常用 1 秒左右采样；生产采集需权衡开销、隐私和短故障捕获能力。
- 同时记录墙上时间用于跨系统对齐、单调时间用于本进程区间计算。
- 保存浏览器/SDK 版本、网络类型、会话与参与者角色，但敏感地址和 SDP 需按策略脱敏。
- 派生指标应带有效性标记，字段缺失不等于数值为零。
- 长会话可保留低频原始样本与故障窗口高频样本，避免只存聚合后无法复盘。

## 常见误读

- `currentRoundTripTime` 是所选候选对路径的估计，不等于完整端到端媒体延迟。
- `jitter` 是 RTP 到达抖动语义，不是浏览器 UI 卡顿，也不等于 jitter buffer 当前时长。
- `qualityLimitationReason=bandwidth` 说明编码受带宽约束，不直接证明网络发生丢包。
- 收到字节仍可能没有可解码帧；已解码仍可能因渲染、页面状态或设备问题不可见。
- 单端 Stats 只表达该端观察到的事实，SFU 的选层和丢弃原因仍需服务端证据。

## 示例

如果 `packetsReceived` 正常增长、`framesDecoded` 停止且 PLI 增加，应检查负载类型/参数集、参考帧损坏与关键帧是否到达；如果连 `packetsReceived` 都不增长，则优先检查上游发送、SFU 路由和所选网络路径。两个现象都叫“黑屏”，排查入口完全不同。

## 图谱关系

- 主题：[[客户端工程地图]]
- 解释层：[[Stats 指标与故障映射]]
- 路径：[[ICE 候选与候选对]]
- 媒体：[[RTP]]
- 体验：[[QoS 与 QoE]]

## 参考资料

- W3C WebRTC Statistics API。
- 《WebRTC 实战指南》第 4 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/04-debugging-a-webrtc-application.md`
