# DSQQ 竞品分析与 DDA 可借鉴方案

**日期：2026-11-04（中国时区）｜性质：限时、只读分析；本报告不是开发授权。**

## 结论与证据分级

- **已核实（代码/文档）**：DDA 当前工作树的 README 将其定位为面向无编程基础 Windows 用户的 DeepSeek Harness 部署助手；`package.json` 显示 Electron、React、TypeScript 和 NSIS 构建。个人 QQ 代码和文档采用 SnowLuma，另有官方 QQ Bot 路线。DSQQ 自述是面向 Windows 的大肥鱼角色一键包，以 AstrBot + NapCat 实现。二者的部署需求重叠，但产品交付对象不同。[D1][D2][S1]
- **已核实（现存实现，不等于验收）**：DDA 有下载、journal、诊断、健康探测、个人 QQ 向导和 SnowLuma 部署模块；源码对 SnowLuma 的 release、download、install、configure、start 设授权门禁。个人 QQ 门禁代码的 `verified` 为空，官方 QQ 门禁列有授权和私聊两项。[D3][D4][D5] 本次未运行应用或测试。
- **合理推断**：今天最高价值是验证现有 SnowLuma → 适配层 → Harness 的真实消息闭环，并修复验证中发现的最小阻塞，而非重做 DSQQ 已有的安装框架。此优先级是建议，不改变冻结需求或既定 M4 门禁。
- **尚待验证**：当前工作树是否干净、最新提交与远端是否一致、上述能力在此刻的真实可用性、个人 QQ 端到端、干净机及当前许可证授权状态。仅有代码或历史日志不能证明通过。

## 范围与限制

DDA 位于 `D:/DeepSeek-Deploy-Assistant/DeepSeek-Deploy-Assistant`，本次读取工作树源码和文档，未运行软件、测试、安装或访问账号数据。`.git/HEAD` 指向 `fix/v0.1-stability-sprint-1`，该引用文件为 `c8491d6cbff99208d9eb51838146c3709dd84ae7`；Git 命令对该路径返回 Permission denied，因此不能核实工作树差异或提交完整性。README 的 M2、M3 状态和审计清单可能早于当前代码；本报告仅将其作为有日期的项目记录，不当成当前实测结果。

DSQQ 读取 GitHub README、发布页、安装/状态/进程/配置/存储源码及人工测试清单。根目录可见 `app/`、`build/`、`dev/`、`docs/`、`tests/`、`vendor/dafeiyu-config-pack/`；README 列出关键模块。[S1] `build/build.py`、完整 tests 目录及状态页前端抓取失败，故构建细节以 README 自述为限、测试覆盖无法完整审计；未运行竞品。线上 `main` 可能变化，发布 v1.0.0 页面显示提交 `035a454`，不能假设本次读取的 main 与发布产物完全一致。[S2]

## DSQQ 拆解

1. **产品与安装**（README 自述）：Windows 10/11 x64；约 790 MB；需要 10 GB 空间、英文数字路径；用户填 QQ 与多个服务凭据，支持个性化、扫码和首次私聊。后台安装与填表并行，宣称中断续装。未独立验证这些体验或无 VPN 声明。[S1][S2]
2. **安装器**（源码）：将 extract、ports、configs、astrbot、napcat、import、shortcut、login 拆成步骤；完成状态持久化，错误可重试，发现解压产物不完整时清除完成记录。[S3] 这是步骤级恢复，不足以证明每步均幂等或所有中断位置安全。
3. **状态页与生命周期**（源码）：状态接口结合 AstrBot/NapCat PID、登录状态、启动与错误信息；支持启动、停止、换号、卸载，应用设置时停服务并重做相关步骤。[S4] 进程以独立进程组启动并写日志，停止使用 `taskkill /T /F`；PID 存在性不证明服务可用，也需考虑 PID 重用风险。[S5]
4. **配置与安全**（源码/自述）：生成随机密码、token 和端口；绑定本机；状态文件通过临时文件替换，保存的秘密使用 DPAPI，按已知值脱敏。[S6][S7] 但 AstrBot 配置写入 DeepSeek key，且完成接口将后台密码写入 `我的信息.txt`，因此不能笼统称“所有凭据全程不落明文”。[S4][S6] 日志脱敏范围和临时文件清理还需全面测试。
5. **构建与发布**（README 自述）：7-Zip SFX，便携 Python + 本地 HTTP/Edge app 窗口，构建时准备 AstrBot、NapCat 和配置包、安装依赖、预下载并清理构建数据；输出 EXE 与 SHA-256。v1.0.0 发布页说明未签名。[S1][S2] 没有取得构建脚本，未核对下载校验、构建可复现性或依赖闭包。
6. **测试清单**：列 8 项：正常流程、中断续装、端口占用、错误凭据、踢下线重扫码、设置/reset、杀毒拦截、中文或空格路径；要求干净 Win10/11 各一次。[S8] 清单是计划，不是执行记录；单测数量、通过率及真机结果未知。
7. **许可证**：根目录页面未显示仓库许可证，`LICENSE` 路径返回 404；这不排除其他位置或单个文件另有条款。当前不能据此认定可复制、修改或分发 DSQQ 的代码、界面素材及其 vendor 内容；逐组件核实许可证与授权后再决定。研究抽象功能和独立设计可作为方向，具体法律判断需进一步核查。[S1]

## DDA 现状与逐项对照

下表中“已有”仅指检查到对应源码或项目报告，不代表本次实测通过；“待核实”不是断言缺失。

| 维度 | DSQQ 证据 | DDA 工作树证据 | 差距 / 建议 |
|---|---|---|---|
| 定位 | 打包一个可个性化 QQ AI 角色 [S1] | 面向零基础 Windows 用户部署和管理 Harness，非重开发 Harness [D1] | 无需更改定位；对用户用任务结果描述价值 |
| 技术路线 | AstrBot + NapCat + 配置包 [S1] | Electron/React/TS；Harness + 官方 QQ Bot，以及 SnowLuma + `dsh-qq-link` 个人路线 [D2][D6] | **坚持 SnowLuma；不引入 NapCat、AstrBot 或 DSQQ 配置包作为替代路线** |
| 安装 | SFX、后台并行、步骤续装 [S1][S3] | 下载/校验、journal 与部署服务代码存在 [D7]；SnowLuma 引导用户官方下载、自行安装 [D8] | 首先检查已有恢复行为与页面；针对失败步骤补清晰提示，勿绕过授权自动部署 |
| 运行状态 | PID、登录、启动、错误 [S4] | 个人 QQ 检测、阶段合成与消息人工验证代码 [D3][D9] | 显示证据和下一步；进程、登录、桥接、真实收发分开，未知不得显示成功 |
| 配置/密钥 | DPAPI 状态、配置生成；部分下游文件明文 [S4][S6][S7] | README 描述 API 凭据 DPAPI 与环境变量注入，个人 QQ 服务读取端点并配置适配层 [D1][D3] | 独立核查所有下游持久化、诊断与日志；只更新受管字段、备份与回读 |
| 启停与恢复 | 启动、强制停止进程树、重新应用设置 [S4][S5] | Harness 服务及 SnowLuma 进程/部署模块存在 [D7]；自动步骤受门禁 [D4] | 优先复用现有服务，核验进程身份和受管范围；不要把用户自行启动的进程当作可随意终止的对象 |
| 验收 | 八项人工清单；未见执行证据 [S8] | 门禁源码列官方 QQ 已验证两项、个人 QQ 无已验证项 [D5]；项目报告记录历史测试 [D8] | 今天闭环证据优先；独立记录官方与个人路线，不用 mock 或进程存活替代真实消息 |
| 打包/发布 | 已有 v1.0.0；未签名、约 790 MB [S2] | `dist` 用 electron-builder/NSIS，README 记录版本 0.2.0 与未签名状态 [D1][D2] | 当前产物与签名状态需复核；无干净机验收不得声称可公开稳定交付 |
| 安全与数据 | 文档宣称独立目录，提供彻底卸载 [S1] | 项目记录描述隔离、路径级清理及诊断脱敏 [D1] | 用户数据保留和删除预览是应保留的设计；还须检验真实边界 |
| 插件生态 | 依赖 AstrBot 插件及预设配置 [S1] | 历史审计把插件资源中心列为缺口 [D10] | 这是历史记录，当前完整状态待审；不删除 M4 原计划或改变 Gate 4 |

## 借鉴、优势与风险

**可独立实现的体验/设计**：准备材料及预计步骤前置；输入即时校验且区分网络/凭据错误；安装过程中显示当前步骤、等待用户与可重试原因；中断恢复前检查实际产物；状态卡展示证据、时间和下一步；按实际权限给出官方安装指引；准备干净机、端口冲突、中断、断线与凭据错误的测试矩阵。先检查 DDA 是否已有相应能力，已有则修复或复用，避免重复建设。

**已有基础和潜在优势**：仓库定位聚焦 Harness 管理；有官方和个人 QQ 两条代码路线；分层健康状态、部署 journal、校验和诊断模块，以及明确的用户数据清理边界和授权门禁。[D1][D4][D7] 这些是源码/文档层面的基础，并非与竞品的实测优劣结论。未验证“双路线都可用”或优于 DSQQ。

**不可照搬**：NapCat、AstrBot 及其进程/配置方式、DSQQ 人格素材和 vendor 内容；不复制未获授权源码；不把下游明文配置、默认彻底删除、强杀进程、要求绕过安全提示作为默认体验。OneBot 作为协议接口不等于引入 NapCat，但应依据 SnowLuma 和适配器实际接口实现，不以竞品栈替代既定路线。

**优先级与风险**：P0 真实个人 QQ 双向消息无通过证据、授权门禁和账号风控；P0 状态误报、用户数据误删和密钥泄漏；P1 安装中断恢复、错误定位及干净机；P1 签名与第三方许可证；P2 个性化和功能广度。SnowLuma 许可现状以项目报告对 EULA §5.4 的记录及清单 `authorized-only` 为依据，本次未独立核对最新上游条款与书面授权，商业使用、自动部署和再分发必须另行核实。[D4][D6]

## 今天的最小开发计划（建议，实施需另行开展）

时间盒按可用半天至一天安排；若账号或授权不可用，以可重复的模拟/只读验证和明确阻塞交付，不能宣布真实闭环完成。

1. **0–45 分钟：基线和选点。** 获得仓库访问权限，确认 Git HEAD、工作树、现有门禁、最近测试/审计；检查现有界面和状态来源，选一个阻塞真实闭环的最小缺陷。验收：记录提交、未提交变更、复现步骤和证据；不覆盖用户改动。
2. **45–180 分钟：一个垂直切片。** 复用现有五步向导和状态组合；仅修复实际发现的一个问题，例如状态缺失时显示“未验证 + 下一步”，或错误重试入口失效。验收：缺失证据、连接失败、恢复后分别显示真实状态；既有功能和授权闸门不回退。具体改动以基线检查为准，不预设缺陷已经存在。
3. **180–300 分钟：自动化与可控验收。** 针对选定缺陷做有意义的回归测试、类型检查及相关现有测试；通过用户自行安装/启动的 SnowLuma，在用户本人参与且许可允许时测试 QQ → Harness → QQ。验收：保留脱敏时间、版本、操作和收发证据；分别记录登录、适配器、模型回复；失败时显示原因且不将模拟通过标为真实通过。无真实账号/许可则结果为阻塞。
4. **300–360 分钟：交付与决策。** 形成通过/失败/阻塞清单与最小修复结果，更新对应验收证据（开发阶段再执行）。不得仅凭构建成功宣称可发布。官方 QQ 路线独立保留已有证据和剩余门禁。

## 后续阶段路线

- **近期：** 按原有 QQ-GATE-02 逐项完成真实设备、断线、重启与错误恢复验收；复核 QQ-GATE-01 未完成项。与用户确认可用账号、SnowLuma 授权与测试环境。
- **随后：** 对中断恢复、端口占用、密钥脱敏、数据保留及干净 Win10/11 做回归；建立可重复的受控集成测试与明确错误提示。
- **M4：** 回到冻结 PRD、`03-开发任务拆分.md` 和原 Gate 4，核实前置验证、插件索引/安装能力、网络与许可闭包；逐项记录，不以本报告调整或跳过门禁。
- **发布前：** 完成签名、第三方许可与可分发性审查、发布产物哈希核验、干净机验收和真实用户验证；未达条件则如实标示。

## 证据索引

DDA 本地路径均相对于 `D:/DeepSeek-Deploy-Assistant/DeepSeek-Deploy-Assistant/`：

- [D1] `README.md`（定位、技术栈、历史状态与验收记录）；[D2] `package.json`（脚本与依赖）。
- [D3] `apps/desktop/src/main/services/personal-qq-service.ts`；[D4] `packages/core/src/snowluma/deploy.ts` 与 `apps/desktop/resources/manifests/snowluma.json`。
- [D5] `packages/spec/src/gates.ts`；[D6] `docs/M3.2-个人QQ实施与验收记录.md` 与 `docs/M3.3-实施报告.md`（历史报告及许可记录）。
- [D7] `packages/core/src/{transfer/downloader.ts,engine/journal.ts,health/probe.ts,diagnostics/report.ts,snowluma/}`、`apps/desktop/src/main/services/`；[D8] `docs/M3.3.1-用户引导安装流程.md`。
- [D9] `packages/core/src/qq/personal/detect/compose.ts`、`apps/desktop/src/renderer/src/components/PersonalQqPanel.tsx`；[D10] `docs/audit/V0.1-待开发功能清单.md`、`docs/audit/V0.1-完整功能验收矩阵.md`（均为历史审计，不代表当前全量状态）。

公开证据：

- [S1] [DSQQ README 与目录](https://github.com/Jack-Cherish/DSQQ)；[S2] [v1.0.0 发布页](https://github.com/Jack-Cherish/DSQQ/releases/tag/v1.0.0)。
- [S3] [安装流水线源码](https://github.com/Jack-Cherish/DSQQ/blob/main/app/installer.py)；[S4] [本地服务与状态接口](https://github.com/Jack-Cherish/DSQQ/blob/main/app/server.py)；[S5] [进程生命周期](https://github.com/Jack-Cherish/DSQQ/blob/main/app/services.py)。
- [S6] [配置生成](https://github.com/Jack-Cherish/DSQQ/blob/main/app/configs.py)；[S7] [状态、DPAPI 和脱敏](https://github.com/Jack-Cherish/DSQQ/blob/main/app/store.py)；[S8] [人工测试清单](https://github.com/Jack-Cherish/DSQQ/blob/main/docs/%E6%B5%8B%E8%AF%95%E6%B8%85%E5%8D%95.md)。
