---
aliases: [SRTP/SRTCP Packet Protection, SRTP 报文保护, SRTCP 报文保护]
tags: [rtc/concept, rtc/security, rtc/transport, rtc/deep-dive]
type: concept
---

# SRTP 与 SRTCP 报文保护

> [!tip] 阅读提示
> **前置：** [[RTP]]、[[RTCP]]、[[DTLS]]、[[SRTP]]。
> **初读：** 先读“定义”“解决的问题”“工作流程或状态流”，分清媒体保护、密钥协商与重放防护的职责。
> **深入：** 算法套件、exporter、ROC、nonce 和重放窗口留到实现或排障时逐项阅读；第一轮可先读 [[SRTP]]。

## 定义

SRTP 为 RTP 媒体负载提供机密性、完整性和抗重放保护；SRTCP 对 RTCP 控制报文提供对应保护。二者共享 DTLS-SRTP 协商出的密钥层次，但使用不同的包索引和报文结构。本文只描述协议对象、状态和调用边界，不实现密码学算法。

## 解决的问题

实时媒体不能因为安全处理而等待可靠重传，也不能因为允许乱序而接受篡改或重放的旧报文。因此发送端必须为每个包构造稳定的索引和 nonce/IV，接收端必须在认证成功后正确维护序号扩展、重放窗口和每个 SSRC 的上下文。

## 工作流程或状态流

1. DTLS-SRTP 协商 profile 和方向，exporter 产生 master key/master salt，建立 key epoch。
2. 发送端为每个 SSRC 维护 sequence/ROC，计算 packet index，经 profile 库保护 RTP 或 SRTCP。
3. 接收端按 SSRC 找到上下文，推断 index，先完成 profile 验证，再提交 replay window 和序号状态。
4. 通过安全检查的 RTP 交给重排/解码，RTCP 交给反馈处理；失败包只更新受控计数。
5. ICE restart、DTLS 重握手、SSRC 变化和关闭触发上下文复用、原子切换或清理。

## Profile 与算法套件边界

SRTP profile 是媒体安全配置文件，决定加密算法、认证方式、tag 长度、密钥长度、salt 长度、密钥派生和重放语义。DTLS cipher suite 只描述 DTLS 握手和 DTLS 记录保护，不能用它替代 SRTP profile。

- AES-CM-128 加 HMAC-SHA1-80/32 是传统的分离式加密/认证组合；80 或 32 表示认证 tag 的典型截断长度。
- AEAD_AES_128_GCM 和 AEAD_AES_256_GCM 把加密与认证组合为一次 AEAD 操作，tag 和附加认证数据由 profile 定义。
- RTP/RTCP 的头部可见性、哪些字段进入认证、哪些扩展可加密，以及 MTU 开销，都由使用的 profile 和扩展规范决定。
- 浏览器 WebRTC 使用 DTLS-SRTP 进行密钥管理；SDP SDES 的明文 inline master key 不应当作为普通 WebRTC 实现的替代方案。

算法名称只是协商和库配置的一部分。实现应使用经过验证的 SRTP/AEAD 库，不能把 profile 名称当成可以自行拼接的密码算法说明。

## 密钥层次与 DTLS-SRTP exporter

### Master key、master salt 与 session key

一个 SRTP crypto context 从 master key、master salt、profile 参数和密钥派生速率得到 session encryption key、session authentication key 和 session salt。派生过程还会用到 profile 定义的 label、key index 和长度；应用只管理密钥句柄和 key epoch，不应读取或打印原始字节。

master key/master salt 是密钥生命周期的根材料，session key 是供包保护使用的派生材料，packet index 不是密钥。不能把 RTP sequence number 直接当成 master key，也不能让不同方向共用未经区分的发送/接收密钥。

### DTLS-SRTP 映射

DTLS 通过 use_srtp 扩展协商 SRTP protection profile。握手完成后使用 DTLS exporter 标签 EXTRACTOR-dtls_srtp 生成固定长度的 keying material，再按客户端/服务端方向和 profile 的 master key/master salt 长度切片。切片顺序和长度必须由 RFC 5764 及所选 profile 规定，不能由应用自行猜测。

每次新的 DTLS key epoch 都要建立与方向绑定的 crypto context。若只是 ICE restart 且 DTLS transport 复用，旧 context 可能继续有效；若发生新的 DTLS 握手，则要原子切换到新 epoch，禁止把旧包、旧 replay window 和新密钥无条件混在一起。

## 关键对象、字段与报文

profile、master key/master salt、session key、SSRC、sequence、ROC、packet index、replay window、SRTCP index/E bit 和 key epoch 共同构成报文保护上下文；RTP/RTCP 的头部、负载、认证 tag 和 padding 则构成线路报文。

## 每 SSRC 的 crypto context

RTP 安全层通常按 crypto context 管理共享的 profile/派生材料，再为每个 SSRC 保存独立的包序与重放状态：

| 状态 | 发送端 | 接收端 |
| --- | --- | --- |
| SSRC | 当前发送源标识 | 期望/已观察到的发送源标识 |
| sequence | 下一个 RTP 序列号 | 最近接受或用于推断的序列号 |
| ROC | 序列回绕计数 | 当前及候选 ROC |
| packet index | 发送包的 ROC 与 sequence 拼接 | 通过 ROC 推断得到 |
| replay window | 通常只需维护发送序号 | 最高已接受 index 与位图 |
| key epoch | 当前保护密钥代次 | 当前可验证的密钥代次 |
| 计数器 | 发送、保护失败 | 认证失败、过窗、重复、未知 SSRC |

SRTCP 另外维护 SRTCP index 和 E bit 处理状态，不能把 RTP sequence/ROC 直接用于 RTCP。

## 原理细节

安全层把报文身份拆成三部分：profile 决定算法和字段边界，packet index 解决序列回绕与乱序，replay window 解决重复/过旧包。任何一部分状态错位，都可能表现为“包到了但无法解密”，不能只从网络丢包率判断。

## RTP packet index 与 ROC

RTP packet index 是 48 位概念值，由高 32 位 ROC 和低 16 位 RTP sequence number 拼接：

    packet_index = (ROC << 16) | SEQ

发送端每发送一个 RTP 包递增 sequence；从最大序列号回绕到较小序列号时递增 ROC。sequence 本身只在包头中传输，ROC 通常不在线路上显式发送，而是由接收端根据历史最高序列号和半个序列空间推断。

接收端必须允许少量乱序。例如，当前最高序列号接近 65535，而收到 0 附近的包，通常是前进回绕；当前最高序列号很小而收到接近 65535 的迟到包，通常属于上一 ROC。边界判断应采用 RFC 定义的模 2^16 序号空间，不要用普通整数大小比较。

下面是用于理解的 ROC 推断伪代码。实际实现应直接采用经过测试的协议库算法，并覆盖半空间边界：

~~~text
delta = signed_16bit(seq - highest_seq)
if delta > 0 and seq < highest_seq:
    guessed_roc = current_roc + 1       # 前进回绕
else if delta < 0 and seq > highest_seq:
    guessed_roc = current_roc - 1       # 迟到的上一回绕
else:
    guessed_roc = current_roc
candidate_index = (guessed_roc << 16) | seq
~~~

ROC 推断只是候选索引，不能在认证前更新最高序列号或 replay window；否则伪造包可以推进状态并制造拒绝服务。

## IV/nonce 构造概念

SRTP 不为每个包随机生成并传输一个完整 nonce，而是用 session salt、SSRC、packet index 和 profile 定义的方向/上下文编码构造包级 IV 或 AEAD nonce。抽象表示为：

    nonce = ProfileEncode(session_salt, SSRC, packet_index, direction)

不同 profile 的字节布局、移位、填充、长度和是否包含方向标签可能不同。AES-CM 的计数器输入与 GCM 的 nonce 规则不能互换；实现应调用库的 protect/unprotect 接口，不要根据上式手写位运算和密码调用。

关键不变量是：同一 key epoch 下，不能让同一 SSRC 和 packet index 重复使用会导致 nonce 重用的组合；重启、重协商和 key epoch 切换必须明确状态边界。

## RTP 保护与验证原理

### 发送

- 保留 RTP header、timestamp、payload type、SSRC 和 sequence；更新发送端 sequence/ROC 状态。
- 计算 packet index，交给 profile 生成 IV/nonce。
- AES-CM 组合先用密钥流保护负载，再按 profile 对头部、密文负载和 ROC 相关输入计算认证 tag；AEAD profile 则使用附加认证数据一次完成加密和认证。
- 将认证 tag 按 profile 附加到 RTP 包；ROC 通常不作为明文字段发送。

### 接收

- 解析 RTP header，按 SSRC 找到接收 crypto context，并推断 candidate ROC/index。
- 对明显过旧的 index 可以做不推进状态的早期过滤；真正接受前仍需由密码库完成认证/解密。
- 认证失败时绝不更新最高 index、ROC 或 replay window；认证成功后再检查重复/过窗并提交状态。
- 通过后交给 RTP 重排、丢包恢复和解码层，安全层不负责判断帧是否及时可播。

## SRTCP index 与 E bit

SRTCP 在 RTCP 报文后附加一个 32 位字段：最高位是 E bit，低 31 位是 SRTCP index，随后是 profile 定义的认证 tag。E=1 表示 RTCP 有效载荷被加密，E=0 表示有效载荷不加密但仍可按 profile 进行完整性保护；解析时不能把 E bit 当成 index 的普通最高位。

SRTCP index 由发送端针对 RTCP 安全上下文递增，用于构造保护输入、派生包级 nonce/IV 和接收端防重放。它与 RTP sequence、ROC 相互独立。接收端需先按 SSRC/crypto context 识别 profile，再验证 index/E 和认证，之后才更新 SRTCP replay window。

RTCP 头、报告块、反馈消息和可能的 padding 是否进入附加认证数据，由 SRTCP profile 规定。NACK、PLI、Sender Report 等控制报文的安全失败应与 RTP 认证失败分别计数。

## 收发伪代码

下面的伪代码故意把密码运算封装在受验证的 profile 库中：

~~~text
send_rtp(packet, ssrc_state, crypto_context):
    seq = ssrc_state.next_seq
    roc = ssrc_state.roc
    index = (roc << 16) | seq
    protected = profile.protect_rtp(packet, index, crypto_context)
    transport.send(protected)
    ssrc_state.advance_after_send(seq)

receive_rtp(raw, ssrc_state, crypto_context):
    packet = profile.parse_rtp(raw)
    index = infer_index(packet.seq, ssrc_state)
    if ssrc_state.replay.too_old(index):
        metrics.replay_or_too_old += 1
        return DROP
    if not profile.verify_and_open_rtp(packet, index, crypto_context):
        metrics.auth_failed += 1
        return DROP
    if ssrc_state.replay.seen(index):
        metrics.replay_duplicate += 1
        return DROP
    ssrc_state.replay.accept(index)
    deliver_to_rtp_jitter_buffer(packet)
    return ACCEPT

send_srtcp(rtcp, rtcp_state, crypto_context):
    index = rtcp_state.next_index
    protected = profile.protect_srtcp(rtcp, index, crypto_context)
    transport.send(protected)
    rtcp_state.next_index += 1

receive_srtcp(raw, rtcp_state, crypto_context):
    rtcp_packet, e_bit, index = profile.parse_srtcp(raw)
    if rtcp_state.replay.too_old(index):
        metrics.srtcp_old += 1
        return DROP
    if not profile.verify_and_open_srtcp(rtcp_packet, e_bit, index, crypto_context):
        metrics.srtcp_auth_failed += 1
        return DROP
    if rtcp_state.replay.seen(index):
        metrics.srtcp_duplicate += 1
        return DROP
    rtcp_state.replay.accept(index)
    deliver_to_rtcp_control(rtcp_packet)
    return ACCEPT
~~~

库接口必须保证认证失败不改变接收上下文。应用层不要在 profile 之外自行截断 tag、更新 ROC 或拼接 nonce。

## 重放窗口算法

接收端为每个 RTP SSRC 和 SRTCP 安全上下文保存最高已接受 index 与固定宽度位图。候选 index 处理逻辑为：

1. index 高于最高值时，认证成功后把窗口向前移动；位移大于窗口宽度时清空位图，否则左移并标记新包。
2. index 不高于最高值时，计算距最高值的偏移；偏移超出窗口直接丢弃，窗口内已置位表示重复，未置位表示允许的乱序包。
3. 只有认证成功的包才能置位或推进窗口；未知 SSRC 应进入有界待验证状态，不能无限创建上下文。

窗口宽度是延迟、乱序容忍和内存成本的取舍。过小会误丢正常乱序，过大则增加状态和重放检查范围；实际值由实现/profile和网络特征决定。

## 工程实现与取舍

- 密钥、profile 和每 SSRC 状态由同一个 transport/crypto-context 所有者管理，避免多个线程各自推进 ROC 或 replay window。
- 认证、窗口提交和媒体交付分层；安全层不决定关键帧恢复、抖动缓冲或解码截止时间。
- 使用成熟库封装 KDF、AEAD、tag 比较和序号扩展；应用层只处理状态机、错误分类、资源上限和生命周期。
- 对新旧 key epoch 设定明确切换和排空策略，优先保证不会接受错误密钥或重放包，再考虑平滑过渡。

## 重协商、ICE restart 与关闭生命周期

- **新建**：DTLS-SRTP exporter 完成后建立 key epoch、profile、crypto context 和每个 SSRC 状态。
- **仅 ICE restart**：若 DTLS transport 和密钥仍复用，RTP/SRTCP 状态通常按现有上下文继续；仍需关联新的 transport/generation 并验证 selected pair。
- **新 DTLS 握手/重新协商**：建立新 epoch，profile/密钥长度/方向重新校验；以原子方式切换上下文，旧包按策略短暂排空或立即拒绝。
- **SSRC 变化**：创建有界的新 SSRC 接收状态，等待认证成功后纳入会话；不能因一个未认证包无限分配资源。
- **关闭**：停止发送，阻止新包进入保护队列，清理密钥句柄、SSRC 状态、replay window 和定时器，不把密钥写入崩溃日志。

## 可观测指标与验证

验证应同时覆盖 profile 协商、key epoch、每 SSRC index/ROC、replay window、SRTCP E bit 和媒体结果；抓包只用于确认包型、方向、长度和握手顺序，不能把未解密包误判为媒体内容。

## 失败指标与日志

- 协商：无共同 SRTP profile、use_srtp 缺失、profile/MTU 不兼容、DTLS exporter 长度错误。
- 密钥：key epoch 不匹配、方向映射错误、context 初始化失败、旧 key 使用和密钥生命周期超时。
- RTP：认证失败、未知 SSRC、ROC 推断冲突、序列跳跃、过窗、重复包、nonce 重用保护触发。
- SRTCP：E bit/低 31 位解析错误、index 回退、认证失败、重复/过窗、RTCP payload 解密失败。
- 关联指标：selected pair、DTLS state、RTP 收包、解码帧、RTCP 反馈和丢包恢复，区分安全层丢弃与网络丢包。

日志只记录 profile 名称、key epoch 标识的不可逆摘要、SSRC、index 范围、错误分类和时间，不记录 master key、session key、salt、私钥或可还原密钥的导出材料。

## 常见误区与失败表现

- 把 DTLS cipher suite 当作 SRTP profile，导致 exporter 长度、tag 或 nonce 规则不匹配。
- 在认证前推进 ROC 或 replay window，攻击者可用伪造包污染接收状态。
- 把 RTP sequence/ROC 复用于 SRTCP index/E bit，表现为 RTCP 认证失败或反馈全部丢弃。
- ICE restart 后无条件重置或复用 SRTP context，导致旧包被接受、合法包被拒绝或出现连续认证失败。
- 看到认证失败就增加重传；安全层失败应先检查 key epoch、方向、profile 和上下文，而不是制造更多网络流量。

## 测试向量策略

- 使用 RFC 3711 的 SRTP/SRTCP 测试向量，以及 RFC 5764 的 DTLS-SRTP profile/exporter 约束；采用 RFC 6904、RFC 7714 等适用扩展的公开向量。
- 用固定的合成 master key/salt 仅存在于隔离测试 fixture，验证 AES-CM/HMAC 与 AEAD profile 的 protect/open、tag 错误和附加认证数据。
- 覆盖 sequence 65535→0、上一 ROC 迟到包、乱序窗口边界、重复/过窗、SSRC 切换、SRTCP E=0/1、RTCP padding 和 key epoch 切换。
- 与至少一个成熟 SRTP 库或标准向量逐包比对，不以自写加密实现作为 oracle；应用测试只验证状态机、错误分类、清理和不泄露密钥。
- 做模糊测试和资源测试：畸形 RTP/RTCP 头、超长 tag、未知 profile、巨大 index 跳跃、无限新 SSRC 和高重放速率。

## 工程边界

密码算法、KDF、AEAD、HMAC、tag 比较、序号扩展和 replay window 的细节应交给成熟、审计过的库；本笔记只定义输入输出、状态所有权、验证顺序和观测要求。不要复制伪代码直接实现密码学，也不要在生产环境启用为测试向量准备的固定密钥。

## 示例场景

一个视频 SSRC 在序列号 65534 后发送 65535、0、1。发送端在 0 处将 ROC 加一；接收端通过半序列空间推断相同的 packet index，认证成功后推进 replay window。若攻击者重放 65535，候选 index 已在窗口内置位，报文被丢弃且不会再次交给解码器。

## 图谱关系

- 上位概念：[[SRTP]]定义 RTP/RTCP 的安全职责边界。
- 密钥来源：[[DTLS]]通过 DTLS-SRTP exporter 提供方向分离的 master key/master salt。
- 媒体报文：[[RTP]]提供 SSRC、sequence、timestamp 和 payload 结构。
- 控制报文：[[RTCP]]提供报告、反馈和 SRTCP 保护对象。
- 生命周期：[[WebRTC 会话生命周期]]管理 transport、key epoch、SSRC 和关闭清理。

## 参考资料

- 《WebRTC 权威指南》第 10 章“协议”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/10-protocols.md`
- 《WebRTC 权威指南》第 12 章“IETF RFC 文档”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/12-ietf-rfc-documents.md`
- 《WebRTC 权威指南》第 13 章“安全与隐私”：`90-参考资料/音视频与 WebRTC 书库/webrtc-authoritative-guide-zh/content/13-security-privacy.md`
- 《WebRTC Cookbook》第 3 章“集成 WebRTC”：`90-参考资料/音视频与 WebRTC 书库/webrtc-cookbook/translation/03-integrating-webrtc.md`
