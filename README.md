# dsh-marketplace-indexer

自给自足的 DSH 插件市场静态索引生成器：定时扫描 GitHub `#dsh-plugin` 话题，
生成 `registry.json`（供 dsh-market 插件消费），不依赖任何第三方索引。

## 用法

1. 把这个仓库推送到你的 GitHub（公开仓库）：
   ```bash
   git init
   git add .
   git commit -m "init marketplace indexer"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 推送后 CI 自动运行：
   - 每 2 小时增量更新（只拉最近 3 天 pushed 的仓库）
   - 每天 04:00 UTC 全量重建
   - 首次可手动触发全量：Actions → build-registry → Run workflow → 勾选 full
3. 你的 dsh-market 插件消费本仓库的 `registry.json`：
   - `https://cdn.jsdelivr.net/gh/<你的用户名>/<仓库名>@main/registry.json`
   - `https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/registry.json`

## 本地运行

```bash
# 全量（需 GH_TOKEN，冷启动约 1.5 小时，Search 限额 30/min）
GH_TOKEN=xxx node scripts/build-registry.mjs

# 增量（只拉最近 3 天）
INCREMENTAL_DAYS=3 GH_TOKEN=xxx node scripts/build-registry.mjs

# 无 token 快速测试（限速 10/min，数据不完整）
MAX_PAGES=5 node scripts/build-registry.mjs
```

## 原理

GitHub Search API 单查询最多返回 1000 条（topic 搜索同样受限）。
本脚本用「stars 分段 + 时间窗口二分」突破上限：

- 按 star 数分段：`stars:>=1000` / `stars:100..999` / `stars:10..99` / `stars:0`
- 某段拉满 1000 条说明还有更多 → 对半分裂继续查询
- 单值段（`stars:0`）按 pushed 时间窗口二分
- 增量模式给所有查询附加 `pushed:>=N天前`，只扫最近活跃仓库

## 输出字段

`registry.json`：`{ generated_at, count, source, mode, repos[] }`
每条 repo：full_name / name / description / html_url / stargazers_count /
updated_at / created_at / default_branch / topics / license / registry_seen_at