---
aliases: [Stats Fault Mapping, 指标故障映射]
tags: [rtc/concept, rtc/troubleshooting, rtc/observability]
type: concept
status: growing
---

# Stats 指标与故障映射

> [!tip] 阅读提示
> **前置：** [[测试与排障地图]]、[[WebRTC Stats]]；入口见 [[RTC 故障树]]。
> **初读：** 读到「初读到此为止」就停。弄清：累计 Stats → 区间时间序列 → 映射到采集/编码/发送/路径/接收/解码/呈现；指标只缩小范围。
> **深入：** 现象组合判断、仪表盘与验证边界，做监控或线上归因时再读。

## 一句话说明

把累计 Stats 转成可解释的时间序列，再将接通失败、无声、黑屏、卡顿和高延迟映射到候选路径、发送、接收、解码或渲染阶段。指标异常用于**缩小范围**；根因仍需状态、日志、报文或设备证据确认。

## 先记住这三句

1. 先把累计计数变成 **Δ/Δt** 时间序列，再谈故障阶段——累计丢包 ≠ 最近窗口丢包率。
2. 「bytes 涨但 framesDecoded 不涨」与「packets 不涨」是**不同阶段**，别混成一种黑屏。
3. 指标异常用于缩小范围；根因仍要状态/日志/报文/设备证据确认。

## 问题边界

- **上游：** 周期性 `getStats` / 导出序列、对象 ID 与引用、采样时钟。
- **下游：** 区间速率/比率、阶段假设、告警与仪表盘上的可操作结论。
- **易混淆：**
  - 累计 `packetsLost` ≠ “最近 5 秒丢包率”。  
  - 发送端口径 ≠ 接收端口径。  
  - 单点 RTT 升高 ≠ 一定拥塞（可能路径切换或噪声）。  
  - framesDecoded 涨 ≠ 用户一定看见（还可能卡在渲染/布局）。

## 核心机制

1. 沿对象 ID 关联 candidate-pair、transport、RTP、codec、media-source。  
2. 对累计计数求**区间增量**，再除以真实采样间隔。  
3. “bytes 涨但 framesDecoded 不涨”与“packets 不涨”属于不同阶段。  
4. 用组合指标提出假设，再用日志/抓包证伪。

## 建立可计算时间序列

1. 保存每次报告的原始时间戳、对象 ID、类型及引用。  
2. 按 PeerConnection + 对象 ID 配对相邻样本。  
3. 累计计数求差 ÷ 真实 Δt。  
4. 对象更换、计数重置、缺字段、负增量 → 标记断点，不输出假值。  
5. 与应用事件、切网、前后台写入同一时间轴。

```text
bitrate_bps = 8 * Δbytes / Δseconds
packet_loss_ratio = Δlost / (Δreceived + Δlost)
fps = Δframes / Δseconds
mean_encode_time = ΔtotalEncodeTime / ΔframesEncoded
mean_decode_time = ΔtotalDecodeTime / ΔframesDecoded
```

分母为零、重置或代次变化时不输出。

## 故障阶段映射

| 阶段 | 关键变化 | 可提出的假设 |
| --- | --- | --- |
| 采集 | audioLevel、frames/samples captured | 设备、权限或 source 未产数 |
| 编码 | framesEncoded、bytesSent、encode time | 未启动、过载或被码率限制 |
| 发送 | outbound packets/bytes、retransmission | 未发送、队列或传输受限 |
| 路径 | pair bytes、RTT、available bitrate | 选路、排队或容量异常 |
| 接收 | inbound packets/bytes、lost、jitter | 未到包、丢包、乱序或抖动 |
| 解码 | framesDecoded、keyFramesDecoded、decode time | 参数、参考帧或解码资源 |
| 呈现 | framesDropped、jitter buffer、应用渲染 | 截止、同步或 UI/设备 |


---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面是工程展开与排障细节，**第二轮或遇到具体问题时再读**；第一次直接点文末「第一次阅读下一站」即可。

## 常见现象的组合判断

### 有声音、无画面

- `video packetsReceived` 不涨 → 远端发送 / SFU 订阅 / 路径。  
- packets 涨、`framesDecoded` 不涨 → PT、关键帧、参数集、参考帧。  
- decoded 涨但不可见 → 渲染、页面状态、尺寸/纹理、布局。

### 声音断续

- 丢包 + concealedSamples 同涨 → 网络损伤已进音频恢复。  
- 丢包平稳但 jitterBufferDelay / late discard 涨 → 抖动或缓冲目标。  
- 网络正常、设备 underrun 涨 → 音频线程/设备/系统负载。

### 延迟持续增长

- 发送队列 / pacing 延迟涨 → 目标超容量或突发注入。  
- RTT 与队列同涨 → 瓶颈队列可能膨胀。  
- jitter buffer 持续涨而 RTT 稳 → 接收调度、时钟漂移或恢复策略。

## 工程要点

- 每项派生指标写清：公式、单位、方向、采样周期、重置规则。  
- 不混用收发口径；不用累计丢包当窗口丢包率。  
- 建立基线与版本字段，避免浏览器升级后误判字段变化。  
- 告警窗口 ≥ 数个采样间隔，避免单点噪声。

## 仪表盘设计

- 按方向 × 媒体类型拆分，勿把音视频汇总成一个码率。  
- 展示趋势、分位数与状态事件。  
- 保留 selected pair、候选类型、编码层、质量受限原因等上下文。  
- 服务端转发指标与端点 Stats 用稳定订阅 ID 关联；存储遵守隐私策略。

## 验证边界

Stats 是端点观测面：可能延迟更新或缺少可选字段。结论注明浏览器/SDK 版本与字段来源。协议争议用[[抓包分析]]；路由决策用服务端日志；设备问题用平台音视频诊断。

## 观测与验证

- **最小证据：** 原始 Stats 序列（或导出）+ 派生公式说明 + 同窗状态事件。  
- **自检：** 是否对象代次错位；Δt 是否异常大；是否把对端指标当本端。  
- **回归：** 修复后同一脚本重算窗口指标与体验是否同向改善。


## 派生指标清单（建议产品化）

| 名称 | 公式要点 | 用途 |
| --- | --- | --- |
| send_bitrate | 8·ΔbytesSent/Δt | 上行是否真在发 |
| recv_bitrate | 8·ΔbytesReceived/Δt | 下行是否真在收 |
| loss_ratio_win | Δlost/(Δrecv+Δlost) | 窗口丢包，非累计 |
| encode_ms | ΔtotalEncodeTime/ΔframesEncoded | 编码是否过载 |
| decode_ms | ΔtotalDecodeTime/ΔframesDecoded | 解码是否过载 |
| jb_delay | jitterBufferDelay 或其增量形态 | 接收缓冲是否膨胀 |

每个指标附：方向、媒体类型、对象代次、采样周期、缺测策略。

## 生命周期（监控侧）

```text
sample getStats
  -> join by object id
  -> delta / gate resets
  -> stage classifier
  -> alert or ticket hint
  -> attach raw window on page
```

## 阅读导航

- **上一篇：** [[WebRTC 会话生命周期]]
- **下一篇：** [[视频预处理与硬件渲染管线]]
- **第一次阅读下一站：** [[webrtc-internals]]
- **所属专题：** [[00-知识地图/专题说明/14 RTC 终端设备与生命周期|14 RTC 终端设备与生命周期]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[测试与排障地图]]
- 数据源：[[WebRTC Stats]]、[[webrtc-internals]]
- 诊断入口：[[RTC 故障树]]
- 体验映射：[[QoS 与 QoE]]
- 互证：[[抓包分析]]、[[WebRTC 状态机诊断]]

## 参考资料

- W3C WebRTC Statistics API
- 《WebRTC 实战指南》第 4 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/04-debugging-a-webrtc-application.md`
