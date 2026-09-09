---
aliases: [chrome webrtc-internals]
tags: [rtc/concept, rtc/troubleshooting, rtc/observability]
type: concept
status: growing
---

# webrtc-internals

## 一句话说明

`webrtc-internals` 是 Chromium 系浏览器提供的 WebRTC 调试视图，可查看 PeerConnection API 调用、状态变化、事件和统计曲线，适合还原单端运行时间线。

## 核心机制

- API 事件记录 offer/answer、描述设置、候选与轨道操作，可辅助检查调用顺序。
- Stats 图表展示传输、RTP、编解码和媒体源指标随时间变化。
- 导出文件只代表采集端看到的状态，不包含服务端内部决策或网络中所有报文。

## 采集流程

1. 在开始复现前打开 `chrome://webrtc-internals`（Chromium 系产品入口可能不同）。
2. 清楚记录浏览器完整版本、操作系统、实验开始时间、双方角色和预期 PeerConnection 数量。
3. 执行一次尽量短且可重复的复现，不刷新或关闭调试页。
4. 在异常发生时记录墙上时间和用户动作，例如“14:03:21 切换 Wi-Fi”。
5. 导出调试数据，并同时保存应用日志、服务端日志及必要抓包。

调试页需要在 PeerConnection 创建前打开，才能尽量获得完整事件。不同 Chromium 版本的页面、字段和导出格式会变化，不能把某个截图步骤写成永久接口。

## 阅读顺序

### 1. 确认 PeerConnection

页面可能包含多个连接。先用创建时间、URL、进程和配置找到目标对象，确认没有把测试重试或另一个标签页的数据混进来。

### 2. 看 API 与状态事件

沿时间顺序检查 createOffer/createAnswer、setLocalDescription、setRemoteDescription、addIceCandidate、Track/Transceiver 操作与关闭。异常包括调用拒绝、顺序错误、重复协商和状态长时间不推进。

### 3. 看连接路径

确认 selected candidate pair、候选类型、协议、地址族、RTT 和收发字节变化。若发生路径切换，把切换时间与网络事件、ICE 状态和媒体指标对齐。

### 4. 看 RTP 与媒体链

分别查看 audio/video、inbound/outbound：包和字节、帧率、关键帧、编码/解码耗时、丢包、抖动缓冲和质量受限原因。累计图需要看斜率变化，不能只读最后一个数。

### 5. 看用户现象对应时窗

缩小到故障前后几十秒，对比状态事件和多个指标共同变化，再到日志或抓包验证。

## 工程要点

- 复现前打开页面并记录浏览器版本、实验时间、PeerConnection 标识和远端角色。
- 分享导出前检查 SDP、地址、设备名和业务标识等敏感信息。
- 用同一时间范围与应用日志、服务端日志和抓包互证。

## 常见模式

- outbound RTP bytes 为零：发送轨道、方向、编码或业务状态问题。
- candidate pair bytes 增长而 inbound RTP 不增长：远端/SFU 未发送该流，或查看了错误 RTP 对象。
- inbound packets 增长而 framesDecoded 停止：关键帧、参数集、Payload Type 或解码问题。
- RTT、发送队列和 bandwidth limitation 同时上升：可能发生网络排队和拥塞降码率。
- concealed samples 与 jitter buffer delay 增长：网络抖动/丢包已影响音频恢复。

这些模式用于定位阶段，不能单凭一个图表宣布根因。

## 导出与隐私

导出内容可能包含 SDP、ICE 候选地址、设备名称、页面来源、业务 ID 和时间信息。发送给他人前应按团队规则脱敏，并保留一份受控原始证据供内部复盘。不要把公开脱敏后的文件当作完整取证副本。

## 局限

- 它看不到 SFU 内部为何丢包或选择某一层。
- 抓包点之外发生的丢包不能仅靠单端图表精确定位。
- 浏览器内部字段可能是实现扩展，不保证跨版本或跨浏览器一致。
- 页面显示本身可能降采样或聚合；严谨计算应基于导出的原始 Stats 序列和规范语义。

## 结果记录模板

```text
问题方向：B -> A 视频
异常窗口：14:03:21–14:03:34
状态事实：ICE/DTLS 保持 connected
媒体事实：packetsReceived 增长，framesDecoded 停止，PLI 增加
初步范围：接收端视频可解码性/关键帧
互证材料：A 端导出、SFU 订阅日志、同窗抓包
```

## 图谱关系

- 主题：[[测试与排障地图]]
- 指标语义：[[WebRTC Stats]]
- 状态解释：[[WebRTC 状态机诊断]]
- 报文互证：[[抓包分析]]

## 参考资料

- Chromium `webrtc-internals` 当前版本实现；字段和导出格式需按浏览器版本确认。
- 《WebRTC 实战指南》第 4 章，`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/04-debugging-a-webrtc-application.md`
