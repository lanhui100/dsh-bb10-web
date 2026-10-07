# Agent Note: Decoupled Standalone Deployment Package via Docker and Systemd

Status: implemented

## Problem
`dsh-q20-web` 最初紧密运行在作者专用的开发机环境中（通过宿主机 Systemd 守护进程、私有网段和固定上游 DSH 地址），未提供对外开源开箱即用的一键解耦拉起配置。外部用户克隆仓库后，无法通过一行命令以标准化、环境隔离的方式拉起服务，且反代域名与上游 DeepSeek Harness URL 缺乏声明式环境变量解耦模板。同时，改造必须严格保持对作者当前生产环境（Systemd + 反向代理 Ingress）的零侵入与零破坏。

## Decision
1. 提供生产零侵入的标准化容器套件：在仓库根目录增设 `Dockerfile` 与 `docker-compose.yml`，并将配置参数抽离至 `.env.example`。
2. 保持环境变量全量解耦与对齐：
   - `DSH_WEB_URL`（默认 `http://host.docker.internal:3080` 或指定远程端点）；
   - `DSH_HOME`（支持挂载本地 `~/.dsh` 会话与配置目录）；
   - `PORT` 与 `HOST`（容器内默认监听 `3090`，对外映射可配）；
   - `ALLOWED_ORIGINS`（用户自定义外部访问域名）；
   - `Q20_AUTH_TOKEN` 与 `Q20_COOKIE_SECURE`（可选鉴权与公网 HTTPS Cookie 标记）。
3. 提供外部反代与守护参考模板：在 `deploy/` 目录下组织标准 Nginx 反代配置（保持 SSE 与 WebSocket 无缓冲直通）以及无硬编码路径的通用 Systemd Unit。
4. 补充自动化解耦回归测试，确保新套件与既有宿主机直接运行双轨并存互不污染。

## Alternatives considered
- 仅提供 Shell 启动脚本与文档：对外部用户宿主机 Node 版本和环境存在强假设，容易因环境差异引发运行问题，不满足“开箱即用”预期。
- 侵入式改造 `server.mjs` 改为全 Dockerized 强制路径：会破坏作者现有的宿主机 Systemd 守护和基于私有回源链路的既有部署，增加不可控风险。

## Consequences
- 外部用户可通过 `cp .env.example .env && docker compose up -d` 一条命令启动独立容器服务。
- 既有生产环境的 `dsh-q20-web.service` 和代码无任何破坏性变动。
