---
aliases: [UDP, IP, Socket, MTU, RTC传输基础]
tags: [rtc/concept, rtc/transport, rtc/network]
type: concept
status: growing
---
# UDP、IP、Socket 与 MTU

> [!tip] 阅读提示
> **前置：** [[从 RTP 到网卡、路由器与物理链路]] 的初读区即可；有 [[RTP]] 更好。
> **初读：** 读到「初读到此为止」就停。弄清：UDP 数据报边界、五元组、以及 MTU/PMTU 为什么让 RTC 尽量别踩 IP 分片。
> **深入：** Socket 缓冲、PMTUD 状态机、DSCP/ECN、错误归因与抓包矩阵，联调时再读。

## 一句话说明

这篇笔记解释 RTC 媒体包从用户态发送接口到网络链路、再回到接收线程时，哪些字段、队列和状态真正参与了传输。它不把 UDP 当成“可靠传输协议”：UDP 只提供按端口区分的数据报服务，丢失、重复、乱序、拥塞和时限都需要 RTC 在 RTP/RTCP、SRTP、重传、FEC、抖动缓冲和拥塞控制层处理。

## 先记住这三句

1. **UDP 保留消息边界**：一次 `send` 对应一个数据报；IP 分片再重组后，对应用仍应是「一个数据报」，但分片途中丢一片就整报作废。
2. **RTC 常用路径是 RTP/SRTP over UDP**；决定「谁收到」的是五元组（协议 + 源/目的 IP + 源/目的端口），上面还要再按 SSRC/MID/RID 拆媒体。
3. **按路径 MTU 做包长预算**：以太网常见 1500 字节 IP MTU，扣掉 IP/UDP/RTP/SRTP/扩展/TURN 隧道后，媒体 payload 往往只剩一千出头——宁可小包，也别依赖 IP 分片。

## 用一句话说清

UDP 是「寄明信片」：发出去不保证对方一定收到、也不保证顺序。实时音视频大多选它，因为**宁可丢几张过期的明信片，也不要像挂号信那样死等重传**。

**第一次只需记住三样工具概念：**

| 词 | 人话 |
| --- | --- |
| IP | 寄到哪台机器 |
| 端口 / Socket | 寄到那台机器上的哪个程序入口 |
| MTU | 一条链路上「一包最大能多大」；太大就要拆或自己避开 |

## 和 TCP 差在哪（直觉）

- TCP：丢了会重传、保证顺序 → 延迟可能被拖长（队头阻塞）
- UDP：丢了上层自己决定要不要补 → RTC 用 NACK/FEC/降码率等手段自己管

## 一个生活例子

开会时你说了一句「今天…」，中间两个字丢了。实时系统往往**补最近的、或糊过去**，而不是把整句从开头重念三遍——那会让对话卡住。

（Socket API、PMTUD、分片黑洞等工程细节在折叠线后。）

---

> [!warning] 初读到此为止
> 上面这些已经够第一次阅读。下面先是「原初读区深文」（可跳过），再是工程细节；**第一次直接点文末「第一次阅读下一站」即可。**


## 初读展开（原初读区深文，第二轮再读）

> 下面是本篇原先堆在初读区的展开内容，已整体后移，避免第一次阅读过载。

## 在 RTC 协议栈中的位置

若还不清楚 IP、MAC、网关和交换机分别负责什么，先读 [[从 RTP 到网卡、路由器与物理链路]]。其中包含逐跳地址变化、ARP/NDP、Wi-Fi/以太网与物理层说明；本篇继续展开字段、Socket 队列和 MTU 的工程约束。

典型的媒体路径是：

```text
编码帧
  ↓ RTP 头 + 负载格式
SRTP 认证/加密
  ↓ 用户态 UDP socket
UDP 头
  ↓ IP 头
IPv4/IPv6
  ↓ 链路层与路由器
网络
```

接收方向反过来：网卡收到帧后，内核按目标地址和端口把 UDP 数据报放入 socket 接收队列；应用读出数据后，先验证 SRTP，再按 RTP 的 SSRC、MID、RID 和 Payload Type 分流。[[RTP]] 负责媒体包的序号与时间线，[[SRTP]] 负责机密性和完整性，[[ICE]] 负责选择可用的地址对；本篇只补它们下方的 IP/UDP/socket 传输基础。

## 一个 RTC 数据报的字节预算

### IPv4 + UDP

IPv4 的基础头为 20 字节，UDP 头固定 8 字节。因此，在没有 IPv4 选项时：

```text
应用负载上限 = 路径 MTU - 20（IPv4）- 8（UDP）
```

若发送的是 SRTP RTP 包，还要再扣除 RTP 固定头（通常 12 字节）、CSRC/扩展头、SRTP 认证标签和可能的 MKI。RTP 负载格式自己的分片边界必须在应用层决定，不能把“允许 IP 分片”当成视频分片策略。

IPv4 头中与 RTC 排障直接相关的字段包括：

- `Version=4`、`IHL`：版本和头长度；解析器不能无条件假定完整数据报从第 20 字节开始。
- `Total Length`：整个 IPv4 数据报长度，包含 IP 头和负载。
- `Identification`、`Flags`、`Fragment Offset`：分片重组所需字段。`DF`（Don't Fragment）置位时，路由器不能继续分片；超出 PMTU 时通常返回 ICMP “Fragmentation Needed”。
- `TTL`：每经过一个三层跳减一；过期会产生 ICMP Time Exceeded，可帮助定位路径，但不是媒体寿命计时器。
- `Protocol=17`：表示 UDP；同一 ICE 五元组上的 STUN、DTLS、SRTP/RTP/RTCP 仍可能需要更高层按首字节和状态分类。
- `Source Address`、`Destination Address`：参与路由和 NAT 映射，也属于连接识别的一部分。
- `DSCP/ECN` 所在的 `TOS` 字节：DSCP 用于服务分类，ECN 用于显式拥塞标记；中间设备可能重写或清零。

IPv4 允许分片，但 RTC 通常会避免依赖它：一个分片丢失，整个 IP 数据报对 UDP 都不可用；分片还增加重组内存、超时和防火墙兼容性风险。

### IPv6 + UDP

IPv6 基础头固定 40 字节，UDP 头仍是 8 字节：

```text
应用负载上限 = 路径 MTU - 40（IPv6）- 8（UDP）
```

IPv6 基础头的 `Payload Length` 不包括 40 字节基础头，`Next Header` 指示 UDP 或扩展头，`Hop Limit` 对应 IPv4 的 TTL。IPv6 中路由器不负责分片；若端点需要分片，发送端必须使用 Fragment 扩展头，且应用通常应通过 PMTUD 选择不需要分片的大小。超大数据报会触发 ICMPv6 Packet Too Big。

这意味着相同的 RTP/SRTP 负载在 IPv6 上比 IPv4 少约 20 字节可用空间。双栈实现不能只用一个固定常量：候选地址、TURN/隧道、扩展头和实际路径都可能改变预算。

### UDP 头字段

UDP 头只有四个字段：

| 字段 | 长度 | RTC 含义 |
| --- | ---: | --- |
| Source Port | 16 bit | 发送端端口；NAT 映射和返回路径的一部分 |
| Destination Port | 16 bit | 目标 socket 端口；WebRTC 常为动态端口 |
| Length | 16 bit | UDP 头加数据长度；接收端应检查它与实际数据报长度是否一致 |
| Checksum | 16 bit | 端到端差错检测；IPv4 可在特定场景为零，IPv6 通常必须存在 |

UDP 没有序列号、确认、重传、窗口、连接握手和拥塞控制。RTC 的序列号是 RTP 字段，丢包反馈是 RTCP/NACK/TWCC，速率控制是发送器、pacer 和拥塞控制器共同完成的，不能归因于 UDP。

## 五元组与 RTC 流识别

网络五元组是：

```text
源 IP、源端口、目的 IP、目的端口、传输协议（UDP）
```

它描述一条内核和 NAT 可以观察到的 UDP 流，但不是完整的 RTC 媒体身份。一个 WebRTC UDP socket 可能在同一端口复用 STUN、DTLS、SRTP/RTP 和 RTCP；应用还要使用 ICE 状态、DTLS 状态、RTP 的 SSRC/PT，以及 MID/RID 等头扩展完成分流。

同一 SSRC 在网络切换、ICE 重启或 SFU 转发后不一定仍对应同一个五元组；反过来，同一个五元组也可以承载多个 SSRC 和多个媒体方向。因此日志至少应同时记录：

- 本地/远端 IP、端口和地址族（IPv4/IPv6）；
- ICE selected pair、路径类型（host/srflx/relay）和 generation；
- UDP socket 标识、收发方向和协议分类结果；
- SSRC、MID、RID、Payload Type；
- 发送序号/接收扩展序号、时间戳、包长、发送/到达时间。

这样才能区分“IP 路径没包”“UDP socket 丢包”“SRTP 校验失败”“RTP 分流错误”和“解码后播放失败”。

## MTU、PMTU 与分片

### 三个概念

- **链路 MTU**：某一链路层一次能承载的最大 IP 数据报，常见以太网值为 1500，但蜂窝、VPN、PPPoE、隧道和 TURN/TLS 路径可能更小。
- **路径 MTU（PMTU）**：从发送端到接收端整个路径上允许的最大 IP 数据报大小，取各段链路 MTU 的最小值。
- **应用安全包大小**：在 PMTU 中扣除 IP、UDP、RTP 扩展、SRTP 标签、隧道/中继开销后的可用 RTP 负载预算。

一个简化预算示例：以太网 IPv4 路径 MTU 1500，IPv4/UDP 占 28 字节，RTP 固定头占 12 字节，SRTP 认证标签占 10 字节，则不含 RTP 扩展时，单个 RTP 负载最多约为 `1500 - 20 - 8 - 12 - 10 = 1450` 字节。实现还应留出扩展、不同地址族和隧道变化的余量，不应把 1450 写成所有网络的常量。

### PMTUD 状态机

```text
Unknown
  → Probe（用受控大小探测）
  → Validated（收到确认/反馈，记录当前 PMTU）
  → Reduce（收到 ICMP Too Big/Fragmentation Needed 或探测失败）
  → Reprobe（在退避后逐步探测更大值）
```

在 IPv4 中，`DF` 配合 ICMP Fragmentation Needed 可反馈下一跳 MTU；在 IPv6 中，Packet Too Big 是端点降低发送大小的重要信号。ICMP 可能被防火墙过滤，因此 RTC 实现常同时设置保守上限、监听发送错误和使用小型探测包。PMTU 变化后应让 RTP 分片器、pacer 和编码器包化策略使用同一份路径预算。

### 为什么 RTC 避免 IP 分片

如果一个 UDP 数据报被拆成多个 IP 分片，任意一个分片丢失都会使整个 UDP 数据报无法交给应用；中间 NAT/防火墙还可能丢弃或错误处理分片。视频更不应依赖 IP 分片，因为一个大包的损失会放大为一个 RTP 分片或整帧的损失。

正确做法是让 RTP 负载格式在应用层分片，例如 H.264 的 FU-A；每个 RTP 包独立通过 SRTP 和 UDP 传输，再由接收端重组。[[H264]]、[[Opus]] 等负载格式必须把包化上限绑定到当前 MTU 预算。

---

## Socket 生命周期与队列

### 创建到关闭

一个 RTC UDP socket 的典型状态机是：

```text
Created
  → Bound（绑定本地地址/端口）
  → CandidateReady（提供给 ICE）
  → Checking（STUN 检查）
  → Selected（selected pair 使用该 socket）
  → Running（收发 DTLS/SRTP/RTCP）
  → Draining（停止新发送，清空或丢弃队列）
  → Closed
```

`connect()` 对 UDP 不会建立远端握手，但可以锁定默认对端、让内核返回异步错误，并减少每次 `sendto()` 传入地址的工作；ICE 场景仍要正确支持候选切换和多个对端检查，不能把 UDP `connect()` 当成 TCP 连接。

### 发送路径

应用通常经过以下队列：

```text
编码输出 → RTP 打包 → SRTP 保护 → pacing 队列 → socket 发送缓冲
→ 内核路由/邻居队列 → 网卡队列 → 链路
```

每层都可能造成延迟或丢弃：

- RTP/SRTP 之前的队列通常受帧生成和编码器背压影响；
- pacing 队列按带宽预算、包优先级和发送时刻释放包；
- `SO_SNDBUF` 只是内核发送缓冲上限，不代表真实可用带宽；
- `sendto()` 成功通常只表示数据交给内核，不表示对端收到，更不表示已经播放；
- 非阻塞 socket 在队列暂满时可能返回 `EAGAIN/EWOULDBLOCK`，发送器必须记录、重试或按媒体截止时间丢弃过期包。

发送队列必须有包数、字节数和媒体时间上限。无限堆积会把拥塞变成不断增长的端到端延迟；视频过期包通常应丢弃或跳过低优先级层，而不是阻塞音频。

### 接收路径

```text
链路 → 网卡 → 内核 UDP 接收队列 → socket 用户态读取
→ 包分类 → SRTP 校验/解密 → RTP 重排/组帧 → 抖动缓冲
```

`SO_RCVBUF` 过小会在应用线程未及时读取时溢出；过大则可能把调度问题隐藏成高延迟。应用应统计内核丢包、用户态队列丢包、SRTP 认证失败、RTP 重复/乱序和播放欠载，它们不是同一个指标。

非阻塞 I/O 常与事件循环、专用网络线程或 IOCP/epoll/kqueue 配合。一次可读事件不保证只有一个包，也不保证下一次读取仍有数据；读取循环应处理直到 `EAGAIN`，同时设置每次批量读取的上限，避免网络线程长期霸占 CPU。Windows 常见异步模型是 IOCP 或 overlapped I/O，Linux 常见是 epoll；抽象层要保持“数据报边界”而不是套用 TCP 的字节流读取模型。

### 发送与接收缓冲的工程边界

```text
媒体队列：按 RTP 包/帧和播放截止管理
Socket 缓冲：按 UDP 数据报接收内核背压
网卡/路由队列：由系统和网络设备管理
```

调整 socket buffer 不能修复编码器超载、pacer 配置错误或远端不消费数据。调大缓冲前要同时观察排队时延、丢包和内存；调小缓冲也不能代替应用层有界队列。

## TURN、VPN 与其他隧道的额外开销

路径上的封装会消耗 PMTU，但具体开销取决于传输方式，不能用一个“TURN 固定开销”概括：

- TURN/UDP 的 ChannelData 有通道号和长度字段；若使用 Send Indication，还会包含 STUN 属性，开销不同。
- TURN/TCP 或 TURN/TLS 把媒体放入可靠字节流，除了 TCP/TLS 记录开销，还可能引入队头阻塞和更长的排队延迟。
- VPN、企业代理、PPPoE、GRE、IPsec、QUIC 或其他隧道会增加外层 IP/UDP/TCP、认证标签和填充；外层路径 PMTU 可能比内层网络明显更小。
- SFU 不是简单的三层转发：入站和每个出站路径分别有自己的五元组、MTU 和发送队列，SFU 可能重写 RTP SSRC/序号/时间戳并重新 pacing。

因此应以“端到端选中的路径”计算预算。直连、TURN/UDP、TURN/TLS、VPN 和 SFU 级联都应分别测量安全最大 UDP 数据报大小，并把路径类型写入日志。[[TURN]] 解释中继资源和回退机制；本篇关注它如何改变字节预算和队列行为。

## DSCP 与 ECN 的边界

### DSCP

DSCP 是 IP 头中的 6 位服务分类标记，RTC 可按音频、视频、低延迟控制等队列需求设置不同类别。但它不是带宽保证，也不是端到端加密后的媒体优先级证明：操作系统、Wi-Fi 驱动、企业网络、VPN、路由器或运营商都可能重写、清零或忽略它。

工程上应做到：

- 记录应用请求值与抓包看到的实际值，避免把 `setsockopt` 成功当成线路生效；
- 避免把音频标记成会导致网络绝对优先的类别；
- 对 IPv4 TOS 和 IPv6 Traffic Class 分别验证；
- 在不同平台、Wi-Fi、蜂窝、VPN 和企业网络中做对照测试；
- 即使 DSCP 不生效，仍依靠 pacer、拥塞控制和有界队列保持交互质量。

### ECN

ECN 用 IP 头的低 2 位表示发送端是否支持显式拥塞通知，以及网络是否标记发生拥塞。UDP 本身不会自动根据 ECN 降速；RTC 必须有明确的协议、内核和对端支持，才能把标记转成拥塞控制输入。中间设备清零或错误标记时，不能把 ECN 状态当作可靠事实。

DSCP/ECN 是 IP 层标记，不能替代 RTP/RTCP 的时间线和反馈；也不能从抓包中的一个标记直接推断音频一定优先或链路一定拥塞。

## 错误、返回值与状态处理

### 发送错误

发送函数的结果至少要区分：

- `成功`：数据报交给内核，不表示到达对端；
- `EAGAIN/EWOULDBLOCK`：非阻塞队列暂满，应交给调度器重试或按 deadline 丢弃；
- `EMSGSIZE`：包超过本地或已知 PMTU，立即降低包化上限；
- `ENETUNREACH/EHOSTUNREACH`：本地路由或邻居不可达，通常需要交给 ICE/路径管理；
- `ECONNREFUSED` 或异步 ICMP 错误：对端端口不可达，不能自动等同于媒体丢包；
- `EINTR`：系统调用被中断，按平台约定重试且避免重复发送一个已成功提交的数据报。

不要只记录“send 返回负数”。应保存错误码、socket、五元组、包类型、大小、PMTU、路径类型和当前队列长度。

### 接收错误与丢包归因

接收端应分别记录：

- 内核统计显示的 UDP receive buffer 溢出；
- 用户态 socket 读取晚导致的丢弃；
- SRTP 认证失败、重放窗口拒绝和密钥/ROC 不匹配；
- RTP 序号缺口、重复、乱序和过期包；
- 组帧失败、解码器丢帧和播放欠载。

它们在用户体验上都可能表现为“卡顿”，但修复位置完全不同。

## RTC 传输的完整状态机

把关键控制面和数据面状态合在一起，可以用下面的模型定位问题：

```text
SocketCreated
  → Bound
  → ICEChecking
       ├─ 无可达地址 → PathFailed
       └─ selected pair → PathSelected
                              → DTLSReady
                              → SRTPReady
                              → Sending/Receiving
                                   ├─ EAGAIN/队列高水位 → Backpressure
                                   ├─ PMTU 下降 → Repacketize
                                   ├─ 网络切换 → ICEChecking
                                   ├─ 连续无包/consent 失败 → PathFailed
                                   └─ 挂断 → Draining → Closed
```

其中 `Backpressure` 不能简单阻塞网络线程：音频和控制包通常有更高时效性，视频包可以根据帧依赖和截止时间丢弃。`Repacketize` 既要修改 RTP 包化大小，也要更新 pacer 和编码器的最大传输单元配置；只降低 socket buffer 不会解决 `EMSGSIZE`。

## 抓包与故障注入

### 抓包顺序

1. 先确认 ICE selected pair 和本地/远端五元组，避免分析了未使用候选。
2. 按 UDP 端口和地址过滤，再用 STUN、DTLS、RTP/RTCP 特征及连接状态分类；同端口复用时不要只靠端口号判断媒体。
3. 观察 IP 版本、总长度、DF/分片、TTL/Hop Limit、DSCP/ECN、UDP 长度和校验和。
4. 解密条件允许时，比较 SRTP 前后的 RTP 序列号、SSRC、时间戳、Marker、头扩展和负载格式。
5. 对照应用日志中的 `send` 时间、socket 队列、读取时间、SRTP 结果、RTP 缺口和播放时间。

Wireshark 中可用 `stun`、`dtls`、`rtp`、`rtcp`、`udp.port == <port>` 等过滤器；加密媒体仍能看到 IP/UDP 长度和包间隔，但不能仅凭负载内容推断帧是否可解码。

### 故障注入矩阵

| 注入条件 | 预期现象 | 应验证的 RTC 处理 |
| --- | --- | --- |
| 随机丢 UDP 包 | RTP 序号缺口、音频 PLC 或视频丢帧 | NACK/RTX/FEC、deadline 和统计归因 |
| 突发丢包 | 连续音频断续或关键帧依赖受损 | 抖动缓冲、关键帧请求、恢复上限 |
| 增大包到超过 PMTU | `EMSGSIZE` 或 ICMP Too Big | 降低预算、RTP 应用层分片 |
| 丢弃 ICMP | PMTU 探测停留在旧值 | 保守上限、探测退避和黑洞检测 |
| 缩小 `SO_RCVBUF`/延迟读取 | 内核接收溢出 | 网络线程及时读取与缓冲调优 |
| 强制 TURN/TLS 或 VPN | 可用 MTU 更小、RTT/队头阻塞增加 | 路径分类、预算重算、回退策略 |
| 清零/重写 DSCP/ECN | 标记与发送请求不一致 | 不依赖标记，保留观测数据 |
| 网络切换/拔网卡 | selected pair 失效、socket 错误 | ICE restart/重选路、队列清理 |

## 工程实现清单

- Socket 采用非阻塞或平台异步模型，保持 UDP 数据报边界；不要用 TCP 的“读满 N 字节”模型读取。
- 应用层发送队列按优先级、字节、包数、媒体时长和 deadline 有界；网络线程不执行重编码或长时间解码。
- 每条路径保存地址族、PMTU、包化上限、selected pair、socket buffer 和错误统计；路径变化时原子切换配置。
- `send` 成功只记为“提交到内核”，接收端到达要由 RTCP/Stats/抓包等独立证据确认。
- 所有解析和日志使用显式长度、无符号字段和回绕安全的序号比较；不信任 IP/UDP 长度和扩展头以外的隐含边界。
- 在 IPv4、IPv6、直连、TURN/UDP、TURN/TLS、VPN、小 MTU、丢包、乱序和网络切换环境做回归。
- 关闭时先停止生产、取消事件注册、处理或丢弃过期队列，再释放 socket；防止异步回调访问旧路径。

## 阅读导航

- **上一篇：** [[DHCP]]
- **下一篇：** [[TCP]]
- **所属专题：** [[00-知识地图/专题说明/09 RTP 打包、解析与传输|09 RTP 打包、解析与传输]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

- **第一次阅读下一站：** [[TCP]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 分层与硬件路径：[[从 RTP 到网卡、路由器与物理链路]]
- 入网配置：[[DHCP]]
- 传输语义对照：[[TCP]]
- 上游协议：[[RTP]]、[[SRTP]]、[[RTCP]]
- 路径建立：[[ICE]]、[[TURN]]、[[NAT 映射与过滤行为]]
- 发送控制：[[拥塞控制]]、[[Pacing]]
- 接收处理：[[抖动缓冲]]、[[丢包恢复策略]]
- 诊断观测：[[WebRTC Stats]]、[[端到端延迟]]

## 最小验收清单

- 能从一个 RTP/SRTP 包计算 IPv4/IPv6、UDP、RTP、认证标签和隧道开销后的可用负载预算。
- 能解释五元组为何不能单独识别 WebRTC 媒体，并能把 socket、ICE、SSRC 和头扩展关联起来。
- 能实现 `EAGAIN`、`EMSGSIZE`、路由不可达和接收溢出的分级处理。
- 能说明为什么应用层 RTP 分片优于依赖 IP 分片，并能在 PMTU 下降后重算发送上限。
- 能用抓包和应用日志区分路径不可达、socket 丢包、SRTP 失败、RTP 缺口和播放欠载。

## 复盘问题

- 当前日志能否回答“包在哪一个队列等待了多久”？
- IPv4、IPv6、TURN/UDP、TURN/TLS 和 VPN 是否使用了不同的安全包大小预算？
- 发送器是否把 `send` 成功误报成对端收到，接收器是否把所有异常都归类成网络丢包？
- 网络线程在 `EAGAIN` 或接收突发时是否会阻塞、无限重试或饿死音频？

## 参考资料

- RFC 768：User Datagram Protocol
- RFC 791：Internet Protocol, Version 4
- RFC 8200：Internet Protocol, Version 6
- RFC 1191：Path MTU Discovery for IPv4
- RFC 8201：Path MTU Discovery for IPv6
- RFC 8085：UDP Usage Guidelines for Application Designers
- RFC 8831：WebRTC Data Channels（WebRTC 传输环境与 UDP 使用背景）
