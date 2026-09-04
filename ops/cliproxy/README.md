# CLIProxyAPI 运维

Frely 的 CPA distribution 固定基于官方最新 non-prerelease tag `v7.2.145`（commit `d9cea8904b14fbbebb77ef26e98ef08f6b48a724`）、source archive SHA-256 `0a6015ae9511f6e10307ef3cea1bf86b703f418ba74182e523639c9871af0eae` 及官方 multi-arch manifest `eceasy/cli-proxy-api:v7.2.145@sha256:b90fcd2282e8b8da9ee05d531fb92e5215ac8340722f8842adb47bb7120226fd`。项目在 exact source 上应用 `friday-evidence-v1` CPA-side adaptation，并把 `cli-proxy-api` 作为第七个 first-party release image；生产不再直接运行 floating 或 stock upstream image。目标身份或 patch 改变前必须重新执行 source、协议、prefix 隔离、运行身份和日志 sentinel 验证。

## 稳定版本选择

CLIProxyAPI 候选版本以官方 GitHub `releases/latest` 指向的最新 non-prerelease semantic-version release 为准，不再另设发布时间观察门槛。发布时间和 release age 仍作为风险信息记录，但不能替代官方 stable 标记，也不能把已发布的最新 stable 排除在“尽可能新”的选择之外。

`bun run ops:check-cpa-updates` 读取官方 Release feed、`releases/latest` 和 exact tag lineage，并以 `friday-relay-cpa-update-evidence.v2` 报告当前 pin 是否与官方最新 stable 一致。选择最新 stable 不代表只替换版本号：采用仍必须固定 tag、commit、source checksum 和 OCI digest，并重新完成 source adaptation、兼容性、安全、回滚、runtime identity 与 Local Docker E2E 门禁。

## 运行边界

- Compose 只 `expose` CPA 的 `8317` 和窄控制服务的 `8319`，不发布宿主机端口。Admin/Gateway 不直接进入 Management 网络；只有 `cliproxy-control` 可使用 Management API。
- `config.yaml` 和 entrypoint 从仓库只读挂载。entrypoint 只在容器 tmpfs 中渲染 inference key，不把 secret 写回仓库或持久卷。
- OAuth/auth files 使用独立 `cliproxy-auth` volume。该 volume 不属于 PostgreSQL 备份、Request Capture 或普通日志归档。
- CPA 应用与访问日志写入独立 `cliproxy-logs` volume，`logs-max-total-size-mb: 100` 对该日志目录执行总量清理。它不替代 Friday Request Log 或 Request Capture；`commercial-mode: true` 和 `request-log: false` 继续禁止 CPA 保存请求/响应正文。
- `CLIPROXY_API_KEY` 只认证 inference；`CLIPROXY_MANAGEMENT_API_KEY` 只进入 CPA 与 `cliproxy-control`；`CLIPROXY_CONTROL_API_KEY` 只认证 Friday 到窄控制服务；`CLIPROXY_CREDENTIAL_STORE_KEY` 加密专用 credential volume。四者都至少 32 字符且必须两两不同。
- `request-log: false`、`commercial-mode: true`、`force-model-prefix: true` 是上线硬门禁。后两项分别提供 error-only request log 的纵深防护并阻止无 prefix credential fallback。
- `plugins.enabled: false` 固定关闭进程内 plugin；Friday 不挂载 plugin 目录。`friday-evidence-v1` 是 exact-source CPA distribution 内的窄 evidence adaptation，不是 Relay parser 或动态 plugin。Gemini 只支持 `api-key`，Admin 和 Control 不提供 Gemini OAuth。
- entrypoint 不得传 `-local-model`。CPA 使用镜像内嵌目录作为 fallback，启动时从上游远程目录刷新，并保持每 3 小时刷新；该 observation 不修改 Provider、ProviderModel 或 AccessPoint 的 Owner desired state。
- Provider generation 的 CPA 通用 `request-retry` 固定为 `0`，`max-retry-credentials` 固定为 `1`；后者表示一次只尝试一个 credential，CPA 中的 `0` 实际表示继续尝试全部可用 credential，禁止再用于“关闭重试”。Friday transport 也不重试，quota project/preview/Antigravity credits fallback 均固定关闭。OAuth credential 只可在明确收到 401、即本次认证未通过且 Provider generation 未开始后刷新并重发；其他内部 generation retry 只有具体 adapter 能权威证明上一轮 `not_started` 时才可增加，不能恢复通用 retry。
- CLIProxyAPI 不连接 Compose `default` 或 `cliproxy-public` 网络，不能直接访问公网。它的唯一公网出口是 internal hop 上的 `cliproxy-egress:8318`；egress 只跨接专用 `cliproxy-public` 网络，不与应用默认网络共享，自身无宿主机端口、无请求日志，也不读取任何 Provider 或 CPA secret。
- egress 只接受 HTTP forward request 和 HTTPS `CONNECT`，默认目标端口 allowlist 为 `80,443`。每次请求或 `CONNECT` 都解析全部 DNS answer，任一 private、loopback、link-local、CGNAT、documentation、multicast 或 metadata address 会令整次请求失败；连接只使用已经验证的 IP，不再按 hostname 二次解析。egress 不跟随 HTTP redirect：跨 origin 跳转必须建立新的请求/`CONNECT` 并重新验证，复用的同 origin tunnel 始终保持在原已验证 IP，不会因 DNS rebinding 换目标。

`bun run start` 和 `bun run local` 始终构建并启动 manifest-owned CLIProxyAPI、受控 egress 与 `cliproxy-control`。启动脚本会在私有 env 文件中生成并持久化四个独立 secret；Compose 只要求 CPA 容器进入 started 状态，随后由 `cliproxy-control` 校验 Management 配置、`cpa-basic@1` adaptation identity 和带鉴权的 `/v1/models`，Gateway 只等待 Control healthy。任一 CPA 服务、secret、adaptation identity 或 authenticated catalog smoke 不可用都会阻止 Gateway ready。已删除迁移期的 `CLIPROXY_ENABLED` 和可选 Compose profile；CPA 是唯一 Provider runtime，Provider 契约不存在可切换连接模式，也不能构成省略 CPA 的运行拓扑。

```dotenv
CLIPROXY_BASE_URL=http://cli-proxy-api:8317
CLIPROXY_API_KEY=<stable inference secret>
CLIPROXY_MANAGEMENT_API_KEY=<different stable management secret>
CLIPROXY_CONTROL_API_KEY=<different stable control secret>
CLIPROXY_CREDENTIAL_STORE_KEY=<different stable store encryption key>
CLIPROXY_OAUTH_SESSION_TTL_MS=600000
CLIPROXY_EGRESS_ALLOWED_PORTS=80,443
```

OAuth session TTL 默认 10 分钟，允许 `60000..900000` 毫秒；超出范围时 `cliproxy-control` 拒绝启动。它只控制 Friday 的短期编排 session，不改变 CPA token/auth file 生命周期。

启动脚本必须生成/验证四个独立 secret。readiness 链固定为 `cliproxy-egress healthy -> cli-proxy-api started -> cliproxy-control healthy -> gateway-srv`；CPA runtime 不以 `wget`/`curl` 作为合同，因此不得恢复容器内工具型 healthcheck。上游浅层 `/healthz` 只用于宿主侧诊断。

Admin 的 Runtime Versions 分开展示 `CLIProxyAPI Running binary` 和 `CLIProxyAPI Configured image`。运行身份来自 Control 对 CPA 鉴权 Management 响应的 `X-CPA-VERSION`、`X-CPA-COMMIT`、`X-CPA-BUILD-DATE`、`X-FRIDAY-CPA-EVIDENCE-CONTRACT` 和 `X-FRIDAY-CPA-ADAPTATION` 五个脱敏字段；不可达、不匹配或缺少 adaptation identity 时不得用 Compose 配置值伪装 running。

查看内部服务健康状态，不需要也不得临时发布 `8317`：

```bash
docker compose exec -T gateway-srv node -e \
  "fetch('http://cli-proxy-api:8317/healthz').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
```

## OAuth 自助建链

常态 Compose 不发布 `1455`、`8085`、`54545`、`51121` 或 `11451` callback ports。Admin 通过 `cliproxy-control` 的 start/status 窄接口发起 OAuth；遇到上游重定向到 localhost 时，管理员把最终 callback URL 粘贴回 Admin，由服务端只转交 allowlisted provider/state/code/error 字段。浏览器永远不接触 Management key。

Gemini 不在 OAuth 支持矩阵中，只能通过 `gemini-api-key` 建链。手工提交 `kind=gemini, authMethod=oauth` 必须在 Friday 边界返回 `cliproxy_auth_method_unsupported`，不得调用 CPA。

维护完成后必须确认 auth file 已写入 `cliproxy-auth` volume，并通过 Management API 给它设置目标 Friday `provider.id` prefix。不得使用 owner、`sys` 或共享前缀。恢复流量前依次验证：

1. `force-model-prefix` 仍为 `true`。
2. `/v1/models` 只在目标 `<provider.id>/...` prefix 下看到该 credential 的模型。
3. 同名模型的另一个 Provider prefix 不会命中这份 credential。
4. quota、disable、401/403 和 upstream error 均不会跨 prefix fallback。

## 日志 sentinel 门禁

固定目标版本仍使用 `commercial-mode: true` 从服务入口禁用 request-log middleware。日志 sentinel 使用真实 inference key，并在同一个已配置 Provider prefix 下请求一个刻意无效的 model，使请求通过认证、handler 和 credential/provider 选择后产生真实 upstream/provider error；401/403 不算有效错误样本。随后再发送成功请求，等待默认 3 秒 flush，并检查容器 stdout/stderr、容器内全部 writable path 和宿主 Docker logs 均不含两个 prompt 与有效 Authorization key。

任何 sentinel 命中都表示验证失败；不能用 `/dev/null`、缩短保留期、忽略日志目录或只清理文件代替验证。真实上游检查只属于受控验收，不由普通启动或健康检查自动触发。

常态服务已启动、目标 prefix credential 已 ready 后，显式执行成功/失败双路径 sentinel。该命令会向真实上游发送一次最小 Responses 请求，必须在受控 canary 窗口运行：

```bash
CLIPROXY_SENTINEL_MODEL='<provider.id>/<model>' bun run verify:cliproxy:sentinel
```

脚本不输出 prompt sentinel、Authorization sentinel、inference key 或响应正文；它扫描 CLIProxy Docker logs、tmpfs runtime path 和持久 auth volume。成功请求失败或任一 sentinel 命中都会以非零状态退出。

## 备份与恢复

CLIProxy auth volume 与 Friday DB 分开备份、分开恢复，不构成原子 snapshot。恢复后先运行 binding reconciliation；未达到 `ready` 的 CLIProxy-backed Provider 必须失败关闭。config 模板来自代码，inference/management secret 来自私有 env，二者都不能从 CLIProxy credential 内容反向回填 Friday。
