# OMS GitMD Import 执行文档

日期：2026-05-09

## 目标

`oms_git_import` 把另一个 agent 的 GitMD 脑包导入当前 OMS agent。GitMD 是交换格式，SQLite raw ledger 是运行格式。

导入不是复制文件夹，也不是 `git pull`。流程必须保持 agent 身份、来源证据和去重规则清楚。

```text
source gitmd/*.md
  -> parse frontmatter/body
  -> validate source manifest
  -> convert to RawWriteInput
  -> write target agent SQLite raw_messages
  -> target RawWriter mirrors new GitMD Markdown
```

## 输入

工具参数：

```json
{
  "sourceRepoPath": "C:\\Users\\...\\.openclaw\\oms\\xiao-bai-...\\gitmd",
  "mode": "preview",
  "duplicatePolicy": "skip",
  "limit": 10000
}
```

字段：

- `sourceRepoPath`：源 GitMD 目录，必须包含 `manifest.json` 和 `raw/`。也可以传 agent 根目录；如果下面存在 `gitmd/manifest.json`，工具会自动使用这个 `gitmd/` 子目录。
- `mode`：`preview` 或 `import`。默认 `preview`。
- `duplicatePolicy`：`skip`、`force`、`import_as_reference`。默认 `skip`。
- `limit`：最多扫描 raw md 文件数，默认 `10000`。

## Manifest 校验

源目录必须包含：

```json
{
  "format": "oms-gitmd-v1",
  "agent_id": "小白",
  "owner": {
    "agent_id": "小白"
  }
}
```

导入使用 `owner.agent_id ?? agent_id` 作为 `sourceAgentId`。缺失或 JSON 损坏时拒绝导入。

## 解析规则

只扫描：

```text
raw/YYYY/MM/DD/*.md
```

每个 raw md 必须有 frontmatter：

```yaml
---
message_id: raw_...
agent_id: 小白
session_id: ...
turn_id: ...
timestamp: ...
role: user
source_purpose: general_chat
original_hash: sha256:...
redacted: false
---

正文
```

只导入 `role=user|assistant` 且正文非空的条目。

## 写入目标 agent

导入写入当前 OMS agent，不覆盖源 agent。

目标 raw 字段：

```text
agentId = current target agent
sessionId = import_<batchId>
turnId = import_<batchId>_<sequence>
turnIndex = imported order
sourcePurpose = imported_timeline
sourceAuthority = visible_transcript
evidencePolicyMask = general_history
retrievalAllowed = true
evidenceAllowed = true
```

metadata 必须保存来源：

```json
{
  "import": {
    "importBatchId": "import_...",
    "sourceAgentId": "小白",
    "sourceMessageId": "raw_...",
    "sourceSessionId": "...",
    "sourceTurnId": "...",
    "sourcePath": "...",
    "sourceOriginalHash": "sha256:..."
  }
}
```

## 去重策略

重复判断优先用来源签名：

```text
metadata.import.sourceAgentId + metadata.import.sourceMessageId
```

再用目标 agent 内的 `original_hash` 防止同一正文重复灌入。

策略：

- `skip`：重复时跳过，不写 raw。
- `force`：重复也写入新 raw，用新的 import batch/turn。
- `import_as_reference`：重复时不复制正文，只记录 `gitmd_import_reference` 审计事件。

## 返回结果

`preview` 返回：

```json
{
  "ok": true,
  "mode": "preview",
  "sourceAgentId": "小白",
  "scanned": 12,
  "importable": 10,
  "duplicates": 2,
  "blocked": []
}
```

`import` 返回：

```json
{
  "ok": true,
  "mode": "import",
  "importBatchId": "import_...",
  "imported": 10,
  "skipped": 2,
  "referenced": 0
}
```

## 不做

- 不把源 `manifest.json` 复制进目标脑包。
- 不保留源 `message_id` 作为目标 `message_id`。
- 不把源 agent 的 sqlite 合并进目标 sqlite。
- 不自动 git commit/push。
- 不把导入记忆伪装成目标 agent 的原生会话。

## Git 边界

Git 仓库根目录应设在目标 agent 的 `gitmd/` 目录，不要设在 agent 父目录或 `~/.openclaw/oms/`。

`gitmd/` 初始化时自动写入白名单 `.gitignore`：

```gitignore
*
!.gitignore
!manifest.json
!raw/
!raw/**
!timeline/
!timeline/**
!exports/
!exports/**
```

也就是说 Git 只跟踪 GitMD 脑包本体：manifest、raw markdown、timeline/export markdown。SQLite、日志、缓存、临时文件即使被误放进 `gitmd/`，默认也不会被 Git 收进去。
