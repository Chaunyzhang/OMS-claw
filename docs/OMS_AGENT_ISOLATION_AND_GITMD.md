# OMS Agent 隔离与 GitMD 脑包方案

日期：2026-05-08

## 结论

OMS 的长期记忆必须按 agent 隔离。隔离对象包括：

1. SQLite ledger：raw、summary、graph、embedding、retrieval run。
2. GitMD 脑包：从 raw 导出的 Markdown 时间线和审计文件。
3. manifest owner：每个持久化目录必须声明自己属于哪个 OMS agent。

默认规则：

```text
baseDir = ~/.openclaw/oms
dbPath = ~/.openclaw/oms/<agentPathId>.sqlite
memoryRepoPath = ~/.openclaw/oms/<agentPathId>/gitmd
```

其中 `<agentPathId>` 是把 `agentId` 转成路径安全名称，并追加 UID/hash 后缀后的值。比如：

```text
agentId = agent/main
agentPathId = agent-main-<10位hash>
dbPath = ~/.openclaw/oms/agent-main-<10位hash>.sqlite
memoryRepoPath = ~/.openclaw/oms/agent-main-<10位hash>/gitmd
```

这解决的是“一 agent 一 sqlite，一 agent 一 GitMD 脑包”。

## Agent 命名规则

OMS 区分三件事：

1. `agentId`：逻辑身份，写进 sqlite row 和 GitMD manifest，可以是中文，例如 `小白`。
2. `agentUid`：宿主如果提供稳定 UID，OMS 用它防重名；宿主暂未提供时，OMS 用 `sha256(agentId)` 的前 10 位作为派生 UID。
3. `agentPathId`：磁盘目录名，由 `agentId` 的拼音/ASCII slug 加 UID/hash 后缀组成。

路径规则：

```text
agentId = 小白
agentUid = agent_123
agentPathId = xiao-bai-agent_123
memoryRepoPath = ~/.openclaw/oms/xiao-bai-agent_123/gitmd
```

如果没有 `agentUid`：

```text
agentId = 小白
agentPathId = xiao-bai-<10位hash>
```

同音不同字不会撞：

```text
小白 -> xiao-bai-<hashA>
晓白 -> xiao-bai-<hashB>
```

如果两个 agent 的显示名完全相同，而且宿主没有提供独立 UID，OMS 无法判断它们是不是同一个 agent。生产多 agent 场景必须配置 `agentUid` 或等待 OpenClaw 插件 API 注入宿主 UID。

## 当前边界

当前 OMS 内部有 `agentId`，但宿主 OpenClaw 的 agent id 还没有被自动注入到 OMS 配置里。

因此多 agent 部署必须满足其中之一：

1. OpenClaw 为每个 agent 显式配置不同的 `pluginConfig.agentId`。
2. 后续由 OpenClaw 插件 API 提供宿主 agent id，OMS 自动派生 `agentId`。

如果 OpenClaw 配置里只有一个 agent，单 agent 可以继续使用默认：

```text
agentId = oms-agent-default
```

如果 OpenClaw 配置里有多个 agent，而 OMS 没有显式 `agentId`，OMS 必须 fail closed：

```text
oms_agent_id_required_for_multi_agent_openclaw_config
```

这不是可接受的多 agent 配置。生产多 agent 环境必须显式配置 `agentId`，或者由宿主自动注入 agent id。

## GitMD 脑包

GitMD 是 agent 的 Markdown 脑包目录。它只保存可导出的 redacted raw Markdown，不保存 sqlite。

写入时机：

```text
RawWriter.write 成功写入 raw_messages
  -> 立即写 GitMD raw Markdown
  -> 同一 raw 重放时不重复写文件
```

`oms_git_export` 仍可作为补导/批量导出工具，但正常运行不再依赖手动 export 才生成 Markdown。

目录：

```text
~/.openclaw/oms/<agentPathId>/gitmd
```

内容：

```text
gitmd/
  manifest.json
  raw/
    YYYY/
      MM/
        DD/
          YYYYMMDDTHHMMSSZ-00000001-raw_....md
  timeline/
    YYYY/
      MM/
        DD.md
  exports/
    export-log.jsonl
```

`manifest.json` 必须包含 owner：

```json
{
  "format": "oms-gitmd-v1",
  "brainpack": "gitmd",
  "agent_id": "agent-a",
  "owner": {
    "kind": "oms-agent",
    "agent_id": "agent-a"
  },
  "source": "sqlite",
  "redaction": {
    "enabled": true,
    "policy": "default"
  }
}
```

导出时规则：

- 如果没有 manifest，创建 manifest。
- 如果 manifest 的 `owner.agent_id` 或 `agent_id` 等于当前 `agentId`，允许写入。
- 如果 manifest 属于另一个 agent，拒绝导出。
- 如果 manifest JSON 损坏，拒绝导出。

拒绝原因：

```text
memory_repo_agent_mismatch
memory_repo_manifest_invalid
```

这样即使有人手动把两个 agent 的 `memoryRepoPath` 配到同一个目录，也不会静默串脑包。

## SQLite 隔离

默认 SQLite 文件按 agent 分开：

```text
~/.openclaw/oms/<agentId-safe>.sqlite
```

表内仍保留 `agent_id` 字段。这有两个作用：

1. 防御：即使未来有人显式共用 DB，查询和 status 也尽量按 agent 过滤。
2. 审计：从任意 row 能看出归属 agent。

默认部署不应该让多个 agent 共用 sqlite。共享 DB 只有在显式 `allowSharedDb=true` 的未来设计里才允许。

## 配置建议

单 agent 可以使用默认：

```text
agentId = oms-agent-default
dbPath = ~/.openclaw/oms/oms-agent-default.sqlite
memoryRepoPath = ~/.openclaw/oms/oms-agent-default/gitmd
```

多 agent 必须显式配置：

```json
{
  "plugins": {
    "entries": {
      "oms": {
        "enabled": true,
        "config": {
          "agentId": "小白",
          "agentUid": "openclaw-agent-uuid-or-stable-id"
        }
      }
    }
  }
}
```

如果 OpenClaw 是每个 agent 单独加载 plugin config，则每个 agent 配自己的：

```text
agent main -> agentId main -> main-<uid/hash>.sqlite -> main-<uid/hash>/gitmd
agent 小白 -> agentId 小白 -> xiao-bai-<uid/hash>.sqlite -> xiao-bai-<uid/hash>/gitmd
```

## 后续必须补的宿主级防线

当前代码已经做到：

- 默认 GitMD 路径按 OMS `agentId` 隔离。
- GitMD manifest owner 不匹配时拒绝导出。
- `agentId` 转拼音/ASCII 路径安全名称，并追加 UID/hash 后缀，避免路径穿越和同音重名。
- 检测到 OpenClaw 多 agent 配置但 OMS 未显式设置 `agentId` 时 fail closed。

后续需要 OpenClaw 宿主配合做到：

1. 插件注册时提供宿主 agent id 和宿主稳定 UID。
2. OMS 没有显式 `agentId` 时，从宿主 agent id 派生。
3. 多 agent 环境下禁止使用 `oms-agent-default`，当前已用配置检测先 fail closed。
4. 启动时检查 sqlite manifest owner，不匹配则拒绝打开。

## 验收

必须有自动化测试：

1. `agentId=agent/main` 时，默认路径为 `agent-main-<hash>.sqlite` 和 `agent-main-<hash>/gitmd`。
2. 显式 `memoryRepoPath` 不被默认规则覆盖。
3. 多 agent OpenClaw config 缺少 OMS `agentId` 时抛出 `oms_agent_id_required_for_multi_agent_openclaw_config`。
4. 首次 GitMD 导出会创建 `oms-gitmd-v1` manifest。
5. agent-b 不能写入 agent-a 的 GitMD。
6. manifest 损坏时拒绝导出。
7. raw 写入成功后立即生成 `gitmd/raw/YYYY/MM/DD/YYYYMMDDTHHMMSSZ-00000001-raw_....md`。
8. 同一 raw 重放不会重复生成 Markdown。
9. 中文 `agentId=小白` 时默认路径为 `xiao-bai-<hash>`。
10. 同音不同字 `小白` / `晓白` 生成不同 `agentPathId`。

## 不做的事

本轮不做：

- 不迁移旧 `~/.openclaw/oms/memory-repo`，避免误搬历史文件。
- 不把 sqlite 放进 GitMD。
- 不支持默认共享 DB。
- 不把 agent 隔离交给人工约定。
- 不把一个 agent 的记忆静默导入另一个 agent；导入必须显式记录 provenance。

核心原则：

```text
路径默认隔离，manifest 二次校验，配错拒绝写入。
```
