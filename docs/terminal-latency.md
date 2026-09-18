# 远程终端延迟验证与优化

> 历史实验记录：2026-09-16 已按要求删除本轮临时测试脚本。本文的实验路径和复现命令仅说明当时方法，
> 不再是当前仓库的可执行入口；当前实现与云端测试入口见 `docs/terminal-direct-integration.md`。

日期：2026-09-16。范围：`xterm` 分支的远程 POC，沿用现有东京区域 API Gateway WS / Lambda。
本文为实测记录，不是最低延迟保证或 SLA。所有终端输入均为测试字符/无副作用命令。

## 结论

- 已去掉 Bridge 固定 8ms 输出等待，改为当前事件循环结束时合并发送，不等待固定毫秒数。
- 已把输入 ACK 移出画面事件排序流；晚到的 ACK 不再阻止已经到达的终端输出显示。
- 同机 Bridge“收到输入 → 发出 PTY 回显”中位数从约 **10ms 降至 0.7ms**。
- 主耗时仍在云端往返。原生 WS Ping/Pong 中位约 **187ms**；完整远程输入/回显涉及
  浏览器→云端→Bridge→云端→浏览器，不能把一次 Ping 当成完整终端回显。
- 调整 Lambda 资源的对照中，完整回显最快观测约 **446ms**，中位约 **480–493ms**；
  原 128MB 配置优化后中位约 **604ms**。这些是本次网络/机器条件下的小样本，不是理论极限。
- **当前已恢复 128MB**，没有永久增加云端内存、修改架构或降低身份/连接归属校验。
  若接受调整资源，512MB 是后续候选；1024MB 在本次测试中的中位收益明显递减，不能据此推导长期成本。

## 方法

`test/bridge/terminal-latency-bench.mjs` 每次创建独立的临时 Bridge 设备连接，复用真实
`createTerminalRemote` 和 PTY，在真实 Chrome 中加载现有 xterm 页面，走实际云端 WS。
不会占用用户正在使用的测试终端，不执行安装/部署脚本。

Shell 为无用户启动配置的交互 Bash，用 `read -r -p 'BENCH> '` 接收逐个字符。每轮 3 次预热，
随后 30 次顺序按键；上一字符可见后立即发送下一字符，没有人为添加样本间隔。
统计使用最近秩分位数，min 是观测最小值；首次建连、登录 Shell 配置时间不计入按键统计。

捕获并分解：

1. 浏览器实际 keydown → WebSocket.send。
2. WebSocket.send → 同机测试 Bridge 收到输入。
3. Bridge 收到输入 → 输出发送（含 PTY 和合并调度）。
4. Bridge 输出发送 → 浏览器原始 WS 帧收到。
5. 原始帧收到 → 排序适配交付给页面。
6. 页面交付 → xterm DOM 出现字符。

浏览器和 Bridge 都运行在同一台 Mac，使用 `performance.timeOrigin + performance.now()` 做
同机分段观测；没有直接相减客户端和 AWS 的不同机器时钟。AWS 分段耗时独立使用
`time.perf_counter()`，只作为处理阶段观测，不冒充单向网络延迟。

测试保留完整 HAR、连续 CDP 网络/WS 事件、未经改写的应用层帧及分段报告；没有在页面跳转时
清空记录。此独立页没有 messages REST 请求。基线帧已通过真实 `RemoteTerminalSocket`
回放测试，再实施 ACK 排序调整。

**HAR/CDP 含连接 URL 和认证头，保存在权限受限的本机临时目录，不提交、不上传。**
`report.json` 的采样帧仅为测试终端内容；不要用这套录制方式无意记录生产终端中的密钥。

## 实测结果

单位 ms；每个完整终端配置 30 个正式样本，另外有 3 个预热样本。

| 配置 | 最小 | p50 | p95 | 最大 |
|---|---:|---:|---:|---:|
| 原实现，Lambda 128MB | 517.2 | 616.2 | 715.6 | 759.8 |
| 无固定输出等待 + 独立 ACK，128MB | 523.4 | 603.9 | 747.4 | 3597.7 |
| 同样代码，512MB 临时对照 | 447.0 | 493.2 | 660.6 | 939.3 |
| 同样代码，1024MB 临时对照 | 446.2 | 479.7 | 558.9 | 619.9 |

128MB 优化轮存在一次约 3.6 秒长尾，**没有剔除**。该样本的 Bridge→浏览器段约 3299ms，
PTY/合并约 0.7ms；对应服务端处理计时约 686ms。未计入处理计时的时间还可能涉及调用调度、
初始化和网络，不能没有额外证据就全部归因于冷启动。小样本 p95 不能代替长期长尾验收。

原生控制帧 Ping/Pong 另测 20 次：min **184.9**、p50 **186.9**、p95 **193.5**、max **194.8ms**。
它不包含 PTY、终端渲染或应用消息的完整双向转发，只用于观察当前 WS 路径的往返开销。

### 本地代码段

| 阶段 | 原实现 p50 | 优化后 128MB p50 |
|---|---:|---:|
| keydown → 发送 | 0.1 | 0.1 |
| Bridge 输入 → PTY 输出发送 | 10.0 | 0.7 |
| 浏览器排序等待 | 0.1 | 0.1 |

排序等待的中位都很小，但基线实测出现 output 先到、前序 ACK 晚到的情况，额外等待分别约
12ms 和 **87ms**；调整后这轮排序等待最大约 **0.2ms**。没有用伪造的本地字符回显掩盖网络延迟。

xterm DOM 渲染段在这些带 HAR/CDP 录制的无头浏览器测试中中位约 24–35ms，存在帧调度波动。
本轮不修改 xterm 私有实现、不调用弃用的 `writeSync`，也不把 DOM 时间当成显示器像素呈现时间。

### 服务端分段

仅 `profile: true` 的测试会话输出 `[terminal-timing]` 结构化计时，普通会话不记录。
日志包含 terminalId、事件种类/序号和耗时，不含输入、输出、API Key。
以下为测试相关日志的阶段中位数，包含 setup/预热，所以不应逐项相加替代 30 样本总延迟。

| 阶段 | 128MB | 512MB | 1024MB |
|---|---:|---:|---:|
| 上行连接身份查询 | 12.9 | 3.0 | 3.2 |
| 上行设备路由查询 | 40.0 | 4.4 | 4.6 |
| 上行 PostToConnection | 39.7 | 13.3 | 14.5 |
| 上行 handler 合计 | 85.1 | 21.2 | 22.1 |
| 下行目标连接查询 | 37.3 | 3.7 | 3.9 |
| 下行 handler 合计 | 73.9 | 20.6 | 19.6 |

测试表明这一负载在 512MB 下的服务端耗时明显降低，1024MB 没有同等幅度的进一步下降。
各组是顺序对照，不是严格随机控制实验；网络、热实例和机器负载的变化也会影响结果。
AWS 官方说明内存配置同时影响 CPU 配额，见原始依据：
`https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html`。

## 实现变化与不变项

- `bridge/terminal-remote.mjs`：`setTimeout(flush, 8)` 改为 `setImmediate(flush)`；满块和退出仍即时 flush。
- ACK 使用 `eventSeq: 0` 和累计 `clientSeq`，不占用画面事件序号。其他输出/尺寸/退出事件继续严格排序。
- Web 和 Server 兼容旧的有序 ACK；新独立 ACK 仍经过账号、设备、连接和 clientSeq 校验。
  不能让 output 使用 eventSeq 0 绕过排序。
- 心跳、断开重连、缺序超时、租约回收都是健康/故障处理，不是正常输入路径上的等待，保留它们。
- 保留 28KiB 帧限制、Base64 字节传输、队列上限、单连接所有权，不用削弱安全来换数字。
- 仅增量部署 `Baton-ws-handler` 的终端模块及可选计时入口，原有旧终端路由仍保留。
- 更新后的 WS 代码 SHA256：`+arVrSMgCIX8JEjpodhIufhRHGT3PP9p5lJml88aiAE=`。
  Lambda 内存对照结束已恢复 **128MB**；没有修改 CloudFormation 默认规格。
- 已确认独立测试 Bridge 没有活跃 PTY 子进程后重启，使同一个测试 URL 使用新代码；原有正式 Bridge 未动。

## 复现

仅测 WS Ping，不依赖浏览器测试库：

```bash
node test/bridge/ws-rtt-bench.mjs --run --samples 20
```

完整真实浏览器测试需本机有 Playwright 和 Chrome，Vite 运行在 5173；`PLAYWRIGHT_MODULE`
可指定已安装 Playwright 的绝对模块目录（不把本机路径写死到仓库）：

```bash
node test/bridge/terminal-latency-bench.mjs --run --samples 30 --label comparison --profile
```

`--echo` 是可选的纯字节回送对照，不启动 Shell，不能拿它冒充完整 PTY 验证；本文表格均为真实 PTY。
脚本没有 `--run` 时只打印用法，不连接 AWS。报告写入新建的私有临时目录。

回放捕获报告：

```bash
TERMINAL_LATENCY_REPORT=/absolute/private/report.json node --test test/frontend/terminal-remote-transport.test.mjs
```

该回放测试针对具有 ACK 阻塞的基线报告；普通自动化运行不读取本机私有捕获文件。

本次记录目录均在 `/var/folders/9g/xkkjxhjd1mn3dt2p1y0sqymc0000gq/T/` 下：
`terminal-latency-baseline-mpCxND`、`terminal-latency-immediate-128-wNSPv6`、
`terminal-latency-memory-512-lGIzvw`、`terminal-latency-memory-1024-2CSlo4`。
部署备份与原内存配置在 `terminal-latency-deploy-1itycrvh`；恢复代码前先检查是否已有更新部署。

## 下一步

当前已没有毫秒级的固定回显等待，继续盲目调小计时器收益有限。先由用户决定是否采用 512MB；
若目标仍是之前的 p50≤150ms，需要另行评审更近的部署区域或持久转发服务，并在真实网络验证。
不能承诺只换服务器就达到目标，也不应通过本地假回显掩盖真实远程状态。

2026-09-16 后续已完成 Gateway 直接集成部署验证及 AppSync Events 的合成双端 WS 对照，
详见 `docs/terminal-relay-options.md`。直接 `execute-api` AWS integration 被部署接口拒绝；
AppSync 虽不使用逐消息 Lambda，本轮纯消息往返 p50 685.5ms，对照 Gateway 为 517.6/505.1ms，
没有低延迟优势。这组不包含 PTY/浏览器渲染，不能与前文 keydown→DOM 指标直接比较。

同日后续已改用 EC2 做稳定网络对照，并完成独立 WSS 中继的跨主机测试。
最新结果见 `docs/terminal-resident-relay-benchmark.md`：原链路约 144–147ms，中继约 1.6–1.9ms，
均为预热后的合成双端消息往返，不是用户页面最终延迟。此前本机数据不可解释成纯云端运行开销。
