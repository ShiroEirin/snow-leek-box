# 上架到 Snow App 插件市场

面向作者的操作清单。协议细节以应用内置文档为准：
`~/.snowapp/docs/zh-CN/2-使用指南/24-插件开发与安装.md` 第 11 节。

## 1. 打包

```powershell
pwsh -File scripts/package.ps1
```

产物：`dist/snow-stock-panel-<version>.zip`，并打印 SHA-256。

硬性要求（不满足会被客户端拒装）：

- `plugin.json` 必须位于 **zip 根目录**，不能套一层文件夹；
- zip 内 `plugin.json` 的 `id` 必须与市场条目 `id` 完全一致；
- zip 上限 128 MB，解压后总量上限 512 MB。

## 2. 发布 Release

在插件仓库创建 Release：

- tag 用语义化版本，如 `v1.0.0`（与 `plugin.json` 的 `version` 一致）；
- 上传 `dist/snow-stock-panel-1.0.0.zip` 作为资产（文件名不要改）；
- 记录 Release 资产的 SHA-256（必须对应 zip 的原始字节，重新打包后要重算）。

## 3. 提交索引条目

向 [snow-plugin-store](https://github.com/MayDay-wpf/snow-plugin-store) 提 PR，
新增 `app/plugins/<id>.json`（一插件一文件，文件名必须等于 `<id>.json`）：

```json
{
  "id": "com.shiroeirin.leek-box",
  "kind": "plugin",
  "name": {
    "default": "Leek Panel",
    "zh-CN": "韭菜面板"
  },
  "description": {
    "default": "Fund NAV, A-share/US/HK quotes with intraday and candlestick charts, a cost-basis trading ledger and symbol search.",
    "zh-CN": "基金净值、A股/美股/港股行情（分时与日K蜡烛）、按成本价记账的交易账本、交易时段与标的搜索。"
  },
  "repo": "https://github.com/ShiroEirin/snow-stock-panel",
  "version": "1.0.0",
  "tag": "v1.0.0",
  "asset": "snow-stock-panel-1.0.0.zip",
  "sha256": "<第 1 步打印的 64 位十六进制>",
  "author": "ShiroEirin",
  "privacy": ["network"],
  "tags": ["stock", "fund", "finance", "行情", "基金", "持仓"],
  "icon": "lucide:Sprout"
}
```

字段约束：

| 字段 | 说明 |
| --- | --- |
| `id` | 与 `plugin.json` 一致；字母/数字/`.`/`-`/`_`，≤96 字符 |
| `version` | 与 Release 内容一致 |
| `tag` / `asset` | 未提供 `downloadUrl` 时必填，客户端按 `releases/download/<tag>/<asset>` 推导 |
| `sha256` | 64 位十六进制；客户端下载后逐字节校验，不一致即拒装 |
| `privacy` | 必须与 `plugin.json` 的 `privacy.scopes` 一致（本插件为 `network`） |
| `minAppVersion` | 可选；高于用户应用版本时禁用安装 |

本地可先跑仓库里的 `node app/scripts/validate-registry.mjs` 自检。

## 4. 生效

CI 校验通过、维护者合并后自动重建 `app/registry.json`；客户端「插件市场 → 刷新」
即可看到条目并一键安装。**不要手动编辑 `registry.json`。**

## 5. 社区通道（可选，不用等审核）

给插件仓库打 GitHub 主题 **`snow-plugins`**，客户端「插件市场 → 社区插件」即可检索到。
社区通道没有哈希锁定，条目会标注「社区插件 · 未发布到市场」。官方收录后建议保留主题，
客户端会把两条通道识别为同一仓库。

## 6. 版本升级

1. 改 `plugin.json` 的 `version` + `CHANGELOG.md`；
2. 重新 `package.ps1`（SHA-256 会变）；
3. 新建 Release（新 tag）并上传新 zip；
4. PR 更新 `app/plugins/<id>.json` 的 `version` / `tag` / `asset` / `sha256`；
5. 合并后用户端出现「更新」按钮（原地覆盖，保留启用状态）。

## 隐私声明一致性

本插件只声明 `network`：

- `api.fund.eastmoney.com` — 基金历史净值
- `qt.gtimg.cn` — 实时行情（GBK）
- `ifzq.gtimg.cn` / `web.ifzq.gtimg.cn` — 日 K 线（主域名 + 回退）
- `push2his.eastmoney.com` — 分时
- `smartbox.gtimg.cn` — 标的搜索

自选、持仓、资源库均写插件私有存储（`app_plugin_values`），不上传。
改动数据源时必须同步更新 `plugin.json` 的 `privacy.note` 与市场条目。


