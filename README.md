# DeepSeek Deploy Assistant

[![CI](https://github.com/shauernowak-sys/DeepSeek-Deploy-Assistant/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shauernowak-sys/DeepSeek-Deploy-Assistant/actions/workflows/ci.yml)

面向**没有编程基础的 Windows 用户**的 DeepSeek Harness 部署助手：把 Node.js 私有运行时、pnpm、Harness（dsh）、web profile 与官方 QQ 插件的一次性配置，收敛成"打开软件 → 点开始 → 完成"。

> 本仓库是**我们自己的部署助手**，不含也不重新开发 DeepSeek Harness 本体；Harness 由用户确认后从官方渠道自动获取安装。

---

## 当前状态

| 项目 | 状态 |
|---|---|
| 产品版本 | **0.2.0**（M2 已交付） |
| 平台 | Windows 10/11 x64，per-user 安装，**无需管理员权限** |
| 技术栈 | Electron 33 + React 18 + TypeScript（strict）+ 纯 CSS；NSIS 安装器 |
| 技术基线 | Node.js 22.23.4 · pnpm 11.28.5 · `@deepseek-ai/dsh@0.2.0-rc.2`（web profile）· `@tencent-connect/dsh-qqbot@0.5.5` |
| 自动化测试 | 60 通过 / 2 门控跳过（真实集成测试按 `DDA_E2E=1` 启用）；GitHub Actions CI 全绿 |
| QQ-GATE-01 | **未通过**（真实扫码、消息收发、图片、断线重连、重启恢复尚未验证） |
| Windows 11 第二环境验证 | **未执行**（无干净 Win11 机器/虚拟机） |
| 代码签名 | S0（未签名，SmartScreen 会提示未知发布者） |

> 未验证的能力一律标注"未验证/未通过"，不因为代码写了就当作已完成。

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
| [M2 验收报告](./docs/M2-验收报告.md) · [实施](./docs/M2-实施报告.md) · [测试](./docs/M2-测试报告.md) · [已知问题](./docs/M2-已知问题.md) | 任务控制、诊断导出、稳定性修复与真实证据 |

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
