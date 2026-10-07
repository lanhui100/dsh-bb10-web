# Agent Note: ws-add-home-hint-no-prefix

Status: implemented

## Problem

A 键新增弹窗的 `~/` 固定前缀条在 720 宽屏占 44px，且 `~/<name>` 实时预览对用户是噪音。用户要求：去掉前缀条，注释只保留一句“新建的 Workspace 在哪里”。

## Decision

1. 弹窗说明改为“输入新工作区名称（将创建在家目录下）”，输入框恢复全宽单行；
2. 删除 `#ws-add-preview` 元素、`wsAddPreview` 变量、`wsAddSyncPreview` 函数及全部三处调用（openWsAdd/keyup/onpropertychange 兜底改为仅清报错）；
3. 单测 2a 前端接线针同步：正向针去掉 preview 两项、加“将创建在家目录下”，反向针断言 `ws-add-preview`/`wsAddSyncPreview`/旧绝对路径提示词三者根除。

## Alternatives considered

- **保留前缀条只删预览**：前缀条本身占宽且与“去提示”要求相悖；去掉后输入框全宽，Q20 小屏更实用；故整组删除。
- **预览改为创建成功 toast**：成功路径已有 `setStatus('已新增工作区…')`，不再加。
