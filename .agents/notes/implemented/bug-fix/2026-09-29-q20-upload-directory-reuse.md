# Agent Note: Q20 upload directory reuse and file conflict

Status: implemented

## Problem

`handle_streaming_upload` calls `os.makedirs(target_dir, exist_ok=True)` for every upload. The QNX/Python 3.2 runtime does not reliably support the keyword, so an already-existing upload directory can return `Errno 17` instead of accepting the upload. A target path occupied by a regular file must fail as a clear JSON error without destabilizing the server.

相关前置决策：`.agents/notes/implemented/bug-fix/2026-09-19-q20-upload-completed-but-file-missing.md`（上传落盘结果与服务端 `files` 语义）以及 `.agents/notes/implemented/bug-fix/2026-09-29-q20-upload-hostile-filename-graceful-failure.md`（上传失败保持连接、返回 JSON 与结构化日志）。

## Decision

`handle_streaming_upload` now uses Python 3.2-compatible directory handling: it first reuses an existing directory, creates the directory only when absent, and treats a path occupied by a file as a 500 JSON conflict. If creation races with another creator and raises `EEXIST`, the handler rechecks `isdir` and accepts the directory; other errors remain 500 failures. Logs distinguish `reused`, `created`, and `file-conflict` without recording the full user path. Phase 1 regression covers both an existing `documents` directory upload (200) and a same-name file conflict (500 JSON), followed by a normal upload to prove service liveness.

## Alternatives considered

- Keep `os.makedirs(..., exist_ok=True)`: rejected because the target QNX/Python 3.2 runtime can raise `Errno 17` for an existing directory and the keyword is not a safe compatibility contract.
- Unconditionally call `os.mkdir`: rejected because repeated uploads would fail on the normal existing-directory path; the explicit existence check plus `EEXIST` recheck handles both reuse and creation races.
- Treat a same-name regular file as an existing directory: rejected because writing into it is unsafe and must produce a precise conflict response.

## Consequences

- Uploads to an existing directory are accepted without relying on `exist_ok`.
- A same-name file returns structured HTTP 500 JSON and the server remains usable.
- The handler remains Python 3.2 standard-library compatible and preserves existing style/template/JavaScript boundaries.
