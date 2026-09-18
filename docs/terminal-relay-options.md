# Terminal 中继选型：官方依据与隔离验证

> 历史实验记录：2026-09-16 已按要求删除本轮临时测试脚本。本文的实验路径和复现命令仅说明当时方法，
> 不再是当前仓库的可执行入口；当前实现与云端测试入口见 `docs/terminal-direct-integration.md`。

更新：2026-09-16。测试区域：`ap-northeast-1`。

最新约束与验证：用户排除自建 EC2 / Fargate 常驻中继。客户端 SigV4 HTTPS 直推
`@connections` 已完成 EC2 100 次对照，双端往返 p50 21.21/23.06ms；原链路为
158.55/159.96ms。进一步已跑通两端 WS → Gateway HTTP integration → `@connections`，
签名由客户端提供，修复了实际路径与签名路径编码不一致的问题。逐消息不经过 Lambda，
也不依赖常驻自建服务；两端 WS 最终 100 次采样 p50 34.28/35.74ms，对照 157.18/159.24ms。
实际浏览器与最小权限授权仍须验证，不能等同于现有 WS 自动配对。
详见 `docs/terminal-connections-benchmark.md`。下文早期“不经过 Lambda”的候选结论以此更新为准。

本机与 EC2 后续同 API 对照：本机新链路 p50 416.89/423.31ms，原链路 521.34/527.69ms；
EC2 前后两轮新链路 p50 为 33.01–39.79ms。本机目标 IPv4 路由前后仍经过 `utun6`，
不能用同区域 EC2 的 30 多毫秒替代用户本机的实际时延。细节见上述文档第 7 节。

后续更新：已完成跨 EC2 独立 WSS 中继对照，p50 1.64/1.87ms，对照当前 Gateway + Lambda
为 147.46/143.90ms。口径、限制和 VPN/EC2 复测见 `docs/terminal-resident-relay-benchmark.md`；
该数字不是公网用户终端的最终延迟。

## 结论先行

- 当前客户端到 API Gateway 的 WS 连接是持久连接，但应用消息仍逐条调用 Lambda；
  它不是把 Web 与 Bridge 两个 socket 配对后直接转发的常驻应用中继。
- API Gateway 支持非 Lambda 集成，不能说“所有 WS 集成都只能用 Lambda”。
  但本次测试的直接 AWS service integration → `@connections` 路径无法部署。
- HTTP integration + `CredentialsArn` 不等于自动 SigV4 签名。后续补充的隔离运行时验证
  已跑通客户端提供签名、Gateway HTTP 调用 Management API 回送，详见最新验证文档。
- 官方另有 AppSync Events、IoT Core 等托管发布/订阅服务，绕过逐消息 Lambda 不一定要 WebRTC
  或自建服务器。AppSync Events 已做真实双端 WS 对照；本轮没有表现出更低延迟。
- 独立 WSS 中继在跨 EC2 低并发对照中显示明显收益，但用户已排除常驻中继部署方式。
  保留该实验作为性能基线，不继续把它当作落地建议。

## 1. 当前实现与官方能力的区别

现有应用数据路径：

```text
Web ──WSS── API Gateway ──Lambda / DDB / PostToConnection── API Gateway ──WSS── Bridge
```

终端输入和输出各走一次应用转发。`$connect`、`$disconnect`、`$default` 目前指向同一个
`AWS_PROXY` Lambda integration。原生 WS Ping/Pong 不是这个应用转发流程。

AWS 的 WebSocket integration 文档列出 `AWS_PROXY`、`AWS`、`HTTP_PROXY`、`HTTP`、`MOCK`。
其中 HTTP integration 调用 HTTP 后端；它不是把已经建立的客户端 WS 原样延伸到后端 WS。
后端向另一个客户端推送时，官方接口是 `POST /stage/@connections/{connectionId}`，需要 IAM/SigV4。
客户端现有的 Baton API Key 不能代替该签名。

官方 Step Functions + WebSocket 示例也不能证明存在直接 WS 配对功能：示例先启动状态机，
再由 Lambda 向客户端发送消息。它演示服务集成，不是面向每个终端按键的低延迟捷径。

真正的常驻 WSS 应用中继可让 Web、Bridge 都向它建立出站连接，并在完成身份及会话绑定后，
由进程内路由转发消息。AWS ALB 官方支持 WS upgrade 后保持客户端与后端的持久连接。
但两个客户端之间的配对、账号隔离、背压和断线处理仍由中继应用实现，ALB 不自动完成这些工作。

## 2. Gateway 直接集成验证

复现脚本：`test/server/ws_direct_integration_probe.py`。
脚本创建独立 API、最小权限临时 IAM role，逐个调用真实 `create_deployment` 验证，不创建公开 stage。
角色只允许访问该临时 API 的 `probe/POST/@connections/*`，结束后清理 API 与 role。

| 配置 | 实际结果 |
|---|---|
| `AWS` → `execute-api:path/.../@connections/{connectionId}` | 部署拒绝：`AWS Service of type execute-api not supported` |
| `AWS` → `{apiId}.execute-api:path/...` | 部署拒绝：对应 service 不支持 |
| `AWS` → `apigatewaymanagementapi:path/...` | 部署拒绝：对应 service 不支持 |
| `AWS` → `execute-api:action/PostToConnection` | 部署拒绝：`execute-api` 不支持 |
| `AWS` → `apigateway:path/...` | 部署拒绝：对应 service 不支持 |
| `HTTP` → 当前临时 API 的 `@connections` URL | 可以部署；未证明可运行时回送 |
| 上述 `HTTP` 配置再加 `CredentialsArn` | 可以部署；未证明它会执行 SigV4 签名 |

上表是早期部署验证，不是最终运行时结论。后续实测仅加 `CredentialsArn` 返回 403 / missing authentication，
但客户端提供匹配实际 URI 的 SigV4 header 或 query 时，HTTP integration 成功回送 200。
完整运行时与延迟结果见 `docs/terminal-connections-benchmark.md`。

注意：`create_integration` 成功并不代表可部署，不能只测试配置创建接口就宣称打通。
上述错误是本次区域、日期和具体 URI 的实测结果，不扩展为“AWS 集成完全不可用”。

探索性运行时测试使用临时 `MOCK + IAM` 的 `$connect`，握手返回 500，尚未走到 HTTP 回送。
这不能被算作 HTTP 回送不受支持的证据。最终保留脚本明确只验证部署，避免将测试设施问题混入结论。

## 3. AppSync Events：确实无逐消息 Lambda，但本轮更慢

官方支持 WebSocket 发布和订阅，消息广播不要求用户部署 Lambda。
本轮创建独立 Event API、`terminal` namespace 和短期 API Key；不配置 handler、数据源或 Lambda。
只传递合成的一字节输入/回送事件，不连接 PTY，不发送真实命令、文件或账号数据。

测试路径：

```text
模拟 Web ──WSS── AppSync Events ──WSS── 模拟 Bridge
    ↑                                     │
    └──────────────── 原样回送 ────────────┘
```

用同一台机器、同一客户端库、相同输入/输出业务字段比较当前 Gateway + Lambda 128MB。
顺序为 Gateway → AppSync → Gateway，每组 3 次预热、30 次测量，不在样本间人为等待。
以本机单调时钟统计完整双端往返，不相减不同机器的时钟。

| 纯消息双端往返，毫秒 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB，前置对照 | 486.2 | 517.6 | 606.9 | 741.1 |
| AppSync Events，无逐消息 Lambda | 476.7 | 685.5 | 870.2 | 895.1 |
| Gateway + Lambda 128MB，后置对照 | 477.8 | 505.1 | 548.8 | 589.3 |

这些数字不包括 PTY、xterm 和浏览器渲染，不能与 `terminal-latency.md` 的 keydown→DOM 数字
直接混成同一指标。本地原样回送耗时中位约 0.006–0.008ms。发布确认不作为测量完成条件；
只有目标订阅实际收到对应输入/输出才计时结束。

结论仅限本轮网络与配置：AppSync 可以实现不经过逐消息 Lambda 的云端 WS 中继，但没有低延迟优势。
不能由此宣称 AppSync 在所有地区都更慢，也没有证据把多出的时间具体归因于某个服务内部机制。

实际还发现一处协议细节：官方示例的 `data.event` 是字符串数组，捕获到的实际帧是单个 JSON 字符串。
测试解码器兼容两者，并加了离线测试；原始合成 data 帧保留在私有报告中。

复现需要本机 `boto3`、`websocket-client` 和用于当前 POC 的 Bridge 配置：

```bash
python3 test/server/ws_direct_integration_probe.py --run
python3 test/server/ws_managed_relay_bench.py --run --samples 30
python3 -m pytest -q test/server/test_ws_managed_relay_bench.py
```

脚本不带 `--run` 时不连接 AWS。实验需要创建和删除隔离资源的权限；不使用现有业务 API 作为实验部署目标。
Gateway 对照会创建临时测试客户端/Bridge 连接，结束时关闭；不会操作用户正在运行的终端。

本轮成功报告位于系统私有临时目录：
`terminal-direct-integration-probe-xz27h9il/report.json`、
`terminal-managed-relay-bench-r4ba61um/report.json`。

## 4. 改动量与后续选择

| 候选 | 应用改动/运维 | 已验证到哪一步 | 当前判断 |
|---|---|---|---|
| 保留现有 WS，Lambda 调到 512MB | 很小；无新协议 | 前一轮真实 PTY/浏览器已对照，内存已恢复 128MB | 最小改动候选；需要决定是否接受资源配置变化 |
| Gateway 直接 AWS integration → `@connections` | 原设想很小 | 上述直接集成部署失败 | 不继续当作可用捷径 |
| Gateway HTTP integration → 常驻 HTTP 后端 | 需新后端，仍有逐消息 HTTP/回调 | 仅核实官方能力，未做完整性能测试 | 能替换 Lambda，但不是两个 WS 的直接转发 |
| AppSync Events | 改终端传输适配和授权；无需自管服务器 | 合成双端 WS 已完成对照 | 本轮无延迟优势，不因“无 Lambda”而迁移 |
| IoT Core MQTT over WSS | 新 MQTT 协议、topic 策略和凭据机制 | 仅查官方文档，未测 | 有托管 broker，但不是当前 JSON WS 的直接替换 |
| 独立常驻 WSS 中继 | 新小服务与部署；可复用终端事件协议 | 后续跨 EC2 已测，p50 1.64/1.87ms；未含 ALB/公网/PTY | 有明确收益，下一步验证真实终端闭环 |
| WebRTC DataChannel | 新信令、穿透、TURN 和故障回退 | 本轮不实现、不测试 | 不是绕过逐消息 Lambda 的唯一方法 |

若继续接入独立 WSS 中继，保持 REST/当前 WS 管理通道不动，只让终端数据选择新传输：
复用 PTY、事件序号、ACK、尺寸调整、断线杀进程与租约；不重写 xterm。
先做相同合成双端消息基线，再做真实 PTY/浏览器 keydown→可见输出测量，保留回退开关。

新中继上线前必须补齐短期会话凭据、账号/设备/会话授权和流控；本轮 AppSync 的全 API 测试 Key
仅用于隔离合成实验，不能直接复制到多租户生产终端，也不能向前端分发长期 AWS 凭据。
不能把共享 Key 或不可猜测 channel 名当成完整授权。

## 5. 官方资料

以下为本轮直接读取的 AWS 官方文档；区分文档能力、实际部署验证与性能测量，不依赖论坛推测。

1. WebSocket integration 类型与 HTTP 后端：
   `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-integration-requests.html`
2. `@connections` 与 IAM/SigV4：
   `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html`
3. Integration API 与 `CredentialsArn` 定义：
   `https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid-integrations.html`
4. 官方 AWS integration 示例（Step Functions，仍调用 Lambda 广播）：
   `https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-step-functions-tutorial.html`
5. ALB 原生 WebSocket 支持：
   `https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html`
6. AppSync Events 能力与授权类型：
   `https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-welcome.html`
7. AppSync Events WebSocket 握手、发布与订阅协议：
   `https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html`
8. IoT Core MQTT over WSS 与认证：
   `https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html`
