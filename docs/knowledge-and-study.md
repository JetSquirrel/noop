# Knowledge base and study

## Knowledge base

A machine can hold a read-only index of the owner's [SiYuan](https://b3log.org/siyuan/) notes:

```bash
noop kb setup E:/siyuan-data --notebooks 知识库,Inbox
noop kb search "架构 同步"
noop kb show <doc or block id>
```

- `setup` writes `[kb]` to `config.local.toml`, which is never synced, and the machine then advertises the `kb` capability.
- The index is `~/.noop/kb/index.sqlite`, outside the synced data folder. SiYuan's own files are only read.
- The index refreshes before a search once it is 10 minutes old, re-reading only the notes that changed.
- Agents on that machine are told how to search it. The chat brain can search it when it runs there.
- Note text leaves the machine only as what an agent quotes in a result, and agents are told to summarize instead of copying notes.

## Study

Ask for a lesson from the app's 学习 page, in chat ("讲讲 noop 的同步层是怎么设计的"), or from the terminal:

```bash
noop study "文件同步是怎么工作的" -p noop -m architecture
```

Angles: `auto`, `architecture`, `design`, `tech`, and `activity` (what the agents did, from tasks, the journal and commits).

The `tutor` agent reads the code, the fleet's history and the notes, and writes `reports/study/<task id>-<title>.md`, ending with a self-test that the app shows as cards with hidden answers. Which lessons are finished is remembered per device.

A project name resolves to a checkout under `[study] project_dirs` or `[resources] work_dirs`. A local checkout pins the lesson to that machine; otherwise it prefers a machine with the `kb` capability.

To add project folders on a machine, in `config.local.toml`:

```toml
[study]
project_dirs = ["E:/proj"]
```

## When the primary is gone

The primary is named in the shared config and nothing takes over automatically. `noop doctor` reports it, and `noop primary <host>` moves the role. Every running daemon restarts into its new role once it syncs the change, so a former primary that comes back steps down by itself.
