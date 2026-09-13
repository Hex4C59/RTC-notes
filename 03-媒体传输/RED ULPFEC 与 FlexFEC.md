---
aliases: [RED, ULPFEC, FlexFEC]
tags: [rtc/concept, rtc/transport, rtc/resilience]
type: concept
status: growing
---

# RED ULPFEC 与 FlexFEC

> [!tip] 阅读提示
> **前置：** 无强前置；可先从本篇一句话说明读起。
> **初读：** 先读「一句话说明」和「三者的定位」，弄清 RED ULPFEC 与 FlexFEC 解决什么问题、不负责什么。
> **深入：** 「发送策略状态机」、「接收恢复状态机」、「工程实现」 在实现、联调或排障时再读。

## 一句话说明

RED、ULPFEC 和 FlexFEC 经常一起被简称为“FEC”，但职责不同：RED 是冗余负载封装格式，ULPFEC 和 FlexFEC 是产生及描述恢复数据的方案。是否能恢复取决于 SDP 协商、保护集合、丢失模式、到达时限和接收实现。

## 三者的定位

| 机制 | 主要作用 | 关键边界 |
| --- | --- | --- |
| RED | 在一个 RTP payload 中封装一个主负载及若干冗余负载块 | 组织负载，不自行产生纠错符号 |
| ULPFEC | 用 FEC 包保护一组媒体 RTP 包 | 常与 RED 组合承载，保护关系受 mask 约束 |
| FlexFEC | 使用独立修复流和更灵活的掩码保护媒体流 | 需要 repair SSRC 与 protected SSRC 关联 |

它们都不是可靠传输保证。恢复包晚于视频帧播放截止，即使数学上可恢复，也没有实时价值。

## RED 负载字段

RED payload 由若干冗余块头、一个主块头和对应数据块组成。块头的 F 位表示后面是否还有头；冗余块携带 Payload Type、相对主时间戳的 timestamp offset 和 block length。最后的主块头只有 F=0 和主 Payload Type。

解析器应先完整验证头链和所有 block length，再暴露任何数据块。timestamp offset 位宽有限，过旧媒体不能无限装入同一 RED 包。动态 PT 的含义来自 SDP，不能硬编码为 Opus 或 ULPFEC。

## ULPFEC 保护集合

ULPFEC 修复包使用序号基准、长度恢复、保护长度和 packet mask 等信息描述它保护哪些媒体序号。发送端对保护集合的若干 RTP 头字段、长度和 payload 生成恢复信息；接收端在满足格式规定且缺失数量仍可恢复时重建原包。

```text
Collect media -> choose protection set -> build recovery packet
Receive media/FEC -> evaluate mask
  ├─ 无损失 -> 到期后释放修复状态
  ├─ 满足可恢复条件 -> reconstruct -> 回到正常 RTP 接收入口
  └─ 缺失过多或过期 -> recovery failed
```

不同 mask 和多个修复包组合的能力应按规范与实现验证，不能把“有一个 FEC 包”概括为“必然能恢复任意一个丢包”。

## FlexFEC 独立修复流

FlexFEC 通常使用独立 repair SSRC，并通过 SDP `ssrc-group:FEC-FR` 等关系关联受保护媒体。负载描述 protected SSRC、序号基准和包掩码，可更灵活地表达保护范围。

独立序号空间意味着接收端分别维护修复流与媒体流的 RTP 去重和重排状态。恢复出的媒体包必须回到原媒体 SSRC 的统一接收入口，重新经过序号、重复、组帧和截止判断，不能直接交给解码器。

## 与 SRTP 的边界

FEC 在协议栈中的确切位置、哪些头字段参与恢复，以及修复包如何受到 SRTP 保护，由具体负载格式、profile 和实现决定。应使用经过验证的 RTP/FEC/SRTP 库，不能对密文随意异或后假设互操作。

接收端对实际收到的报文先执行相应链路安全处理，再在规定层恢复媒体包。恢复结果不能绕过 SSRC、序号、长度、重复和重放语义。

## 发送策略状态机

```text
Disabled
  └─ 协商支持且预算允许 -> Enabled
Enabled
  ├─ 丢包/RTT 上升且保护有价值 -> IncreaseProtection
  ├─ 线路过载或稳定低损 -> DecreaseProtection
  ├─ 关键参考帧 -> 临时提高保护优先级
  └─ 协商或流代次变化 -> Flush -> Reconfigure
```

保护率调整必须与 Pacer、编码码率和 RTX 共享总预算。拥塞时盲目增加 FEC 会进一步填满链路，使原始媒体和修复包一起丢失。

## 接收恢复状态机

每个保护集合维护 protected SSRC、序号范围、媒体包 bitmap、修复包集合、首次/最近到达时间、可恢复条件和截止时间。状态同时受包数、字节数、序号跨度与时间限制。

```text
Collecting
  ├─ 新媒体或修复包 -> Reevaluate
  ├─ 可唯一恢复 -> Recovering -> Reinject -> Complete
  ├─ 原始包已全部到达 -> Complete
  └─ 超过窗口/播放截止 -> Expired
```

恢复后要区分原始收到、FEC 恢复、RTX 恢复、重复恢复和恢复后过期。最终未恢复包数与用户可见损坏不是同一指标，一个关键参考包可能比多个可丢弃包更重要。

## 与 NACK、RTX 和 Opus FEC 配合

- RTT 小且剩余时间充足时，RTX 可能比持续高比例冗余更省带宽。
- RTT 大或突发丢包时，及时到达的 FEC 可以避免一次往返。
- Opus in-band FEC 是编解码负载内部能力，不是 ULPFEC/FlexFEC。
- 一个包被 FEC 恢复后，应抑制后续 RTX 的重复交付；已发出的 RTX 晚到时仍需统一去重。

组合决策的共同约束是播放截止和总线路预算，而不是把支持的机制全部打开。

## SDP 与流关联

核对动态 Payload Type、RED `rtpmap/fmtp`、ULPFEC/FlexFEC 能力、repair SSRC 和 protected SSRC。双方都出现某个 codec 名称并不足够，还要确认负载格式、时钟、流关联和实现支持范围。

协商改变或 SSRC 重启时清理旧保护集合。旧修复包不能作用到新代次中碰巧相同的 16 位序号。

## 工程实现

- FEC 编码位于 RTP 打包之后、Pacing 之前的明确层次，保存媒体到修复包的关联。
- 保护窗口不能阻塞实时媒体发送；生成失败时按策略降级。
- 恢复处理按流串行，或使用不可变集合快照，避免媒体与修复包并发到达造成重复交付。
- 严格验证块头、mask、block length 和序号范围；畸形包不能触发越界和无界分配。

## 可观测与测试

记录 RED/repair 收发字节、受保护媒体字节、保护集合大小、原始损失、可恢复、成功恢复、失败、重复和过期数量。按关键帧/普通帧、随机/突发丢包分别统计恢复后的解码和冻结结果。

测试覆盖 RED 长度越界、动态 PT 错配、序号回绕、集合缺一/缺多包、修复包乱序、repair SSRC 错配、FEC 与 RTX 同时到达、带宽骤降和协商重建。

## 常见误区

- RED 就是 FEC 算法：RED 主要是负载封装。
- 增加 20% 冗余就一定恢复 20% 丢包：恢复取决于丢失分布和保护集合。
- FEC 不增加延迟：收集集合、等待修复包和计算均占时间。
- 恢复出 RTP 包就代表画面恢复：还需满足帧完整性、参考依赖与播放截止。

## 阅读导航

- **上一篇：** [[FEC]]
- **下一篇：** [[带宽估计]]
- **所属专题：** [[00-知识地图/专题说明/12 丢包恢复、带宽估计与拥塞控制|12 丢包恢复、带宽估计与拥塞控制]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 上位：[[FEC]]、[[丢包恢复策略]]
- 并用：[[NACK]]、[[RTX]]
- 接收：[[视频 RTP 接收与组帧状态机]]
- 预算：[[Pacing]]、[[带宽分配]]
- 安全：[[SRTP 与 SRTCP 报文保护]]

## 参考资料

- RFC 2198，RTP Payload for Redundant Audio Data。
- RFC 5109，RTP Payload Format for Generic Forward Error Correction。
- RFC 8627，RTP Payload Format for Flexible Forward Error Correction。
