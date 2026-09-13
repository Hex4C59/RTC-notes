---
aliases: [RTCP packet calculation and scheduling]
tags: [rtc/concept, rtc/transport, rtc/feedback]
type: concept
status: growing
---

# RTCP 报文计算与调度状态机

> [!tip] 阅读提示
> **前置：** 无强前置；可先从本篇一句话说明读起。
> **初读：** 先读「一句话说明」和「公共头与报文类型」，弄清 RTCP 报文计算与调度状态机 解决什么问题、不负责什么。
> **深入：** 「每个 SSRC 的接收状态」、「周期报告调度状态机」、「可观测与测试」 在实现、联调或排障时再读。

## 一句话说明

RTCP 不只是“定期上报丢包率”。实现需要维护每个 SSRC 的收发统计，正确计算 SR/RR 报告块，在有限控制带宽内调度周期报告与即时反馈，并在 SRTCP、rtcp-mux 和会话生命周期中保持状态一致。

## 公共头与报文类型

RTCP 公共头包含 Version、Padding、Count/FMT、Packet Type，以及以 32 位字为单位、减一编码的 Length。一个 UDP 数据报可以包含多个 RTCP 子包，解析器必须按每个子包的长度推进，不能把 UDP 边界误当成单一 RTCP 包边界。

- SR：发送者 SSRC、NTP 时间、对应 RTP 时间、累计发送包数和负载字节数，后面可带接收报告块。
- RR：报告者 SSRC 和零到多个接收报告块。
- SDES：携带 CNAME 等源描述，用于 RTP 会话关联；它不替代业务用户认证。
- BYE：声明 SSRC 离开 RTP 会话，不等同于信令连接必然关闭。
- RTPFB/PSFB：承载 NACK、PLI、FIR、TWCC 等反馈，具体 FMT/FCI 由扩展规范解释。

## 每个 SSRC 的接收状态

至少维护：基础扩展序号、最高扩展序号、已收唯一包数、上次报告时的期望/接收数、抖动估计、最近 SR 的 LSR 以及本地接收时刻。重复包不重复增加唯一接收数。

```text
expected = extended_max_seq - base_seq + 1
cumulative_lost = expected - received_unique

expected_interval = expected - expected_prior
received_interval = received_unique - received_prior
lost_interval = expected_interval - received_interval
fraction_lost = clamp(lost_interval / expected_interval, 0..255)，以 1/256 表示
```

累计丢包字段是有符号 24 位。晚到包会让累计丢包在后续报告中下降；这可能是正确统计语义。SSRC 重启、冲突和异常大序号跳变必须创建新代次或重新初始化，不能污染旧窗口。

## 到达间隔抖动

先把本地到达时刻换算到该负载的 RTP 时钟。对相邻包定义：

```text
D(i-1,i) = (arrival_i - arrival_i-1) - (rtp_ts_i - rtp_ts_i-1)
J = J + (abs(D) - J) / 16
```

J 的单位是媒体时钟 tick，不是固定毫秒。音频 48 kHz 与视频 90 kHz 的数值必须分别按时钟率换算。重传、乱序和同一视频帧的多个包会影响采样，具体更新规则应按 RFC 和所用实现验证。

## LSR、DLSR 与 RTT

收到 SR 后保存其 NTP 时间戳中间 32 位作为 LSR，并记录本地到达时刻。发送 RR 时，DLSR 表示从收到该 SR 到生成报告的延迟，单位为 `1/65536` 秒。原发送端收到 RR 时可估算：

```text
RTT = A - LSR - DLSR
```

A 也使用收到 RR 时的 NTP 中间格式。必须处理模回绕和单位；没有有效 SR、LSR=0 或跨会话状态时不能输出伪 RTT。这个 RTT 描述报告路径，不是端到端播放延迟。

## SR 的 NTP/RTP 映射

生成 SR 时，应在同一采样点建立参考 NTP 时间与对应 RTP 时间的映射，不能分别读取后跨越长队列。接收端用连续映射点把媒体时钟关联到参考时间，用于音画同步和漂移观测。

内部先扩展 RTP 时间戳再拟合映射。墙上时钟跳变时，单调计时和 NTP 映射的职责要分开；不能用可跳变系统时间直接测任务排队和 RTT。

## 周期报告调度状态机

RTCP 周期不是写死的固定定时器。它受成员数、发送者比例、平均 RTCP 包大小、RTCP 带宽、最小间隔、随机化和 reconsideration 影响。成员骤增时重新考虑发送时间，可以避免大量端点同时报告。

```text
Idle
  -> 计算随机化发送时间 -> Scheduled
Scheduled
  ├─ 成员或带宽变化 -> Reconsider -> Scheduled
  ├─ 到期 -> Build -> ProtectWithSRTCP -> Send -> Scheduled
  └─ 会话结束 -> SendBYEIfNeeded -> Closed
```

WebRTC 常使用 AVPF/SAVPF 的早期反馈和 reduced-size RTCP 能力。是否允许单独反馈、何时发送复合包，必须结合 SDP profile 与实现版本，不能套用单一固定规则。

## 即时反馈与限流

NACK、PLI/FIR 和 TWCC 比周期 RR 更紧急，但仍受带宽与抑制规则约束。NACK 要合并序号并限制重复请求；PLI/FIR 要合并相近请求，避免关键帧风暴；TWCC 的覆盖窗口、反馈频率和包大小都要有界。

反馈若在 Pacer 或 Socket 中排队，其控制价值会下降。需要分别记录生成、入队、实际发送和对端接收时间，而不能只记录“创建过反馈”。

## 安全解析流程

1. 完成 SRTCP 认证、重放检查和解密。
2. 验证公共头版本、声明长度、padding 与数据报剩余长度。
3. 逐子包按 PT/FMT 分派，验证报告块数、SSRC 归属和 FCI 长度。
4. 未知但长度合法的子包可以跳过；任何越界都不能从猜测位置继续解析。
5. 只在整项状态验证成功后提交统计或控制事件，避免半包修改控制器状态。

发送侧先冻结一致的统计快照，再编码长度和 padding，最后交给 SRTCP。保护完成后不得修改明文字段。

## 生命周期与并发

- 每个 SSRC 的统计由单一序列更新，或通过原子快照生成报告。
- SSRC 切换、传输重建和重新协商时，旧 LSR/DLSR、序号与抖动状态不能进入新代次。
- RTP 发送包数与 octet count 的协议口径不含所有线路头；计算带宽时要另外统计 IP/UDP/RTP/SRTP 等实际字节。
- SRTCP 使用自己的 index 和重放状态，不能复用 RTP sequence/ROC。

## 可观测与测试

保存每个 SR/RR 的 SSRC、报告范围、fraction/cumulative lost、最高扩展序号、jitter、LSR、DLSR、生成和发送时间。抓包重算字段，并与 Stats 的累计值及区间增量对照。

测试覆盖序号回绕、乱序晚到、重复包、无有效 SR、NTP 中间格式回绕、成员数骤增、反馈洪泛、复合包截断、未知子包、SRTCP 重放和 SSRC 重启。

## 常见误区

- fraction lost 是会话累计丢包率：它描述本报告区间。
- jitter 是毫秒：它使用相应 RTP 时钟单位。
- RR 能直接测单向延迟：常见 LSR/DLSR 关系给出报告往返估计。
- RTCP 越频繁越好：反馈占用带宽与 CPU，也可能触发恢复风暴。

## 阅读导航

- **上一篇：** [[QoS 与 QoE]]
- **下一篇：** [[00-知识地图/专题说明/11 接收端 Jitter Buffer 与 NetEQ|11 接收端 Jitter Buffer 与 NetEQ]]（本专题配套详解已读完，进入下一专题说明）
- **所属专题：** [[00-知识地图/专题说明/10 RTCP 与质量反馈|10 RTCP 与质量反馈]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]


> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 上位：[[RTCP]]
- 媒体统计：[[RTP]]、[[RTP 流标识与复用]]
- 即时反馈：[[NACK]]、[[PLI 与 FIR]]、[[TWCC]]
- 安全：[[SRTP 与 SRTCP 报文保护]]
- 同步：[[时钟与时间戳]]、[[音视频同步]]

## 参考资料

- RFC 3550，RTP: A Transport Protocol for Real-Time Applications。
- RFC 4585，Extended RTP Profile for RTCP-Based Feedback；RFC 5506，Reduced-Size RTCP。
