# §21.10「回到上一可用」入口 + 安装 E2E 实施报告

**日期：** 2026-11-05
**范围：** ① 把 D08 的 profile 备份/恢复能力接到用户入口（`§21.10` 四个恢复动作里的"回到上一可用"）；② 补「无 VPN 安装」的可重放 E2E（前置项 P-5）。
**未做：** D02 资源中心 UI、D10 宿主索引读取（与此前决策一致）。

---

## 1. §21.10「回到上一可用」接线

### 1.1 原来缺什么

D08 已交付 `createProfileBackup()` / `restoreProfileBackup()`，`HarnessService.restoreProfile()` 也做了"还原 + 按 lockfile `--force` 重建"，但**没有任何用户入口**：矩阵 §21.10 里"回到上一可用"一直是 ✘，用户只能靠"回滚本次创建"删除产物（语义完全不同）。

### 1.2 交付物

| 层次 | 文件 | 内容 |
|---|---|---|
| 契约 | `packages/spec/src/domain.ts` | `ProfileBackupSummary` / `ProfileRecoveryPreview` / `ProfileRecoveryResult` |
| 契约 | `packages/spec/src/ipc.ts` | `ProfileRestoreSchema`（`{ id?, confirmed }`，`.strict()`） |
| 主进程 | `apps/desktop/src/main/services/profile-recovery-service.ts` | `preview()` / `restore()`：三条硬规则见下 |
| 主进程 | `apps/desktop/src/main/services/harness-service.ts` | 新增只读 `hasSession`（判断 Harness 是否在跑，不做 HTTP 探测） |
| 装配 | `apps/desktop/src/main/index.ts` | 用 `harness.restoreProfile` / `harness.listPlugins` / `pnpmCliJs` 组装服务 |
| IPC | `apps/desktop/src/main/ipc/register.ts` | `profile:recovery-preview`（只读）、`profile:restore`（需 `confirmed`） |
| 预加载 | `apps/desktop/src/preload/index.ts` | `profileRecoveryPreview()` / `profileRestore(id, confirmed)` |
| 渲染层 | `apps/desktop/src/renderer/src/App.tsx` | 部署页新增「回到上一可用…」按钮 + 预览/确认弹窗（选择备份、影响面、警告、重建命令） |
| 测试 | `tests/desktop/profile-recovery.test.ts` | 9 例；`tests/desktop/ipc-contract.test.ts` 继续守护三端一致 |

### 1.3 三条硬规则（落成代码 + 测试）

1. **先预览再确认**：恢复会覆盖 profile 的 4 个声明文件并重建依赖。`restore()` 在没有 `confirmed: true` 时直接返回失败且**不动任何文件**；IPC 层用 `ProfileRestoreSchema` 再校验一次。
2. **恢复本身可反悔**：恢复前自动 `createProfileBackup()` 打一份"保险备份"，结果里回传 `safetyBackup` 路径。这里有个真坑：保留策略默认只留 3 份，若按默认 `keep` 打保险备份，会**把即将用于恢复的旧备份挤出窗口**；实现取 `keep = 现有份数 + 1`，并有专门用例（连续 3 份备份后恢复最早那份仍成功）。
3. **不静默兜底**：显式 `id` 找不到时报"找不到备份"，**不**退回最近一份；备份缺 `package.json` 时拒绝；恢复抛错时如实返回失败并给出保险备份位置；pnpm 不可用时预览里 `rebuild.willRun=false` 并提示"依赖需手工重建"，不谎报成功。

### 1.4 预览里给用户看什么

- 备份列表（时间、文件数、缺失文件、哪份是最近）、当前已安装插件；
- 会执行的命令 `pnpm install --offline --frozen-lockfile --force`（`PROFILE_REBUILD_ARGS`）；
- 警告：Harness 正在运行 → 建议先停止；无 pnpm → 只还原文件；"desktop profile 永不备份/恢复"。

---

## 2. 安装 E2E（P-5）

### 2.1 脚本

`scripts/install-e2e.ts`（`npm run e2e:install`）：

```
tsx scripts/install-e2e.ts                       # 镜像源（L2），直连
tsx scripts/install-e2e.ts --source=official     # 官方源（L3）
tsx scripts/install-e2e.ts --source=both --repeat-install
tsx scripts/install-e2e.ts --use-proxy | --keep | --dsh-bin=<path>
```

与 `d08-restore-e2e.ts` 的区别：**走产品编排** `installCatalogPlugin()` 的 9 步，而不是脚本自己拼 `dsh plugin add`。因此这条证据同时覆盖：第 1 步 compat 门禁、第 3 步 spec 生成、第 5 步逐层换源（本次单源）、第 6 步 `plugin list` 复核、第 7 步 `--dump-config` 加载复核、第 8/9 步"无证据就记 unverified"。

### 2.2 两条防自欺措施

第一版跑出"5.5 s 装完 37 个包"，看着很好但**可能是 pnpm 缓存命中**。于是补了两条可核实的东西：

1. **直连字节探测**：用 Node 的 `fetch`（undici 默认**不读** `HTTP(S)_PROXY`）直接拉 packument + tarball，报 KiB / KiB·s⁻¹ / integrity 比对结果 —— 这条证据回答"不挂代理能不能拿到字节"，与 pnpm 缓存无关；
2. **pnpm store 增量**：`pnpm store path` 问出真实 store（本机 `D:\.pnpm-store\v11`），安装前后各统计一次文件数与字节；增量 0 就**明确写"本次为缓存命中"**。

顺带发现：`npm_config_store_dir`（产品 `dshEnv()` 里设的）**对 pnpm 无效**，只有 `--store-dir` 或 `.npmrc` 的 `store-dir` 才生效。这是个环境事实，记录于此，不影响隔离性（`DSH_HOME` 与 profile 都是隔离的；只有 store 是共享的）。

### 2.3 实跑结果（`docs/evidence/m4-install-e2e.log`）

| 源 | 直连探测 | 9 步编排 | 重复安装 | 结论 |
|---|---|---|---|---|
| npmmirror（L2） | tarball 220.2 KiB / **0.20 s → 1101 KiB/s**，integrity 匹配 | 1–7 步 succeeded，8–9 步 unverified，总 6.1 s | `action=none`，0 步 | PASS |
| npmjs（L3） | tarball 220.2 KiB / **0.52 s → 426 KiB/s**，integrity 匹配 | 1–7 步 succeeded，8–9 步 unverified，总 7.9 s | `action=none`，0 步 | PASS |

两次 store 增量均为 **0**（缓存命中，日志里已写明）；因此"字节来自网络"这件事由第 0 步 fetch 证据承担，"干净缓存下的耗时"仍由既有的 `npm run probe:registry`（镜像 2.0 s / 官方 7.6 s）承担。

### 2.4 这条证据能说明什么、不能说明什么

**能说明**：在直连（剔除代理变量）条件下，两个源都能取到元数据与 tarball 且 integrity 一致；产品编排能在全新 `DSH_HOME` 上完成"装 + 列表复核 + 加载复核"，并且同版本再装会短路。

**不能说明**：① 用户机器上没有 VPN（脚本无法判断，只能靠剔除代理变量模拟直连）；② L1 已落地（仍然没有）；③ 第 8/9 步（配置自检 / 连通）——本脚本不提供证据源，按产品规则记 `unverified`，**不得据此宣称"可用"**。

---

## 3. 验证记录

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run test` | **593 passed / 6 skipped / 0 failed**（76 文件；新增 `tests/desktop/profile-recovery.test.ts` 9 例） |
| `npm run verify` | exit 0（含 `license:check` / `notices:check` / `licenses:check`） |
| `npm run e2e:install -- --source=both --repeat-install` | exit 0，两个源 PASS，日志已归档 |
| `npm run e2e:restore` | 未重跑（D08 链路未改动） |

---

## 4. 仍未关闭

1. **§21.10 还有两个入口缺**：主部署的"重试这一步"、以及"重置安装"。前者需要在执行器上做单步重试，后者是产品决策（当前只有"回滚本次创建"）。因此该行状态仍是**部分完成**。
2. **UI 未做视觉验收**：新弹窗只做了功能与文案，未做 1920×1080 / 1366×768 截图（与第三轮遗留一致）。
3. **D02 / D10** 未动。
4. 资源中心仍"码级就绪、无入口"，"已安装"不得显示为"可用"。
