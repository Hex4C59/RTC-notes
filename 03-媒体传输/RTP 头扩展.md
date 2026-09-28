---
aliases: [RTP Header Extensions, RFC 8285, MID, RID]
tags: [rtc/concept, rtc/transport, rtc/protocol, rtc/feedback]
type: concept
status: growing
---

# RTP 头扩展

> [!tip] 阅读提示
> **前置：** [[RTP]]；有 [[SDP]] 更好。
> **初读：** 读到「初读到此为止」就停。弄清：扩展是固定头旁边的「协商挂件」；ID 含义来自 SDP `a=extmap`，不是全球固定编号。
> **深入：** one-byte/two-byte 解析、收发状态机和伪代码，做抓包或写解析器时再读。

## 一句话说明

RTP 固定头只能表达 PT、序号、时间戳和 SSRC。WebRTC 通过 RTP header extension 增加媒体线、编码层、音量、方向和传输观测信息。扩展不是 RTP payload，也不是 SDP 的替代品；它的存在、ID 和格式要由 SDP `a=extmap` 协商或由明确的会话配置允许。

## 先记住这三句

1. 固定头 `X=1` 才有扩展；扩展内容由 **SDP 把「整数 ID ↔ URI」** 谈好，不能跨会话硬编码 ID。
2. 常见挂件：`MID`（哪条 m-line）、`RID`（哪一层）、`audio-level`、`TWCC` 序号、`abs-send-time`、画面方向……
3. 扩展通常在 SRTP 认证范围内；未认证的 MID/RID/TWCC 不能信。

## 外层长什么样（初读版）

```text
| 16-bit profile | 16-bit length（单位：32-bit 字） | extension bytes ... |
```

- `length` 是 **字数**，总字节 = `length * 4`。
- 常见 profile：`0xBEDE` = one-byte 元素头；`0x1000` = two-byte 元素头。
- 未知 profile 可按策略跳过，**不能把扩展当 payload**。

> [!example] 和固定头的关系
> 固定头像信封上的邮编和收件人编号；扩展像贴纸：贴纸编号（ID）在开会（SDP）时说好「1 号贴纸 = MID」，换一场会贴纸编号可能完全不同。

## SDP 怎么挂上扩展

```sdp
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:2 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:3 urn:ietf:params:rtp-hdrext:transport-wide-cc-02
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id
```

`a=extmap:<id> [direction] <URI>`：把当前 m-line 的整数 ID 映射到扩展 URI。`a=extmap-allow-mixed` 只表示允许混用 one/two-byte 封装，不等于某个 URI 已启用。

## 常见扩展一眼表

| URI/简称 | 干什么 | 别踩的坑 |
| --- | --- | --- |
| MID | BUNDLE 里标 m-line | 字符串，不是 PT |
| RID | Simulcast 编码层 | 缺失时别默认「最高层」 |
| repaired-rtp-stream-id | RTX 对应原 RID | 和 RTX/SFU 映射绑定 |
| audio-level | VAD/音量提示 | 对数电平，不是 PCM 幅度 |
| abs-send-time | 发送时刻观测 | 实验 URI；≠ RTP timestamp |
| transport-wide-cc | TWCC 传输序号 | 与 RTP seq 是两套空间；见 [[TWCC]] |
| video-orientation | 旋转/镜像提示 | 改渲染，不改像素 |
| framemarking | 帧边界/参考提示 | 看是否协商启用 |

MID/RID 路由细节见 [[RTP 流标识与复用]]。

---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面是工程展开与排障细节（字段、指标、状态流），**第二轮或遇到具体问题时再读**；第一次直接点文末「第一次阅读下一站」即可。

## One-byte / Two-byte 细节

### One-byte（profile 常为 `0xBEDE`）

每个元素首字节：高 4 位 ID，低 4 位 `len_minus_one`，数据长度 = `low_nibble + 1`。

- ID=0：padding。
- ID=1..14：普通元素，长度最多 16 字节。
- ID=15：保留，不能作普通 ID。

### Two-byte（profile 常为 `0x1000`）

先 8 位 ID，再 8 位长度；数据最长 255 字节。ID=0 的 padding 按 RFC 8285 处理。`extmap-allow-mixed` 是否支持看协商与实现。

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

1. 只添加当前 m-line 已协商且允许发送的元素。
2. 用准确的元素长度编码；one-byte 超过 16 字节时改用 two-byte 或省略，不能截断。
3. 选择 profile，填充到 32 位边界；`length` 写入 32-bit word 数。
4. MID/RID/transport sequence 等用会话状态，不在每包重新分配 ID。
5. 完整 RTP（含扩展）交给 SRTP；扩展在认证范围内，加密后不能改。

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

先完成 SRTP 认证/解密，再信任扩展。未知扩展通常可跳过；未知 MID/RID 冲突、非法长度或未协商的关键路由扩展应按策略丢包。

### 与流解复用的关系

BUNDLE 中 MID 关联 m-line，RID 关联同一媒体线上的编码层。它们不能替代 SSRC：接收状态至少按 `(MID, SSRC)`，多层时可扩展为 `(MID, SSRC, RID)`。SFU 改写 MID/RID 或 SSRC 时，必须同时更新路由和反馈映射。

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

实际实现要防止 `words * 4` 整数溢出，限制扩展总长度、元素数量和 MID/RID 字符串长度。

## 具体字段检查

- MID/RID：按协商 ID 查表，比较 ASCII；RID 缺失时不能自动归入「最高层/默认层」。
- Audio level：长度必须 1 字节；bit7=V，bit6..0=level。
- TWCC：长度必须 2 字节，网络序 16 位 transport-wide sequence；与 RTP sequence 两套回绕空间。
- abs-send-time：3 字节固定点（约 18 位整数/6 位小数），不要当毫秒整数。
- Video orientation：校验保留位后再解释旋转/镜像。

## 标准与 WebRTC 实现的边界

- RFC 8285 定义通用封装；单个 URI 语义来自相应 RFC/draft。
- MID、RID、TWCC、abs-send-time 等的具体 URI、默认 ID、是否强制发送以 SDP 和实现版本为准。
- 抓包工具认出「看起来像 TWCC」不代表对端已协商并会消费。
- 使用 SRTP 时扩展通常随 RTP 一起认证/加密；SFU 若需读改，必须在合法终止/转发模型中处理。

## 抓包验证与错误用例

先从 SDP 导出每个 m-line 的 `extmap`，再检查 RTP `X`、profile、word length、element ID 和字段长度。逐包关联 MID/SSRC/PT/RID。

应测试：无扩展、one-byte、two-byte、混用与 padding；长度不是 4 倍数、越界、ID=15、未知 profile；MID/RID 缺失冲突、Audio Level 错长度、TWCC 回绕、orientation 保留位；SRTP 失败后篡改扩展；SFU 改写后下游反馈映射仍一致。

常见症状：BUNDLE 路由错 → 查 MID ID；带宽估计异常 → 查 TWCC ID/长度/回绕；方向错 → orientation；能解码但统计全零 → 扩展未协商或把 RTP seq 当 TWCC。

## 阅读导航

- **上一篇：** [[Opus RTP 负载格式]]
- **下一篇：** [[视频 RTP 接收与组帧状态机]]
- **所属专题：** [[00-知识地图/专题说明/09 RTP 打包、解析与传输|09 RTP 打包、解析与传输]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]
- **第一次阅读下一站：** [[RTP 流标识与复用]]（MID/RID/SSRC 怎么一起解复用）


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
