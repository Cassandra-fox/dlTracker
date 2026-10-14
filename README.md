# DL Price Tracker

在 DLsite 作品页与收藏列表显示历史最低价，并主动管理本地追踪作品。使用 Manifest V3、TypeScript、Vite、idb、dayjs 和原生 DOM。

## 业务规则

- 本地追踪独立于 DLsite 收藏；导入只追加，站点取消收藏不会删除本地记录。
- 管理页支持单条、选中项、全部更新，以及失败项重试。
- 追踪作品的历史最低价只由用户主动更新，不受 24 小时 TTL 清理影响。没有价格的作品也会展示。
- 普通浏览记录使用 24 小时缓存；已过期的普通缓存可以清理。
- 同编号的远程请求合并，所有后台 DLwatcher 请求共享最多 10 并发，并采用每秒最多启动 10 次的保守节流。
- 成功、无有效价格、请求失败分别统计；每项结果独立提交。失败不会清空已有价格。
- 历史最低价只降不升，对应原价和折扣随同一价格快照保留。
- 备注支持编辑、清空，最多 1000 个 Unicode 码点；更新价格和重复导入不会覆盖备注。
- 删除追踪会删除备注，已有价格作为普通缓存保留，且不会延长原缓存期限；以后可以重新导入。
- CSV 只导出追踪作品，包含备注、状态和最近成功更新时间。

## 收藏导入

当前版本使用现有的 `#wishlist_work article` 收藏卡片结构，按钮明确标记“导入当前页”。支持页面展示 30、50、100 条的情形，不扫描推荐区域。

单次最多 300 个去重后的作品，超过时可继续导入剩余批次；全部本地追踪数量不设上限。翻到下一页后再次导入即可追加。空结果不会改变已有数据。

尚未验证 DLsite 收藏 API 的分页参数、总数及基础编号映射，因此不使用该 API 自动读取全部收藏。

更新本地扩展文件后，请先在 `chrome://extensions` 或 `edge://extensions` 中重新加载 DLTracker，再刷新已打开的 DLsite 收藏页。仅刷新网页可能让新页面脚本与旧后台混用：旧后台读取 `rjCodes.filter(...)`，新版发送 `products`，因此会报 `Cannot read properties of undefined (reading 'filter')`。新版导入前会检查后台协议，不兼容时停止导入并提示重新加载，不回退到旧版导入逻辑；不需要清除数据库。

## 作品链接

支持 RJ、BJ、VJ；编号统一大写。频道取自合法作品 URL，不根据编号前缀猜测，也不限制为固定频道列表。价格请求共用：

`https://dlwatcher.com/product/{productId}.json`

接受 HTTPS 的 `www.dlsite.com/{category}/work/=/product_id/{productId}.html` 链接，允许查询参数及尾部斜杠。路径编号优先，翻译版查询参数不改变作品身份。各频道 DOM 选择器保留原项目逻辑。

## 本地开发与检查

建议使用 Node.js 22.20 或更新的兼容版本：

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

测试使用 Node 测试运行器、tsx、内存 IndexedDB 和模拟 DOM，不访问个人浏览器数据库或真实站点。生产构建位于 `dist/`，在 Chrome/Edge 的扩展管理页启用开发者模式后加载该目录。

构建自动执行类型检查，并核对生成 Manifest 的版本与资源引用。图标通过 `src/assets/icons` 的静态资源路径复制。插件默认的远程 Manifest Schema 下载没有超时，因此关闭该在线校验，以保证离线构建可完成；Manifest 仍接受 TypeScript 类型检查、本地资源检查与真实浏览器加载验证。

生产包浏览器冒烟测试（先执行构建）：

```powershell
node scripts/browser-smoke.mjs 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/browser-smoke.mjs 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

脚本使用独立的 `test-results/profile-*` 配置目录，模拟 DLwatcher 响应，不读取个人浏览器数据。它验证生产扩展加载、真实 IndexedDB、备注保存、部分结果提交后强制终止 Worker、重启后数据保留、删除、统计及 CSV，并保存管理页截图。该脚本需要支持 `Extensions.loadUnpacked` 调试协议的较新浏览器；此限制仅属于测试工具，不是扩展的最低版本要求。

2026-10-15 已通过 41 项回归测试（包括导入协议不兼容、失效页面上下文和正常导入流程），以及 Chrome 155.0.8059.40、Edge 155.0.4283.45 的上述冒烟测试。Chromium 116 为 API 兼容性评估基线，未在该旧版本运行实机测试；Manifest 未增加最低版本限制。实际 DLsite 页面与远程 API 响应仍需结合真实站点验收。

## 数据与中断

数据库版本为 3，仍使用 `prices`、`favorites`、`settings` 三张表及原有 `rjCode` 主键。`favorites` 现在代表本地追踪关系，是列表与统计的唯一权威来源；`isFavorite` 仅保留为兼容镜像。

升级保留旧有效价格，并初始化备注、追踪标识及缺失价格记录。旧 `lastChecked` 可能曾记录失败，不能准确还原成功时间，因此不会伪造最近成功更新时间。不要删库重建；升级后的数据库不能直接用只支持 v2 的旧程序打开。

批量任务只在当前 Worker 内存中运行，没有持久化队列、自动续跑或 alarms。Worker 终止后已提交结果仍在；界面会提示任务不可继续查询，用户可以主动重新更新。保活只是有限运行期的辅助，不能保证 Worker 常驻。

## 手动验收

- Chrome 和 Edge 加载生产包，确认图标、Popup、管理页与 Content Script 正常。
- 在实际站点检查原有价格及收藏卡片 DOM；不同频道若使用不同 DOM，本版不会自动猜测选择器。
- 收藏分页导入、备注编辑、选中更新、删除、CSV 导出。
- 在更新期间终止 Worker，重新打开页面，确认已保存数据保留且没有自动续跑。
- 模拟网络中断及 429；失败可重试，旧价格和备注保留。

价格来自 DLwatcher，作品编号会随查价请求发送给该站点；备注仅保存在扩展本地。
