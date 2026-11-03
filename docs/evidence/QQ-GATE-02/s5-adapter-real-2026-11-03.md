# QQ-GATE-02 证据 · S5 适配层真实链路（2026-11-03）

**环境：** Windows 11（本机，非管理员）· dsh `0.2.0-rc.2` · `dsh-qq-link@1.5.1` · **SnowLuma 未安装**（本机无任何 SnowLuma 目录）
**对象：** `%LOCALAPPDATA%\DeepSeekDeployAssistant` 真实实例（非副本）
**纪律：** 所有 token 已脱敏；未修改 SnowLuma（本机没有）；未提交 Git。

---

## 1. 做了什么

| 步骤 | 命令/动作 | 结果 |
|---|---|---|
| 1 | `dsh plugin --profile web add dsh-qq-link@1.5.1`（与产品里「安装适配插件」同一路径） | 成功：`+ dsh-qq-link 1.5.1`，`Done in 1s` |
| 2 | 启动 Harness：`dsh --profile web --no-open --port 18740`（清空 `QQBOT_APPID/SECRET`） | 正常启动，输出 `http://127.0.0.1:18740/?token=<redacted>` |
| 3 | `GET /?token=<redacted>` | **303 See Other** + `set-cookie: dsh-auth-…=<redacted>; HttpOnly; SameSite=Strict` + `location: ./` |
| 4 | `GET /dsh-qq-bridge/state`（带该 cookie） | **200**，`{"ok":true,"版本":"1.5.1",…,"NapCat状态":{"错":"fetch failed"}}` |
| 5 | 用服务层跑真实检测（gated integration test） | `phase=snowluma-not-installed`；`adapter.installed=true`；`automation.allowed=false` |

## 2. 真实检测输出（`tests/integration/personal-qq-real.test.ts`，已脱敏）

```
[real] plugin dsh-qq-link installed= true
[real] phase= snowluma-not-installed
[real] qq installed= true running= false
[real] snowluma installed= false dir= …\components\snowluma\(not-installed)
[real] onebot responsive= false error= fetch failed
[real] automation allowed= false
[real] evidence[manifest] 清单：SnowLuma 要求版本 2.4.0，端口 3000
[real] evidence[fs]       文件检测：找到 C:\Program Files\Tencent\QQNT\QQ.exe
[real] evidence[process]  进程检测：没有 QQ.exe 在运行
[real] evidence[fs]       文件检测：安装目录没有 release.json（未安装或目录不对）
[real] evidence[process]  进程检测：安装目录下的 SnowLuma 未运行（注意：不能只看 node.exe）
[real] evidence[port]     端口检测：WebUI 127.0.0.1:5099 不可连接
[real] evidence[port]     端口检测：OneBot HTTP 127.0.0.1:3000 不可连接
[real] evidence[http]     OneBot：fetch failed
[real] evidence[fs]       适配插件：dsh-qq-link 1.5.1（要求 1.5.1）
[real] evidence[bridge]   适配层：OneBot 后端不可用：fetch failed
[real] evidence[license]  …EULA 要求"通过自动化脚本部署"须事先取得书面授权…
```

**结论**：适配层（插件安装 / 加载 / 状态接口 / 鉴权）**真实可用**；OneBot 后端因 SnowLuma 未安装而如实报错，**未出现任何"假连通"**。

## 3. 本轮真实环境发现并修复的缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| R1 | 首次实跑得到 `bridge-auth-required`（cookie 拿不到） | Harness 的 `/?token=` 返回 **303 + Set-Cookie**，Node 的 `fetch` 默认跟随重定向，**把 303 上的 Set-Cookie 丢掉** | `createNodeBridgeDeps` 的 `fetch` 改为 `redirect: 'manual'`；修复后同一场景返回 `ok:true` |

> 这个缺陷在单测里不可能发现（桩不重定向），只有真实 Harness 会暴露 —— 这也是本阶段坚持实跑的理由。

## 4. 本证据**没有**证明的事

| 项 | 状态 |
|---|---|
| SnowLuma 安装/运行/hook 注入 | **未验证**（本机未安装；按产品决策不由本软件安装） |
| OneBot `get_login_info` 真实返回 | **未验证**（无后端、无登录） |
| QQ 消息 → Harness | **未验证** |
| Harness → QQ 回复 | **未验证** |
| 群聊 @ / 图片 / 断线 / 重启 | **未验证** |

⇒ `QQ-GATE-02` 仍为 **0/12**；本条证据只能证明"适配层与检测链路真实可用"，不得据此宣称个人 QQ 已接入成功。
