---
aliases: [getStats, WebRTC 统计]
tags: [rtc/concept, rtc/client, rtc/observability]
type: concept
status: growing
---

# WebRTC Stats

> [!tip] 阅读提示
> **前置：** [[RTP]]、[[ICE 候选与候选对]]；排障对照 [[Stats 指标与故障映射]]。
> **初读：** 读到「初读到此为止」就停。弄清：Stats 是累计快照；速率要两点求差；黑屏要按「路径→包→解码→上屏」分层查。
> **深入：** 采集设计与误读清单，接监控或写诊断工具时再读。

## 一句话说明

WebRTC Stats 通过 `RTCPeerConnection.getStats()`（及 Native 对等接口）暴露候选对、传输、RTP、编解码等对象的**累计状态**。它是把“用户看见的现象”关联到协议层的端点证据，不是端到端延迟的直接读数，也不替代服务端 SFU 日志。

## 先记住这三句

1. `getStats()` 给的是候选对/传输/RTP/编解码等对象的**累计状态**，不是 E2E 延迟读数。
2. 码率、丢包率、帧率几乎都要 **Δ累计 / Δt**；对象 ID 换代禁止跨代相减。
3. 黑屏先分层：pair/字节 → outbound → inbound → decoded → rendered——两种「都叫黑屏」入口完全不同。

## 问题边界

- **上游：** PC/Sender/Receiver 内部计数、RTCP 带来的远端视角。  
- **下游：** 诊断 UI、监控时序库、告警与实验对比。  
- **易混淆：**
  - 单次快照 ≠ 趋势；多数速率要两点求差。  
  - `currentRoundTripTime` ≠ 媒体 E2E。  
  - 本端 Stats ≠ SFU 选层/丢弃原因全文。

## 核心机制

- 对象靠 `id` 互引：selected candidate pair → transport → inbound/outbound RTP → codec…  
- 码率/丢包率/帧率：Δ累计 / Δt。  
- 字段随浏览器/SDK 演进；采集必须记版本并容忍缺失。

## 报告对象图

```text
candidate-pair (selected)
  -> transport
       -> outbound-rtp / inbound-rtp
            -> codec / media-source ...
remote-inbound-rtp  (via RTCP, partial)
```

- `candidate-pair`：路径、RTT、收发字节。  
- `outbound-rtp` / `inbound-rtp`：一条发送或接收 RTP 流。  
- `remote-inbound-rtp` 等：远端视角，采样更稀、字段更少。  
- `codec` / `media-source`：编码与源侧补充。  

保存原始 `id/type/timestamp/引用`，在派生层建模。只按字段名捞数，容易把两条同名流糊在一起。

## 常用区间计算

设间隔 `Δt` 秒：

```text
发送码率 = 8 × ΔbytesSent / Δt
接收码率 = 8 × ΔbytesReceived / Δt
窗口丢包率 = max(0, ΔpacketsLost) / (ΔpacketsReceived + max(0, ΔpacketsLost))
帧率 = ΔframesEncoded(or Decoded) / Δt
均帧编码时 = ΔtotalEncodeTime / ΔframesEncoded   (分母>0)
```

对象 ID 更换、计数重置、时间倒退 → **新开序列**，禁止跨代次相减。`packetsLost` 语义按当前规范处理。

## 从路径到画面逐层判断

把“黑屏/无声”拆开：

1. candidate pair 是否 selected，字节/RTT 是否在变。  
2. transport / RTP 是否绑在预期 pair。  
3. outbound packets/frames 是否增长。  
4. inbound packets 是否增长；丢包、jitter、JB 是否异常。  
5. framesDecoded / keyFrames 是否增长。  
6. rendered/dropped 或应用层是否真正上屏/出声。  

| 阶段卡住 | 优先方向 |
| --- | --- |
| 无 outbound 字节 | 采集/编码/发送 pause |
| 有发送无 inbound | 路径、SFU 路由、权限 |
| 有包无 decoded | PT/参数集/参考帧/关键帧 |
| 有 decoded 无画面 | 渲染、页面可见性、设备 |

## 具体例子

`packetsReceived` 持续涨，`framesDecoded` 停，PLI 升 → 查参数集/参考损坏/关键帧是否到。  
若 `packetsReceived` 也不涨 → 先查发送、SFU 订阅、selected pair。  
两种都叫黑屏，入口完全不同。


---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面是工程展开与排障细节，**第二轮或遇到具体问题时再读**；第一次直接点文末「第一次阅读下一站」即可。

## 工程要点

- 单调采样；同时留原始累计与派生值。  
- 分清：本端测量、远端 RTCP 视图、解码/渲染计数。  
- 与日志/抓包/[[webrtc-internals]] 交叉，不单点定罪。  
- 缺失字段标无效，**不要当 0**。  

## 采集设计

- 前台诊断约 1 s；生产权衡 CPU、隐私、短故障可捕性。  
- 墙上时间做跨系统对齐，单调时间做 Δt。  
- 记浏览器/SDK 版本、网络类型、角色；地址与 SDP 脱敏。  
- 长会话：低频常采 + 故障窗加密采。  

## 常见误读

- `currentRoundTripTime`：选中 pair 路径估计 ≠ 口型/互动 E2E。  
- `jitter`：RTP 到达抖动语义 ≠ UI 卡顿，≠ JB 当前时长。  
- `qualityLimitationReason=bandwidth`：编码受带宽限 ≠ 一定在丢包。  
- 有 bytes 仍可能无解码帧；有解码仍可能因页面/设备不可见。  
- 单端好看不排除 SFU 把你订在底层。  

## 与其它信号的配合

- 服务端：选层原因、丢弃原因、关键帧等待（[[SFU]]）。  
- 本地：设备 underrun、权限、前后台（[[采集与渲染]]）。  
- 体验：卡顿、首帧、主观分（[[QoS 与 QoE]]）。  
- 字段释义总表：[[Stats 指标与故障映射]]。  

## 观测与验证

固定场景录一段 getStats 序列：带宽阶跃、丢包、切层、Mute、ICE restart。人工标注现象，检查分层判断是否指向正确阶段。回归时对比同版本字段可用性。

## 阅读导航

- **上一篇：** [[FFmpeg 解码状态机]]
- **下一篇：** [[webrtc-internals]]
- **第一次阅读下一站：** [[QoS 与 QoE]]（回看体验口径；本专题客户端概念到此收口）
- **所属专题：** [[00-知识地图/专题说明/04 WebRTC 应用接入与源码阅读|04 WebRTC 应用接入与源码阅读]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[客户端工程地图]]、[[测试与排障地图]]
- 解释层：[[Stats 指标与故障映射]]、[[webrtc-internals]]
- 路径：[[ICE 候选与候选对]]
- 媒体：[[RTP]]、[[RTCP]]
- 体验：[[QoS 与 QoE]]、[[端到端延迟]]

## 参考资料

- W3C WebRTC Statistics API。
- 《WebRTC 实战指南》第 4 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/04-debugging-a-webrtc-application.md`
- 同库 [[Stats 指标与故障映射]]。
