---
aliases: [PTS, DTS, time_base, 时间戳]
tags: [rtc/concept, rtc/media, rtc/time]
type: concept
---

# PTS DTS 与时间基

## 定义

PTS（Presentation Time Stamp）表示样本/帧应被呈现的媒体时间，DTS（Decoding Time Stamp）表示解码器应处理压缩包的顺序时间。时间戳不是秒，必须结合流的 `time_base = num/den` 解释；转换到秒通常是 `timestamp * num / den`。

## 核心机制

- 没有 B 帧时 PTS 和 DTS 常常相同；有 B 帧时，编码器可能先存储/传输后续参考帧，DTS 先行而 PTS 按显示顺序排列。
- 音频通常按采样数连续推进，视频按帧时长或每帧实际时间推进。不同流的时间基可以完全不同，比较前必须使用有理数 rescale 到共同时钟。
- `AV_NOPTS_VALUE` 表示时间不可用，不应默认为真实零点。遇到缺失时间戳时要依据容器、帧率、解码器输出和接收时刻建立明确的回退规则。
- FFmpeg 的 `AVFrame` 可能携带解码后的 PTS 或 best-effort timestamp；应以当前 API 和解码器文档为准，不能依赖早期资料中自行挂到 `opaque` 的旧做法。

## 工程要点

- 使用 `av_rescale_q()` 等有理数运算转换时间戳，避免先转浮点再取整造成长期漂移；记录舍入方向和溢出策略。
- 处理 seek、负起始时间、时间戳回绕、可变帧率和输入流切换时，维护每条流独立的基准，并明确是否允许 discontinuity。
- 播放器应以主时钟和帧 PTS 安排呈现；不能用“读到包的墙上时间”代替媒体时间，否则网络抖动会直接变成音画抖动。
- RTP 时间戳、容器 PTS/DTS 和本地单调时钟属于不同域。必要时通过 RTCP SR 或显式映射建立共同参考，不能直接比较数值大小。

## 问题边界

- PTS/DTS 是媒体时间，不是发送时刻、接收时刻、墙上时钟或 RTP 序号；这些量只有在明确映射后才可比较。
- DTS 主要描述压缩数据进入解码器的顺序，PTS 描述解码结果何时呈现；没有 B 帧时两者常相同，但不能假定永远相同。
- `time_base` 是有理数单位，不是帧率字段本身。固定帧率常见 `1/fps`，但容器、编码器和滤镜可以使用不同时间基。

## 数据结构与换算

时间值通常以 `int64` tick 保存。若 `time_base = num/den`，秒值为 `timestamp * num / den`；两个流比较时先通过有理数 rescale 到共同 time base。FFmpeg 中应优先使用 `av_rescale_q`/`av_rescale_q_rnd` 等函数，避免浮点累计误差和整数溢出。

| 时间 | 所在对象 | 说明 |
| --- | --- | --- |
| packet DTS | `AVPacket` | 压缩包解码顺序 |
| packet PTS | `AVPacket` | 容器/编码器给出的呈现时间 |
| frame PTS | `AVFrame` | 解码/滤镜后的呈现时间 |
| RTP timestamp | RTP 头 | 负载对应媒体时钟 tick |
| wall/monotonic clock | 系统/播放器 | 调度与超时参考 |

## 时间线处理步骤

1. 读取每条流原始时间戳和 time base，保留 `AV_NOPTS_VALUE` 状态。
2. 对 packet 按 DTS 送解码器，但保留 PTS 供输出 frame 关联。
3. 从 frame 的有效 PTS/best-effort timestamp 计算媒体呈现时间。
4. 将音视频 PTS rescale 到共同播放时钟，结合主时钟计算等待、丢帧或重复。
5. seek、切流或 discontinuity 时重置基准、队列和解码器状态，避免旧时间线泄漏。

## 时间与缓冲关系

缓冲区保存的是带媒体时间的对象。jitter buffer 用 RTP timestamp/到达时刻估计播放计划，解码器重排序缓存等待参考帧，播放器队列按 PTS 安排呈现。增加任一缓冲都会增加可用恢复时间和端到端延迟，但不会修复错误的 time base 或时钟映射。

## 关键参数与取舍

- rescale 舍入模式：向下、向上或 nearest 会影响边界帧，需固定并记录。
- 起始时间/负时间戳：决定是否重基准到零，影响 seek 和音画对齐。
- 时钟漂移阈值：决定何时重采样、丢/补帧或重建播放基准。
- jitter/reorder buffer 上限：决定容忍乱序/抖动与实时延迟的取舍。

## 常见误区与故障

- 直接比较音频和视频原始 PTS：不同 time base 下数值大小没有意义。
- 用帧号除以 nominal fps 生成所有 PTS：可变帧率、重复帧和丢帧会产生漂移。
- 把 `AV_NOPTS_VALUE` 当 0：会把未知时间错误地放到开头，造成跳帧或音画突然对齐。
- 用到达墙上时间覆盖媒体 PTS：网络抖动将直接变成播放抖动和音画漂移。

## 可观测与验证

- 日志同时输出原始 tick、time base、rescaled seconds、DTS/PTS、frame index、到达时间和呈现时间。
- 构造无 B 帧、有 B 帧、VFR、负起点、timestamp gap、回绕和音视频不同起点的样本，检查单调性和同步误差。
- 长时间播放记录 A/V diff、队列时长、重采样/丢帧次数和时钟校正量，按 P95/P99 分析而非只看末值。

## 具体例子

一个视频流使用 90,000 Hz time base，30 fps 等间隔帧的 PTS 增量约 3,000；一个音频流使用 48,000 Hz 采样时钟，20 ms 帧的 PTS 增量为 960。两个 `3000` 和 `960` 不能直接比较，必须先换算到秒或统一 time base。

## 图谱关系

- 时间基来源：[[复用与解复用]]
- 数据对象：[[AVPacket 与 AVFrame]]
- 状态机：[[FFmpeg 解码状态机]]
- 播放调度：[[播放器队列与主时钟]]
- RTC 参考：[[时钟与时间戳]]

## 参考资料

- 《FFmpeg API 与解码流程参考》，AVPacket 与时间信息，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-api-decoding-reference-zh\content\05-avpacket-and-time.md`。
- 《FFmpeg 播放器教程》，同步视频与 PTS/DTS，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-player-tutorial-zh\content\05-tutorial-5.md`。
- 《FFmpeg Basics》，第 12 章时间操作，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-basics\translation\13-time-operations.md`。
