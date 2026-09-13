---
aliases: [WebSocket Protocol, WebSocket 协议, WS, WSS]
tags: [rtc/concept, rtc/transport, rtc/signaling]
type: concept
status: stable
---

# WebSocket：双向消息通道与 RTC 承载边界

> [!tip] 阅读提示
> **前置：** [[TCP]]、[[实时通信中的信令消息与业务消息]]。
> **初读：** 先读“一句话说明”“它提供什么”“一条连接的状态流”和“承载信令与承载媒体的区别”。
> **深入：** 第二轮再读 HTTP Upgrade、帧字段、分片、心跳关闭、背压和媒体消息信封。

## 一句话说明

WebSocket 是在客户端与服务器之间提供长连接、全双工、带消息边界通信的应用层协议，常用 `ws` 或加密的 `wss`。它能承载文本、二进制媒体或信令，但不理解 SDP、H.264、房间状态或播放截止时间，这些语义必须由上层协议定义。

## 问题边界

- **WebSocket 提供：** 连接、消息与帧边界、双向发送、协议级 Ping/Pong、关闭握手以及扩展/子协议协商。
- **WebSocket 不提供：** 用户身份、业务确认、消息 schema、媒体时间戳、抖动缓冲、码率自适应、丢包恢复或断线后的会话恢复。
- **底层关系：** 经典部署通常是 WebSocket over TCP，`wss` 再由 [[TLS]] 保护。HTTP/2、HTTP/3 上的 WebSocket 使用另外的扩展建立方式，不能把 HTTP/1.1 `Upgrade` 报文原样套用。
- **不是普通 HTTP 轮询：** 建立后双方都可以主动发送，不必为每条数据重新创建一次 HTTP 请求/响应。

## 为什么 RTC 系统常用 WebSocket

RTC 信令具有“低频、需要可靠、服务器要主动推送”的特点：成员变化、Offer/Answer、candidate、挂断和权限撤销都可能由服务端主动到达客户端。WebSocket 比反复轮询更自然，并能让一条连接内的消息保持顺序。

这不表示 WebSocket 是 WebRTC 的组成部分。WebRTC 没有规定业务信令必须使用 WebSocket；同样的协商消息也可以通过 HTTPS、SIP、XMPP 或其他系统传递。

## 从 HTTP 建立到 WebSocket

### HTTP/1.1 Upgrade 示例

客户端发起的典型请求如下，示例省略了普通 HTTP 头：

```http
GET /rtc-signaling HTTP/1.1
Host: rtc.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Protocol: rtc-signaling-v2
Origin: https://app.example.com
```

服务器接受后返回：

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: rtc-signaling-v2
```

`Sec-WebSocket-Accept` 由客户端 key、RFC 6455 固定 GUID、SHA-1 和 Base64 按规范计算，用于证明服务器理解 Upgrade；它不是身份认证或内容加密。生产环境通常使用 `wss`，并在升级前或建立后的应用协议中完成鉴权与授权。

浏览器会发送 `Origin`。服务器应校验允许的来源，但仍要独立校验登录身份、房间权限和每条消息目标；通过 Origin 校验不等于用户已授权。

### 子协议和扩展

- `Sec-WebSocket-Protocol` 用于选择双方理解的应用子协议，例如 schema 版本；值必须是双方约定的 token。
- `Sec-WebSocket-Extensions` 可协商扩展，例如压缩。音视频通常已经压缩，再启用消息压缩可能收益有限并增加 CPU、内存和安全边界，必须实测。
- 子协议只声明“怎样解释消息”，不替代消息内的 session、version、generation 和权限字段。

## 帧格式与消息边界

RFC 6455 帧头包含：

| 字段 | 位数/长度 | 作用 |
| --- | ---: | --- |
| FIN | 1 bit | 是否为该消息最后一个分片 |
| RSV1–3 | 各 1 bit | 仅在协商扩展后使用，否则应为 0 |
| Opcode | 4 bit | continuation、text、binary、close、ping、pong 等 |
| MASK | 1 bit | 是否携带 32-bit masking key |
| Payload length | 7 bit + 可扩展 16/64 bit | 声明负载长度；解析前必须做上限检查 |
| Masking key | 可选 32 bit | 客户端到服务器帧必须掩码 |
| Payload data | 变长 | 文本、二进制或控制负载 |

必须分清三个边界：

```text
TCP 字节读取边界  ≠  WebSocket frame 边界  ≠  WebSocket message 边界
```

- 一次 TCP `recv()` 可能只得到半个帧，也可能包含多个帧。
- 一条 WebSocket message 可以由一个帧组成，也可以拆成首帧和若干 continuation frame。
- Text message 的完整负载必须是有效 UTF-8；Binary message 的解释完全由应用子协议决定。
- 控制帧不能分片，负载长度受 RFC 6455 限制；控制帧可以插在分片数据消息之间，解析器不能等大消息全部收完才处理关闭或 Ping。
- 客户端发往服务器的帧必须使用不可预测的 32-bit masking key，服务器发往客户端的帧不得掩码；掩码不是加密，保密性依赖 TLS。

库通常替应用完成帧解析和掩码。自己实现解析器时，必须处理 partial read、长度溢出、非法 opcode、无效 UTF-8、错误分片、控制帧限制和关闭码；不要按一次 Socket 读取就是一条消息来解析。

## 一条连接的状态流

```text
Disconnected
    │ 发起 DNS/TCP/TLS/HTTP 建连
    ▼
Connecting
    │ 101 或扩展 CONNECT 成功
    ▼
Open
    │ 正常收发 Text/Binary/Ping/Pong
    ├───────────────┐
    │ 应用/网络异常  │ 收到或发送 Close
    ▼               ▼
Reconnecting      Closing
    │               │ 完成关闭握手或超时
    └────新连接─────► Closed
```

浏览器 API 常见 `CONNECTING/OPEN/CLOSING/CLOSED` 四态。应用自己的“鉴权完成、已入房、已同步、可发信令”不能压缩成 `OPEN` 一个布尔值。

### 打开阶段

1. 解析 URL，进行 DNS、TCP；`wss` 还要完成 TLS 证书校验。
2. 通过 HTTP/1.1 Upgrade 或适用版本的扩展方式建立 WebSocket。
3. 协商子协议/扩展，完成应用鉴权。
4. 恢复或新建业务 session，再允许发送需要会话上下文的消息。

### 心跳与半开连接

协议级 Ping/Pong 可以确认对端 WebSocket 栈是否响应；应用心跳可以携带 session 版本、服务器时间等业务信息。浏览器标准 `WebSocket` API 不向脚本暴露发送协议 Ping 的接口，常见浏览器应用因此使用业务心跳或依赖服务端 Ping，具体由客户端环境决定。

心跳间隔和超时应结合移动网络、代理空闲超时、后台调度和服务容量配置，不能照搬一个“固定 30 秒”的通用值。心跳成功也不证明 ICE、RTP、解码或渲染正常。

### 关闭阶段

Close frame 可携带状态码和短原因。收到 Close 后应按规范回应并停止产生新消息；网络中断时可能来不及完成握手。应用需分别记录本地主动关闭、远端关闭、协议错误、TLS/网络失败和心跳超时。

`1006` 是 API 用来表示异常关闭的保留值，不会作为 Close 状态码在线发送。关闭后重连会得到新的传输连接；旧连接上的顺序和“最后一条是否已处理”不能自动延续。

## WebSocket 承载信令或业务消息

常见做法是每条 Text/Binary message 承载一个应用消息：

```json
{
  "schemaVersion": 2,
  "type": "webrtc.ice-candidate",
  "messageId": "msg-2048",
  "sessionId": "session-7",
  "generation": 4,
  "sequence": 91,
  "payload": {
    "sdpMid": "0",
    "candidate": "candidate:..."
  }
}
```

WebSocket 保证当前连接内消息按序交付，但应用仍须处理：

- 重连后重复发送和响应丢失；
- 多连接、多设备和多节点带来的业务乱序；
- Offer、Answer、candidate 属于哪个协商 generation；
- 消息鉴权、最大长度、schema 版本和未知类型；
- 高低优先级消息共享发送队列时的阻塞；
- `send()` 成功、本地缓冲下降、服务端接受和业务生效之间的证据差异。

完整的消息语义见 [[实时通信中的信令消息与业务消息]]，协商状态见 [[信令与 PeerConnection 状态机]]。

## WebSocket 承载流媒体

WebSocket 的 Binary message 可以装编码帧、容器片段或自定义媒体包，所以“能传”在技术上成立。但 WebSocket 不会自动补出媒体系统所需的信息。

### 上层至少要定义什么

| 信息 | 为什么需要 |
| --- | --- |
| 协议版本与消息类型 | 区分配置、音频、视频、控制和错误 |
| Track/stream 标识 | 把数据交给正确解码器和渲染链 |
| Codec 与配置代次 | 初始化/重建解码器，处理 SPS/PPS、AudioSpecificConfig 等 |
| PTS/DTS 或媒体时间戳 | 播放调度和音画同步 |
| 关键帧/依赖信息 | 新观众起播、丢弃积压和解码恢复 |
| 序号与 discontinuity | 发现应用层缺口、重连和时间线重置 |
| 负载长度与上限 | 安全解析一条或多条媒体单元 |

一种自定义二进制消息可能是：

```text
magic | version | type | flags | track_id | sequence
      | dts_us | pts_us | payload_length | encoded_payload
```

这只是示意，不是标准 WebSocket 媒体格式。也可以直接发送 FLV、MPEG-TS 或 fMP4 片段，让成熟 demuxer 处理边界与时间戳；但容器、codec 和浏览器播放能力仍需明确协商。

### 播放链路

```text
WebSocket Binary message
  → 应用协议解帧或容器 demux
  → 取得 codec config、DTS/PTS、关键帧
  → MSE/WebCodecs/原生解码器
  → 播放队列与主时钟
  → 音频设备/屏幕
```

浏览器的 `<video>` 不会因为 URL 是 WebSocket 就自动播放任意二进制流。应用需要 JavaScript/原生代码接收和解析，再交给浏览器支持的 MSE 容器/codec 或 WebCodecs；具体格式支持必须按目标浏览器版本验证。

### 有序可靠带来的实时性代价

经典 WebSocket 通常建立在 TCP 之上。前面的字节丢失会阻塞后面的消息交付，即使后面的视频帧已经过了播放截止时间。若播放器读取变慢，内核、WebSocket 库和应用队列还可能共同积压，形成“画面越来越延迟而不是立刻卡死”。

媒体承载必须定义有界策略：

- 限制未发送字节、排队帧数和最老帧年龄；
- 优先保留 codec config、音频和最新可解码关键帧；
- 对直播旧视频帧执行丢弃/跳到新关键帧，而不是无限补发历史；
- 慢订阅者独立排队和断开，不能反压整个发布源或其他观众；
- 统计编码产生时间、入队时间、实际写出时间、接收时间和播放时间。

这些策略是应用实现，不是 WebSocket 标准的能力。需要亚秒互动、逐包反馈、部分可靠和媒体拥塞控制时，通常应优先评估 WebRTC/RTP，而不是在 WebSocket 上重新实现一套媒体传输协议。

## 承载信令与承载媒体的直接对照

| 维度 | WebSocket 承载信令/业务消息 | WebSocket 承载媒体 |
| --- | --- | --- |
| 负载 | JSON/Protobuf 等控制信息 | 编码帧、容器片段或自定义媒体包 |
| 频率与吞吐 | 通常低频、低带宽 | 高频、持续、带宽大且有突发 |
| 迟到数据 | 命令可能仍需执行或明确过期 | 超过播放截止时间常应丢弃 |
| 关键状态 | session/version/generation/幂等 | codec config、PTS/DTS、关键帧、播放队列 |
| 成功证据 | 业务确认和状态收敛 | 首包、首个可解码帧、持续播放和 A/V 同步 |
| 队列策略 | 关键命令优先，可重试/去重 | 有界缓存，跳过过期帧并隔离慢客户端 |
| 典型风险 | 重连重复、旧信令污染、越权 | TCP 队头阻塞、延迟爬升、解码配置丢失 |

同一连接理论上可以同时承载二者，但大媒体消息会阻塞关键控制消息。工程上通常分离连接或直接让媒体走 WebRTC/RTP、HTTP-FLV 等专用路径。

## 发送队列、背压与所有权

- 浏览器 `WebSocket.bufferedAmount` 表示调用 `send()` 后尚未发送到网络的数据字节量附近的应用可见指标；它不是服务端已接收量，也不是往返确认。
- 经典浏览器 WebSocket API 没有自动把接收侧消费速度反馈成应用 `ReadableStream` 式背压；应用仍需限制生产和解码队列。
- 原生库的回调线程、发送队列所有者和关闭顺序各不相同。跨线程发送时明确谁持有 payload、何时复制、何时释放。
- 关闭时先停止生产，再有界等待关键控制消息，发起 Close，最后释放连接与回调对象；避免回调访问已销毁会话。

## 安全与部署边界

- 公网使用 `wss` 并验证证书；TLS 保护链路，不替代消息级鉴权和服务端权限检查。
- 限制握手速率、连接数、空闲时间、消息大小、压缩膨胀、解析深度和发送队列。
- 浏览器脚本不能像普通 HTTP 客户端那样任意设置握手头。鉴权方案需按浏览器能力设计；避免把长期 token 放在易进入 URL、代理和访问日志的位置。
- 反向代理、负载均衡和服务端都要支持 Upgrade/长连接，并统一配置空闲超时；多节点部署还要解决 session 路由或共享状态。
- 不可信 Binary payload 必须先验证长度、类型和 codec/container 配置，再分配大缓冲或交给解码器。

## 常见误区与故障表现

| 误区或现象 | 正确定位方向 |
| --- | --- |
| WebSocket 已 Open，媒体应该通了 | Open 只证明控制/数据通道建立，继续查 ICE/DTLS/RTP/解码 |
| 一次 `recv()` 就是一条 WebSocket 消息 | 库下方仍有 TCP partial read；自己实现需按帧状态机解析 |
| WebSocket 每条消息对应一个网络包 | 消息可分片，TCP 还会重新分段与合并 |
| Ping 正常，用户就一定在线且通话正常 | 只证明某层可响应，业务 session 和媒体要独立验证 |
| `send()` 返回即发送成功 | 可能仍在本地缓冲；检查 `bufferedAmount`、服务端确认和业务结果 |
| WebSocket 传视频天然低延迟 | 有序可靠、慢客户端和无界队列会让延迟持续增长 |
| 重连后继续使用旧序号和旧 Offer | 新连接需要重新认证、对账并拒绝旧 generation |

## 观测与验证

### 分阶段指标

| 阶段 | 观察内容 |
| --- | --- |
| DNS/TCP/TLS | 解析、连接、握手耗时和失败原因 |
| HTTP 建立 | 状态码、Upgrade/扩展 CONNECT、Origin、子协议、扩展 |
| 连接运行 | 当前连接数、收发消息/字节、Ping RTT、空闲时间、关闭码 |
| 应用消息 | type、schema、session、generation、处理结果、端到端耗时 |
| 发送背压 | `bufferedAmount`、队列字节/帧数、最老消息年龄、丢弃/断开 |
| 媒体播放 | codec config、首关键帧、首帧、缓冲时长、A/V drift、解码错误 |

### 可复现故障注入

- 把握手后第一个 WebSocket frame 拆成逐字节 TCP 读取，验证解析状态不会丢失。
- 发送分片 Text message，并在中间插入 Ping，验证控制帧及时处理。
- 发送非法 UTF-8、未掩码客户端帧、控制帧过长和宣告超大 payload，验证按协议关闭且不大额分配。
- 暂停接收端读取，观察客户端 `bufferedAmount`、服务端队列和慢连接隔离。
- 服务端处理命令后立即断网，验证重连使用幂等键和状态快照，而不是盲目重放。
- 媒体流中移除 codec config 或让关键帧间隔变长，验证播放器保持 WaitingConfig/WaitingKeyframe 且指标可解释。

## 最小验收清单

- 能区分 TCP 读取、WebSocket frame、WebSocket message 和应用消息四种边界。
- 能解释 HTTP/1.1 Upgrade 的关键头、masking、opcode、分片、Ping/Pong 和 Close。
- 能画出传输连接、应用鉴权、业务会话和媒体路径四条独立状态轴。
- 能为信令消息定义 version/generation/幂等，为媒体消息定义 codec config/PTS/DTS/关键帧。
- 能用队列字节数和最老消息年龄证明背压是否有界。
- 能解释为什么 WebSocket 可以传媒体，但不自动获得 RTP/WebRTC 的媒体能力。

## 阅读导航

- **上一篇：** [[实时通信中的信令消息与业务消息]]
- **下一篇：** [[Offer Answer]]
- **所属专题：** [[00-知识地图/专题说明/02 信令与 SDP 协商|02 信令与 SDP 协商]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[会话与信令地图]]、[[媒体传输地图]]
- 传输前置：[[TCP]]
- 安全层：[[TLS]]保护 `wss` 链路，但不替代 WebSocket 与业务协议状态。
- 信令语义：[[实时通信中的信令消息与业务消息]]、[[信令服务器]]
- 协商消费：[[Offer Answer]]、[[SDP]]
- 媒体输入：[[实时媒体链路]]、[[码流与容器]]
- HTTP 长流对照：[[HTTP-FLV 拉流服务]]
- 点对点消息对照：[[RTCDataChannel 与 SCTP]]
- 排障：[[抓包分析]]、[[网络仿真]]

## 参考资料

- IETF RFC 6455, *The WebSocket Protocol*：HTTP/1.1 opening handshake、帧、掩码、分片、控制帧和关闭语义。
- IETF RFC 8441, *Bootstrapping WebSockets with HTTP/2*：HTTP/2 extended CONNECT 建立方式。
- IETF RFC 9220, *Bootstrapping WebSockets with HTTP/3*：HTTP/3 上的 WebSocket 建立方式。
- WHATWG, *WebSockets Living Standard*：浏览器 WebSocket API 与协议集成；行为应按目标浏览器版本验证。
- MDN Web Docs, *WebSocket*：浏览器 API 的 `readyState`、`bufferedAmount` 和事件说明；属于实现使用文档，不替代 RFC。
