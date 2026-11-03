# 阶段 B 实验证据 · B-X1：`dsh-qq-link@1.5.1` 在 dsh `0.2.0-rc.2` 上能否加载

**执行时间：** 2026-11-03（本机，非管理员）
**实验环境：** `%TEMP%\m32-dual\x1\dsh-home`（真实实例 `dsh-home` 的副本，**排除 `node_modules`/`.plugin-manager`**，只在副本里安装）
**原则：** 未触碰 `%LOCALAPPDATA%\DeepSeekDeployAssistant`；未提交 Git；所有 token / `task_id` 已脱敏

---

## 1. 实验步骤与原始结论

| 步骤 | 命令（要点） | 结果 |
|---|---|---|
| 1 | `robocopy dsh-home → %TEMP%\m32-dual\x1\dsh-home /XD node_modules .plugin-manager` | 复制成功（不含依赖树） |
| 2 | `node <dsh>\lib\bin.js plugin --profile web add dsh-qq-link@1.5.1` | **成功**：`+ @tencent-connect/dsh-qqbot 0.5.5`、`+ dsh-qq-link 1.5.1`，`Done in 2.6s`（仅 `[WARN] Issues with peer dependencies found`） |
| 3 | `node <dsh>\lib\bin.js --profile web --dump-config` | **组合配置含 `qq-bridge` 条目**（`name: dsh-qq-link`），且 `im-qqbot` 条目**同时存在** |
| 4 | 启动 `--profile web --no-open --port 1873x`（清空 `QQBOT_APPID`/`QQBOT_SECRET`） | **正常启动**，输出 `dsh web: http://127.0.0.1:1873x/?token=<redacted>` |
| 5 | `GET /dsh-qq-bridge/state`（无凭据） | `200`，body `{"ok":false,"说":"authentication_required"}` |
| 6 | `GET /?token=<redacted>` 取会话 cookie（`dsh-auth-…`）→ 再 `GET /dsh-qq-bridge/state` | **`200`，`ok:true`，完整状态 JSON**（见 §3） |
| 7 | `GET /qqbot/im-qqbot/bind` | **`200`**，返回 `{"phase":"waiting","url":"https://q.qq.com/qqbot/openclaw/connect.html?task_id=<redacted>…","qrSvg":"data:image/svg+xml;base64,…"}` |

启动后的 stdout 只有 12 行（URL + 官方插件二维码块 + 绑定链接），**没有** `dsh-qq-link` 报错或崩溃。

---

## 2. 结论

1. **`engines.dsh >= 0.2.1-rc.2` 只是声明，安装与加载都不拦截** —— `dsh-qq-link@1.5.1` 在 `0.2.0-rc.2` 上**可以安装、可以组合进配置、可以随 Harness 启动**。
2. **它与官方 `im-qqbot@0.5.5` 在同一进程内共存**，两边的证据都正常（官方插件照常打印二维码/绑定链接）。
3. **`dsh-qq-link` 的状态接口可用**（先取 Harness 会话 cookie 后返回完整状态），其中 `NapCat状态` 字段就是"能否连上 OneBot 后端"的**实时取证**。
4. **官方插件的 `GET /qqbot/im-qqbot/bind` 本次返回 200 且带 `phase/url/qrSvg`** —— 这与 M3.2 技术调查 K-M3.2-02 记录的"在本产品宿主下 404"**不一致**，需要阶段 C 用真实凭据复核后再修订该结论。

---

## 3. `/dsh-qq-bridge/state` 关键字段（脱敏摘录）

```json
{
  "ok": true,
  "版本": "1.5.1",
  "配置文件": "<DSH_HOME>\\qq-bridge-config.json",
  "NapCat状态": { "错": "fetch failed" },
  "配置": {
    "总开关": false,
    "试运行": true,
    "NapCat": "http://127.0.0.1:3000",
    "令牌": "<redacted>",
    "轮询间隔毫秒": 2000
  },
  "活着的会话": [ { "id": "ses…" } ]
}
```

- `总开关=false / 试运行=true` 是插件的安全默认值：**不手动打开，一句都不会真的发到 QQ**（与其 README 一致）。
- `NapCat状态.错 = fetch failed` 是真实证据：本机没有 OneBot 后端时，插件**如实报错**而不是假装联通。

---

## 4. 本次实验**没有**证明的事（不得当成通过）

| 项 | 状态 |
|---|---|
| 真实 OneBot 后端（NapCat）连通 | **未验证**（需 B-X4，用户手动安装） |
| QQ 消息 → Harness | **未验证** |
| Harness → QQ 回复 | **未验证** |
| 插件自带 Web 设置面板在 `0.2.0-rc.2` 是否渲染正常 | **未验证**（本轮只验证了 HTTP 接口，没有渲染 UI） |
| 插件声明的 `0.2.1-rc.3` 专有行为 | **未评估**（可能在边界路径上依赖新 API） |

---

## 5. 复现命令（脱敏版）

```powershell
$src = "$env:LOCALAPPDATA\DeepSeekDeployAssistant"
$lab = "$env:TEMP\m32-dual\x1"
robocopy "$src\dsh-home" "$lab\dsh-home" /E /XD node_modules .plugin-manager
$env:DSH_HOME = "$lab\dsh-home"
$env:PATH = "$src\runtimes\node\22.23.4;$src\bin;$env:PATH"
$env:QQBOT_APPID=''; $env:QQBOT_SECRET=''
& "$src\runtimes\node\22.23.4\node.exe" "$src\harness\0.2.0-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add dsh-qq-link@1.5.1
& "$src\runtimes\node\22.23.4\node.exe" "$src\harness\0.2.0-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile web --no-open --port 18731
# 先访问 http://127.0.0.1:18731/?token=<URL 里的 token> 拿 cookie，
# 再 GET http://127.0.0.1:18731/dsh-qq-bridge/state
```
