---
aliases: [chrome webrtc-internals, WebRTC Internals]
tags: [rtc/concept, rtc/troubleshooting, rtc/observability]
type: concept
status: growing
---

# webrtc-internals

> [!tip] 阅读提示
> **前置：** [[测试与排障地图]]；指标语义见 [[WebRTC Stats]]、[[Stats 指标与故障映射]]。
> **初读：** 读到「初读到此为止」就停。弄清：Chrome 单端时间线工具——PC 创建前打开；看 API 顺序与 Stats 斜率，不是全路径权威。
> **深入：** 常见模式、局限与导出隐私，对照日志/抓包做结论时再读。

## 一句话说明

`webrtc-internals` 是 Chromium 系浏览器提供的 WebRTC 调试视图，可查看 PeerConnection API 调用、状态变化、事件和统计曲线，适合还原**单端**运行时间线；它看不到 SFU 内部决策，也不能替代抓包证明路径上每一跳。

## 先记住这三句

1. `webrtc-internals` 还原**单端** API 事件 + Stats 曲线；看不见 SFU 内部决策。
2. PeerConnection **创建前**打开调试页；累计图看**斜率**，不只读最后一个数。
3. 导出含 SDP/地址——分享前脱敏；严谨计算用导出序列，别把截图当接口契约。

## 问题边界

- **上游：** PeerConnection 创建前打开的调试页、浏览器完整版本、复现步骤与墙上时间标记。
- **下游：** 可导出的 API 事件、Stats 曲线、与应用/服务日志/抓包对齐的异常时窗结论。
- **易混淆：**
  - 页面曲线 ≠ 协议权威（可能降采样；严谨计算用导出序列 + 规范语义）。
  - candidate-pair 字节涨 ≠ 某路 inbound RTP 一定在涨（可能看错对象）。
  - 单端导出 ≠ 对端/服务端事实。

## 核心机制

1. API 事件记录 offer/answer、描述设置、候选与轨道操作，检查调用顺序。  
2. Stats 图表展示传输、RTP、编解码和媒体源随时间变化。  
3. 导出只代表**采集端**所见，不含服务端内部决策或全路径报文。  
4. 用同一时间窗与日志、抓包互证，单图不下根因。

## 采集流程

1. 复现前打开 `chrome://webrtc-internals`（其他 Chromium 系入口可能不同）。  
2. 记录浏览器完整版本、OS、实验开始时间、双方角色、预期 PC 数量。  
3. 执行尽量短且可重复的一次复现；不刷新/关闭调试页。  
4. 异常时记下墙上时间与用户动作（如“14:03:21 切 Wi-Fi”）。  
5. 导出调试数据，并同时保存应用日志、服务端日志及必要抓包。

调试页最好在 PeerConnection **创建前**打开。版本间页面、字段、导出格式会变，勿把某次截图步骤写成永久接口。

## 阅读顺序

### 1. 确认 PeerConnection

页面可能有多个连接。用创建时间、URL、进程和配置锁定目标，避免混入重试或其他标签页。

### 2. 看 API 与状态事件

沿时间检查 createOffer/Answer、setLocal/RemoteDescription、addIceCandidate、Track/Transceiver、关闭。异常：调用拒绝、顺序错、重复协商、状态长时间不推进。

### 3. 看连接路径

selected candidate pair、候选类型、协议、地址族、RTT、收发字节。路径切换时，与网络事件、ICE 状态、媒体指标对齐。

### 4. 看 RTP 与媒体链

分 audio/video、inbound/outbound：包/字节、帧率、关键帧、编解码耗时、丢包、抖动缓冲、质量受限原因。累计图看**斜率**，不只读最后一个数。

### 5. 缩到用户现象时窗

故障前后几十秒，对比多指标共变，再到日志或[[抓包分析]]验证。

## 结果记录模板

```text
问题方向：B -> A 视频
异常窗口：14:03:21–14:03:34
状态事实：ICE/DTLS 保持 connected
媒体事实：packetsReceived 增长，framesDecoded 停止，PLI 增加
初步范围：接收端视频可解码性/关键帧
互证材料：A 端导出、SFU 订阅日志、同窗抓包
```



---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面是工程展开与排障细节，**第二轮或遇到具体问题时再读**；第一次直接点文末「第一次阅读下一站」即可。

## 常见模式

| 模式 | 优先怀疑阶段 |
| --- | --- |
| outbound RTP bytes ≈ 0 | 发送轨道、方向、编码、业务静音 |
| pair bytes 涨、inbound RTP 不涨 | 远端/SFU 未发该流，或看错 RTP 对象 |
| packets 涨、framesDecoded 停 | 关键帧、参数集、PT、解码 |
| RTT + 发送队列 + bandwidth limitation 同升 | 排队/拥塞降码率 |
| concealedSamples + jitterBufferDelay 升 | 抖动/丢包已伤音频恢复 |

模式只用于**缩小阶段**，不能单凭一图宣布根因。

## 工程要点

- 复现前开页；记录版本、时间、PC 标识、远端角色。  
- 分享前脱敏：SDP、地址、设备名、业务 ID。  
- 同一时间范围与应用日志、服务端日志、抓包互证。  
- Native/非 Chromium 客户端用等价 Stats 导出 + 自建时间线，勿硬套本页字段名。

## 导出与隐私

导出可能含 SDP、ICE 候选、设备名、页面来源、业务 ID。对外脱敏；内部保留受控原件。公开脱敏文件 ≠ 完整取证副本。

## 局限

- 看不见 SFU 为何丢包或选某层。  
- 抓包点外的丢包无法仅靠单端图精确定位。  
- 内部字段可能是实现扩展，跨版本/浏览器不保证一致。  
- 显示可能降采样；严谨计算基于导出原始 Stats 序列。

## 观测与验证

- **最小证据包：** 浏览器版本 + 导出文件 + 异常时窗墙上时间 + 对齐的应用/SFU 日志片段。  
- **注入：** 切网、前后台、强制 mute、弱网、重协商。  
- **自检：** 是否抓到正确 PC；曲线斜率是否与现象同窗。

## 与 Stats / 抓包的分工

| 证据 | 擅长 | 短板 |
| --- | --- | --- |
| webrtc-internals | 单端 API 顺序与曲线直觉 | 看不到中间节点 |
| getStats 序列 | 可计算窗口指标、可进监控 | 缺调用级事件 |
| 抓包 | 路径上真实报文与时序 | SRTP 负载不可见；点位敏感 |

典型组合：internals 圈出时窗与对象 → Stats 算 Δ → 抓包确认是否出网/是否 NACK。

## 生命周期（一次取证）

```text
open internals before PC create
  -> reproduce once
  -> mark wall-clock actions
  -> export + parallel logs/pcap
  -> analyze window
  -> redact before share
```

不要在“已经坏了半小时”才打开页面，再指望补全早期 API 事件。

## 阅读导航

- **上一篇：** [[WebRTC Stats]]
- **下一篇：** [[00-知识地图/专题说明/05 音视频数据、采集与播放|05 音视频数据、采集与播放]]（本专题配套详解已读完，进入下一专题说明）
- **第一次阅读下一站：** [[抓包分析]]
- **所属专题：** [[00-知识地图/专题说明/04 WebRTC 应用接入与源码阅读|04 WebRTC 应用接入与源码阅读]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[测试与排障地图]]
- 指标语义：[[WebRTC Stats]]、[[Stats 指标与故障映射]]
- 状态解释：[[WebRTC 状态机诊断]]
- 报文互证：[[抓包分析]]
- 入口：[[RTC 故障树]]

## 参考资料

- Chromium `webrtc-internals` 当前版本实现；字段和导出格式需按浏览器版本确认
- 《WebRTC 实战指南》第 4 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/04-debugging-a-webrtc-application.md`
