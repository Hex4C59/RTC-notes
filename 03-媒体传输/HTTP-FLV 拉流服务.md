---
aliases: [HTTP-FLV, HTTP FLV, HTTP-FLV 服务, FLV over HTTP]
tags: [rtc/concept, rtc/transport, rtc/live-streaming]
type: concept
status: stable
---

# HTTP-FLV 拉流服务：长连接、FLV Tag 与低延迟直播

> [!tip] 阅读提示
> **前置：** [[TCP]]、[[RTMP 推流与拉流]]、[[码流与容器]]、[[GOP 与参考帧]]。
> **初读：** 先读“一句话说明”“端到端链路”“线上字节结构”和“首屏为何要等关键帧”。
> **深入：** 第二轮再读 HTTP 版本边界、时间戳、服务端状态、慢客户端背压、代理/CDN 和故障注入。

## 一句话说明

HTTP-FLV 是客户端通过一个长时间不结束的 HTTP 响应持续接收 FLV Header 和 FLV Tag 的直播拉流方式。HTTP 负责连接与字节交付，FLV 负责封装音视频和时间戳，H.264/AAC 等 codec 负责压缩内容；三层不能混为一种协议。

`HTTP-FLV` 是直播工程生态中的通用称呼，并不是一份同时规定 HTTP、FLV、鉴权、重连和播放器行为的单一 IETF 标准。实现边界需要同时对照 HTTP 规范、FLV 格式规范以及所用服务器和播放器版本。

## 问题边界

- **常见用途：** 将流媒体服务器中的直播流通过 HTTP/WSS 基础设施分发给网页或原生播放器，主要是服务器到观众的单向拉流。
- **不等于 RTMP：** 二者可使用相似的 FLV 音视频负载语义，但 HTTP-FLV 没有 RTMP handshake、Chunk Stream、AMF `connect/publish/play` 状态机。
- **不等于普通 FLV 文件下载：** 响应体持续增长，通常没有预先可知的完整长度，也没有自然文件结尾。
- **不等于 codec：** `.flv` 或 `video/x-flv` 只说明封装；实际音视频编码和播放器支持必须另外确认。
- **不天然低延迟：** TCP 重传、服务端 GOP cache、代理缓冲、播放器缓存和长 GOP 都会增加延迟。

## 一条端到端链路

```text
主播/采集端
  │ RTMP、SRT、WebRTC 等上行
  ▼
流媒体服务器
  │ 鉴权与流路由
  │ 取得 metadata、codec config、音视频帧和时间戳
  │ 为新观众准备可解码起点（常见为 GOP cache）
  ▼
HTTP-FLV 响应
  │ FLV Header → metadata/config → Audio/Video Tag → ...
  ▼
播放器
  │ HTTP 读取 → FLV demux → 解码 → 同步 → 渲染
  ▼
扬声器/屏幕
```

HTTP-FLV 服务往往只负责拉流出口。上游怎样发布、服务端是否转码、源流由谁鉴权、是否录制和怎样调度 CDN，属于相邻模块而不是 HTTP-FLV 名称自动包含的能力。

## HTTP 请求与长响应

一个典型请求可能是：

```http
GET /live/room-42.flv HTTP/1.1
Host: live.example.com
Accept: video/x-flv
Authorization: Bearer <short-lived-token>
```

HTTP/1.1 下的示意响应：

```http
HTTP/1.1 200 OK
Content-Type: video/x-flv
Cache-Control: no-store
Transfer-Encoding: chunked
```

随后响应体持续输出 FLV 字节。这里的头部只是一个可能的部署示例：

- `video/x-flv` 是常见媒体类型，播放器仍应以实际响应和内容验证为准。
- HTTP/1.1 可以用 chunked transfer coding 表达未知总长度，也可以通过连接关闭界定；HTTP/2/3 使用各自的数据帧，不使用 HTTP/1.1 的 `Transfer-Encoding: chunked`。
- HTTP chunk 边界与 FLV Tag 边界没有稳定的一一对应关系。一次读取可能只有半个 Tag，也可能含多个 Tag。
- `200 OK` 只证明 HTTP 请求被接受，不证明流存在有效 codec config、关键帧或播放器已经渲染。

生产系统还要处理鉴权失败、流不存在、尚未开播、重定向、限流和跨域。错误应尽量在还没发送 `200` 和响应体之前返回明确 HTTP 状态；响应开始后再失败，通常只能关闭流并通过服务端日志/指标解释原因。

## FLV 线上字节结构

经典 FLV 数据顺序如下：

```text
FLV Header（9 bytes）
PreviousTagSize0（4 bytes，值为 0）
Tag Header（11 bytes） + Tag Data + PreviousTagSize（4 bytes）
Tag Header（11 bytes） + Tag Data + PreviousTagSize（4 bytes）
...
```

### FLV Header

| 字段 | 作用 |
| --- | --- |
| Signature | ASCII `FLV` |
| Version | FLV 版本，经典规范常见为 1 |
| TypeFlags | 声明文件/流中是否存在音频、视频 |
| DataOffset | Header 长度；解析器应按字段跳转而非假定永远固定扩展 |

### Tag Header

| 字段 | 长度 | 作用 |
| --- | ---: | --- |
| TagType | 1 byte | 常见 `8` 音频、`9` 视频、`18` Script Data |
| DataSize | 3 bytes | 当前 Tag Data 字节数，分配前必须做上限检查 |
| Timestamp | 3 bytes | 时间戳低 24 bit |
| TimestampExtended | 1 byte | 时间戳高 8 bit |
| StreamID | 3 bytes | 经典 FLV 中应为 0 |

Tag 后面的 `PreviousTagSize` 是前一个 Tag Header 与 Data 的总长度，可用于一致性检查。它不是下一 Tag 的长度，也不能替代对当前 `DataSize` 的边界验证。

### Script、音频和视频 Tag

- Script Data 常携带 `onMetaData`，例如分辨率、帧率或编码标识；在线流中的实际参数仍可能变化，不能只信初始化元数据。
- 经典 AAC over FLV 会先发送解码配置，再发送 AAC raw 数据。播放器缺少或错过配置时不能正确初始化解码器。
- 经典 AVC/H.264 over FLV 会发送 AVCDecoderConfigurationRecord，再发送 NALU 数据；DTS 与 CompositionTime 共同恢复 PTS，存在 B 帧时不能把 DTS 直接当显示时间。
- 新 codec 可能依赖扩展 FLV/Enhanced RTMP 生态。服务端、封装器和播放器必须固定并验证共同支持的版本，不能仅因扩展名仍是 `.flv` 就假设兼容。

## HTTP 读取不是 FLV Tag 读取

底层是连续字节流，解析器需要状态机：

```text
NeedFlvHeader
  → NeedPreviousTagSize0
  → NeedTagHeader
  → NeedTagData(DataSize)
  → NeedPreviousTagSize
  └──────────────────────→ NeedTagHeader
```

每个状态都可能只收到部分数据。实现必须：

1. 在累积完整固定头后再读取长度字段。
2. 验证 TagType、DataSize、总缓冲上限和整数加法溢出。
3. 等完整 Tag Data 到达后才交给 AMF/audio/video 解析器。
4. 将 codec config、时间戳和上一 Tag 大小保存在连接级解析状态中。
5. EOF 时区分正常主动停止、网络中断、服务端踢流和语法截断。

不要把一次 HTTP 回调、一次 TCP `recv()` 或一个 HTTP/2 DATA frame 当作完整 FLV Tag。

## 新观众起播需要哪些数据

观众中途加入时，不能从任意预测帧开始解码。服务端通常需要尽快提供：

1. FLV Header；
2. 最新 metadata（若使用）；
3. 当前音频/视频 codec configuration；
4. 一个可独立解码的视频关键帧及其后的帧；
5. 与该起点一致的音频数据和时间戳基准。

因此很多服务器维护 GOP cache。缓存必须按流和 codec configuration 代次管理；编码参数改变后，旧 SPS/PPS 或旧关键帧不能与新帧拼接。

### 首屏为何要等关键帧

假设 30 fps、每 60 帧一个关键帧，则 GOP 约 2 秒。没有 GOP cache 时，随机加入的观众仅等待下一个关键帧就可能等待 0–2 秒；加上网络、代理和播放器缓冲后会更长。这个数值只是计算示例，实际关键帧策略由编码器和服务器决定。

有 GOP cache 也不代表立即出画：缓存复制、带宽突发、解码器初始化、音频对齐和播放器起播阈值仍会消耗时间。

## 服务端连接状态与所有权

```text
RequestReceived
  → Authenticating
  → ResolvingStream
  → WritingHeaderAndConfig
  → Streaming
       ├─ SourceDiscontinued → Waiting/Close（按产品策略）
       ├─ SlowConsumer → DropToKeyframe/Close
       └─ ClientGone → Closing
  → Closed
```

服务端要明确：

- HTTP 连接对象拥有 socket/response 写入生命周期；
- 订阅对象拥有该观众的发送队列、时间戳基准和丢弃状态；
- 源流对象拥有当前 codec config、GOP cache 和发布代次；
- 同一源的多个观众不能共享一个会被慢观众阻塞的可变写队列；
- 发布者断开再重连时创建新代次，旧缓存和时间线必须清理或显式重基准。

## 时间戳、音画同步与重连

FLV Tag 时间戳通常以毫秒表达解码时间轴。视频 CompositionTime 用于从 DTS 推导 PTS；音频也要保持单调且与视频处在可对齐的时间基准。

工程上要定义：

- 源流时间戳回退、跳变和回绕如何处理；
- 上游重连从 0 开始时，是关闭旧 HTTP 响应还是在同一响应内发 discontinuity/重基准；
- 丢弃积压到关键帧时，音频从哪个时间点继续；
- 播放器是以音频、视频还是外部时钟为主时钟。

FLV 本身没有像 HLS playlist discontinuity 那样通用的分段控制面。对跨代次重连，关闭旧连接并让客户端重新拉流往往更容易形成清晰状态；若选择不断流拼接，必须由具体服务器/播放器协议明确约定并验证。

## 延迟从哪里产生

```text
采集/编码
 + 上行发送与服务器接收
 + 等待 codec config/关键帧
 + 服务端订阅发送队列
 + TCP 重传与网络排队
 + 代理/CDN 缓冲
 + 客户端 demux/解码缓冲
 + 音画同步与渲染调度
 = 观众端到端延迟
```

HTTP-FLV 常被称为低延迟直播，但不存在脱离配置的固定“1 秒”或“3 秒”保证。应测量捕获时间到光子/声音输出的端到端延迟，并同时记录首字节、首媒体 Tag、首关键帧、首个解码帧和首次渲染时间。

## 慢客户端、背压和队头阻塞

HTTP-FLV 通常依赖可靠有序传输。客户端暂停读取或网络吞吐低于媒体产生速率时，积压会依次出现在：

```text
源流/转封装队列
  → 单订阅者应用发送队列
  → TLS/HTTP 库缓冲
  → Socket 发送缓冲
  → TCP 在途与接收窗口
  → 播放器接收/解码队列
```

不能只看 socket “暂时可写”。至少限制每个观众的队列字节、媒体时长和最老 Tag 年龄，并选择策略：

- 直播允许丢弃时，跳过旧视频直到最新可解码关键帧，并同步调整音频；
- 无法安全跳转或持续跟不上时，关闭该观众连接并给出可诊断原因；
- GOP cache 和实时队列分开计量，避免新观众起播突发挤占所有连接；
- 慢客户端的锁和写任务不能阻塞发布线程及其他观众；
- 已经过播放截止的字节即使最终可靠到达，也可能只会增加延迟。

## 浏览器播放路径

主流浏览器通常不能把 HTTP-FLV URL 直接交给 `<video src>` 原生播放。常见网页播放器使用 `flv.js` 一类方案：通过 Fetch/XHR 读取 FLV、在 JavaScript 中 demux/remux 为浏览器 MSE 接受的媒体片段，再追加到 `SourceBuffer`。

这条路径受以下条件约束：

- 浏览器是否支持 MSE；
- MSE 是否支持所选 codec/profile/level 和封装组合；
- CORS、HTTPS mixed content 和凭据策略是否允许读取；
- `SourceBuffer` 追加、清理和 quota 是否有界；
- 页面后台调度、移动端策略和目标浏览器版本。

`flv.js` 项目及浏览器支持会随时间变化，不能把某一版本的兼容表当永久事实。iOS/Safari 等目标应以计划支持的系统、浏览器和播放器版本做真实设备验证，并准备 HLS/WebRTC 等替代出口。

## 代理、网关与 CDN

- 代理若缓冲上游响应，可能攒够一批字节才下发，造成周期性延迟和卡顿；需要按所用代理版本验证 streaming/buffering 配置。
- 各层空闲超时要覆盖正常直播静默特征，并通过心跳或媒体活动正确刷新；不要只改一层配置。
- HTTP 缓存通常不适合把无限直播响应当普通可复用对象；cache key、鉴权和防盗链必须按实时流语义设计。
- CDN 是否支持长连接 HTTP-FLV、最大连接时长、回源策略和分发地域取决于具体产品，不是 HTTP 标准保证。
- TLS 终止、反向代理和源站日志要共享 request/stream/session 标识，才能定位延迟在哪一跳增长。

## 鉴权与安全

- 使用 HTTPS 保护 token 和内容；同时执行流级授权、过期、并发数限制和防重放策略。
- URL 查询参数容易进入浏览器历史、代理和访问日志；若必须使用，应采用短期、限定资源与权限的签名，并做日志脱敏。
- 在按 `DataSize` 分配内存前设置 Tag 和连接总缓冲上限；对 AMF metadata、codec config 和 NALU 长度继续做深层校验。
- 限制单 IP/账号连接速率、并发观众和回源扇出，防止慢连接消耗无限资源。
- 对错误流、异常 codec 切换和解码器输入做隔离，不让单个流破坏同进程其他订阅。

## 与相邻方案对照

| 方案 | 会话/承载 | 实时性与适用边界 |
| --- | --- | --- |
| RTMP/RTMPS | RTMP handshake、命令和 Chunk over TCP/TLS | 常用于推流，也可拉流；浏览器通常不原生播放 |
| HTTP-FLV | 长 HTTP 响应持续输出 FLV Tag | 适合单向低延迟直播分发；TCP 队头阻塞，网页需播放器适配 |
| HLS/LL-HLS | Playlist + HTTP 媒体分片/部分分片 | CDN 和浏览器生态好；延迟由分片与播放器策略决定 |
| WebRTC | ICE/DTLS/SRTP、RTP/RTCP | 适合亚秒互动，有媒体反馈和拥塞控制，系统复杂度更高 |
| WebSocket 自定义媒体 | Binary message + 自定义/容器协议 | 灵活，但消息、时间线、背压和播放适配均由应用承担 |

## 常见误区与故障表现

| 误区或现象 | 应检查的阶段 |
| --- | --- |
| HTTP 200 就代表播放成功 | Header/config/关键帧/解码/渲染分别验证 |
| 收到很多字节却一直黑屏 | AVC config、关键帧、codec 支持、时间戳 |
| 新观众首屏很慢 | GOP 长度、GOP cache、代理与播放器起播缓冲 |
| 播放越看越延迟 | 单观众发送队列、TCP 重传、代理缓冲、SourceBuffer 积压 |
| 音频正常但视频黑屏 | 视频配置或关键帧缺失，不要先归因于 HTTP |
| 断流重连后花屏/时间跳变 | 旧 codec config/GOP cache 与新发布代次混用 |
| 开发机可播、经代理后卡顿 | 代理 buffering、空闲超时、TLS/HTTP 层写出策略 |
| 把 HTTP chunk 当 FLV Tag | 解析器在任意拆分/合并读取下失败 |

## 观测与验证

### 服务端建议记录

- request ID、stream key、发布代次、观众 ID、边缘/源站节点和鉴权结果；
- HTTP 建立、首字节、首 metadata、首 codec config、首关键帧和连接关闭时间；
- 每观众发送队列字节/媒体时长/最老 Tag 年龄、写阻塞时间和慢连接处置；
- 源流输入码率、输出码率、GOP 间隔、codec config 变化和时间戳跳变；
- 状态码、关闭原因、客户端主动断开、源断开和代理超时分别计数。

### 客户端建议记录

- HTTP 状态、Content-Type、首字节和持续吞吐；
- demux 的 Tag 类型/大小/时间戳，codec config 代次和首关键帧；
- 解码错误、buffered duration、首帧渲染、卡顿、A/V drift 和追帧次数；
- 网络重连次数以及重连后时间线/播放器状态是否重置。

### 可复现命令

使用 FFmpeg 工具查看服务端实际输出，具体支持取决于所安装版本：

```bash
ffprobe -v info -show_format -show_streams \
  "https://live.example.com/live/room-42.flv"
```

限时保存字节流用于离线检查：

```bash
curl --no-buffer --max-time 10 \
  --output sample.flv \
  "https://live.example.com/live/room-42.flv"
```

直播响应通常不会自行结束，因此达到 `--max-time` 后退出并不等于服务故障。样本是否可独立解码取决于截取时是否获得 Header、codec config 和关键帧。

### 可复现故障注入

| 注入 | 预期行为 |
| --- | --- |
| 将每个 FLV Tag 任意拆成 1–17 字节读取 | 增量解析最终恢复相同 Tag，不依赖 read 边界 |
| 宣告超大 DataSize 或截断 Tag | 分配前拒绝，报告协议错误，不越界或无限等待 |
| 丢弃 AVC/AAC config | 播放器进入 WaitingConfig 并可观测，不崩溃 |
| 新观众在预测帧处加入 | 等待缓存/下一关键帧，不把预测帧误当可独立解码帧 |
| 暂停一个观众读取 | 只增长该观众队列，达到阈值后跳帧或断开，不拖慢其他观众 |
| 代理开启响应缓冲 | 可看到首字节/Tag 批量到达和延迟阶梯增长 |
| 上游重连且时间戳归零 | 创建新代次并清理旧 cache，或按明确策略重基准 |

## 最小验收清单

- 能画出 HTTP、FLV、codec 三层，并说明每层各自负责什么。
- 能从字节流解析 FLV Header、Tag Header、DataSize、Timestamp 和 PreviousTagSize。
- 能解释 HTTP read/chunk 与 FLV Tag 没有一一对应关系。
- 能说明新观众为什么需要 codec config 和关键帧，以及 GOP cache 的代次边界。
- 能给出首屏、持续延迟和慢客户端的分阶段指标。
- 能区分连接成功、收到 Tag、首个可解码帧和实际渲染四种证据。

## 阅读导航

- **上一篇：** [[RTMP 推流与拉流]]
- **下一篇：** [[RTP 流标识与复用]]
- **所属专题：** [[00-知识地图/专题说明/09 RTP 打包、解析与传输|09 RTP 打包、解析与传输]]
- **回看：** [[RTC 知识总览]] · [[00-知识地图/学习路线/学习进度模板|学习进度]] · [[00-知识地图/学习路线/RTC 工程师学习路线.canvas|阶段路线]]

> 读完先回所属专题做练习/验收，再点下一篇。内部链接最多再追一层；不影响理解的陌生词先记下。

## 图谱关系

- 主题：[[媒体传输地图]]
- 传输前置：[[TCP]]
- 传输安全：[[TLS]]保护 HTTPS-FLV 客户端到 TLS 终止点的链路。
- 上游直播协议：[[RTMP 推流与拉流]]、[[WHIP 与 WHEP]]
- 封装：[[码流与容器]]、[[复用与解复用]]
- 视频依赖：[[H264]]、[[GOP 与参考帧]]、[[PTS DTS 与时间基]]
- 服务端：[[媒体服务器]]
- 自定义长连接对照：[[WebSocket]]
- 播放：[[播放器队列与主时钟]]、[[音视频同步]]
- 排障：[[抓包分析]]、[[网络仿真]]

## 参考资料

- Adobe, *Video File Format Specification*, Version 10.1：FLV Header、Tag、AAC/AVC packet type、AVCDecoderConfigurationRecord 与 CompositionTime。
- IETF RFC 9110, *HTTP Semantics*：HTTP 方法、状态码和消息语义。
- IETF RFC 9112, *HTTP/1.1*：消息体长度与 chunked transfer coding。
- IETF RFC 9113, *HTTP/2*：HTTP/2 帧与流；不能沿用 HTTP/1.1 chunked 边界解释。
- FFmpeg 官方文档：FLV demuxer/muxer 和 HTTP protocol；选项及 codec 支持以实验所用 FFmpeg 版本为准。
- `flv.js` 项目文档：浏览器 FLV demux、MSE 路径及版本兼容信息；需固定播放器与浏览器版本验证。
