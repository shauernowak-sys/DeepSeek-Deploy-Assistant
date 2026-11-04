# THIRD_PARTY NOTICES

> 本文件由 `scripts/build-notices.ts（package.json 版本 + pnpm 生产闭包）` 生成；请勿手工修改（CI 会校验一致性）。

本软件随安装包分发的第三方组件如下。**仅在线安装**的插件不随包分发，其字节由用户机器从
上游 registry 获取，因此不列入可分发清单，但在此一并说明其许可边界。

---

## 本软件自身的生产依赖

本清单只覆盖可随包分发的依赖。被拒条目（UNLICENSED 等）不会出现在我方产物中。

| 包 | 版本 | 许可 |
|---|---|---|
| argparse | 2.0.1 | Python-2.0 |
| js-tokens | 4.0.0 | MIT |
| js-yaml | 4.1.0 | MIT |
| loose-envify | 1.4.0 | MIT |
| pend | 1.2.0 | MIT |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| scheduler | 0.23.2 | MIT |
| yauzl | 3.4.0 | MIT |
| zod | 3.25.76 | MIT |
---

## 仅在线安装（不随包分发）

### @tencent-connect/dsh-qqbot@0.5.5（条目 plg-official-qqbot）

该插件由用户在联网环境从上游 registry 安装，本软件不复制、不镜像、不随包分发其字节。

- 不可分发：`@tencent-connect/qqbot-connector@1.2.0` — `UNLICENSED`

---

## 运行时

Node.js 与 pnpm 以官方发行包形式安装到用户私有目录，其许可（MIT）全文随官方发行包提供；
本软件不修改其内容。Harness（`@deepseek-ai/dsh`，MIT）由官方 npm 渠道获取。
