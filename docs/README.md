# DeepSeek Deploy Assistant — 设计基线文档

**文档状态：** 草案 V0.2（第二轮架构审查后修订），待评审
**事实核对日期：** 2026-11-02（一轮 + 二轮，均为上游源码 / npm 元数据一手核对）
**对应 PRD：** [PRD-V0.1-FROZEN](./PRD-V0.1-FROZEN.md)（V0.1 冻结版需求，2026-11-02 补齐）

| 编号 | 文档 | 内容 | 状态 |
|---|---|---|---|
| PRD | [PRD-V0.1-FROZEN](./PRD-V0.1-FROZEN.md) · [修订记录 R2](./PRD-V0.1-REVISION-LOG.md) | V0.1 冻结需求：目标/画像/范围/流程/双路线/QQ/资源库/UX/验收门禁；含 R2 修订对照 | **冻结（R2：2026-11-02）** |
| 01 | [项目结构设计](./01-项目结构设计.md) | 分层、仓库结构、领域模型、双路线（CLI/Desktop）、兼容矩阵、接口契约、IPC、磁盘布局、ADR | 草案 V0.2 |
| 02 | [开源项目复用盘点](./02-开源项目复用盘点.md) | 逐个项目的存在性/许可证/复用方式/风险、陪伴能力盘点、许可门禁 | 草案 V0.2 |
| 03 | [开发任务拆分](./03-开发任务拆分.md) | 阶段、任务表、依赖、验收标准、风险登记、跨阶段工程策略 | 草案 V0.2 |
| 04 | [最终决策清单](./04-最终决策清单.md) | 已确定 / 已通过源码验证 / 尚待实机验证 / 阻塞开发 | 草案 V0.2（本轮新增） |
| M0 | [M0 技术验证报告](./M0-技术验证报告.md) | 环境、步骤、结果、证据、阻塞解除情况 | **已执行（2026-11-02）** |
| M1 | [M1 实施计划](./M1-实施计划.md) · [M1 测试报告](./M1-测试报告.md) · [M1 已知问题](./M1-已知问题.md) · [M1 验收报告](./M1-验收报告.md) | 审查/映射/决策、46 单测+2 集成、K1–K16、验收与 QQ-GATE-01 | **已交付（2026-11-02）** |
| M2 | [M2 实施报告](./M2-实施报告.md) · [M2 测试报告](./M2-测试报告.md) · [M2 已知问题](./M2-已知问题.md) · [M2 验收报告](./M2-验收报告.md) | 任务控制（暂停/继续/取消/清理）、诊断 ZIP 导出与脱敏、UX 完善、Journal 竞态修复、CI 与许可证门禁、60 单测+2 集成 | **已交付（0.2.0，2026-11-02；结论已被 M2.1 修订）** |
| M2.1 | [M2.1 独立审计报告](./M2.1-独立审计报告.md) · [M2.1 修复记录](./M2.1-修复记录.md) · [M2.1 验收报告](./M2.1-验收报告.md) | 独立复核 M2 交付：重跑全部门禁与实机链路、定位并修复 8 个真实缺陷（含 1 个会删除用户 profile 的 P0 与 3 个脱敏缺陷）、版本信息 0.2.0 校正、重建安装包 | **已交付（0.2.0 重建包，2026-11-02）** |
| M3.1 | [M3.1 技术调查报告](./M3.1-技术调查报告.md) · [实施报告](./M3.1-实施报告.md) · [测试报告](./M3.1-测试报告.md) · [已知问题](./M3.1-已知问题.md) · [验收报告](./M3.1-验收报告.md) | API 配置（DeepSeek 模板 + OpenAI 兼容网关）、DPAPI 密钥与启动环境注入、真实连接测试与 9 类错误分类、写 Harness patch 并回读校验、失败回滚；验收期修复"未部署即启动"崩溃、推理模型响应误判 | **已交付（0.2.0，2026-11-03；真实 Key 200 已通过，Harness 内人工对话待确认）** |
| M3.2 | [技术调查报告](./M3.2-技术调查报告.md) · [实施报告](./M3.2-实施报告.md) · [测试报告](./M3.2-测试报告.md) · [已知问题](./M3.2-已知问题.md) · [验收报告](./M3.2-验收报告.md) · [QQ-GATE-01 证据](./M3.2-QQ-GATE-01证据.md) | QQ 官方机器人接入：插件精确版本管理、AppID/AppSecret（DPAPI + 启动注入）与官方扫码双路径、10 相位连接状态机（只认运行时证据）、消息/访问控制配置写入与回读；验收期修复扫码入口假成功 | **已实现（0.2.0，2026-11-03）；QQ-GATE-01 2/6（方式 A 授权 + 私聊通过）** |
| M3.2-双路线 | [双路线技术调查报告](./M3.2-双路线技术调查报告.md) · [双路线实施方案](./M3.2-双路线实施方案.md) · [B-X1 实验证据](./evidence/m32-dual/bx1-dsh-qq-link-on-0.2.0rc2.md) | 阶段 A：项目与 PRD 覆盖审计（官方 QQ 12 项 + 个人 QQ PQ-1~PQ-10）、12 项审计发现、第三方组件许可与活跃度一手核对；阶段 B-X1：**`dsh-qq-link@1.5.1` 在 dsh 0.2.0-rc.2 上可安装/可加载/可与官方插件共存** | **阶段 A 已交付；B-X1 通过。路线已由 R4 调整为 SnowLuma，本表保留原始审计记录** |
| M3.2-SnowLuma | [SnowLuma 专项技术调查报告](./M3.2-SnowLuma专项技术调查报告.md) · [SnowLuma 实施计划](./M3.2-SnowLuma实施计划.md) | 个人 QQ 采用 SnowLuma 的专项调查：v2.4.0 上游事实（自带 Node / 端口 / 配置 / hook 注入）、**许可证与 EULA §5.4「自动化脚本部署需书面授权」的硬约束**、与 Harness 0.2.0-rc.2 的解耦关系、`dsh-qq-link` 复用结论、八相位检测与 QQ-GATE-02（12 项）验收标准、文件级计划 | **S2 已实现（契约 + 检测器）；自动部署待 U18 授权文号落库** |
| M3.2-个人QQ | [S5+B 实施与验收记录](./M3.2-个人QQ实施与验收记录.md) · [S5 真实证据](./evidence/QQ-GATE-02/s5-adapter-real-2026-11-03.md) | 个人 QQ 真实接入实现：八相位检测、安装/启动引导（不代装不代启）、适配插件 `dsh-qq-link@1.5.1` 管理、只读令牌并写入插件配置、bridge 状态取证、私聊会话绑定、人工验证标记；真实 Harness 上验证适配层并修复 303 重定向丢 cookie 缺陷 | **已实现并通过自动化+真实适配层验证；QQ-GATE-02 仍 0/12（消息链路需用户装 SnowLuma 后验收）** |
| M3.3 | [M3.3 实施报告](./M3.3-实施报告.md) · [真包验证证据](./evidence/m33-real-package.log) · [UI 冒烟](./evidence/m33-ui-smoke.log) | 个人 QQ 部署向导与编排：官方版本在线核对（GitHub API size/digest）、下载（进度/速度/续传/取消/跳过已校验）、暂存安装与日志回滚、配置备份与恢复、进程启停与健康分层判据、适配层联通、五步 UI；**EULA §5.4 授权闸门 fail-closed**，未授权时自动步骤一律 blocked | **已实现（0.2.0，2026-11-03）；268 测试通过；真实 QQ 双向收发待书面授权 + 用户扫码** |
| M3.3.1 | [用户引导安装流程](./M3.3.1-用户引导安装流程.md) · [UI 截图（第二步）](./evidence/m331-ui-step2-guide.png) · [官方链接核实](./evidence/m331-official-links.log) | 个人 QQ 改为「官方下载 + 图文引导 + 只读校验 + 自动 Harness 配置 + 真实消息验收」：官方 Releases 入口、v2.4.0 文件名/大小/SHA-256、4 步示意图与 FAQ、安装目录自动发现与逐项校验（含父目录自动下钻）、用户确认后落盘；M3.3 自动部署保留但仍在授权闸门后 | **已实现（2026-11-03）；279 测试通过；真实 QQ 双向收发仍未验证** |
| M3.3-清理 | [冗余专项清理记录](./M3.3-冗余清理记录.md) | 流程调整为引导安装后的针对性清理：删除 3 个无调用 IPC/preload/service 方法、5 个无调用函数、6 个失效 schema/常量、12 个渲染层重复类型；安装发现逻辑去重；20 个内部符号降级为私有；修正 CSS 注释编码 | **已完成（2026-11-03）；-228 行，0 文件删除；279 测试不变；自动安装引擎按产品决策保留为授权后能力** |
| V0.1-止血 | [第一轮工程止血实施报告](./V0.1-第一轮工程止血实施报告.md) | 状态机 `failed` 终态、回滚生命周期串行化、原子写（唯一临时名 + 按路径串行化 + fsync）、异常分级与可靠退出、启动日志归位、崩溃后状态对账 | **已交付（2026-11-04）；自动化全绿；功能缺口按审计保留** |
| V0.1-环境智能 | [第二轮环境感知与安装决策实施报告](./V0.1-第二轮环境感知与安装决策实施报告.md) · [UI 门禁截图](./evidence/v01-env-gate-confirm.png) · [真实检测日志](./evidence/v01-real-windows-env.log) | 五态真实检测（Node/pnpm/Harness CLI/Desktop）、系统 Node 复用（D-1/D-6）、六动作决策引擎、安装前门禁（planId + confirmed）、多版本/路线选择、环境总览与确认弹窗 | **已实现（2026-11-04）；399 测试通过；真实干净机端到端部署与真机 UI 待用户验收** |
| V0.1-用户旅程 | [第三轮完整用户流程与界面体验实施报告](./V0.1-第三轮完整用户流程与界面体验实施报告.md) · [QQ 模式截图](./evidence/v01-qq-mode.png) · [首页截图](./evidence/v01-scheme-a-current.png) | 首页与四项导航、QQ 模式优先流程（官方/个人）、浅色蓝白视觉方案 A 与图标 B、按路线裁剪部署计划（`qqMode` 持久化 + IPC 校验）、官方/个人分支页面打磨 | **进行中（2026-11-04，未提交）；401 测试通过；七步向导、双分辨率视觉验收、真实 QQ 收发未完成** |
| M4-前置验证 | [M4 前置验证报告](./M4-前置验证报告.md) | V-M4-1~V-M4-8 实测：官方索引 Schema 逐字段规则、锁定宿主无索引读取方、`plugin_manager` 默认禁用、npm/GitHub 安装实测、闭包许可（含 `UNLICENSED`）、五段证据可得性、篡改包拒绝、方案 A/B 对比、Gate 4 逐项判定；**含关闭 VPN 后的直连复测（§0.3.1 / §4.5）** | **已执行（2026-11-04，隔离环境；未改产品代码）** |
| M4-架构决策 | [M4 技术架构决策](./M4-技术架构决策.md) | 索引（官方 format 1 + overlay）、目录（catalog）、安装（CLI/Web 驱动）、五段证据三档、许可门禁、安全边界、A/B 推荐、7 项待决策 | **决策稿（待产品确认 P-1/P-2/P-6/Q-3/Q-5）** |
| M4-实施计划 | [M4 D01–D11 实施计划](./M4-D01-D11-实施计划.md) | 逐任务：原始要求/前置/实现方式/依赖/测试标准/验收/风险/可并行；新增 3 项前置修复；D10 顺延；**P-6（Gate 4 ② 降级）已决议并落地** | **计划稿（批次 0 可立即开工）** |
| M4-批次0 | [D11 + D01 实施报告](./M4-D11-D01-实施报告.md) | D11 许可门禁（重构为 `scripts/license-gate.ts`，产品 + 插件闭包，SPDX 别名归一化，三态判定，真实 QQ 闭包判 denied 并点名 connector）；D01 索引构建链（`catalog` → 官方 format 1 `index.json` + overlay，构建期调用官方 `parseMarketIndex` + 6 类断言 + registry 复核，CI 增加 build/validate 两步） | **已完成（2026-11-04）；441 测试通过；D02/D09 未开始** |
| M4-D09+P | [D09 / P-8 / P-9 / P-10 / D03 实施报告](./M4-D09-P8-P9-P10-D03-实施报告.md) | D09 结构化验收与策展规则；P-8 registry 回退（CLI 逐层换源 + profile `plugin-manager` 双源配置）；P-9 `downloadVerified` 错误码；P-10 安装入口收敛（删除 `installPlugin(spec)`，精确 spec + 白名单）；D03 9 步安装编排（第 1 步 compat、按步重试、缺证据记 unverified、`marketInstallTarget` 与官方等价位） | **已完成（2026-11-04）；496 测试通过；D02 UI 暂缓** |
| M4-P11+D06 | [P-11 + D06 实施报告](./M4-P11-D06-实施报告.md) | P-11 失效代理检测（启动探测 + 仅子进程剔除，不改系统设置）；D06 逐层换源的源与耗时记录、tarball host 记录（pnpm 不输出时如实"未取得"）、`probe:registry` 干净缓存复测（镜像 2.0 s / 官方 7.6 s，各自单源）、L1 接口位与计划快照 | **已完成（2026-11-04）；516 测试通过** |
| M4-D07+D08 | [D07 + D08 实施报告](./M4-D07-D08-实施报告.md) · [回滚 E2E 证据](./evidence/m4-d08-restore-e2e.log) | D07 四态版本决策（同版本短路、升级限白名单、降级需二次确认、切换=remove+add）；D08 文件级备份/恢复（4 个声明文件、保留 3 份、失败回滚、禁 `--from-default-profile`、拒 desktop profile）；真实链路验证"恢复后 listPlugins 与备份前一致"，并固化恢复后必须 `--force` 重建依赖 | **已完成（2026-11-04）；540 测试通过；E2E PASS** |
| M4-D04 | [D04 本地导入实施报告](./M4-D04-实施报告.md) | zip / tgz / 目录 → 绝对路径 `.tgz`（目录与 zip 用 `pnpm pack --config.ignore-scripts=true`）；许可门禁先行（导入即分发，QQ 插件被拒）；`name/version`+`dsh.bundle.patch`+生命周期脚本校验；自带 ustar 读取与 zip-slip 防护；SHA-256 比对失败即删产物 | **已完成（2026-11-04）；557 测试通过；产物经 pnpm 实装验证** |
| M4-D05 | [D05 离线与缓存实施报告](./M4-D05-实施报告.md) | 离线打包 API（先过 D11 门禁，含 UNLICENSED 直接拒）、内容寻址缓存（`cache/market/<sha256>`，命中重校验、损坏淘汰）、D03 本地安装模式、断网可执行提示；`THIRD_PARTY_NOTICES.md` 生成 + CI 校验 + 随包分发 | **已完成（2026-11-04）；578 测试通过；NOTICES 已进入 win-unpacked/resources** |
| M4-收尾审计 | [M4 收尾审计报告](./M4-收尾审计报告.md) · [验收矩阵 §16](./audit/V0.1-完整功能验收矩阵.md) · [许可全文索引](../licenses/README.md) | 把 6 份实施报告逐任务对齐验收矩阵（15 行状态重判，`已完成` 112 / `部分完成` 59 / `未实现` 24，脚本复核）；补 `licenses/` 13 份许可全文 + 索引 + CI `licenses:check` + 随包分发；同步待开发功能清单口径 | **已完成（2026-11-04）；584 测试通过；typecheck/license/notices/licenses/validate:index/dist:dir 全绿** |
| M4-恢复入口 | [恢复入口与安装 E2E 实施报告](./M4-恢复入口与安装E2E-实施报告.md) · [安装 E2E 证据](./evidence/m4-install-e2e.log) | §21.10「回到上一可用」接线（预览+确认+恢复前保险备份，`profile:recovery-preview` / `profile:restore`，部署页按钮与弹窗）；P-5 可重放安装 E2E（走 `installCatalogPlugin` 9 步 + 直连 fetch 字节探测 + pnpm store 增量） | **已完成（2026-11-05）；593 测试通过；e2e:install 两个源 PASS（镜像 1101 KiB/s、官方 426 KiB/s，integrity 匹配）** |
| M4-单步重试 | [重试单步与视觉验收实施报告](./M4-重试单步与视觉验收-实施报告.md) · [UI 冒烟日志](./evidence/m4-recovery-ui-smoke.log) · [弹窗 1920](./evidence/m4-recovery-modal-1920x1080.png) · [弹窗 1366](./evidence/m4-recovery-modal-1366x768.png) · [重试按钮 1920](./evidence/m4-retry-step-1920x1080.png) · [重试按钮 1366](./evidence/m4-retry-step-1366x768.png) | §21.10「重试这一步」：`executor.stopAfterStepId` + `pausedReason=step-retry`（不复用 `pausedByUser`）、`task:retry-step` 四道守卫、失败步骤行按钮；双分辨率视觉验收（1920×1080 / 1366×768，无横向溢出、按钮可点） | **已完成（2026-11-05）；602 测试通过；UI 冒烟 RESULT=PASS；125%/150% 缩放与键盘走查仍未验证** |
| M4-可访问性 | [可访问性走查实施报告](./M4-可访问性走查-实施报告.md) · [走查日志](./evidence/m4-a11y-ui-smoke.log) · [100%](./evidence/m4-a11y-100.png) · [125%](./evidence/m4-a11y-125.png) · [150%](./evidence/m4-a11y-150.png) | §21.12：弹窗补 `role="dialog"`/`aria-modal`/`aria-labelledby`/焦点移入/焦点陷阱/Esc 关闭/焦点归还；新增 `aria-live` 阶段播报（`role=status` + `role=alert`）；`--force-device-scale-factor` 三档真实 DPI 走查 + 真实按键 Tab/Enter/Esc + **CDP 无障碍树断言**（按钮有名称、live 区域有内容、dialog 有名称且 modal） | **已完成（2026-11-05）；三档 PASS；Narrator/NVDA 人工听读实测未做（不宣称无障碍合规）** |
| M4-交接 | [M4 交接文档](./M4-交接文档.md) | 现状一句话、M4 任务状态表、代码地图、常用命令与期望值、**操作规程与踩过的坑**（PowerShell 编码/BOM、pnpm store 无效、恢复必须 `--force`、许可重生成、CDP 焦点模拟）、未完成/阻塞清单、硬约束、接手自检顺序、证据索引 | **已交付（2026-11-05）** |
| M4-D09完整策展 | [D09 完整策展（候选集）实施报告](./M4-D09-完整策展-实施报告.md) | 把"评估过但不该装"的插件变成一等公民：7 条真实候选（1 needs-review + 6 blocked）+ 受控拒绝理由词表 + **D11 闭包审计 7/7 + 隔离 DSH_HOME 的 D03 安装探测 7/7** + 16 条一致性不变量；候选**不进** index.json、安装入口查不到；新增 35 例测试 | **已完成（2026-11-05）；637 测试通过；D02 UI 未做** |
| M4-重置安装草案 | [「重置安装」产品决策草案](./M4-重置安装-产品决策草案.md) · [决策材料（Q1–Q5 + 方案 B 失败路径）](./M4-重置安装-决策材料.md) | 定义"重置安装"与继续/重试/回到上一可用/回滚本次创建四条边界的差异；三个候选方案（A 不做、B1/B2 回滚+重装、C 只重置配置）+ 推荐 A；决策材料逐条给出 Q1–Q5 选项与建议、方案 B 的时序/失败矩阵/4 条硬规则/4 条验收标准；核实并纠正"回滚保留缓存"的错误说法（`cache/downloads` 属本次产物会被删，`cache/pnpm-store` 保留） | **草案 + 决策材料（待产品勾选，未开工）** |

---

## 0. 一页结论

### 0.1 事实核查对早期 PRD 草案的 8 处修正（重要）

早期 PRD 草案的多处表述与实际生态存在偏差；以下结论均在一手源码上核对过，**已并入 [冻结版 PRD](./PRD-V0.1-FROZEN.md)**，建议评审时逐条确认。

1. **对外公开的分发形态是 npm CLI（仓库内另有桌面端，见第 6 条）。**
   官方 README 给出的运行方式是 `npx @deepseek-ai/dsh web`（MIT，developer preview，官方明示 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"）。
   → `GUIDE-001` 的"获取官方安装方式"应具体化为"安装 Node.js → `npx`/全局安装 `dsh` → `dsh web`"。
   → **推论：Node.js 是"官方 QQ 模式"的硬前置**，不是可选项。PRD 4.2 只写了"官方 QQ 路线不强制安装 Python"，实施时不能据此认为官方路线无需任何运行时。

2. **插件安装有官方文档化接口，我们不应自研安装器。**
   `dsh plugin --profile <name> add <pkg>`，其实现是把参数**原样转发给 profile 目录内的 pnpm**（`docs/cli-help.md`）。
   → `PLG-4` 第 7 步可直接落地为封装该 CLI。
   → **离线安装的唯一正确形态是：把预置包落盘为 `.tgz`，再以 `file:<绝对路径>` 交给 pnpm**，绝不可手工往 profile 目录里拷贝插件文件。

3. **`dsh-qqbot` 是腾讯官方插件，走 QQ Bot API v2，与 OneBot 无关。**
   `@tencent-connect/dsh-qqbot`（MIT）。凭据为 `appId`/`appSecret`，可通过 `QQBOT_APPID`/`QQBOT_SECRET` 注入；**绑定方式是手机 QQ 扫码**，由插件自身的绑定页/终端二维码完成，凭据落到 profile 内。
   → 官方模式的"扫码登录"不需要（也不应该）由我们实现，引导页只需把用户送到该入口并检测连接结果。
   → PRD 3.1/4.3 中"官方 QQ 用官方 API、个人 QQ 用 OneBot"的划分是正确的，但**不能把 OneBot 概念混入官方链路**。

4. **Harness 自带插件市场索引格式，我们的"插件资源中心"应产出兼容索引而非另建市场。**
   索引 `format: 1`，`plugins[].versions[].source` 支持 `{type:"npm", registry?}` 与 `{type:"git", url, commit(40 位), path?}`，
   版本条目必须带 `publishTimestamp`，并可声明 `engines.dsh` 兼容区间；`icon` 支持内联 `data:` URL（≤32 KiB）**或**指向索引旁的相对路径/绝对 `https:` URL。
   → 我们的核心工作变成：**策划清单 + 国内镜像源 + 校验 + 离线包 + 一键安装编排**，而不是从零写一个插件市场 UI。
   → `engines.dsh` 正好承载 PRD 5.3 的"Harness 兼容范围"，无需自定义字段（但它可选；插件包实际可能只声明 `dsh.compatibility.dshReleases`，见第 8 条）。

5. **个人 QQ 网关在 V0.1 无法按期交付，且主要候选不可打包。**
   - NapCatQQ：自定义 "Limited Redistribution License"，明文**禁止商业使用**并限制再分发 → 不可预置、不可随包分发。
   - Lagrange.Core：V1 已 sunset，master(V2) 根目录无 LICENSE 文件（默认保留所有权利）。
   - go-cqhttp：已停止维护（AGPL-3.0）。
   - 可闭源打包的只有 NoneBot2 / Koishi（MIT）与官方 botpy（MIT），但它们都不是"开箱即用的网关"。
   → **建议：V0.1 将 PRD 6 的"已验证网关及适配组件 P0"降级为"仅保留适配器接口 + 官方文档引导"**，与 PRD 10 的"个人 QQ 不宣称已完成"保持一致，避免验收时无法交付 P0 项。

6. **官方仓库里已有一个桌面端（Electron + NSIS per-user 安装器），但与 CLI 的 profile 互不通用。**
   `apps/desktop` 是完整 dsh Web 之上的 Electron 壳，自带 NSIS 安装页（per-user、签名、自动更新、卸载），并**内置一份 pnpm**（`resources/runtime/primary-runtime/dependencies/pnpm`），插件操作不依赖 PATH 上的 pnpm。
   但官方明示其 **profile 归属 Desktop**（`$DSH_HOME/profiles/desktop`）：**CLI 无法启动该 profile，npm 安装的 dsh 也不能修改它**。
   → 推论：①"用我们的 `dsh plugin` 给 Desktop 用户装插件"**不可行**，Desktop 只能走其应用内插件管理；
   ②我们必须先判定用户是"CLI 路线"还是"Desktop 路线"，两条路线的 GUIDE/PLG 流程完全不同；
   ③截至核对日 GitHub Releases 只有 prerelease 且 **assets=0**，公开 README 仅给 `npx` 路径 → **官方桌面版的对外发行渠道属待核实项（R7）**，M0 必须实测。

7. **npm 上的 `latest` 指向预发布版本，版本固定策略要据此改写。**
   `@deepseek-ai/dsh` 共 40 个版本，`dist-tags.latest = 0.2.1-rc.5`（同时存在 `alpha`、`next` 通道），且包**未声明 `engines.node`**。
   → `npx @deepseek-ai/dsh` 拿到的就是 rc 版本；我们的"版本固定"必须固定到具体 prerelease 串并记录通道，
   不能依赖 `latest` 含义，也不能假设 semver `^` 范围安全。

8. **插件兼容性有官方机器可读字段，且优先级高于 `engines.dsh`。**
   `@tencent-connect/dsh-qqbot@0.5.5` 的 `package.json` 中：
   `dsh.compatibility.dshReleases = { "0.1.0-rc.8": "compatible", "0.2.0-rc.2": "compatible" }`，
   并**未声明 `engines.dsh`**，只声明 peerDeps（`@deepseek-ai/dsh-llm >=0.1.0-rc.6` 等，由宿主提供）。
   → 兼容判定顺序应为：`dsh.compatibility.dshReleases` → `engines.dsh` → `@deepseek-ai/dsh*` peerDeps。
   → 另外官方提供索引校验库 `@deepseek-ai/dsh-plugin-market-index`（MIT、零运行时依赖，`parseMarketIndex` / `marketInstallTarget`），
   **应直接作为依赖复用**，不自研 schema（见 02 §1）。

### 0.2 第二轮核查新增的 7 条事实（2026-11-02）

9. **Desktop 的安装身份可观测，但 `appId` 不是稳定常量。** `productName = "DeepSeek Harness"`、产物名 `deepseek-harness-<ver>-win-x64.exe`、`uninstallDisplayName = "DeepSeek Harness"`；`appId` 由环境变量注入。
   → 检测只能依赖 `uninstallDisplayName` / 安装目录 / `profiles/desktop` 等可观测信号。
10. **Desktop 载荷约 588 MB（616,701,792 B / 11,735 文件），官方首次安装约 38 s，分发走腾讯云 COS + EdgeOne。**
    → 我方**不代下、不镜像、不内置**；只提供"打开官方入口 + 装后检测"。这也是 V0.1 不把 Desktop 作为自动化路线的重要理由。
11. **`$DSH_HOME` 有三级解析**：`dshHome` 配置 → 环境变量 `DSH_HOME` → `~/.dsh`。
    → 所有 profile 探测必须走同一解析函数，硬编码 `~/.dsh` 会漏检自定义 home 的用户。
12. **共享插件管理器接受任意 `pnpm add` 规格**（`file:` 绝对路径、`link:`、registry 标签/别名），Desktop 与 Web 共用同一管理器。
    → 我们的"离线 `.tgz` + `file:`"是官方支持的形态；Desktop 的插件安装同样经此管理器（但我们仍不去驱动它）。
13. **`--from-default-profile` 是破坏性替换**：会删除目标目录的 `package.json` / `node_modules` / `cordis.patch.yml`（v0.2.1-alpha.2 升级指南）。
    → 它只能当"重置"，不能当"回滚"；回滚必须靠我方对 profile 的备份。
14. **内置 profile 名（`web`/`tui`/`desktop`/`headless`/`acp`/`sdk`/`sdk-minimal`）被保留**，不能作为自定义 profile 目标。
    → 我方 profile 用专有名（`dda-core`）。
15. **`dsh-qqbot` 的运行时依赖 `@tencent-connect/qqbot-connector@1.2.0` 在 npm 上标记 `UNLICENSED`。**
    → 含它的"完整离线包"在许可澄清前不可分发；这是 **Gate 4 的潜在阻塞项**（V11）。

### 0.3 架构定调（5 条）

- **A. 我们是"清单驱动的部署编排器"，不是安装器工厂。** 所有安装动作要么调用官方 CLI（`dsh plugin`、`winget`、`python.exe /quiet`），要么"下载 → 校验 → 解压到私有目录 → 仅对子进程注入 PATH"，不修改系统级环境。
- **B. Harness 永远在进程外。** 我们只 `spawn` 它、探测它、通过它的 CLI 操作它的 profile；不 import 它的代码，不读写它的内部结构（除官方允许的 profile 配置文件）。
- **C. 一切"完成"必须有证据。** 下载完成 ≠ 安装成功 ≠ 配置完成 ≠ 运行可用。这四个状态在数据模型上是独立字段（见 01 §6.4），UI 上分别展示。
- **D. 免管理员、per-user、可回滚。** 安装到 `%LOCALAPPDATA%`，永不请求 UAC 提权，永不删除用户已有环境。
- **E. 先判路线，再谈步骤。** 启动即探测"CLI 路线 / 官方 Desktop 路线 / 两者并存 / 未安装"，因为两者 profile 互不通用（见 0.1 第 6 条、01 §6.6）。
  未判定路线就展示部署步骤，是这个产品最容易犯的结构性错误。
- **F. 只装清单里验证过的版本组合。** `latest` 是预发布，插件兼容性只对特定宿主版本声明；任何"看起来更新"的版本都不构成支持依据（01 §6.6.4）。

### 0.4 当前进度声明

| 项目 | 状态 |
|---|---|
| 需求文档（PRD V0.1 冻结版） | **已补齐**（[PRD-V0.1-FROZEN](./PRD-V0.1-FROZEN.md)，2026-11-02） |
| 事实核查（Harness / dsh-qqbot / QQ 生态 / 工具链） | **已完成**（见 02） |
| 二轮复核（Desktop 身份与分发、双路线边界、插件管理器、`DSH_HOME`、许可闭包） | **已完成**（2026-11-02，见 0.2） |
| 项目结构与接口设计 | **第二轮修订完成**（草案 V0.2） |
| 开发任务拆分 | **第二轮修订完成**（草案 V0.2） |
| 最终决策清单 | **本批新增**（[04-最终决策清单](./04-最终决策清单.md)） |
| M0 技术验证 | **已执行**（[M0 技术验证报告](./M0-技术验证报告.md)）：C1 组合实测失败，改用 C1′ |
| M1 开发 | **已交付**（[M1 验收报告](./M1-验收报告.md)）：安装器 + 部署链路可运行；QQ-GATE-01 未通过 |
| M2 开发 | **已交付 0.2.0**（[M2 验收报告](./M2-验收报告.md)）：任务控制、诊断导出、UX 完善、稳定性修复、CI 门禁（GitHub Actions run #2 全绿）；QQ-GATE-01 仍未通过 |
| 代码托管 | **已推送 GitHub**：`shauernowak-sys/DeepSeek-Deploy-Assistant`（private，`main`） |
| 代码 / 脚手架 | **已建立**（M1 + M2 范围）；下一步 M3（API 真实连接、QQ 实机验证、第二环境、资源库） |
| 第二环境（Win11）验证 | **未执行**（无 Win11 机器/虚拟机），"支持 Win11"仍为待验证 |

> 按 PRD 第 14 条第 8 款，任何尚未完成的能力在本文档体系中一律标注"未开始 / 待验证"，不得标为已完成。

---

## 1. 变更记录

### V0.8（2026-11-02，上传 GitHub 并实跑 CI）

| 项 | 结果 |
|---|---|
| 仓库 | 首次推送至 `github.com/shauernowak-sys/DeepSeek-Deploy-Assistant`（private，`main`），89 个文件；`node_modules/`、`out/`、`release/`（79 MB 安装包）按 `.gitignore` 不上传 |
| 新增 | 仓库根 [README.md](../README.md)（项目门面：状态、能力、目录、快速开始、文档导航、设计边界） |
| 修复 | **CI run #1 失败**：pnpm 11 已弃用 `onlyBuiltDependencies`，`pnpm install --frozen-lockfile` 在 `CI=true` 下报 `ERR_PNPM_IGNORED_BUILDS`；改用 `allowBuilds`（`pnpm approve-builds` 标准形式）后 **run #2 全绿** |
| 证据 | [evidence/m2-ci-run2-quality.log](./evidence/m2-ci-run2-quality.log)：typecheck + 60 单测 + 许可证 + NSIS 打包 + 产物上传全部 success |
| 文档同步 | M2 三份报告与已知问题中"CI 未实跑"的表述已按实跑结果更新（K-M2-03 标记为已解除） |
| 未改 | 产品代码逻辑、PRD、01/02/03/04、M0/M1 文档 |

### V0.7（2026-11-02，M2 开发与验收）

| 项 | 结果 |
|---|---|
| 新增 | [M2-实施报告](./M2-实施报告.md)、[M2-测试报告](./M2-测试报告.md)、[M2-已知问题](./M2-已知问题.md)、[M2-验收报告](./M2-验收报告.md)；`docs/evidence/m2-*.log` 共 10 份实机日志 |
| 产品 | 0.2.0：任务控制（暂停/继续/取消/取消确认/路径级清理）、诊断 ZIP 导出（7 段、构建期脱敏、预览可取消）、UX 完善（阶段/失败分类/真实 Harness 版本/插件状态/修复重跑）、Journal `EPERM` 竞态修复、清理空父目录、CI 工作流与许可证门禁 |
| 测试 | 60 通过 / 2 门控跳过（M1 为 46，无删除降级）；真实集成 2 项通过（完整部署 47.2 s、幂等重跑 3.7 s + 健康 `usable`）；10 个实机场景通过 |
| 未通过 | QQ-GATE-01（无真实凭据）、Windows 11 第二环境（无机器）、Desktop 四态实机、API 真实连接（未实现）；CI 曾未实跑，V0.8 已实跑通过 |
| 未改 | 01/02/03/04、PRD 与 M0/M1 文档；冻结定位与技术基线未变 |

### V0.6（2026-11-02，PRD R2 修订）

| 项 | 结果 |
|---|---|
| 修订 | [PRD-V0.1-FROZEN](./PRD-V0.1-FROZEN.md)：国内资源库三层优先级与口径约束、核心资源清单（§10.5）、QQ 门禁升级为对外宣传/销售必要条件、API 端到端流程与配置写入边界、V0.1/V0.2 边界（§20）、P0/P1 定义与不可豁免门禁（§18.3）、个人 QQ 引导流程（§9.4）、**新增 §21 用户体验与交互规范** |
| 新增 | [PRD-V0.1-REVISION-LOG.md](./PRD-V0.1-REVISION-LOG.md)：逐项"原文→修订后"对照、是否改变冻结需求、剩余待确认 |
| 未改 | 产品代码、01/02/03/04、M0/M1 文档均未改动；未启动 M2 |
| 结论 | 冻结需求**未变**（0 处删除/推迟；`澄清` 6 处、`收紧` 5 处） |

### V0.5（2026-11-02，补齐冻结版 PRD）

| 项 | 结果 |
|---|---|
| 新增 | [PRD-V0.1-FROZEN.md](./PRD-V0.1-FROZEN.md)：20 章 + 附录 A–F（需求登记表、术语、旧编号对照、依据、待确认、需求↔实现差距） |
| 说明 | PRD 按"需求 / 技术建议 / 当前实现状态"三类标注；**M1 的实现限制未被写成需求限制**；未验证项一律标注"未验证" |
| 未改 | 01/02/03/04、M0/M1 文档与产品代码均未改动 |

### V0.4（2026-11-02，M1 开发）

本轮**首次产出产品代码与安装包**（此前 M0 只做验证）。

| 项 | 结果 |
|---|---|
| 代码 | `packages/{spec,core,adapters}` + `apps/desktop`（Electron 33 + React 18 + TS strict）；下载/解压/矩阵/执行器/健康探测/路线检测/命令策略均带单测 |
| 测试 | 46 单测全绿；2 个真实集成（生产 plan 44.2 s 全绿；幂等重跑 3.8 s + 三级健康 `usable`） |
| 安装包 | `release/deepseek-deploy-assistant-0.1.0-x64.exe`（NSIS per-user，78.9 MB，未签名） |
| 安装/卸载 | 非管理员静默安装 4.1 s；卸载清注册项、**保留部署数据** |
| UI | 打包后 CDP 验证挂载；UI 驱动完整部署 78.6 s 全绿；重启后任务态持久化 |
| 门禁 | **QQ-GATE-01 未通过**（真实扫码/收发未验证） |
| 文档 | 新增 M1 实施计划 / 测试报告 / 已知问题 / 验收报告；[evidence/](./evidence/) 收录 8 份原始日志 |

### V0.3（2026-11-02，M0 技术验证）

本轮**执行真实验证**（1 台全新 Win10，无 Node/npm），未写产品代码。结论已回写到设计文档：

| 影响 | 变更 |
|---|---|
| 组合矩阵 | **C1（`dsh@0.1.0-rc.8`）实测崩溃（`requires the Cordis HMR service`，3/3），标记禁用**；新增 **C1′（`dsh@0.2.0-rc.2` + `qqbot@0.5.5` + Node 22.23.4）** 为唯一允许组合（`verified-local`） |
| profile 策略 | 0.1.x 无 `--from-default-profile`，自定义 profile 不含 Web UI → **CLI 路线固定使用 `web` profile**（F20）；`dda-core` 方案作废 |
| 安装工具 | npm 在本机挂起 14 分钟 → **必须用 pnpm**（03 §13） |
| peer 语义 | profile 显式 `autoInstallPeers: false` → 不重复安装 `dsh-llm`；**peer warning 不得判为失败**（F21） |
| 健康探测 | `dsh web` 需 token，`/` 与 `/healthz` 均返回 **401** → 探测规则改为"401 即在线"（F22） |
| 许可 | 确认 `qqbot-connector@1.2.0` 为 **UNLICENSED 且无 LICENSE 文件** → 禁止打包/镜像；新增"元数据缺失回退 tarball LICENSE"规则 |
| 陪伴能力 | 人设/压缩/MCP 存在；**`schedule` 在 0.2.0-rc.2 的 web profile 未挂载** → 主动互动标注"默认不可用" |
| 离线 | 镜像下载、sha256、Range 续传、预热 store 后 `--offline` 安装全部实测通过；"自带离线包"仍受许可阻塞 |

详见 [M0 技术验证报告](./M0-技术验证报告.md)。

### V0.2（2026-11-02，第二轮架构审查）

本轮**只改设计文档，未写任何产品代码、未建脚手架**。变更来源：上游仓库源码 / npm 元数据复核。

| 文档 | 主要变更 |
|---|---|
| README | 新增 §0.2 二轮 7 条事实（第 9–15 条）；架构定调扩为 6 条（新增 F：只装验证过的组合）；重写进度表；新增本变更记录；索引表加入 04 |
| 01-项目结构设计 | 事实基线扩到 F19；把 §6.6 重写为**双路线模型**（四态检测 + 强制选择 + 冲突硬规则 + 职责归属表 + 兼容矩阵 + 5 条禁止性规则）；新增 §6.7 陪伴能力落地形态；端口层拆为 `HarnessRouteDetector` / `HarnessCliAdapter` / `DesktopGuideAdapter` / `MarketIndexAdapter`；IPC 增 `harness:detect`、`harness:choose-route`、`harness:open-desktop-entry`、`plugin:register-index`；磁盘布局增 `profiles-backup`、`market`；新增 §11.5 安装/卸载数据安全边界、§11.6 许可门禁；ADR 增至 15 条；Node 固定为 22.23.4（含实测 sha256） |
| 02-开源项目复用盘点 | Desktop 行补齐身份/体积/分发事实；新增"共享插件管理器"行；新增 §2.3 陪伴能力逐项盘点（结论：**不需要第三方插件**）；Node 版本改为 22.23.4 + 实测校验和；决策总表增版本组合/索引托管/陪伴能力三行；许可清单增第 8、9 条（`UNLICENSED` 阻断）；待核实项增 R10–R13 |
| 03-开发任务拆分 | M0 增 V10（C1 组合实机复现）、V11（离线依赖闭包与许可）、V12（零基础快测），V09 收紧为 Desktop 检测；新增 A11 兼容矩阵门禁、C07 Desktop 引导；C01/C02/C04 按白名单与只读约束重写；D03/D05/D08 改按矩阵与备份语义；新增 D10 本地索引托管、D11 许可门禁、E08 签名落地；风险增至 13 条；新增 §13 三项跨阶段工程策略；工期 13.5 → 15.5 周 |
| 04-最终决策清单 | 新增：四类状态的完整清单（已确定 / 已通过源码验证 / 尚待实机验证 / 阻塞开发） |

**未变更的定位**：独立 Windows 桌面部署助手；不重开发 Harness；不打包 Harness 本体；Harness 走"官方渠道获取 + 用户确认后安装"（B 方案）；个人 QQ 走 C 方案；插件库 A 方案；安装顺序按依赖动态决定；优先复用成熟开源项目；SnowLuma 不进 V0.1。

### V0.1（2026-11-02，首轮）

初版：事实核查 5 条修正 + 项目结构 / 复用盘点 / 任务拆分三份文档。

### V0.1 第二轮（2026-11-04）

环境感知与安装决策：五态真实检测、系统 Node 复用、六动作决策引擎、安装前门禁（`planId + confirmed`）、多版本/路线选择、环境总览与确认弹窗。详见[第二轮实施报告](./V0.1-第二轮环境感知与安装决策实施报告.md)。
