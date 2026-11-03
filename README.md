# DeepSeek Deploy Assistant

[![CI](https://github.com/shauernowak-sys/DeepSeek-Deploy-Assistant/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shauernowak-sys/DeepSeek-Deploy-Assistant/actions/workflows/ci.yml)

面向**没有编程基础的 Windows 用户**的 DeepSeek Harness 部署助手：把 Node.js 私有运行时、pnpm、Harness（dsh）、web profile 与官方 QQ 插件的一次性配置，收敛成"打开软件 → 点开始 → 完成"。

> 本仓库是**我们自己的部署助手**，不含也不重新开发 DeepSeek Harness 本体；Harness 由用户确认后从官方渠道自动获取安装。

---

## 当前状态

| 项目 | 状态 |
|---|---|
| 产品版本 | **0.2.0**（M2 已交付，M2.1 独立复核后重建） |
| 平台 | Windows 10/11 x64，per-user 安装，**无需管理员权限** |
| 技术栈 | Electron 33 + React 18 + TypeScript（strict）+ 纯 CSS；NSIS 安装器 |
| 技术基线 | Node.js 22.23.4 · pnpm 11.28.5 · `@deepseek-ai/dsh@0.2.0-rc.2`（web profile）· `@tencent-connect/dsh-qqbot@0.5.5` |
| 自动化测试 | **174 通过 / 3 门控跳过**（真实集成测试按 `DDA_E2E=1` 启用；API 配置落地测试按 `DDA_DSH_BIN` 启用） |
| API 配置（M3.1） | 图形化配置 DeepSeek 官方模板或其它 OpenAI 兼容网关；密钥仅 DPAPI 密文 + 启动时注入；真实连接测试与 9 类错误分类；写入 Harness patch 并 `--dump-config` 回读校验 |
| 版本信息 | `package.json` / `app.getVersion()` / exe FileVersion / ProductVersion / 安装包文件名 **均为 0.2.0** |
| 最终安装包 | `release/deepseek-deploy-assistant-0.2.0-x64.exe`（82,855,888 B，SHA-256 `1C491397AC74F72DB8BD70793D32F46EB1F7F9051345CB9F5E5A913310E8AE35`） |
| 本轮实机环境 | Windows 11 Pro 10.0.26200，非管理员，**非干净机**（存在系统 Node） |
| QQ-GATE-01 | **未通过**（真实扫码、消息收发、图片、断线重连、重启恢复尚未验证） |
| 干净 Win11 第二环境验证 | **未通过**（本机不是干净机；验收方案见 [M2.1 独立审计报告](./docs/M2.1-独立审计报告.md) §6.4） |
| 代码签名 | S0（未签名，SmartScreen 会提示未知发布者） |

> 未验证的能力一律标注"未验证/未通过"，不因为代码写了就当作已完成。**M2 的原始交付包（82,722,409 B）已被 M2.1 修复包取代，不应继续分发。**

---

## 已实现能力（M2）

- **环境检测**：系统版本、管理员状态、已有 Node/pnpm/Harness、磁盘空间、网络可达性。
- **隔离部署**：私有 Node.js 运行时 + 私有 pnpm + 独立缓存，不污染用户已有环境。
- **下载与校验**：多源下载、SHA-256 校验、断点续传（`.part`）、失败回退。
- **13 步部署引擎**：磁盘检查 → 下载/解压/校验 Node → 安装 pnpm → 写 shim → 安装 Harness → 校验版本 → 版本组合白名单 → 创建 web profile → 安装 QQ 插件 → 校验插件 → 记录路线。
- **任务控制**：暂停 / 继续 / 取消（含确认弹窗与**路径级**清理预览），只清理本次任务创建的路径。
- **恢复能力**：journal 持久化，重启后可恢复；已完成部署可"重新部署（修复）"。
- **诊断报告**：一键导出 ZIP（系统/运行时/profile/插件/任务/网络/日志 7 段），构建期脱敏，不含 API Key、Token、AppSecret。
- **三级健康检测**：`down` / `alive` / `authorized` / `usable`（HTTP 401 只算"存活"，不算可用）。
- **质量门禁**：`typecheck` + `vitest` + 生产依赖许可证检查 + 安装包构建。

## M2.1 修复摘要（独立审计后）

| 缺陷 | 修复 |
|---|---|
| 「取消 + 清理」会把 `dsh-home/profiles` 当成本任务产物，可能递归删除用户 Harness profile（**P0**） | 移除该记录，新增"清理边界"回归测试 |
| 空 `USERPROFILE` 时 `sanitize()` 摧毁整份诊断报告、且路径失去脱敏（**P0**） | 空/过短 homeDir 直接跳过路径替换；支持正/反斜杠、结尾斜杠、JSON 二次转义 |
| QQ 号（5–8 位）、`DEEPSEEK_API_KEY=`、`api_key:`、`token=`、`password=`、`Authorization:` 不脱敏（**P0/P1**） | 改为"字段名驱动 + 已知值形状"的脱敏规则，日志与诊断双通道 |
| 诊断预览与最终 ZIP 不是同一份内容 | 导出复用预览快照 |
| 全新部署后首次启动 Harness 在 30 s 上报失败（实测约 39 s） | 超时 120 s，错误信息带子进程尾部输出 |
| exe `FileVersion` 显示 `33.4.11` | 两段式构建 + `resedit` 写版本资源 → `0.2.0` |
| 卸载残留空程序目录 | NSIS `customUnInstall` 回收（只删空目录） |

详见 [M2.1 修复记录](./docs/M2.1-修复记录.md)。

## M3.1 API 配置（0.2.0 起）

| 能力 | 说明 |
|---|---|
| 图形化配置 | DeepSeek 官方模板（预填地址与模型）或任意 OpenAI 兼容网关；只需填 **服务类型 + API Key** |
| 密钥安全 | 仅 DPAPI 密文落盘；启动 Harness 时作为 `apiKeyEnv` 环境变量注入（磁盘上无明文密钥） |
| 真实连接测试 | 一次最小请求，分 9 类结果（鉴权/配额/网络/DNS/模型不存在/服务端/响应异常/超时/成功），不以 HTTP 200 判成功；推理模型只回思考块也算成功 |
| 写入 Harness | 写入 profile 的 `cordis.patch.yml` 受管块（`llm-deepseek` 或 `llm-pi-ai` + `agent-default-model`），写前备份 |
| 回读校验 | `dsh --profile web --dump-config` 解析组合树，确认路由与默认模型真的生效；失败自动回滚 |
| 修改 / 删除 | 覆盖写入；删除需二次确认，移除配置块并清除密文 |

> 真实 Key 已实测通过（HTTP 200 + 模型回复，`verdict=ok`）；仅"Harness Web 界面内人工对话"待人工确认一次，详见 [M3.1 已知问题 K-M3-01](./docs/M3.1-已知问题.md)。

**使用顺序**：先在第 3 节"开始部署"装好 Harness（联网下载 Node / pnpm / dsh），部署成功后才能启动 Harness；未部署时启动按钮禁用并给出提示。本软件**不复用**你手动安装的官方 Harness，它会在 `%LOCALAPPDATA%\DeepSeekDeployAssistant` 下部署自己的隔离副本。

## M3.2 QQ 机器人（0.2.0 起）

| 能力 | 说明 |
|---|---|
| 插件管理 | 第 4 节显示 `@tencent-connect/dsh-qqbot` 的精确版本并与验证基线比对；一键安装/修复；失败给出网络与许可限制的说明 |
| 授权（方式 A） | 填 AppID / AppSecret → 仅 DPAPI 密文落盘 → 启动 Harness 时注入 `QQBOT_APPID`/`QQBOT_SECRET`，配置文件里只有 `__FROM_ENV__` |
| 授权（方式 B） | 「用官方扫码绑定」：由官方插件走 q.qq.com 授权页；本软件只展示/打开链接，不实现任何 QQ 协议。点下去会**自动打开官方授权页**，正文同时显示二维码与链接，25 秒没出现会给原因并可「重新生成」。**不会删除**你已保存的 AppID/AppSecret（点「取消扫码」即恢复）。扫码成功后插件会把凭据明文写进它自己的 profile，界面会警示并提供「迁移到加密存储」清掉明文 |
| 连接状态 | 10 个相位（未部署/未装/版本不符/已安装/未授权/等待扫码/连接中/已连接/重连中/失败），`已连接` 只由插件输出 `[im-qqbot] Bot ready!` 触发，并把依据逐条展示 |
| 消息配置 | 群聊是否需 @、私聊流式、单条上限、群历史条数、私聊/群访问控制与白名单、群/私聊提示词、图片接收与文件发送路径限制；写入后 `--dump-config` 回读，失败自动回滚 |

> **QQ-GATE-01 = 2/6**：方式 A 授权 + 私聊对话已真实验证通过；群内 @、图片、断线自动恢复、重启免扫码、方式 B 扫码**未验证**。详见 [M3.2 验收报告](./docs/M3.2-验收报告.md) 与 [QQ-GATE-01 证据](./docs/M3.2-QQ-GATE-01证据.md)。

---

## 目录结构

```
apps/desktop         Electron 主进程 / 预加载 / React 渲染层（IPC 全量 zod 校验）
packages/spec        领域模型、IPC 契约、版本基线
packages/core        引擎（计划、执行器、journal、下载、校验、ZIP、诊断）
packages/adapters    环境/路径/策略/插件列表等适配层
scripts              验收驱动、许可证门禁
tests                单元测试 + 真实集成测试（DDA_E2E=1）
docs/                需求、架构、验证与验收文档（见下方导航）
```

---

## 快速开始（开发）

```powershell
# 需要 Node.js 22.x + pnpm 11.x
pnpm install
pnpm dev          # 开发模式启动桌面应用
pnpm verify       # 类型检查 + 单元测试 + 许可证门禁
pnpm dist         # 构建 NSIS 安装包（输出到 release/，已被 .gitignore 忽略）
```

真实部署集成测试（会下载 Node/Harness，耗时约 1 分钟）：

```powershell
$env:DDA_E2E = "1"; pnpm test
```

> **构建说明（M2.1 起）**：`pnpm dist` 是**两段式**构建 —— `electron-builder --dir` → `scripts/set-win-version.mjs`（用 `resedit` 写 `FileVersion`/`ProductVersion`）→ `electron-builder --prepackaged` 出 NSIS。
> 原因：electron-builder 的 `signAndEditExecutable` 在非管理员机器上会去解压 `winCodeSign`（内含符号链接，需要管理员权限），把"写版本资源"和"签名工具链"绑死了。拆开后，**非管理员也能产出 FileVersion = 0.2.0 的安装包**。

---

## 文档导航

完整文档索引见 **[docs/README.md](./docs/README.md)**，常用入口：

| 文档 | 内容 |
|---|---|
| [PRD V0.1 冻结版](./docs/PRD-V0.1-FROZEN.md) · [R2 修订记录](./docs/PRD-V0.1-REVISION-LOG.md) | 需求基准（含发布门禁与 V0.1/V0.2 边界） |
| [01 项目结构设计](./docs/01-项目结构设计.md) | 分层、领域模型、双路线（CLI/Desktop）、IPC、磁盘布局、ADR |
| [02 开源项目复用盘点](./docs/02-开源项目复用盘点.md) | 上游项目许可证与复用方式 |
| [03 开发任务拆分](./docs/03-开发任务拆分.md) | 阶段、任务、依赖、验收标准 |
| [04 最终决策清单](./docs/04-最终决策清单.md) | 已确定 / 源码验证 / 待实机验证 / 阻塞开发 |
| [M0 技术验证报告](./docs/M0-技术验证报告.md) | 真实环境验证结论（含失败组合与替代基线） |
| [M1 验收报告](./docs/M1-验收报告.md) | 首个可运行安装器与部署链路 |
| [M2 验收报告](./docs/M2-验收报告.md) · [实施](./docs/M2-实施报告.md) · [测试](./docs/M2-测试报告.md) · [已知问题](./docs/M2-已知问题.md) | 任务控制、诊断导出、稳定性修复与真实证据（结论已被 M2.1 修订） |
| [M2.1 独立审计](./docs/M2.1-独立审计报告.md) · [修复记录](./docs/M2.1-修复记录.md) · [验收报告](./docs/M2.1-验收报告.md) | 对 M2 的独立复核：8 个真实缺陷（含 1 个会删除用户 profile 的 P0）、版本信息校正、重建安装包与 SHA-256 |
| [M3.1 技术调查](./docs/M3.1-技术调查报告.md) · [实施](./docs/M3.1-实施报告.md) · [测试](./docs/M3.1-测试报告.md) · [已知问题](./docs/M3.1-已知问题.md) · [验收](./docs/M3.1-验收报告.md) | API 配置与真实连接：Harness 官方配置层与凭据 seam 复用、DPAPI 密钥、连接测试错误分类、回读校验与回滚 |
| [M3.2 技术调查](./docs/M3.2-技术调查报告.md) · [实施](./docs/M3.2-实施报告.md) · [测试](./docs/M3.2-测试报告.md) · [已知问题](./docs/M3.2-已知问题.md) · [验收](./docs/M3.2-验收报告.md) · [QQ-GATE-01](./docs/M3.2-QQ-GATE-01证据.md) | QQ 官方机器人：插件版本管理、DPAPI + 环境注入的 AppID/AppSecret、官方扫码入口与明文迁移、10 相位状态机、消息与访问控制配置 |
| [M3.2 双路线技术调查](./docs/M3.2-双路线技术调查报告.md) · [双路线实施方案](./docs/M3.2-双路线实施方案.md) | 双路线（官方 QQ / 个人 QQ）阶段 A 审计与阶段 B-X1 实验：PRD 需求覆盖、官方 QQ 12 项复核、12 项审计发现、第三方组件许可核对；实测 `dsh-qq-link` 在锁定基线上可用 |
| [M3.2 SnowLuma 专项调查](./docs/M3.2-SnowLuma专项技术调查报告.md) · [SnowLuma 实施计划](./docs/M3.2-SnowLuma实施计划.md) · [个人 QQ 实施与验收](./docs/M3.2-个人QQ实施与验收记录.md) | 个人 QQ 改为 SnowLuma（PRD R4）：上游事实与许可约束、八相位检测、适配插件与 bridge 取证、真实适配层证据；自动部署待书面授权 |

---

## 设计边界

- 不重新开发 DeepSeek Harness，不把 Harness 本体打包进安装包。
- 不接管用户 API：用户自行登录并配置自己的 API Key，本地 DPAPI 加密保存，不经过我们的服务器。
- 不跨 profile 操作：CLI 只管理自己的 `dsh-home`，绝不修改官方 Desktop 的 profile。
- 不删除用户数据：取消/回滚只删除本次任务记录的创建路径。
- 未通过真实凭据验证的 QQ 能力，不对外宣称可用。

---

## 许可证与第三方组件

本仓库代码许可证待定（**尚未添加 LICENSE**）。第三方依赖均为 MIT（由 `pnpm license:check` 在 CI 与本地校验）；`@tencent-connect/qqbot-connector` 为 `UNLICENSED`，仅允许在线安装，**不得打包、镜像或纳入离线资源库**。
