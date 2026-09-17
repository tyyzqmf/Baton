# API Gateway @connections：隔离运行时验证

> 历史实验记录：2026-09-16 已按要求删除本轮临时测试脚本。本文的实验路径和复现命令仅说明当时方法，
> 不再是当前仓库的可执行入口；当前实现与云端测试入口见 `docs/terminal-direct-integration.md`。

日期：2026-09-16。区域：`ap-northeast-1`。

> 后续集成发现：具体 connection ID 的 IAM Resource 限制实测不成立。
> 本文证明的是传输与延迟，不是单连接授权。实际 POC 改为独立数据 API + 会话 HMAC，
> 实现及安全边界见 `docs/terminal-direct-integration.md`。

## 结论与约束

- 用户明确不接受 EC2 / Fargate 常驻中继；此前自建 WSS 仅作为性能对照，不是后续落地方案。
- **两端保持 WebSocket，客户端附带 SigV4 签名，Gateway HTTP integration 直接调用
  `@connections` 转给对端，这条路径已经完成双端运行时验证。** 不需要自建中继，逐消息不经过 Lambda。
- 另验证了客户端直接签名 HTTPS POST、对端 WS 接收，用于对照转发开销。
- Gateway 仍不自动发现 / 配对客户端；需要安全获取目标 connection ID、短期签名权限、
  终端会话绑定与消息顺序控制。不是删除 Lambda 或仅配置 IAM role 就能完成。
- 本次测试的 HTTP integration + `CredentialsArn` 返回 403，不能把它当成 Gateway 自动签名转发已可用。
- 标准跨域 Authorization-header POST 的 OPTIONS 预检返回 403，无 CORS 允许头。
  **两端 WS 方案不要求浏览器执行这次 HTTP POST**：签名材料通过 WS 传给 Gateway，
  Gateway 在服务端请求 `@connections`。尚未接入真实浏览器 xterm，不能把 EC2 验证当作浏览器验收。

## 1. 拓扑与计时

客户端均运行在已有 `test-ec2-ap`，没有创建新的 EC2 或部署常驻服务。

```text
原链路：
模拟 App ─WS→ Gateway → Lambda → @connections → Gateway ─WS→ 模拟 Bridge
模拟 App ←WS─ Gateway ← @connections ← Lambda ← Gateway ←WS─ 模拟 Bridge

签名直推：
模拟 App ─签名 HTTPS POST→ @connections ─WS→ 模拟 Bridge
模拟 App ←WS─ @connections ←签名 HTTPS POST─ 模拟 Bridge

两端保持 WS：
模拟 App ─WS(消息+签名)→ Gateway HTTP integration → @connections ─WS→ 模拟 Bridge
模拟 App ←WS─ @connections ← Gateway HTTP integration ←WS(消息+签名)─ 模拟 Bridge
```

- 新建隔离 WebSocket API，`$connect` 使用 `AWS_IAM`，不配置后端 integration。
  官方允许省略 `$connect` integration；不能把先前 MOCK 握手 500 当成回送接口不可用的证据。
- `hello` 使用 MOCK 返回自己的 connection ID；无 DynamoDB、无终端进程、无 Lambda。
- STS 临时凭据有效期 900 秒，权限仅限临时 API 的指定 stage 建连、回送。
  仅通过 SSH stdin 传递给客户端，不传长期 AWS 凭据或真实 Baton API Key。
- 原链路对照使用合成账号、独立设备名，不向真实 Bridge 发送命令。
- 相同 `measure()`、一字节 base64 输入及原样输出、3 次预热后每组 100 次。
- 所有时间取 EC2 本机单调时钟；包含签名、发送、双向转发和实际 WS 收到事件，不计 SSH 时间。
- 直推客户端复用 HTTP 连接，关闭 SDK 自动重试。两个工作线程发送 POST，接收端不等待 HTTP
  响应再读取 WS；最终检查全部 POST 响应为 200。无固定批处理延时或样本间 sleep。
- 不包括真实 PTY、浏览器渲染、用户公网 / VPN、多用户并发或移动网络切换。

## 2. 100 次采样结果

### 2.1 最终两端 WS 与同轮对照

修正签名路径后，按 Gateway 前置对照 → HTTP 直推 → WS header 签名 → WS query 签名 →
HTTP 直推 → Gateway 后置对照的顺序，各做 3 次预热及 100 次采样。
完整双端消息往返，单位 ms：

| 方案 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB，前置对照 | 116.54 | 159.24 | 181.95 | 298.03 |
| 客户端签名 HTTP 直推，第 1 组 | 17.73 | 21.52 | 30.81 | 82.03 |
| **两端 WS，Gateway HTTP 转发 header 签名** | 24.82 | **35.74** | **59.13** | 155.13 |
| **两端 WS，Gateway HTTP 转发 query 签名** | 27.87 | **34.28** | **61.26** | 99.09 |
| 客户端签名 HTTP 直推，第 2 组 | 16.20 | 20.12 | 28.82 | 125.42 |
| Gateway + Lambda 128MB，后置对照 | 119.86 | 157.18 | 210.75 | 247.45 |

两端 WS 方案中位往返约 34–36ms，同轮原链路为 157–159ms；逐条核对序号与数据。
没有人为等待 HTTP integration 的响应 ACK 后再显示数据，接收函数跳过诊断 ACK 并等待目标数据帧。
全部长尾保留；一次低并发实验不能证明 query 比 header 签名更快，也不承诺公网终端回显只有 35ms。
最终报告目录标识：`terminal-connections-runtime-o2h5tlr1`。

### 2.2 先前客户端 HTTP 直推对照

完整双端消息往返，单位 ms：

| 方案 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB，前置对照 | 114.43 | 159.96 | 182.17 | 270.34 |
| 签名 HTTP 直推，第 1 组 | 16.00 | **23.06** | **30.74** | 120.88 |
| 签名 HTTP 直推，第 2 组 | 16.91 | **21.21** | **27.44** | 29.40 |
| Gateway + Lambda 128MB，后置对照 | 111.51 | 158.55 | 199.00 | 266.57 |

直推两组共 412 次 POST（含预热），全部返回 200，并逐条核对实际接收的序号和内容。
第 1 组保留了 120.88ms 的长尾，没有剔除异常样本，也不在缺少证据时归因于冷启动或网络。
这表明无需自建常驻中继也能显著降低本轮云端转发耗时；不能承诺公网用户最终输入回显为 21ms。

## 3. Gateway 直接转发的编码问题

初次将客户端 SigV4 header / query 映射到 HTTP integration 时都返回 403。
增加安全的布尔诊断字段后确认是签名不匹配，而不是无法透传签名：

- SDK 直接 POST 使用的 URL 将 connection ID 末尾 `=` 编码为 `%3D`。
- 测试 Gateway integration 的路径映射实际保留 `=`；如果按 SDK 预编码路径计算签名，
  SigV4 canonical URI 与实际请求不一致。
- 改为按 integration 实际发出的路径签名后，header 与 query 两种传递方式均返回 **200**，
  对端收到完全一致的合成消息。

不能把这一结果扩大为任意 URI / 字符的通用编码规则；实现必须按实际发送的 method、host、path、
query、signed headers 和 body 统一计算签名。也不能因为一次 403 就宣称 HTTP 回送不受支持。
独立功能验证报告：`terminal-connections-runtime-_1g7fxvo`。

## 4. 签名与浏览器边界

运行时验证已区分以下情况，而非只判断 `create_deployment` 是否成功：

| 调用方式 | 状态 | 对端收到正确内容 |
|---|---:|---|
| Gateway HTTP integration，不签名 | 403 | 否 |
| Gateway HTTP integration，配置 `CredentialsArn` | 403 | 否 |
| Gateway HTTP integration，客户端 header 签名匹配实际路径 | 200 | 是 |
| Gateway HTTP integration，客户端 query 签名匹配实际路径 | 200 | 是 |
| 客户端 SDK SigV4 Authorization header，直接 POST | 200 | 是 |
| 客户端 SigV4 query，保留并签名请求 body，直接 POST | 200 | 是 |
| 使用同一 query 签名但篡改 body | 403 | 否 |
| 浏览器样式 OPTIONS 预检，Authorization / 日期 / token headers | 403 | 不适用 |

Query 签名使用 60 秒有效期，签名绑定 body，不使用 `UNSIGNED-PAYLOAD`。
它不是把任意终端命令放入 URL，也不是给前端发放长期管理员密钥。
直接 query POST 携带 `Origin: http://localhost:5173` 和 `Content-Type: text/plain` 时成功回送，
但 HTTP 响应没有 `Access-Control-Allow-Origin`。这是 HTTP 客户端验证，不是实际浏览器验收。
浏览器若使用简单请求 / `no-cors`，仍需单独验证 opaque 响应、WS 确认、错误反馈、CSP 和断线行为，
不能据此声称浏览器标准跨域 SDK 调用已经跑通。

## 5. 接入真实终端前必须解决

1. 既有认证 API 签发短期、最小权限凭据，绑定账号、设备、角色、终端会话和对端 connection ID；
   不能直接复用实验中“允许整个隔离 API 下回送”的 IAM 策略。
2. 两端 WS 的实际浏览器握手与签名实现，不把长期 AWS Secret 放入页面；
   如选择客户端直接 HTTP，另处理 CORS / opaque 响应，而不是与 Gateway 服务端 POST 混淆。
3. HTTP 并发发送可能乱序，保留现有序号、重排窗口、ACK、背压和输入大小限制。
4. 连接改变、凭据过期和撤销时重新授权；断线不重放终端输入。
5. 大段 PTY 输出、真实 xterm 回显、Vim、Ctrl-C、resize、公网链路与并发压测。

不能把客户端自报的 `replyConnectionId` / account / role 当作服务器身份注入。
更换转发路径时必须保留可信的会话所有权校验，否则仅保证请求有 SigV4 签名并不等于终端授权完整。

现有 API / Bridge / 前端未切换到此路径。本次只新增可复现测试与文档。

## 6. 复现与清理

```bash
python3 test/server/ws_connections_runtime_probe.py --run \
  --ssh-host test-ec2-ap \
  --gateway-url wss://jp53wzd7yd.execute-api.ap-northeast-1.amazonaws.com/v1 \
  --samples 100
python3 -m pytest -q test/server/test_ws_connections_runtime_probe.py
```

默认不带 `--run` 只显示帮助。`--functional-only` 仅运行功能 / 负向验证，不做延迟对照。
脚本创建临时 API、IAM role、日志组，以及现有 EC2 上的临时 venv；`finally` 删除这些资源。
所有阶段、完整样本与清理记录保存在本机私有临时目录，不提交签名 URL、凭据或原始授权帧。
早期 HTTP 直推 100 次采样报告目录标识：`terminal-connections-runtime-a83ulql1`；
最终两端 WS 100 次采样报告目录标识：`terminal-connections-runtime-o2h5tlr1`。

最终审计：本次 9 次隔离实验的 API / IAM role 均不存在，EC2 临时目录均已删除；
补充清理了 CloudWatch 异步投递导致延后重新出现的测试日志组。
正式 `Baton-ws-handler` 仍为 128MB，代码 SHA 与测试前一致，未部署 API / Bridge 业务修改。
测试结果：`test/server` 共 122 项通过，15 条既有弃用警告；`git diff --check` 通过。

## 7. 本机与 EC2 的同 API 对照

按用户要求，使用同一个隔离 API，顺序执行 **EC2 前测 → 本机 → EC2 后测**。
每个位置均包含：原 Lambda 链路前置对照、Header 签名 WS、Query 签名 WS、原链路后置对照，
每组 3 次预热后测 100 次；另对两个 Gateway endpoint 各测 30 次原生 WS Ping/Pong。

```bash
python3 test/server/ws_connections_runtime_probe.py --run \
  --gateway-url wss://jp53wzd7yd.execute-api.ap-northeast-1.amazonaws.com/v1 \
  --samples 100 --ws-only --locations ec2 local ec2
```

`--ws-only` 保留两种实际转发的 smoke check，任一失败就不执行性能测试；跳过先前已验证的
HTTP 直推与签名错误负向实验，避免与本次双端 WS 比较混在一起。
本机阶段两个模拟端都在本机，EC2 阶段两个模拟端都在 EC2；不是一端本机、一端 EC2 的混合拓扑。
计时包含实际消息送达，不计 SSH、建连、凭据签发、环境安装时间，无样本间人为等待。

环境记录：本机 macOS / Python 3.12.4；EC2 Linux / Python 3.9.25。
两端 boto3 都为 1.42.32，websocket-client 都为 1.9.0；botocore 本机为 1.42.32、EC2 为 1.42.97。
因此载荷、代码与服务配置相同，但不是完全相同的 OS / Python / 底层 SDK 环境，不能把所有差异都归因于 VPN。
每阶段测试前后记录目标域名的 IPv4 路由及代理环境变量名称，不读取或记录代理凭据，也不切换 VPN。

本轮报告目录标识：`terminal-connections-runtime-wmd_guik`。
分组文件：`ec2-1.json`、`local-2.json`、`ec2-3.json`；`runtime-details.json` 记录底层 SDK 版本。
### 7.1 本轮结果

以下都是完整双端消息往返，单位 ms；每个单元格为 **p50 / p95**，不是单向时延：

| 方案 | EC2 前测 | 本机当前网络 | EC2 后测 |
|---|---:|---:|---:|
| 原 Lambda 链路，前置对照 | 142.10 / 208.21 | 521.34 / 560.05 | 159.15 / 222.88 |
| 新链路，Header 签名 WS | **37.12 / 67.55** | **416.89 / 499.01** | **39.79 / 56.71** |
| 新链路，Query 签名 WS | **33.01 / 48.99** | **423.31 / 511.59** | **36.10 / 49.71** |
| 原 Lambda 链路，后置对照 | 159.29 / 187.23 | 527.69 / 599.11 | 157.97 / 188.21 |

- 本机中位往返由 521–528ms 降至 417–423ms，约减少 100ms（约 20%）。
- EC2 两轮新链路中位数均为 33–40ms，原链路 142–159ms。没有通过平均不同组的分位数生成“总 p50”。
- 本机 Header 新链路仍有 **882.41ms** 的最大值，原链路两组最大值为 741.46 / 687.82ms。
  保留全部长尾，不能声称每次输入都更快或抖动已经消失。
- 两种签名方式在不同机器的相对次序不同，不能依据本轮小差距断言 Query 或 Header 永远更快。

### 7.2 网络观察及解释边界

原生 WS Ping/Pong，各组 30 次，以下为 p50，单位 ms：

| Endpoint | EC2 前测 | 本机 | EC2 后测 |
|---|---:|---:|---:|
| 原 Gateway | 0.98 | 189.04 | 2.58 |
| 隔离直转 Gateway | 3.00 | 191.14 | 1.85 |

本机两个 endpoint 的已解析 IPv4 地址，测试前后路由均为 **`utun6`**；EC2 前后为
VPC 网卡 **`enp39s0`**。两端代理环境变量列表均为空，但空列表不等于未经过 VPN / 隧道。
没有修改用户的 VPN、系统代理或路由。

本机模拟 App 和 Bridge 都需经过云端转发，完整回显包含多次公网传输，而原生 Ping 只测一次
控制帧往返。新方案减少了应用转发开销，不能把本机公网延迟变成 EC2 同区域的水平。
Ping 也包含服务响应行为，不能把不同组的 Ping 与消息 p50 精确相减得到“纯 Lambda 时间”。

本轮证明的是当前两台机器和网络下的观测差异。地理位置、网络路径、OS、Python 和底层 SDK
不同，**不能把本机与 EC2 的全部差值归因于 VPN**；VPN 的净影响需要另行同机开 / 关对照。
测试仍是 Python 合成客户端，不包括真实 PTY、xterm 渲染、浏览器自身代理策略或移动设备输入。

新增测试与报告功能验证：服务端 126 项通过，15 条既有弃用警告；`git diff --check` 通过。
12 组结果共保留 1,200 次有效计时样本，已逐项核对报告中的分位数。
本轮最终审计确认临时 API / IAM role / EC2 venv / 测试日志组均已清理，
正式 Lambda 仍为 128MB 且代码 SHA 未变；现有 API、Bridge 和浏览器 POC 没有切换传输路径。

## 官方依据

- `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html`
- `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html`
- `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-integration-requests.html`
- `https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-data-mapping.html`
