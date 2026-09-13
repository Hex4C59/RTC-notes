---
aliases: [H.264 over RTP, RFC 6184, AVC RTP payload]
tags: [rtc/concept, rtc/transport, rtc/video, rtc/protocol]
type: concept
status: growing
---

# H264 RTP 负载格式

> [!tip] 阅读提示
> **前置：** [[H264]]、[[RTP]]、[[SDP]]。
> **初读：** 先读“四个不能混淆的边界”“H.264 NAL 头”“SDP 协商”和“三种主要包化格式”，分清帧、NALU 与 RTP 包。
> **深入：** 发送、接收状态机和解析伪代码留到打包、组帧或抓包练习时阅读。

## 一句话说明

这篇笔记描述 H.264 NAL 单元如何映射到 RTP，依据 RFC 6184。H.264 码流的预测、变换和参考帧见 [[H264]]；这里重点是单 NALU、STAP-A/FU-A、访问单元组装和 WebRTC 实现边界。

## 四个不能混淆的边界

```text
图像/访问单元(AU) -> 一个或多个 NALU -> 一个或多个 RTP 包 -> UDP 数据报
```

一个访问单元可能包含 AUD、SPS、PPS、SEI 和一个或多个 slice NALU。一个小 NALU 可以放进一个 RTP 包；一个大 NALU 要拆成多个 FU-A 包；一个 RTP 包也可以用 STAP-A 聚合多个小 NALU。因此 RTP Marker 和包数不能直接当作“编码帧大小”。

## H.264 NAL 头

单 NALU、STAP-A 和 FU-A 的第一个字节都按 RFC 6184 使用 NAL 头：

| 位 | 字段 | 作用 |
| --- | --- | --- |
| 7 | `F` / forbidden_zero_bit | 应为 0；收到 1 通常表示非法/损坏或不支持的语义 |
| 6..5 | `NRI` | nal_ref_idc；提示该 NAL 对参考图像的重要性，不等于完整丢包恢复策略 |
| 4..0 | `Type` | 1..23=单 NAL 类型，24=STAP-A，28=FU-A；其他类型按 RFC 6184 和 packetization-mode 能力判断 |

## SDP 协商

```sdp
m=video 9 UDP/TLS/RTP/SAVPF 102
a=rtpmap:102 H264/90000
a=fmtp:102 packetization-mode=1;profile-level-id=42e01f;sprop-parameter-sets=Z0LgHtoCgPaE,aM4xUg==
```

- `a=rtpmap` 声明 H264 和 90 kHz RTP 时钟；PT 102 只是示例动态值。
- `packetization-mode=0` 只允许 Single NAL Unit Mode；`1` 允许非交错模式中的 Single NAL、STAP-A 和 FU-A；`2` 是交错模式，包含 STAP-B/FU-B 等 DON 语义，WebRTC 主流实现通常不使用。
- `profile-level-id` 的 6 个十六进制字符编码 profile、兼容性约束和 level；不能只比较字符串表面，且最终仍要检查实际解码能力。
- `sprop-parameter-sets` 是 base64 的 SPS/PPS 提示；实现还可能通过带内 RTP NAL 发送参数集。新订阅者/解码器重启时不能假设只看过 SDP 就永远拥有最新参数集。
- `level-asymmetry-allowed` 是常见的协商参数，涉及 offer/answer 两端 level 使用方式；不能把它当作 packetization-mode。

Offer/Answer 完成后，发送器只能使用对端接受的 packetization mode 和编码参数。PT 变化、SSRC 切换和重新协商都要更新接收路由状态。

## 三种主要包化格式

### Single NAL Unit

当 NALU（不含 Annex-B 起始码）能放入当前 payload 预算时，RTP payload 直接是：

```text
| NAL header (1 byte) | RBSP/EBSP payload ... |
```

去掉 Annex-B 的 `00 00 01`/`00 00 00 01` 起始码，或去掉 length-prefix 的长度字段后再按 NALU 字节封装。`F/NRI/Type` 来自原 NAL 头；RTP Marker 通常在该访问单元最后一个 RTP 包设置为 1。

### STAP-A 聚合

STAP-A 只在 packetization-mode=1 时使用，格式为：

```text
| STAP-A indicator (1) | NAL size (16-bit) | NALU | NAL size | NALU | ... |
```

STAP-A indicator 的 `Type=24`，`F` 必须按聚合规则处理，`NRI` 提示聚合内容的重要性。每个 NALU 前是 16 位网络序长度，不含 NAL size 自身。接收器必须循环检查长度，禁止让一个 NALU 长度越过 payload 末尾。STAP-A 内部所有 NALU 属于同一个 RTP timestamp/AU 语境；它不是任意跨帧的压缩容器。

### FU-A 分片

大 NALU 使用 FU-A，RTP payload 结构为：

```text
| FU indicator (1) | FU header (1) | fragment bytes ... |
```

`FU indicator` 的 `F`、`NRI` 继承原 NAL 头，`Type=28`。`FU header` 为：

| 位 | 字段 | 含义 |
| --- | --- | --- |
| 7 | `S` | Start；首片为 1，只能出现在该 NALU 的第一片 |
| 6 | `E` | End；尾片为 1，只能出现在最后一片 |
| 5 | `R` | Reserved；必须为 0 |
| 4..0 | `Type` | 原始 NALU type，不是 28；首尾片必须一致 |

首片不携带原 NAL header，而是通过 indicator 的 NRI 与 FU header 的 Type 重建；中间片 `S=0,E=0`；尾片 `E=1`。同一 FU-A 的所有分片通常共享 timestamp，sequence 连续但接收器必须容忍乱序并根据序号重排。

RFC 6184 还定义 STAP-B、MTAP、FU-B 和 DON（Decoding Order Number）用于交错模式；WebRTC 主流路径通常协商 mode 1、使用 STAP-A/FU-A，不应把 mode 1 接收器伪装成支持 mode 2。遇到 mode 2 要依据 SDP 能力明确拒绝或交给专门实现。

## 发送状态机

```text
EncodedAccessUnit
  -> RemoveAnnexB/length-prefix
  -> EnumerateNALUs
  -> Select packetization mode
       | small NAL -> SingleNAL
       | many small NAL -> STAP-A (mode 1)
       | large NAL -> FU-A
  -> Set timestamp + marker on AU final packet
  -> SRTPProtect -> Pacer/Socket
```

发送器状态至少包括：当前 AU timestamp、AU 内 NAL 顺序、当前 RTP sequence、SSRC、PT、最大 payload、是否已发 SPS/PPS、packetization mode 和上一关键帧状态。

发送步骤：

1. 从编码器输出中识别 Annex-B 或 AVC length-prefixed 格式，提取 NALU，不把起始码/长度字段放进 RTP payload。
2. 根据 `MTU - IP - UDP - RTP header/extensions - SRTP tag - tunnel overhead` 计算可用 payload。
3. 小 NALU 使用 Single NAL；多个小 NALU 在不超预算且 mode=1 时可 STAP-A；超过预算的单 NALU 使用 FU-A。
4. 同一 AU 的包使用同一 RTP timestamp；仅该 AU 最后一 RTP 包设置 Marker=1。编码器/实现可能让一个 AU 的最终包不是最后一个 slice 的直观字节片，必须以打包器的 AU 边界为准。
5. 每包递增 sequence，保持 FU-A 的 fragment 顺序；送入 SRTP 后才发往 pacer/socket。

## 接收与视频组帧状态机

```text
RTP/SRTP packet
  -> Authenticate/Decrypt + RTP parse
  -> PT/SSRC/MID/RID mapping
  -> Sequence unwrap + duplicate/late filter
  -> H264 depacketizer
       | Single NAL -> NALU
       | STAP-A -> length-check and emit NALUs
       | FU-A S -> open fragment assembly
       | FU-A middle -> append if contiguous/valid
       | FU-A E -> close and emit rebuilt NALU
  -> AU assembler(timestamp/marker)
  -> parameter/reference checks
  -> decoder or drop/request keyframe
```

组帧器的 key 建议至少包含 `(SSRC, RTP timestamp, extended sequence window)`，实际 SFU/多层流还要加入媒体线和 RID。对 FU-A 维护：原始 NAL type、NRI、首片序号、最近序号、累计字节数、是否已缺片、开始到截止时间。收到同 timestamp 的新 FU-A 且旧组仍未结束时，不能静默拼在一起；应按序号缺口和 S/E 状态关闭旧组并报告丢失。

### 组帧决策

- Single NAL 或 STAP-A 的各 NALU 可立即进入当前 AU 缓存，但不应在 Marker 前盲目提交最终帧。
- FU-A 必须首片 `S=1` 后才允许建立组；没有首片却收到中间/尾片时丢弃该 NALU。
- 发现序号缺口时标记当前 NAL/AU 不完整；如果缺口覆盖参考 NAL，优先检查 RTX/NACK 是否赶得上截止时间。
- Marker=1 是“访问单元结束”的提示，但异常抓包或非标准发送端可能错误设置；实现可结合 timestamp、解码器 AU 要求和超时做防御，不要用 Marker 替代 FU-A 的 E。
- 已过播放截止时间的残缺 AU 应丢弃，不把半个 NALU 交给解码器；若影响参考帧，向发送端反馈 PLI/FIR，等待可解码关键帧。

## 工程实现伪代码

```text
packetize(au, cfg):
    nalus = splitAnnexBOrAvcLengthPrefixed(au.bytes)
    packets = []
    for nal in nalus:
        if fitsSingleNal(nal, cfg.payloadBudget):
            packets += singleNalPacket(nal, au.timestamp)
        else if cfg.packetizationMode == 1 and canAggregate(nal, nalus):
            packets += stapAPackets(nalus, cfg.payloadBudget, au.timestamp)
            break
        else:
            packets += fuAPackets(nal, cfg.payloadBudget, au.timestamp)
    packets[-1].marker = true
    return assignRtpSequence(packets)

onRtpH264(packet):
    if !verifyRtpAndSrtp(packet) or packet.pt != negotiatedH264Pt:
        return drop()
    if type(packet.payload) in 1..23:
        emitNalu(singleNalPayload(packet))
    else if type(packet.payload) == 24:
        for (size, nalu) in parseStapAWithBounds(packet.payload):
            emitNalu(nalu)
    else if type(packet.payload) == 28:
        fu = parseFuA(packet.payload)
        if fu.start: assembly.open(packet.ssrc, packet.timestamp, packet.seq, fu)
        else if !assembly.acceptContiguousOrReordered(fu): assembly.markLost()
        if fu.end and assembly.complete(): emitNalu(assembly.close())
    else:
        return unsupportedPacketizationMode()
    auAssembler.insert(packet.timestamp, packet.marker)
```

生产实现应对每个长度字段做加法溢出和剩余长度检查，限制单个 NAL/AU 的最大字节数，限制同时打开的组帧数量，并在 SSRC/RID 切换时清理旧组，防止恶意/损坏包耗尽内存。

## 参数集、参考帧与恢复

SPS/PPS 不只是普通画面 NALU：它们决定解码器配置。收到 IDR 但没有匹配 SPS/PPS 时，不能假设解码器能恢复。参数集发生变化时，先按实现安全地刷新解码器，再接受新配置下的帧。

NACK/RTX 只在缺片尚未错过播放截止时间且发送缓存命中时有意义。一个 FU-A 缺中间片可能导致整个 NALU 不可用；若 NALU 属于参考帧，后续预测帧也可能受到影响。无法及时恢复时，应丢弃损坏 AU，并通过 [[PLI 与 FIR]] 请求关键帧。FEC 是否覆盖 H.264 payload 由具体 FEC 机制决定，不能在组帧器内假设一定可恢复。

## 标准与 WebRTC 实现的边界

- RFC 6184 规定 NAL 头、Single NAL、STAP/FU 结构、DON/交错模式和 RTP 时间/Marker 语义；不规定编码器如何选择 QP、GOP、关键帧间隔或具体 PLI 触发阈值。
- WebRTC 常见 `packetization-mode=1`、90 kHz 时钟、FU-A、STAP-A、禁止/限制 B 帧和对 PLI 的关键帧响应是工程组合，不等于 H.264 RTP 只支持这些。
- 浏览器/Native WebRTC 对 H.264 profile、level、SPS/PPS 带内策略、硬件编码器输出格式可能不同；应以 SDP、抓包和实际解码能力共同判断。

## 抓包验证与错误用例

Wireshark 中检查 `rtp.p_type`、`rtp.seq`、`rtp.timestamp`、`rtp.marker`，对 payload 首字节按 `type = byte & 0x1f` 分类。对 FU-A 进一步检查 indicator type=28、FU header 的 S/E/Type 和每片 sequence；对 STAP-A 按 16 位网络序长度逐项走边界。

应测试：

- 小 NAL 单包、多个小 NAL 的 STAP-A、超大 NAL 的 FU-A；验证重组出的 NAL 头与原始 NAL 一致。
- FU-A 缺首片、中间片、尾片，乱序、重复、跨 timestamp 拼接和 marker 错误。
- packetization-mode=0 收到 STAP-A/FU-A 时拒绝；mode=1 收到 mode=2/DON 结构时不能误解析。
- SPS/PPS 缺失、profile/level 不匹配、IDR 丢失、SSRC/RID 切换和参数集更新。
- MTU 减小后验证分片数量变化，确保没有 IP 层大分片；SRTP tag/头扩展开销也必须计入预算。

常见症状：黑屏但 RTP 包持续到达，优先查 FU-A 首尾/序号、SPS/PPS、profile-level-id 和 SRTP 解密；只有关键帧后恢复则常见于参考帧链已损坏；画面撕裂或跨帧内容混合则查 timestamp/AU assembler 和 STAP-A 长度解析。

## 阅读导航

- **上一篇：** [[RTP 流标识与复用]]
- **下一篇：** [[Opus RTP 负载格式]]
- **所属专题：** [[00-知识地图/专题说明/09 RTP 打包、解析与传输|09 RTP 打包、解析与传输]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 编码：[[H264]] · [[GOP 与参考帧]]
- 承载：[[RTP]] · [[RTP 流标识与复用]]
- 恢复：[[NACK]] · [[RTX]] · [[PLI 与 FIR]]
- 协商：[[SDP]]
- 安全：[[SRTP]]

## 参考资料

- RFC 6184，RTP Payload Format for H.264 Video。
- RFC 3550，RTP: A Transport Protocol for Real-Time Applications。
- ITU-T H.264 / ISO/IEC 14496-10，NAL 单元、访问单元和解码语义。
