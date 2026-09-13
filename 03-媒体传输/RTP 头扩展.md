---
aliases: [RTP Header Extensions, RFC 8285, MID, RID]
tags: [rtc/concept, rtc/transport, rtc/protocol, rtc/feedback]
type: concept
status: growing
---

# RTP 头扩展

> [!tip] 阅读提示
> **前置：** [[RTP]]、[[SDP]]。
> **初读：** 先读“外层结构”和“SDP 协商与常见扩展”，理解扩展 ID 如何通过协商关联语义。
> **深入：** 字段解析、具体字段检查及收发状态机留到抓包或实现解析器时阅读。

## 一句话说明

RTP 固定头只能表达 PT、序号、时间戳和 SSRC。WebRTC 通过 RTP header extension 增加媒体线、编码层、音量、方向和传输观测信息。扩展不是 RTP payload，也不是 SDP 的替代品；它的存在、ID 和格式要由 SDP `a=extmap` 协商或由明确的会话配置允许。

## 外层结构

RTP 固定头中的 `X=1` 表示存在扩展头。RFC 8285 常见形式为：

```text
| 16-bit profile | 16-bit length (32-bit words) | extension bytes ... |
```

扩展总字节数是 `length * 4`，不是 length 字节。解析器必须先检查剩余长度，再读取扩展元素；未知 profile 可按会话策略安全跳过，不能把扩展内容当 payload。

### One-byte header format

profile 通常为 `0xBEDE`。每个元素的首字节：高 4 位是 ID，低 4 位是 `len_minus_one`，所以元素数据长度为 `low_nibble + 1`。

- ID=0：一个字节 padding，不带数据。
- ID=1..14：扩展元素 ID，长度最多 16 字节。
- ID=15：保留，不能作为普通元素 ID。

### Two-byte header format

常见 profile 为 `0x1000`。每个元素先有 8 位 ID，再有 8 位数据长度；数据长度可以达到 255 字节。

- ID=0：padding，后续长度字节语义不同，解析时按 RFC 8285 处理。
- ID=1..255：元素 ID；具体保留值和空元素处理按 RFC 8285，不应凭经验把所有未知 ID 当普通数据。

`extmap-allow-mixed` 允许会话中使用 one-byte 和 two-byte 形式，但是否支持要看协商和实现；不要看到 `0xBEDE` 就假设所有包都能混用。

## SDP 协商与常见扩展

示例：

```sdp
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:2 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:3 urn:ietf:params:rtp-hdrext:transport-wide-cc-02
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id
```

`a=extmap:<id> [direction] <URI>` 把当前 m-line 的整数 ID 映射到扩展 URI；ID 只在该 RTP 会话/媒体线的协商上下文中有意义，不能跨会话硬编码。`a=extmap-allow-mixed` 是扩展格式协商能力，不代表具体扩展 URI 已启用。

### WebRTC 常见扩展字段

| URI/简称 | 负载格式与用途 | 标准/实现边界 |
| --- | --- | --- |
| `urn:ietf:params:rtp-hdrext:sdes:mid` / MID | m-line 标识，通常是短 ASCII 字符串 | RFC 8843/8285 体系；WebRTC BUNDLE 路由核心 |
| `urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id` / RID | 发送编码层标识，ASCII RID | RFC 8852；常用于 Simulcast |
| `urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id` | RTX 修复流对应的原 RID | RFC 8852；与 RTX/SFU 实现关联 |
| `urn:ietf:params:rtp-hdrext:ssrc-audio-level` | 1 字节：V bit=voice activity，低 7 位是音量 level，通常为 -dBov 表示 | RFC 6464；VAD/音量展示，不是音频采样值 |
| `http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time` | 24 位固定点发送时间，WebRTC 历史带宽估计用途 | WebRTC 常见实验 URI；不能替代 RTP timestamp/NTP |
| `http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01` 或 `...transport-wide-cc-02` | 16 位 transport-wide sequence number | WebRTC 常见 TWCC 约定；反馈格式和算法另见 [[TWCC]]/[[GCC]] |
| `urn:3gpp:video-orientation` | 1 字节方向/镜像标志 | RFC 7742/3GPP 相关；渲染器使用，不改变像素本身 |
| `urn:ietf:params:rtp-hdrext:framemarking` | 帧起止、独立帧、参考关系等标志 | RFC 8853；具体发送器是否启用取决于协商 |
| `urn:ietf:params:rtp-hdrext:toffset` | RTP timestamp offset | RFC 5450；不应与 WebRTC 所有时间扩展混为一谈 |

MID/RID 是字符串，不能把字符值直接当作 RTP PT。TWCC/abs-send-time 是传输观测字段，不等于接收端的媒体时间戳。Audio level 的低 7 位是对数电平编码，不能按线性 PCM 幅度直接解释。

## 发送状态机

```text
Negotiated extensions
  -> Allocate per-session IDs
  -> Build element list for packet
  -> Choose one-byte/two-byte profile
  -> Pad to 32-bit boundary
  -> Set RTP X=1 and extension length
  -> Add payload / SRTP protect
```

发送器应为每个 RTP 会话保存 URI->ID 映射和发送方向权限。构造每包扩展时：

1. 只添加当前 m-line 已协商且允许发送的元素。
2. 用准确的元素长度编码；one-byte 形式超过 16 字节时必须改用 two-byte 或拆分/省略，不能截断。
3. 选择扩展 profile，填充到 32 位边界；`length` 写入 32-bit word 数。
4. 对 MID/RID/transport sequence 等字段使用会话状态，不在每包重新分配 ID。
5. 把完整 RTP（含扩展）交给 SRTP 保护；扩展位于认证范围内，不能在加密后修改。

## 接收状态机

```text
RTP parse fixed header
  -> if X=0: no extensions
  -> validate profile + word length
  -> iterate elements with bounds checks
  -> ID -> negotiated URI mapping
       | known -> validate exact field length and consume
       | unknown -> skip/count (or reject by policy)
  -> use MID/RID/audio-level/TWCC in media state
```

接收器必须先完成 SRTP 认证/解密，再信任扩展字段。对每个元素检查：profile 是否支持、ID 是否有映射、长度是否符合该 URI 的格式、字符串是否满足字符/最大长度约束、TWCC 是否进入正确的 transport state。未知扩展通常可安全跳过以保证互操作，但未知的 MID/RID 冲突、非法长度或未协商的关键路由扩展应计入异常并按安全策略丢包。

### 与流解复用的关系

在 BUNDLE 中，MID 将包关联到 m-line；RID 将同一媒体线上的编码层关联到 simulcast/RID 状态。它们不能替代 SSRC：接收状态仍至少按 `(MID, SSRC)`，多层时可扩展为 `(MID, SSRC, RID)`。SFU 改写 MID/RID 或 SSRC 时，必须同时更新路由和反馈映射。

## 字段解析伪代码

```text
parseExtensions(rtp):
    if !rtp.extension: return {}
    require rtp.remaining >= 4
    profile = readU16()
    words = readU16()
    bytes = words * 4
    require bytes <= rtp.remaining
    end = cursor + bytes
    result = {}
    while cursor < end:
        if profile == 0xBEDE:
            h = readU8()
            if h == 0: continue                 # one-byte padding
            id = h >> 4
            require id != 15
            len = (h & 0x0f) + 1
            require cursor + len <= end
        else if profile == 0x1000:
            id = readU8(); len = readU8()
            if id == 0: skipTwoBytePadding(len); continue
            require cursor + len <= end
        else:
            return unknownProfile(bytes)         # skip or reject by policy
        uri = negotiatedUriForId(id)
        if uri != null: result[uri] = validateAndDecode(uri, readBytes(len))
        else: cursor += len                     # preserve forward compatibility
    require cursor == end
    return result
```

实际实现要防止 `words * 4` 整数溢出，限制扩展总长度、元素数量和 MID/RID 字符串长度，并在解析失败时保证 cursor 不会落在 RTP payload 中间。示例中 two-byte padding 的处理需严格按 RFC 8285，不可把 ID=0 的字节一概当普通元素。

## 具体字段检查

- MID/RID：按协商 ID 查表，比较 ASCII 字符串；RID 缺失时不能把包自动归入“最高层/默认层”。
- Audio level：长度必须为 1 字节；bit7 是 V，bit6..0 是 level。它适合 VAD/界面电平，不是精确声压计量。
- TWCC：长度必须为 2 字节，按网络序读取 16 位 transport-wide sequence；它与 RTP sequence 是两套回绕空间。
- abs-send-time：读取 3 字节固定点值，必须保留其 18 位整数/6 位小数语义；不要当作毫秒整数。
- Video orientation：校验保留位，再解释旋转/镜像位；渲染器应把它和实际画面尺寸、摄像头方向结合。

## 标准与 WebRTC 实现的边界

- RFC 8285 定义 one-byte/two-byte 通用封装和协商方式；单个 URI 的字段语义来自相应扩展 RFC 或 IETF draft。
- MID、RID、TWCC、abs-send-time、音频电平和视频方向的具体 URI、默认 ID、是否强制发送都不是固定全球常数，必须以 SDP 和实现版本为准。
- WebRTC 可能启用实验 URI 或历史 draft URI；抓包工具识别出“看起来像 TWCC”不代表另一端已协商并会消费它。
- RTP header extension 不是端到端机密性边界的例外：使用 SRTP 时它通常随 RTP 一起认证/加密；中间 SFU 若需读取或改写，必须在合法的终止/转发模型中处理。

## 抓包验证与错误用例

先从 SDP 导出每个 m-line 的 `extmap`，再在 Wireshark/自研解析器中检查 RTP `X` 位、profile、word length、element ID 和实际字段长度。逐包关联 MID/SSRC/PT/RID，确认 BUNDLE 的路由不依赖 PT 猜测。

应测试：

- 无扩展、`0xBEDE` one-byte、`0x1000` two-byte、`extmap-allow-mixed` 混用和末尾 padding。
- 扩展长度不是 4 的倍数、word length 超过剩余包、元素越界、ID=15、未知 profile、未知 ID。
- MID/RID 缺失/冲突、Audio Level 错长度、TWCC 回绕、abs-send-time 时间单位误读、orientation 保留位非零。
- SRTP 认证失败后篡改扩展，确认接收器不会消费未认证的 MID/RID/TWCC。
- SFU 改写 SSRC/MID/RID 后，检查下游 RTP、RTCP 反馈和统计映射仍一致。

常见症状：BUNDLE 包被路由到错误 m-line，先查 MID ID 是否按当前 SDP；带宽估计异常，查 TWCC ID/长度/反馈映射和 sequence 回绕；视频方向错误，查 orientation 是否被渲染器忽略或重复旋转；“包能解码但统计全为零”，常见于扩展未协商、ID 表过期或把 RTP sequence 当 TWCC。

## 阅读导航

- **上一篇：** [[Opus RTP 负载格式]]
- **下一篇：** [[视频 RTP 接收与组帧状态机]]
- **所属专题：** [[00-知识地图/专题说明/09 RTP 打包、解析与传输|09 RTP 打包、解析与传输]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 基础：[[RTP]] · [[RTP 流标识与复用]]
- 协商：[[SDP]]
- 反馈：[[TWCC]] · [[GCC]]
- 视频层：[[Simulcast]]
- 安全：[[SRTP]]

## 参考资料

- RFC 8285，A General Mechanism for RTP Header Extensions。
- RFC 8843，Negotiating Media Multiplexing Using the Session Description Protocol (BUNDLE)。
- RFC 6464，A RTP Header Extension for Client-to-Mixer Audio Level Indication。
- RFC 8852，RTP Stream Identifier Source Description Extension。
- RFC 6184，RTP Payload Format for H.264 Video（RTP 扩展与视频包化的联合排障参考）。
