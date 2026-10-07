# Agent Note: Rename Project dsh-q20-web to dsh-bb10-web

Status: implemented

## Problem
项目原品牌名 `dsh-q20-web` 以具体机型 BlackBerry Q20 命名，但服务实际面向 BlackBerry 10 (BB10) 系统自带浏览器（WebKit 537.35+）及所有 BB10 设备（Q10/Passport/Classic 等），Q20 仅是其中一款代表机型。机型名作为项目名会误导用户以为仅适配单一设备。

## Decision
将项目品牌统一重命名为 `dsh-bb10-web`：
- GitHub 仓库 `lanhui100/dsh-q20-web` → `lanhui100/dsh-bb10-web`；
- `package.json`/`package-lock.json` name、docker-compose 服务名/镜像/容器名；
- systemd 模板 `deploy/dsh-q20-web.service` → `deploy/dsh-bb10-web.service`（单元名/工作目录/EnvironmentFile/SyslogIdentifier 全量同步）；
- README（中英）标题与描述、.env.example 注释、宪法项目名槽位、审核报告标题；
- 运行标识：`server.mjs` healthz `service` 字段与 EADDRINUSE 提示、`test-unit.mjs`/`test-suite.mjs`/`test-decoupling.mjs` 断言与注释、`start.sh`/`stop.sh` 提示文案、`static/index.html` 标题/登录弹窗/欢迎品牌。

## Alternatives considered
1. **仅改 README 不深入代码**：会导致运行时 healthz 标识、systemd 模板、测试断言与外宣名称不一致，长期漂移。
2. **同步重命名生产 systemd 单元 (`dsh-q20-web`)**：被否决——生产单元名对外部监控、watchdog、回滚管道有既有依赖，改名需跨系统迁移，收益低、风险高；保持生产单元名并在 NFR 报告中显式标注历史名。

## Consequences
- 开源树内品牌 100% 统一为 `dsh-bb10-web`，语义更准确（面向 BB10 系统浏览器而非单机型）。
- 本地生产 systemd 单元仍为 `dsh-q20-web`（零迁移），healthz 已返回新标识 `dsh-bb10-web`。
- 全部门禁回归通过：ES5 PASS、secret-scan clean (218 files)、npm test 32/32。