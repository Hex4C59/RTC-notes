---
tags: [rtc/moc, rtc/media, rtc/ffmpeg]
type: moc
status: growing
---

# FFmpeg 与媒体处理地图

## 关系速览

```mermaid
flowchart LR
    Input["文件、网络流或内存输入"] --> Demux["解复用"]
    Demux --> Packet["AVPacket<br/>压缩数据与时间戳"]
    Packet --> Decoder["send_packet / receive_frame"]
    Decoder --> Frame["AVFrame<br/>原始音视频帧"]
    Frame --> Filter["FilterGraph<br/>重采样、缩放、混合"]
    Filter --> Queue["有界队列与主时钟"]
    Queue --> Output["渲染、编码或复用输出"]
```

## 从文件到帧

- [[码流与容器]]：区分编码格式、裸码流、容器和网络流。
- [[复用与解复用]]：在多条编码流与容器结构之间转换。
- [[PTS DTS 与时间基]]：描述解码顺序、显示顺序和时间换算。
- [[AVPacket 与 AVFrame]]：区分压缩包与解码后媒体帧及其所有权。
- [[FFmpeg 解码状态机]]：使用 send/receive API 正确处理 EAGAIN、EOF 和排空。

## 处理与播放

- [[FilterGraph 重采样与缩放]]：连接格式转换、滤镜、混音和缩放。
- [[播放器队列与主时钟]]：协调解复用、解码线程、队列、seek 和呈现。

## 建议学习路径

从码流与容器开始，随后学习解复用得到 AVPacket、解码得到 AVFrame，再处理 PTS/DTS 与时间基。掌握 send/receive 状态机后，再进入 FilterGraph、线程队列、seek 和主时钟。每一步都要明确数据所有权和排空条件。

## 掌握标准

- 能正确处理 `EAGAIN`、EOF 和 drain，且不会丢弃尚未被解码器接受的 packet。
- 能说明 AVPacket/AVFrame 的引用与复用规则，避免异步队列中的悬空或覆盖。
- 能把解复用、解码、滤镜、同步和渲染队列的延迟分别测量。

返回 [[编解码与媒体处理地图]]。
