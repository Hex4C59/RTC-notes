---
aliases: [AVPacket, AVFrame]
tags: [rtc/concept, rtc/media, rtc/ffmpeg]
type: concept
status: growing
---

# AVPacket 与 AVFrame

> [!tip] 阅读提示
> **前置：** [[复用与解复用]]。
> **初读：** 先读「一句话说明」和「核心机制」，弄清 AVPacket 与 AVFrame 解决什么问题、不负责什么。
> **深入：** 「工程要点」、「状态与所有权步骤」、「关键参数与取舍」 在实现、联调或排障时再读。

## 一句话说明

`AVPacket` 表示一个压缩数据包及其流索引、时间戳、持续时间和附加信息；`AVFrame` 表示解码后或待编码的音频/视频帧，包含像素/样本平面、格式、尺寸/样本数、linesize 和时间信息。Packet 是压缩域对象，Frame 是媒体样本域对象，二者不是一一对应关系。

## 核心机制

- 解复用器产生 `AVPacket`，解码器通过 send/receive 状态机消耗 packet 并产生零个、一个或多个 `AVFrame`；B 帧、缓存和重排序会导致一对多或延迟输出。
- 音频 `AVFrame` 的 `nb_samples` 是每声道样本数；视频 `AVFrame` 的 `data[]/linesize[]` 可能包含多个平面和对齐填充，不能按可见宽度直接访问整行。
- Packet 采用引用计数管理数据缓冲；使用 `av_packet_ref/move_ref/unref` 表达共享、转移和释放。Frame 同样可能引用解码器、硬件表面或过滤器缓冲区。
- `avcodec_send_packet()` 接受的是 `const AVPacket *`。当它返回 0 时，解码器已经接受该输入，调用方可以 `av_packet_unref()` 或复用自己的 packet；解码器可能保留底层引用/副本。若返回 `AVERROR(EAGAIN)`，输入没有被接受，调用方必须保留 packet 不变，先 receive 输出，再重试同一个 packet，不能直接 unref 或读取下一个包。
- 调用方传给 `avcodec_receive_frame()` 的 `AVFrame` 是可复用容器；下一次 receive 可能 unref/覆盖其引用。若要跨线程或长期排队，使用 `av_frame_ref()`/`av_frame_clone()` 保存对底层 buffer 的引用，消费完再 `av_frame_unref()`。

```mermaid
flowchart LR
    A[Demuxer] -->|产生压缩数据| B[调用方 AVPacket]
    B -->|send 返回 0| C[Decoder 内部引用 / 缓冲]
    B -->|send 返回 EAGAIN| D[保留同一个 Packet]
    D -->|先 receive| C
    C -->|0..N 次 receive| E[可复用 AVFrame 容器]
    E -->|同步消费后 unref| F[渲染 / 过滤]
    E -->|异步排队前 ref 或 clone| G[Frame 队列持有独立引用]
    G --> F
    F --> H[消费完成后 unref]
```

图中的箭头表示 API 状态和引用责任，不表示一个 Packet 必然产生一个 Frame。尤其是 `EAGAIN` 分支，输入还没有被解码器接受，调用方不能释放或替换它。

## 工程要点

- 包队列只保存压缩数据，帧队列保存可播放数据；分别设置数量、字节数和媒体时长上限，并在退出时唤醒生产者/消费者。
- 检查 `stream_index`、时间戳、大小和 side data；不把 `AVPacket` 的 `size` 当成媒体帧时长，也不把 `AVFrame` 的 `linesize` 当成可见宽度。
- 硬件帧要处理 `AVHWFramesContext` 和下载/映射成本；不必要的 GPU↔CPU 拷贝会抵消硬件解码收益。
- 所有权问题优先通过 RAII 或清晰的 `unref` 约定解决。解码错误、EOF、flush 和线程取消路径都要验证没有泄漏、重复释放或悬空引用。

## 问题边界

- `AVPacket` 是压缩数据和元数据的所有权容器，`AVFrame` 是样本/像素平面和格式描述的容器；它们不是“网络包”和“显示帧”的简单别名。
- `AVPacket` 可能只包含一帧的一部分，也可能包含可被解码器缓存/拆分的编码数据；`AVFrame` 可能由多个 packet 共同产生，或一次 receive 产生多个 frame。
- refcount 只解决底层 buffer 的共享寿命，不自动解决跨线程顺序、时间戳、队列容量和设备同步。

## 数据结构与格式

`AVPacket` 常用字段包括 `data/size`、`stream_index`、`pts`、`dts`、`duration`、`flags` 和 side data。其 `data` 可能引用 `AVBufferRef`，也可能是未引用的外部内存，生命周期必须按 API 契约管理。

`AVFrame` 的音频字段包括 `format`、`sample_rate`、`ch_layout`、`nb_samples`、`data[]` 和 `linesize[]`；视频还包括 `width`、`height`、`format`、多平面地址、stride、color range/space、SAR 和 PTS。硬件帧的数据地址可能不是 CPU 可直接读的指针。

| 操作 | 语义 | 调用方责任 |
| --- | --- | --- |
| `av_packet_ref` | 共享 packet buffer/side data | 两个对象都要 unref |
| `av_packet_move_ref` | 转移引用并清空源 | 不再使用源 packet |
| `av_packet_unref` | 释放当前 packet 引用 | 不能再读 data |
| `av_frame_ref` | 共享 frame buffer/属性 | 目标 frame 独立 unref |
| `av_frame_clone` | 创建带引用的 frame 副本 | 仍共享底层数据 |

## 状态与所有权步骤

1. 解复用器产生 packet，读取线程决定转移、引用或丢弃。
2. 送解码器时，send 返回 0 才可释放 caller packet；EAGAIN 必须保留并在 receive 后重试。
3. receive 写入 caller frame；若交给异步队列，先 ref/clone，不能只保存指针。
4. 过滤器/编码器消费 frame 后，按所有权 unref；设备回调结束前保持底层 buffer 有效。
5. flush、seek、错误和关闭时清空队列，确保每个 packet/frame 引用最终只释放一次。

## 时间与缓冲关系

packet 队列的时间单位通常是压缩流 time base，frame 队列使用 frame PTS 和样本/像素时长。引用 frame 不会复制时间语义或自动限制队列；长期持有硬件帧还可能占满 surface pool，使解码器无法继续输出。应按字节、帧数、媒体时长和底层 buffer 数量共同限流。

## 关键参数与取舍

- ref vs copy：共享引用省 CPU/内存，但要求底层 buffer 生命周期和线程安全明确；深拷贝更独立但代价高。
- software vs hardware frame：硬件路径减少拷贝，处理和调试复杂度更高。
- packet queue vs frame queue：前者省内存、延迟低但解码压力突发；后者平滑播放但占用更大。
- `best_effort_timestamp` 等派生时间：便于处理缺失 PTS，但必须记录其来源和可信边界。

## 常见误区与故障

- send 返回 EAGAIN 后立即 unref packet：会丢包或把 packet 指针复用成下一个输入。
- receive 后只保存 `AVFrame *`：下一次 receive/flush 可能覆盖其引用，异步消费者得到悬空或错误画面。
- 把 linesize 当 width，把 `nb_samples` 当总样本数：平面格式和对齐下会越界或声道错位。
- 看到 refcount 就随意跨线程共享：底层引用安全不代表 codec context、队列和回调安全。

## 可观测与验证

- 记录 packet pointer/id、refcount 生命周期事件、size、PTS/DTS、frame buffer 类型、队列深度和 unref 位置。
- 用一包多帧、跨包帧、EAGAIN、B 帧、硬件 frame、seek/flush 和队列满测试所有权与时序。
- 使用 ASan/UBSan、FFmpeg debug log 和最小文件回放检查重复释放、悬空引用、buffer pool 耗尽及时间戳跳变。

## 具体例子

解码线程调用 send 后得到 0，可以立即 unref 自己的 packet，因为解码器已经按 API 需要保留数据；但若得到 EAGAIN，packet 仍是待提交输入，必须先 receive 已排队的 frame，再重试同一个 packet。若要把 receive 得到的 frame 放入显示队列，应 `av_frame_ref` 到队列对象，不能把解码线程复用的临时 frame 指针直接入队。

## 阅读导航

- **上一篇：** [[复用与解复用]]
- **下一篇：** [[FFmpeg 解码状态机]]
- **所属专题：** [[00-知识地图/专题说明/13 RTC 媒体处理与 FFmpeg|13 RTC 媒体处理与 FFmpeg]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 输入：[[复用与解复用]]
- 时间：[[PTS DTS 与时间基]]
- 消费：[[FFmpeg 解码状态机]]
- 处理：[[FilterGraph 重采样与缩放]]
- 播放：[[播放器队列与主时钟]]

## 参考资料

- 《FFmpeg API 与解码流程参考》，AVPacket、数据结构与函数，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-api-decoding-reference-zh\content\05-avpacket-and-time.md`、`90-参考资料\音视频与 WebRTC 书库\ffmpeg-api-decoding-reference-zh\content\09-sdk-data-structures.md`。
- 《FFmpeg ffplay 源码分析》，libavcodec 与 ffplay 数据流，`90-参考资料\音视频与 WebRTC 书库\ffmpeg-ffplay-source-analysis-zh\content\05-libavcodec.md`、`90-参考资料\音视频与 WebRTC 书库\ffmpeg-ffplay-source-analysis-zh\content\06-ffplay.md`。
- FFmpeg 官方 send/receive API 文档，`https://www.ffmpeg.org/doxygen/trunk/group__lavc__encdec.html`。
