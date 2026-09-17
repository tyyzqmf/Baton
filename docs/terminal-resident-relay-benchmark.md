# Terminal 独立 WSS 中继：跨 EC2 对照结果

> 历史实验记录：2026-09-16 已按要求删除本轮临时测试脚本。本文的实验路径和复现命令仅说明当时方法，
> 不再是当前仓库的可执行入口；当前实现与云端测试入口见 `docs/terminal-direct-integration.md`。

日期：2026-09-16。区域：`ap-northeast-1`。

后续约束：用户明确排除 EC2 / Fargate 常驻中继，此文只保留性能对照，不作为部署建议。
无需自建服务的 Gateway HTTP / SigV4 路径已跑通，见 `docs/terminal-connections-benchmark.md`。

## 结论

**绕过逐消息 Lambda 的独立 WSS 中继已跑通，而且本次跨主机实测有明显收益。**
当前 Gateway + Lambda 128MB 链路的纯消息双端往返 p50 为 144–147ms；
独立 WSS 中继两轮 p50 为 1.64ms、1.87ms，p95 为 1.81ms、2.09ms。

这是同区域 EC2 的合成消息测试，不包含公网客户端、PTY、xterm 或页面渲染。
不能把它说成“用户终端已经从 500ms 降到 2ms”，也不能把全部收益解释为 Lambda 函数本身的差距。
新路径同时省去了逐消息 Lambda 调度、DDB 路由查询、Management API HTTP 回调，资源配置也不同。

## 测试拓扑与口径

```text
基线：测试 EC2 上的 App ──WSS── Gateway / Lambda / DDB / 回调 ──WSS── 同 EC2 上的 Bridge
中继：测试 EC2 上的 App ──WSS── 另一台 EC2 上的中继          ──WSS── 同 EC2 上的 Bridge
```

- 客户端是 `ssh test-ec2-ap`，实例类型 `c8i.4xlarge`。
- 中继运行在新建的独立 `t3.small`，与客户端同 VPC、同子网、同可用区 `ap-northeast-1d`。
  两台实例不同，不是同机回环。中继使用 VPC 私网地址，未经过 ALB/CloudFront。
- 双端消息都由 EC2 上的脚本实际发送、接收；计时在 EC2 内使用单调时钟，SSH 只负责启动和取报告。
- 两条路径复用同一个 `measure()`、相同业务字段及一字节 Base64 输入/原样输出。
  客户端均为 `websocket-client==1.9.0`。每组 3 次预热、100 次测量，不在样本间人为等待。
- 顺序为 Gateway 前置对照 → WSS 中继第一轮 → WSS 中继第二轮 → Gateway 后置对照。
  两侧都验证输入、输出序号及字节内容；不以发送完成或 ACK 代替实际接收。
- Gateway 仍使用原有 `Baton-ws-handler` 128MB，未改代码、内存、路由或表。
- 中继为 `websockets==15.0.1` 的常驻 Python 进程，握手时校验测试令牌，绑定角色与设备；
  数据路径只做校验、连接查找、转发，没有逐消息 HTTP 或数据库请求，也没有固定批处理等待。
- 两条路径的网络并不完全相同：Gateway Ping p50 3.34ms，中继 Ping p50 0.69ms。
  因此这是完整部署路径的对照，不是严格隔离网络、CPU 等所有因素后的函数微基准。

## 实测结果

单位：毫秒。p50/p95 使用最近秩法；保留全部有效测量样本，没有剔除慢样本。

| 双端消息往返 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB，前置对照 | 111.13 | 147.46 | 210.66 | 301.93 |
| 独立 WSS 中继，第一轮 | 1.47 | 1.64 | 1.81 | 1.90 |
| 独立 WSS 中继，第二轮 | 1.63 | 1.87 | 2.09 | 2.22 |
| Gateway + Lambda 128MB，后置对照 | 110.62 | 143.90 | 182.07 | 346.24 |

中继记录了 412 次转发，即两轮各 `(3 次预热 + 100 次测量) × 输入/输出两次转发`。
从中继 handler 开始处理消息到 `await peer.send()` 完成，p50 约 **0.102ms**、p95 约 **0.125ms**。
这不是纯 CPU 时间，也不代表数据已抵达客户端；实际双端接收耗时以表格为准。

本轮是低并发、已建立连接后的交互基准。尚未测冷启动、公开 WSS 入口、多用户并发、
大段 PTY 输出、移动网络切换或断线恢复，不能据此承诺所有负载下都有同样延迟。

## 与前一轮 VPN / EC2 对照的关系

前一轮固定同一 API 做了 EC2 → 本机 → EC2 对照，每组 30 次：

| 指标，p50 | 本机当前网络 | 东京 EC2 |
|---|---:|---:|
| Gateway 原生 Ping/Pong | 187.88ms | 2.34 / 3.72ms |
| Gateway + Lambda 双端消息往返 | 522.27 / 526.48ms | 各组 158.75–161.11ms |

本机当时访问 Gateway 的 IPv4 路由明确走 `utun6` 隧道接口；EC2 使用普通 VPC 路由。
这说明早先本机测得的 500ms 左右不是纯云端处理耗时，但不能把全部差值归因于 VPN，
因为机器所在地、互联网路径和操作系统等也变了。VPN 的净影响仍需同机开/关对照。

前一轮还复测了 AppSync Events：EC2 两轮 p50 分别为 **282.69ms、113.34ms**，
p95 分别为 **454.29ms、271.23ms**；本机这一轮 p50 为 **605.24ms**。
结果有波动，不能说 AppSync 总是更慢，也没有显示出独立 WSS 此次的低延迟与稳定性。

AppSync 的原生 Ping/Pong 另出现约 1 秒的 EC2 往返，而同一服务的数据回送更快。
因此不能把所有服务的 WS Ping/Pong 都直接当成纯网络 RTT，也不能机械地从消息耗时中相减。
RFC 6455 §5.5.2/5.5.3 描述的是端点响应 Ping 的行为，并不保证它是纯网络计时器：
`https://www.rfc-editor.org/rfc/rfc6455.html`。

## 安全边界与清理

- 临时中继安全组仅放行测试 EC2 的私网 IPv4 `/32` 到 28443；没有公开放行 WSS 或 SSH。
- 启用 TLS，客户端固定信任本轮证书并验证证书名称；没有使用 `CERT_NONE` 或关闭 hostname 校验。
  本地功能检查额外验证了错误令牌、错误 TLS hostname 被拒绝。
- 测试令牌独立生成；Gateway 对照也使用独立合成账号，不传真实账号或 AWS 长期凭据到测试 EC2。
- 中继进程以非 root 用户运行，启用文件系统保护；没有 IAM instance profile。
  有 28KiB 帧限制、角色/设备/所有权校验、队列/写缓冲限制、最多 8 组测试连接。
- 此中继只支持测试用 `input`/`output` 事件与监测接口，**不执行命令、不启动 Shell 或 PTY**。
  不可直接作为正式终端服务部署。
- 实例设置开机 20 分钟自动关机且关机即终止，作为清理失败的后备机制；正常结束已主动终止。
  临时安全组、测试 EC2 上的虚拟环境及文件均已删除。
- 原有 Web、Bridge、Gateway 和 Lambda 均未切换，当前用户终端仍走原链路。

## 可复现文件

- `test/server/ws_resident_relay.py`：独立、限用途的 WSS 中继。
- `test/server/ws_resident_compare.py`：复用原测量逻辑，执行前后 Gateway 对照与两轮中继测量。
- `test/server/run_ws_resident_probe.py`：创建临时实例/安全组、准备远端客户端、运行测试并清理。
- `test/server/ws_network_bench.py`：前一轮本机/EC2 网络对照。
- `test/server/test_ws_resident_relay.py`：令牌、角色、设备、所有权、大小与协议校验测试。

执行前需具备相关 AWS 资源权限及已有 SSH 访问权限；脚本只有显式 `--run` 才创建资源：

```bash
python3 test/server/run_ws_resident_probe.py --run \
  --ssh-host YOUR_TEST_HOST --client-instance YOUR_TEST_INSTANCE_ID \
  --gateway-url YOUR_EXISTING_WSS_ENDPOINT --samples 100
```

本轮私有系统临时目录：`terminal-resident-relay-ktlwp51n`，含 `comparison.json` 与 `metadata.json`。
上一轮网络对照目录：`terminal-network-comparison-sge7bna1`。
不把临时凭据、证书私钥、控制台捕获或原始私有报告提交到 Git。

## 下一步最小实现路径

保留现有 REST / Gateway WS 做管理、设备在线及鉴权，仅给终端增加可选的独立 WSS 数据通道：

```text
现有 API：鉴权、选择设备、签发短期会话票据
终端数据：Web / xterm ⇄ WSS Relay ⇄ Bridge / PTY
```

下一步先接现有 PTY 控制器和 xterm 做真实交互闭环，不增加输入提示等易用性功能。
复用已有序号、ACK、帧限制、背压、租约与断线处理；数据不能通过重试自动重复执行。
正式入口还需要有效公网证书、会话级票据与授权、Origin 策略、运维监控、容量验证及回退开关。
如果多进程/多实例部署，必须保证对应 App 与 Bridge 能正确配对，不能假定负载均衡器会自动完成。
