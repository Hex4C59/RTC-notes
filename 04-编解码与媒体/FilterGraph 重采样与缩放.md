---
aliases: [FFmpeg FilterGraph, 重采样, 缩放]
tags: [rtc/concept, rtc/media, rtc/ffmpeg]
type: concept
---

# FilterGraph 重采样与缩放

## 定义

FFmpeg FilterGraph 是由输入、过滤器和输出组成的有向图，用于在 `AVFrame` 域进行重采样、格式转换、缩放、裁剪、混音和其他媒体处理。它不替代解码器或容器层：压缩包先解码成帧，过滤后的帧再交给编码器或播放设备。

## 核心机制

- 音频 `aresample` 可改变采样率、样本格式、声道布局和时间对齐；视频 `scale` 可改变尺寸并配合 `format`、色彩矩阵/范围处理像素格式。
- 图中的每个链接有输入/输出格式约束，过滤器可能协商或插入隐式转换。`buffersrc` 接收帧，过滤器处理 PTS 和格式，`buffersink` 输出满足下游约束的帧。
- `AVFrame` 的 PTS 会沿图传播或按过滤器语义改变，音频重采样在边界处可能产生不同 `nb_samples`；输出时间必须重新检查。
- CLI 中的 `-vf scale=...`、`-af aresample=...` 是图的简写；复杂音视频处理使用 `-filter_complex` 或 libavfilter API 表达明确的输入、输出标签和生命周期。

## 工程要点

- 重采样是质量和时钟问题的交界：选择滤波器、补偿样本数和延迟，记录输入/输出采样率与累计延迟，避免长通话中音频队列逐渐漂移。
- 缩放和颜色转换要明确 [[YCbCr 与色度抽样]]的像素格式、stride、范围、矩阵和色度定位；硬件帧可能需要显式上传/下载或专用硬件过滤器。
- FilterGraph 可能返回 EAGAIN、缓存帧或在 flush 后继续输出。输入结束和动态重配置时按图的 source/sink 语义排空，并在跨线程队列中持有 frame 引用。
- 先确定下游设备/编码器能接受的格式，再设置 graph 输出；否则隐式转换可能带来额外拷贝、延迟和不可见的质量损失。

## 问题边界

- FilterGraph 处理的是 frame 域，不会替代 demux、codec 或 RTP 组包。压缩包必须先解码，过滤后的 frame 还要交给编码器或设备。
- `scale` 处理空间采样/尺寸，`aresample` 处理音频采样率和样本格式；两者可能改变帧边界和延迟，但不应无故重写媒体时间线。
- CLI 过滤器字符串、libavfilter graph 和硬件专用 pipeline 的能力不完全相同，需按实际版本查询支持列表。

## 数据结构与图连接

FilterGraph 由 source、link、filter、sink 组成。音频 link 带 sample rate、sample format、channel layout 和 time base；视频 link 带 width、height、pixel format、SAR、色彩空间/范围和 time base。source 推入 `AVFrame`，sink 拉取可能经过缓存和格式协商的 frame。

| 组件 | 作用 | 生命周期要点 |
| --- | --- | --- |
| `buffersrc`/`abuffer` | 将解码 frame 送入图 | 输入 frame 的引用与 PTS 有效 |
| filter context | 变换/缓存/协商 | 配置后格式约束通常固定 |
| link | 传播格式和时间 | 可能因协商插入转换 |
| `buffersink`/`abuffersink` | 取出下游 frame | 处理 EAGAIN/EOF/引用 |

## 处理步骤

1. 先确定下游编码器或设备的像素/样本格式、尺寸、采样率和声道布局。
2. 创建 graph，添加 source、目标 filter 和 sink，设置必要选项并调用 configure。
3. 将每个输入 frame 按原始 time base 推入 source；按返回值循环从 sink 拉取所有可用 frame。
4. 输入结束或 seek 时向 source 发送 EOF/flush，继续拉取缓存输出到 sink 返回 EOF。
5. 动态改变分辨率、采样率或硬件上下文时停止旧图、清理引用，再创建新图并重建时间基映射。

## 时间与缓冲关系

重采样器可能缓存滤波器历史样本并在输入结束时输出尾部样本；缩放器通常一帧进一帧出，但线程/硬件同步可能增加等待。图内缓存、frame queue 和设备 buffer 叠加会增加端到端延迟。对实时链路应测量 source push 到 sink pull 的延迟，以及 flush 时多出的尾帧。

## 关键参数与取舍

- `aresample` 的滤波器、补偿、async/first_pts：质量、时钟漂移和延迟的取舍。
- `scale` 算法、输出尺寸、SAR 和 flags：清晰度、CPU/GPU 和处理时间的取舍。
- format/色彩矩阵/range：互操作正确性与转换拷贝的取舍。
- thread/hardware frame：吞吐与可预测延迟、调试复杂度的取舍。

## 常见误区与故障

- 只调用 source push 不拉 sink：输出会积压或 graph 认为下游未消费。
- 把 sink 的 EAGAIN 当致命错误：它通常只表示当前无更多输出；但要记录并继续输入。
- flush 时立即销毁 graph：可能丢掉重采样尾样本和最后视频帧。
- 忽略隐式 format conversion：链路表面能工作，实际出现额外拷贝、色彩偏差或 CPU 峰值。

## 可观测与验证

- 日志记录 graph 描述、输入/输出格式、每帧 PTS/nb_samples、source/sink 返回值、缓存帧数、处理耗时和拷贝/硬件同步次数。
- 用 1 kHz 音频、脉冲、采样率漂移、彩条、奇数裁剪、不同 range/matrix 和动态分辨率测试。
- 比较过滤前后样本总数、媒体时长、首尾延迟、像素差、CPU/GPU 和队列深度；对 flush 单独验收。

## 具体例子

将 44.1 kHz 立体声重采样为 48 kHz 单声道时，输出每帧 `nb_samples` 不应简单按 44.1/48 的浮点结果截断；应使用 resampler 的实际返回值和剩余缓存。视频从 NV12 缩放到 I420 时，还要检查矩阵、range、每平面 stride 和下游编码器的可接受格式。

## 图谱关系

- 输入对象：[[AVPacket 与 AVFrame]]
- 音频格式：[[PCM 与采样]]
- 视频格式：[[YCbCr 与色度抽样]]
- 调度：[[播放器队列与主时钟]]
- 编码：[[音频编解码]]

## 参考资料

- 《FFmpeg Basics》，第 4、11、16 章，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-basics\translation\05-resizing-and-scaling.md`、`90-参考资料\音视频与 WebRTC 书库\ffmpeg-basics\translation\12-format-conversion.md`、`90-参考资料\音视频与 WebRTC 书库\ffmpeg-basics\translation\17-digital-audio.md`。
- 《FFmpeg 播放器教程》，解码、转换和输出章节，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-player-tutorial-zh\content`。
- 《FFmpeg ffplay 源码分析》，libavfilter/libavutil 与播放处理章节，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-ffplay-source-analysis-zh\content\03-libavutil.md`、`90-参考资料\音视频与 WebRTC 书库\ffmpeg-ffplay-source-analysis-zh\content\06-ffplay.md`。
