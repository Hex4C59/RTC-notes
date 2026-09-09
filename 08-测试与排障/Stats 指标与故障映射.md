---
tags: [rtc/concept, rtc/troubleshooting, rtc/observability]
type: concept
status: growing
---

# Stats 指标与故障映射

## 一句话说明

Stats 指标与故障映射把累计统计转换成可解释的时间序列，再将接通失败、无声、黑屏、卡顿和高延迟映射到候选路径、发送、接收、解码或渲染阶段。

## 核心机制

- 先沿对象 ID 建立 candidate pair、transport、RTP、codec 和 media-source 的关联，再计算区间增量。
- “bytesReceived 增长但 framesDecoded 不增长”与“packetsReceived 不增长”属于不同故障阶段。
- 指标异常用于缩小范围，最终根因仍需状态、日志、报文或设备证据确认。

## 建立可计算时间序列

1. 保存每次报告的原始时间戳、对象 ID、类型及引用关系。
2. 按 PeerConnection 和对象 ID 将相邻样本配对。
3. 对累计计数求差，并除以真实采样间隔。
4. 对对象更换、计数重置、字段缺失和负增量标记断点。
5. 将派生指标与应用事件、网络切换和可见布局写入同一时间轴。

常用计算示例：

```text
bitrate_bps = 8 * Δbytes / Δseconds
packet_loss_ratio = Δlost / (Δreceived + Δlost)
fps = Δframes / Δseconds
mean_encode_time = ΔtotalEncodeTime / ΔframesEncoded
mean_decode_time = ΔtotalDecodeTime / ΔframesDecoded
```

分母为零、计数器重置或对象代次改变时不输出数值。不能用累计 `packetsLost / packetsSent` 表示“最近 5 秒丢包率”。

## 故障阶段映射

| 阶段 | 关键变化 | 可提出的假设 |
| --- | --- | --- |
| 采集 | audioLevel、frames/samples captured | 设备、权限或 source 未产生数据 |
| 编码 | framesEncoded、bytesSent、encode time | 编码未启动、过载或被码率限制 |
| 发送 | outbound packets/bytes、retransmission | RTP 未发送、队列或传输受限 |
| 路径 | candidate pair bytes、RTT、available bitrate | 选路、排队或网络容量异常 |
| 接收 | inbound packets/bytes、lost、jitter | 未到包、丢包、乱序或抖动 |
| 解码 | framesDecoded、keyFramesDecoded、decode time | 参数、参考帧或解码资源异常 |
| 呈现 | framesDropped、jitter buffer、应用渲染 | 播放截止、同步或 UI/设备问题 |

同一指标不能独立证明根因。例如 RTT 上升和发送队列增长共同支持拥塞排队假设；只有 RTT 单点升高，可能只是路径变化或采样噪声。

## 工程要点

- 为每项派生指标写清公式、单位、方向、采样周期和计数器重置规则。
- 不混用发送端与接收端口径，也不把累计丢包直接当作当前窗口丢包率。
- 建立基线和版本字段，避免浏览器升级后误判字段变化。

## 常见现象的组合判断

### 有声音、无画面

- `video packetsReceived` 不增长：检查远端发送、SFU 订阅和路径。
- packets 增长但 `framesDecoded` 不增长：检查 Payload Type、关键帧、参数集和参考帧损坏。
- decoded 增长但用户不可见：检查渲染、页面状态、尺寸/纹理和应用布局。

### 声音断续

- 丢包和 concealed samples 同时增长：网络损伤已影响音频恢复。
- 丢包平稳但 jitter buffer delay、late discard 增长：到达抖动或缓冲目标不合适。
- 网络指标正常而设备 underrun 增长：转向音频线程、设备与系统负载。

### 延迟持续增长

- 发送队列/pacing 延迟增长：发送目标超过可用容量或应用突发注入。
- RTT 与队列同时增长：网络瓶颈队列可能正在膨胀。
- 接收 jitter buffer 持续增长而 RTT 稳定：接收调度、时钟漂移或恢复策略异常。

## 仪表盘设计

- 按方向和媒体类型拆分，避免把音频与视频汇总成一个码率。
- 展示趋势、分位数和状态事件，告警窗口要比采样间隔长。
- 保留当前 selected pair、候选类型、编码层和质量受限原因等上下文。
- 服务端转发指标应与端点 Stats 使用稳定订阅 ID 关联，但展示和存储时遵守隐私策略。

## 验证边界

Stats 是端点的观测接口，浏览器可能延迟更新或缺少实现可选字段。结论应注明浏览器/SDK 版本及字段来源；协议级争议使用抓包互证，服务端路由决策使用服务端日志互证，设备问题使用平台音视频诊断互证。

## 图谱关系

- 主题：[[测试与排障地图]]
- 数据源：[[WebRTC Stats]]
- 诊断入口：[[RTC 故障树]]
- 体验映射：[[QoS 与 QoE]]

## 参考资料

- W3C WebRTC Statistics API。
- 《WebRTC 实战指南》第 4 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/04-debugging-a-webrtc-application.md`
