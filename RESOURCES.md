# RTC 教学资料

## Knowledge

- [RFC 8836：交互式实时媒体的拥塞控制要求，第 1 节](https://www.rfc-editor.org/rfc/rfc8836.html#section-1)
  IETF 发布于 2021 年的 Informational RFC。用于第一课：理解实时生成、及时消费的数据为何不同于文件传输；迟到媒体通常失去当前播放价值。不把文中时延描述当作所有产品的统一阈值。已于 2026-09-22 核对原文。
- [[01-基础/RTC]]
  本知识库的入门阅读入口；首次只看初读区。教学中的协议结论仍回到原始资料核对。

- [RFC 3550，第 2.1 节](https://www.rfc-editor.org/rfc/rfc3550.html#section-2.1)
  用于第二课：音频分块封装、序列号与时间戳，以及接收端在网络延迟变化下重建播放时序；不据此假设固定缓冲时长。第七课再次用于解释接收端缓冲与连续播放；2026-09-27 核对原文第 2.1 节。0、35、40 ms 的到达时间与两种播放安排均为教学设定，不是协议要求。

- [RFC 3550，第 5.1 节](https://www.rfc-editor.org/rfc/rfc3550.html#section-5.1)
  用于第三课：同一 RTP 流的序列号逐包递增，可帮助接收端检测缺口和恢复顺序；时间戳表达媒体采样时刻。观察到缺口不能单独证明网络永久丢包。

- [RFC 7587，第 4 节](https://www.rfc-editor.org/rfc/rfc7587.html#section-4)
  用于第四课：Opus 的 RTP 负载格式规定一个 RTP payload 恰好包含一个完整 Opus packet。用于区分编解码器输出与带 RTP 头的网络媒体包。

- [[01-基础/端到端延迟]]
  用于第五课：按采集处理、发送排队、网络、接收缓冲和播放分段记录单向延迟。课内数值是算术练习，不是实测或统一阈值。
- [RFC 3550，第 6.4.1 节](https://www.rfc-editor.org/rfc/rfc3550.html#section-6.4.1)
  用于第五课区分 RTCP 可估算的往返传播时延与媒体从产生到呈现的单向端到端时延；前者不能替代后者。
- [RFC 7679，第 1.1 节](https://www.rfc-editor.org/rfc/rfc7679.html#section-1.1)
  用于第五课补充 RTT 除以 2 的限制：去程和回程可能走不同路径，即使路径相同，两个方向的排队情况也可能不同。已于 2026-09-26 核对原文。
- [WebRTC 官方：Paced Sending](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/pacing/g3doc/index.md)
  用于第六课：Background 与 Life of a Packet 说明 RTP 包入队、等待调度再发送，以及集中发包的影响。2026-09-26 核对 main 文档；本课只引用机制，演示中的时间和数量均为教学设定，不是默认参数。

- [RFC 6716，第 4.4 节：Packet Loss Concealment](https://www.rfc-editor.org/rfc/rfc6716.html#section-4.4)
  用于第八课：PLC 是解码侧功能，参考实现利用此前解码的信号生成替代输出；实现方式可以不同。2026-09-27 核对原文，不将参考算法的函数名视作当前 WebRTC API。课内播放时序为教学设定，未开展实际音频实验。

- [RFC 4585，第 6.2.1 节：Generic NACK](https://www.rfc-editor.org/rfc/rfc4585.html#section-6.2.1)
  用于第九课：RTCP Generic NACK 标明缺失 RTP 包，PID 引用其 RTP 序列号；反馈不等于重传成功。2026-09-27 核对原文。
- [RFC 4588，第 3、7 节：RTP 重传的时间与流量取舍](https://www.rfc-editor.org/rfc/rfc4588.html)
  用于第九课：重传受可等待时间限制，并消耗额外发送能力。2026-09-27 核对原文；不据此声称所有音频会话默认启用重传。课内 15、10、25 ms 等为教学设定，不是实测。

- [RFC 7587 §3.3：Opus 带内 FEC](https://www.rfc-editor.org/rfc/rfc7587.html#section-3.3) 与 [RFC 6716 §2.1.7](https://www.rfc-editor.org/rfc/rfc6716.html#section-2.1.7)
  用于第十课：Opus 语音模式可在后续包中携带前一包音频的恢复信息，编码器决定是否加入；可能采用较低码率的再次编码，不等同于逐字节找回 RTP 原包。2026-09-28 核对原文。强调接收支持、及时到达和额外数据量，课内时间为教学设定。

- [RFC 6716 §2.1.1、§2.1.8：Opus 码率](https://www.rfc-editor.org/rfc/rfc6716.html#section-2.1.1)
  用于第十一课：码率与声音质量、目标与可变输出的区别。已核对本地保存的 RFC 原文；课程中的发送能力与额外开销均为教学设定，Opus 输出内含的带内 FEC 不重复计数。

## Wisdom (Communities)

暂未选择。待出现具体项目实践问题后再补充，不要求学习者现在加入社区。

## Gaps

- 后续媒体链路、编解码、网络传输实验的原始资料，随课程逐步核对补充。
