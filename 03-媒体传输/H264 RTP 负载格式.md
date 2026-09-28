---
aliases: [H.264 over RTP, RFC 6184, AVC RTP payload]
tags: [rtc/concept, rtc/transport, rtc/video, rtc/protocol]
type: concept
status: growing
---

# H264 RTP 负载格式

> [!tip] 阅读提示
> **前置：** [[H264]]、[[RTP]]；有 [[SDP]] 更好。
> **初读：** 读到「初读到此为止」就停。弄清：一帧 ≠ 一个 NALU ≠ 一个 RTP 包；Single / STAP-A / FU-A 各自干什么。
> **深入：** SDP 细项、收发状态机和解析伪代码，打包/组帧或抓包练习时再读。

## 一句话说明

这篇笔记描述 H.264 NAL 单元如何映射到 RTP，依据 RFC 6184。H.264 码流的预测、变换和参考帧见 [[H264]]；这里重点是单 NALU、STAP-A/FU-A、访问单元组装和 WebRTC 实现边界。

## 先记住这三句

1. **图像/AU → NALU → RTP 包** 是三层；Marker=1 只提示「这一访问单元的包可能发完了」，不能代替「分片都齐了」。
2. 小 NALU 可单包；多个小 NALU 可 **STAP-A** 聚合；大 NALU 用 **FU-A** 分片（S/E 标记首尾）。
3. WebRTC 常见 `packetization-mode=1`；mode 0 不允许 STAP/FU，mode 2（交错/DON）主流路径通常不用。

## 用一句话说清

H.264 一帧常常很大，RTP 又不能无限大，所以要把编码结果**切成能塞进 UDP 的包**发出去；对端再按规则拼回一帧。

**第一次只需建立三类直觉：**

| 方式 | 人话 |
| --- | --- |
| 单 NALU | 一小片编码数据刚好一个 RTP 包 |
| FU-A 分片 | 一片太大，拆成多个 RTP 包再拼 |
| STAP 聚合 | 好几小片塞进同一个 RTP 包 |

**和 RTC：** 丢的是「片」不是「整段电影」——缺关键片才容易需要关键帧（PLI/FIR）。

（RFC 6184 字段表、防抖组帧细节在折叠线后。）

---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面先是「原初读区深文」（可跳过），再是工程细节；**第一次直接点文末「第一次阅读下一站」即可。**


## 初读展开（原初读区深文，第二轮再读）

> 下面是本篇原先堆在初读区的展开内容，已整体后移，避免第一次阅读过载。

## 四个不能混淆的边界

```text
图像/访问单元(AU) -> 一个或多个 NALU -> 一个或多个 RTP 包 -> UDP 数据报
```

一个访问单元可能包含 AUD、SPS、PPS、SEI 和一个或多个 slice NALU。一个小 NALU 可以放进一个 RTP 包；一个大 NALU 要拆成多个 FU-A 包；一个 RTP 包也可以用 STAP-A 聚合多个小 NALU。因此 RTP Marker 和包数不能直接当作「编码帧大小」。

## H.264 NAL 头（共用第一字节）

| 位 | 字段 | 作用 |
| --- | --- | --- |
| 7 | `F` | 应为 0；收到 1 通常表示非法/损坏 |
| 6..5 | `NRI` | 提示参考重要性，不等于完整恢复策略 |
| 4..0 | `Type` | 1..23=单 NAL；24=STAP-A；28=FU-A |

## 三种主要包化格式

### Single NAL Unit

NALU（不含 Annex-B 起始码）放得进 payload 预算时：

```text
| NAL header (1 byte) | RBSP/EBSP payload ... |
```

去掉 `00 00 01` / length-prefix 后再封装。Marker 通常在该 AU 最后一个 RTP 包置 1。

### STAP-A 聚合（mode=1）

```text
| STAP-A indicator (Type=24) | NAL size (16-bit) | NALU | ... |
```

每个 NALU 前是 16 位网络序长度。接收器必须循环检查长度，禁止越过 payload 末尾。STAP-A 内 NALU 同属一个 RTP timestamp/AU 语境。

### FU-A 分片

```text
| FU indicator (Type=28) | FU header (S/E/R/Type) | fragment bytes ... |
```

| 位 | 字段 | 含义 |
| --- | --- | --- |
| 7 | `S` | 首片 |
| 6 | `E` | 尾片 |
| 5 | `R` | 必须为 0 |
| 4..0 | `Type` | **原始** NALU type（不是 28） |

首片用 indicator 的 NRI + FU header 的 Type 重建原 NAL 头；同一 FU-A 共享 timestamp，接收端要按序号重排。

> [!example] 怎么记
> 单包 = 一整块砖直接装车；STAP-A = 几块小砖捆一袋；FU-A = 一块大砖锯成几片，首片写明「这是哪类砖」，尾片说「锯完了」。

## SDP 里先看这几项

```sdp
a=rtpmap:102 H264/90000
a=fmtp:102 packetization-mode=1;profile-level-id=42e01f;sprop-parameter-sets=...
```

- `packetization-mode=0`：只 Single NAL；`1`：Single + STAP-A + FU-A（WebRTC 常见）；`2`：交错/DON，主流通常不用。
- `profile-level-id` / `sprop-parameter-sets`：能力与 SPS/PPS 提示；带内还可能再发参数集，不能假设只看过 SDP 就永远够用。

---

## SDP 协商细节

```sdp
m=video 9 UDP/TLS/RTP/SAVPF 102
a=rtpmap:102 H264/90000
a=fmtp:102 packetization-mode=1;profile-level-id=42e01f;sprop-parameter-sets=Z0LgHtoCgPaE,aM4xUg==
```

- `a=rtpmap` 声明 H264 和 90 kHz RTP 时钟；PT 102 只是示例动态值。
- `profile-level-id` 的 6 个十六进制字符编码 profile、兼容性约束和 level；不能只比较字符串表面，且最终仍要检查实际解码能力。
- `sprop-parameter-sets` 是 base64 的 SPS/PPS 提示；实现还可能通过带内 RTP NAL 发送参数集。新订阅者/解码器重启时不能假设只看过 SDP 就永远拥有最新参数集。
- `level-asymmetry-allowed` 是常见的协商参数，涉及 offer/answer 两端 level 使用方式；不能把它当作 packetization-mode。

Offer/Answer 完成后，发送器只能使用对端接受的 packetization mode 和编码参数。PT 变化、SSRC 切换和重新协商都要更新接收路由状态。

RFC 6184 还定义 STAP-B、MTAP、FU-B 和 DON（Decoding Order Number）用于交错模式；WebRTC 主流路径通常协商 mode 1、使用 STAP-A/FU-A，不应把 mode 1 接收器伪装成支持 mode 2。

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
4. 同一 AU 的包使用同一 RTP timestamp；仅该 AU 最后一 RTP 包设置 Marker=1。
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

组帧器的 key 建议至少包含 `(SSRC, RTP timestamp, extended sequence window)`，实际 SFU/多层流还要加入媒体线和 RID。对 FU-A 维护：原始 NAL type、NRI、首片序号、最近序号、累计字节数、是否已缺片、开始到截止时间。

### 组帧决策

- Single NAL 或 STAP-A 的各 NALU 可立即进入当前 AU 缓存，但不应在 Marker 前盲目提交最终帧。
- FU-A 必须首片 `S=1` 后才允许建立组；没有首片却收到中间/尾片时丢弃该 NALU。
- 发现序号缺口时标记当前 NAL/AU 不完整；如果缺口覆盖参考 NAL，优先检查 RTX/NACK 是否赶得上截止时间。
- Marker=1 是「访问单元结束」的提示，但异常抓包或非标准发送端可能错误设置；实现可结合 timestamp、解码器 AU 要求和超时做防御，不要用 Marker 替代 FU-A 的 E。
- 已过播放截止时间的残缺 AU 应丢弃，不把半个 NALU 交给解码器；若影响参考帧，向发送端反馈 PLI/FIR，等待可解码关键帧。

更完整的接收流水见 [[视频 RTP 接收与组帧状态机]]。

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

生产实现应对每个长度字段做加法溢出和剩余长度检查，限制单个 NAL/AU 的最大字节数，限制同时打开的组帧数量，并在 SSRC/RID 切换时清理旧组。

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
- **第一次阅读下一站：** [[Opus RTP 负载格式]]（音频怎么装进 RTP）或 [[视频 RTP 接收与组帧状态机]]（收端怎么从包拼回帧）


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 编码：[[H264]] · [[GOP 与参考帧]]
- 承载：[[RTP]] · [[RTP 流标识与复用]]
- 恢复：[[NACK]] · [[RTX]] · [[PLI 与 FIR]]
- 协商：[[SDP]]
- 安全：[[SRTP]]
- 组帧：[[视频 RTP 接收与组帧状态机]]

## 参考资料

- RFC 6184，RTP Payload Format for H.264 Video。
- RFC 3550，RTP: A Transport Protocol for Real-Time Applications。
- ITU-T H.264 / ISO/IEC 14496-10，NAL 单元、访问单元和解码语义。
