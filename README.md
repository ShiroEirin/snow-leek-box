# snow-stock-panel · 韭菜盒子

Snow App 面板插件。**一个**面板装下基金、行情与大饼：净值、实时报价、分时、日 K 蜡烛、
按成本价记账的交易账本、交易时段状态、名称/拼音搜索，外带一个独立的资源库面板。

零构建、零依赖，入口是单个 ES 模块，全部逻辑内联。

## 功能

| 面板 | id | 内容 |
| --- | --- | --- |
| 韭菜盒子 | `leek` | 「基金 / 行情 / 大饼」三页签；分时 + 日 K 蜡烛 + 持仓交易 + 明细列表 |
| 资源库 | `library` | 自定义链接 / 笔记 / 本地文件条目，标签与全文搜索 |

**基金**：9 只预置持仓基金（可增删），单位净值、日涨跌幅、市值、净值日期。

**行情**：A 股 / 美股 / 港股 / 指数自选，批量实时报价，交易时段圆点。

**图表**：

- 分时（东财 `trends2`）：昨收基准虚线，涨跌按基准着色，悬停显示分钟与价格；
- 日 K 蜡烛（腾讯 `fqkline`）：开/高/低/收，20D / 60D / 120D，悬停显示当日 OHLC；
- 基金净值折线：20D / 60D / 120D，区间涨跌与交易日数。

**交易账本**：

- 买入按加权平均成本合并；
- 卖出按均价结转**已实现盈亏**，浮盈与已实现分列；
- 支持「校正」直接改份额 / 均价；旧版 `entryPrice` 数据自动兼容；
- 顶部按币种汇总市值、成本、浮动盈亏、已实现盈亏。

**设置**：涨跌配色（红涨绿跌 / 绿涨红跌），同时作用于文字与图表，持久化。

**智能刷新**：交易中 30 秒，非交易时段 5 分钟；基金 5 分钟。

## 安装

1. 侧边栏底部 **插件** → **插件列表** → **面板插件** → **从目录安装**
2. 选择本目录（包含 `plugin.json` 的那一层）
3. 从顶栏 **加号菜单 → 插件** 或右侧面板标签打开

config 工具覆盖更新：

```json
{ "scope": "plugins", "key": "com.shiroeirin.leek-box", "value": { "sourceDir": "/path/to/snow-stock-panel" } }
```

> 0.2.0 起原 `funds` / `stocks` 两个面板合并为 `leek`；升级后旧标签需手动关一次。

## 数据源

| 用途 | 接口 | 关键点 |
| --- | --- | --- |
| 基金最新净值 | `api.fund.eastmoney.com/f10/lsjz` | `Referer: https://fundf10.eastmoney.com/` |
| 基金历史净值 | 同上 + `pageIndex` | **`pageSize` 上限 20**，60D 需 3 页，按日期去重排序 |
| 实时行情 | `qt.gtimg.cn/q=...` | GBK，`TextDecoder("gb18030")` |
| 日 K 线 | `ifzq.gtimg.cn/appstock/app/fqkline/get` | **主域名 ifzq，web.ifzq 仅回退** |
| 分时 | `push2his.eastmoney.com/api/qt/stock/trends2/get` | `f51` 时间、`f53` 价格；`secid` 按市场推导 |
| 加密货币行情 | `data-api.binance.vision/api/v3/ticker/24hr` | **`api.binance.com` 在本机出口返回 451**，公共数据域名可用 |
| 加密货币 K 线 | `data-api.binance.vision/api/v3/klines` | 日线 `1d` / 分时 `5m`；行序 `开高低收量` |
| 标的搜索 | `smartbox.gtimg.cn/s3/?t=all&q=` | `v_hint` 里 `^` 分记录、`~` 分字段 |

### 已失效的接口（不要再接）

- `fundgz.1234567.com.cn/js/<code>.js`（基金盘中估值）—— 2026-11-02 实测返回东方财富 404 页面。
  市面上仍有教程在传这个地址，已不可用；插件因此不提供盘中估值。
- **这不代表东财整体不能用**：Kimi 的 `automation.py` 走的是 `api.fund.eastmoney.com/f10/lsjz`（历史净值），
  该接口仍然正常，也是本插件在用的同一个；`fundgz` 只是另一个估值接口，两者不是一回事。
- `fund.eastmoney.com/pingzhongdata/<code>.js` 仍可用（约 600 KB 全量数据），但体积不适合高频刷新，
  本插件未接入。

### 字段索引

实时行情：`[1]` 名称、`[2]` 完整代码、`[3]` 现价、`[4]` 昨收、`[5]` 今开、
`[30]` 时间、`[31]` 涨跌、`[32]` 涨跌幅、`[33]` 最高、`[34]` 最低。

日 K 数组：`[0]` 日期、`[1]` 开、`[2]` 收、`[3]` 高、`[4]` 低、`[5]` 量。**顺序是开收高低**。

### secid 规则（东财分时）

| 市场 | secid |
| --- | --- |
| 沪市 | `1.600519` |
| 深市 / 北交所 | `0.000001` |
| 美股 | `105.AAPL`（NASDAQ）/ `106.IBM`（NYSE）/ `107.*`（AMEX），按行情后缀判定 |
| 港股 | `116.00700` |

## 存储

全部数据在插件私有存储（`app_plugin_values` 表），不上传：

| key | 内容 |
| --- | --- |
| `funds.v1` | `[{ code, name, tag }]` |
| `stocks.v1` | `[{ symbol, name, group }]` |
| `crypto.v1` | `[{ symbol, name, group }]`（如 `BTCUSDT`） |
| `holdings.v1` | `{ "fund:110020": { size, avgCost, realizedPnl }, "stock:sh600519": { ... } }` |
| `library.v1` | `[{ id, title, type, url, content, tags, createdAt, updatedAt }]` |
| `settings.v1` | `{ autoRefresh, fundRange, stockRange, chartMode, colorMode }` |

## 已知边界

- **面板没有后台常驻**：关闭面板后轮询停止；盘中提醒需要另配应用的定时任务。
- `api.net.fetch` 响应体上限 5 MB、超时上限 120 秒，本插件统一用 12 秒。
- 公募基金每日公布一次净值（QDII 通常滞后一个交易日），**没有盘中估值**（接口已失效）。
- 交易账本是**本地账面计算**：不处理分红、拆分、汇兑差异；卖出按加权均价结转，不做 FIFO 批次。
- 分时为东财单日数据（约 1 分钟粒度），不含盘前集合竞价的完整明细；美股按美东交易日返回。
- 列表行不画迷你图：那会为每行各拉一次历史，请求量翻十倍。

## 上架插件市场

打包与索引提交流程见 `docs/market-submission.md`。

```powershell
pwsh -File scripts/package.ps1
```

产物 `dist/snow-stock-panel-<version>.zip`，`plugin.json` 位于 zip 根目录，并打印 SHA-256。

## 开发

入口被宿主整体读取并作为 ES 模块执行，**相对 `import` 与裸模块名都无法解析**。因此：

- 不引入任何 `import`；React 用 `window.SnowAppPlugin.React`，只在组件渲染期访问；
- 图表自己用 SVG 画（`SparkChart` / `CandleChart`），不引第三方图表库；
- 单文本文件上限 8 MB、安装目录上限 128 MB；
- 改完源码后需在插件列表点一次「从目录安装」覆盖，宿主运行的是 `~/.snowapp/plugins/` 里的副本。

## 许可

MIT，见 `LICENSE`。

