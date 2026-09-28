---
aliases: [Opus over RTP, RFC 7587]
tags: [rtc/concept, rtc/transport, rtc/audio, rtc/protocol]
type: concept
status: growing
---

# Opus RTP 负载格式

> [!tip] 阅读提示
> **前置：** [[Opus]]、[[RTP]]；有 [[PCM 与采样]] 更好。
> **初读：** 读到「初读到此为止」就停。弄清：一个 RTP 包 = 一个完整 Opus packet；时间戳按 48 kHz、按 packet 总时长递增。
> **深入：** TOC/frame 布局、收发状态机和伪代码，做音频通路联调时再读。

## 一句话说明

这篇笔记只讨论「已经编码好的 Opus packet 如何放进 RTP」，不重复讲 Opus 的 SILK/CELT 编码原理。规范依据主要是 RFC 7587（RTP Payload Format for Opus）和 RFC 6716（Opus 编码格式）；WebRTC 的常见参数和浏览器行为单独标注为实现约定。

## 先记住这三句

1. **一个 RTP 包承载一个完整 Opus packet**——不像 H.264 FU-A 那样把一个 packet 切到多个 RTP。
2. RTP 时钟固定 **48 kHz**；20 ms packet 时间戳加 **960**（即使麦克风是 16 kHz）。
3. 一个 Opus packet 里可以有 1 个或多个 frame；不能「每个 RTP 包固定当 20 ms」硬解。

## 一句话边界

一个 RTP 包承载一个完整的 Opus packet。这个 Opus packet 内部可以包含 1 个或多个 Opus frame，但不能像 H.264 FU-A 那样把一个 Opus packet 任意切到多个 RTP 包中。RTP 序号用于包级丢失检测，RTP 时间戳指向该 packet 中第一个音频 frame 的采样时刻。

## RTP 与 SDP 字段（初读）

### RTP 头

| 字段 | Opus 语义 |
| --- | --- |
| `Payload Type` | 由 `a=rtpmap` 映射到 `opus/48000/<channels>`；常见动态 PT 111，但数值不固定 |
| `Timestamp` | 48 kHz；20 ms 加 960 |
| `Sequence Number` | 每包 +1 |
| `SSRC` | 当前 Opus 同步源 |
| `Marker` | 常见于静音后 talkspurt 首包；**不能**当音频帧边界 |

`Timestamp` 的增量是 packet 内所有音频 frame 的总时长。例如一个 packet 聚合两个 20 ms frame，时间戳仍只指向第一个 frame，下一个 packet 增加 1920。

### SDP 关联

```sdp
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;usedtx=1
```

- `minptime` 是希望的最小 packet 时长提示，不是每个包都必须等于它。
- `useinbandfec` / `usedtx` / `stereo` 等由双方实现决定如何应用。
- PT 可能在重新协商中变化，不要把 111 写死。

> [!example] 和 H.264 对照
> 视频大 NALU 可以 FU-A 分片；Opus packet 太大时通常去调帧长/码率，而不是把同一个 Opus packet 截断分开发。

---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面是工程展开与排障细节（字段、指标、状态流），**第二轮或遇到具体问题时再读**；第一次直接点文末「第一次阅读下一站」即可。

## Opus packet 的字段级解析

RTP payload 的第一个字节是 Opus TOC（Table Of Contents）字节。其高 5 位是 `config`，bit 2 是 `S`（声道/立体声标志），低 2 位是 `code`，用于描述 packet 中 frame 的数量和大小布局。

| TOC 部分 | 位/作用 |
| --- | --- |
| `config` | bits 7..3；选择 Opus mode、带宽和单 frame 时长组合。具体映射由 RFC 6716 的配置表定义，不能自行把数值当毫秒 |
| `S` | bit 2；声明编码流的声道语义。实际解码声道还要与 SDP/解码器能力一致 |
| `code` | bits 1..0；`0`=一个 frame，`1`=两个等长 frame，`2`=两个不等长 frame，`3`=由后续帧数/长度描述的多 frame packet |

当 `code=0` 时，TOC 后剩余字节就是一个 frame。`code=1` 时，剩余数据分成两个等长 frame，payload 长度必须能合法拆分。`code=2` 时，TOC 后先有一个长度字段描述第一个 frame，剩余数据是第二个 frame。`code=3` 时，TOC 后有 frame count/帧长度控制信息，解析器必须按 RFC 6716 的长度编码处理，包括可选 padding；不能凭字节平均切分。

长度字段的 8 位编码不是简单的网络序 `uint8`：Opus 的 frame length coding 对大于 255 字节的值使用扩展表示。因此工程实现应调用经过测试的 Opus packet parser，或完整实现 RFC 6716 的 `N`/padding/长度规则，不要只读取一个字节。

## 发送状态机

```text
Idle
  -> CollectPCM
  -> EncodeFrame(s)
  -> BuildOpusPacket(TOC + frame layout)
  -> CheckDurationAndMTU
  -> BuildRtpHeader
  -> SRTPProtect -> Pacer/Socket
  -> CollectPCM
```

每次发送前维护：`ssrc`、16 位 RTP sequence、32 位 timestamp、48 kHz 时钟、当前 PT、packet 内 frame 数、编码字节数和发送时间。编码器可以动态改变 frame duration，但 RTP timestamp 必须按实际 packet 时长递增；切换帧长不能把 timestamp 重新从零开始。

发送检查：

1. 确认编码输出是完整 Opus packet，长度大于等于 1 且 TOC 可解析。
2. 计算该 packet 的总采样时长和 RTP timestamp 增量。
3. 加上 RTP 固定头、CSRC、扩展、SRTP authentication tag 和可能的 TURN/UDP/IP 开销，确认不超出路径预算。
4. 设置 marker、PT、sequence、timestamp、SSRC；先完成 RTP 头，再交给 SRTP，不能把认证 tag 当作 payload。
5. 在发送历史中记录 packet 的 RTP 序号、时间戳、payload 长度、发送时间和媒体帧关联，供 RTCP 统计与排障使用。

通常不做 Opus RTP 分片。如果编码 packet 太大，应调整编码器帧长/码率，或在允许时降低 packet 聚合；不能把一个 Opus packet 任意截断后分别发送。

## 接收状态机

```text
UDP/SRTP packet
  -> Authenticate/Decrypt
  -> Parse RTP + PT/SSRC mapping
  -> Sequence unwrap + duplicate/late decision
  -> JitterBuffer deadline
       | complete packet -> Parse TOC/frame layout -> Decode
       | missing packet  -> wait / Opus in-band FEC / PLC
  -> Audio clock / render queue
```

接收器先验证 SRTP，再检查 RTP 长度、版本、PT、SSRC 和扩展边界。通过序号状态后，按 timestamp 将完整 Opus packet 放入抖动缓冲。TOC 解析得到 packet 内的 frame 数和时长后，才调用解码器；不能收到一个 RTP 包就假设它只含一个 20 ms frame。

缺包决策必须考虑播放截止时间：

- 仍有等待预算且可能收到 RTX：短暂等待；Opus 通常没有把 RTP packet 作为普通 NACK 分片恢复的语义。
- 后续 packet 携带可用 in-band FEC：按解码器接口先恢复丢失 frame，再解码当前 frame。
- 已错过截止时间或没有 FEC：调用 PLC 生成 concealment，保持音频时间线连续。
- 包认证失败、TOC 非法或长度越界：丢弃并计为 malformed/auth failure，不把损坏数据送入解码器。

### 序号和时间戳回绕

RTP sequence 是 16 位，timestamp 是 32 位。接收状态使用扩展序号/半空间比较；不要用有符号整数直接比较原始值。timestamp 回绕不应重置音频时钟，应该在流状态内扩展成更宽的单调时间轴。SSRC 改变时要区分源重启、冲突和正常新源，避免把两条流的解码状态混在一起。

## 工程实现伪代码

```text
sendOpus(pcm, captureTime):
    frames = opusEncoder.encode(pcm, configuredFrameSize)
    packet = opusPacketBuilder.pack(frames)       # writes valid TOC/layout
    duration = opusPacketDuration(packet)         # RFC 6716 parser
    ts = rtpClock.timestampAt(captureTime)
    if packet.size + rtpOverhead + srtpOverhead > pathPayloadBudget:
        rejectOrReconfigureEncoder()             # never truncate packet
    rtp = rtpBuilder.build(pt, seq++, ts, ssrc, packet)
    history.record(rtp.sequence, ts, rtp.size, captureTime)
    return srtp.protect(rtp)

onOpusRtp(rtp):
    packet = srtp.unprotectAndAuthenticate(rtp)
    stream = streams.lookup(packet.ssrc, packet.pt)
    if !stream.acceptSequence(packet.sequence):
        return dropAsDuplicateOrLate()
    if !opusParser.valid(packet.payload):
        return dropAsMalformed()
    jitter.insert(packet.timestamp, packet.sequence, packet.payload)
    while jitter.deadlineReady():
        if jitter.hasPacketAt(playoutTs):
            opusFrames = opusParser.split(jitter.pop(playoutTs))
            decoder.decode(opusFrames)
        else if decoder.canUseFec(nextPacket):
            decoder.decodeFec(nextPacket)
        else:
            decoder.decodePlc(expectedDuration)
```

伪代码表达状态边界，不代表某个浏览器或 libwebrtc 的类名。WebRTC 具体实现还会把 NetEq、RTCP/NACK、音频设备时钟和音频处理模块接入同一条收包到播放路径。

## 标准与 WebRTC 实现的边界

- RFC 7587/RFC 6716 规定 RTP 映射、TOC/packet 语义和时间规则；它们不规定浏览器必须使用 PT 111、某个固定 jitter buffer 或某个具体 PLC 算法。
- WebRTC 常见 `minptime=10;useinbandfec=1`、20 ms 初始帧、DTX、NetEq 以及特定 marker 使用是实现/配置习惯，不是「Opus 协议永远如此」。
- RFC 7587 不定义 RTX 如何在业务上限流，也不定义 SFU 如何转发/改写 SSRC；这些属于 RTP/反馈/服务端实现。

## 抓包验证与错误用例

在 Wireshark 中按 `rtp.ssrc`、`rtp.seq`、`rtp.timestamp`、`rtp.p_type` 过滤，确认 PT 能由 SDP 映射到 Opus，检查 timestamp 增量是否等于 packet 实际时长。对 RTP/UDP 外层开启 SRTP 解密后，核对 payload 第一个字节 TOC 和 payload 长度。

应测试：

- 单 frame、双等长 frame、双不等长 frame、多 frame packet；验证解码输出样本数。
- sequence 回绕、timestamp 回绕、重复包、乱序包、静音 DTX 后 marker 和首个语音包。
- 截断 TOC、非法 frame count、长度字段越界、认证失败、PT 错映射和错误声道数。
- 模拟丢包，分别观察等待、in-band FEC、PLC 和过期包的统计；不要把 PLC 计成网络重传成功。

常见症状：音频速度变快/变慢通常是 timestamp 增量或 packet duration 解析错误；周期性爆音常见于把聚合 packet 当单 frame；全部无声则先查 PT/SDP、SRTP 认证和 payload 是否误带 Annex-B/其他容器头。

## 阅读导航

- **上一篇：** [[H264 RTP 负载格式]]
- **下一篇：** [[RTP 头扩展]]
- **所属专题：** [[00-知识地图/专题说明/09 RTP 打包、解析与传输|09 RTP 打包、解析与传输]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]
- **第一次阅读下一站：** [[视频 RTP 接收与组帧状态机]]（收端怎么从包拼回视频帧）或 [[抖动缓冲]]（音频时间线）


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 编码：[[Opus]]
- 承载：[[RTP]]
- 反馈与恢复：[[RTCP]] · [[NACK]] · [[抖动缓冲]]
- 连接安全：[[SRTP]]
- 协商：[[SDP]]

## 参考资料

- RFC 7587，RTP Payload Format for the Opus Speech and Audio Codec。
- RFC 6716，Definition of the Opus Audio Codec。
- RFC 3550，RTP: A Transport Protocol for Real-Time Applications。
