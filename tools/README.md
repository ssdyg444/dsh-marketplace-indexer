# dsh-session-fix — DSH 会话日志修复工具

DeepSeek Harness 的会话日志是**多帧 zstd 压缩**格式（每帧独立，第一帧为恰好一行的 header）。
进程被强杀/断电等写入中断会让日志产生两种损坏：

1. **重复 seq**（`corrupt session log: seq gap in committed region`）
2. **帧格式错误**（`first frame is not exactly one header line` / `complete frame contains a torn JSONL record`）

## 用法

```bash
# 审计全部会话（$DSH_HOME/sessions）
node dsh-session-fix.js audit [sessionsRoot]

# 修复指定会话（自动备份 → 删除重复 seq 行 → 按 dsh 格式重新分帧）
node dsh-session-fix.js fix <会话目录>
```

修复前自动备份为 `session.jsonl.zstd.bak-<时间戳>`。

## 关键知识

- **header 帧**：恰好一行 `{"type":"session",...}` + 末尾 `\n`
- **每帧内容必须以 `\n` 结尾**（否则最后一条记录被判"torn JSONL record"）
- **seq 校验**：重复 seq（回退）= 损坏；**向前跳跃 = compaction 正常痕迹**，不要误修
- 压缩参数：`ZSTD_c_checksumFlag: 1`（与 dsh 一致）

## 依赖

Node.js ≥ 22（使用内置 `node:zlib` 的 zstd API，无需外部工具）。

## 许可证

MIT