# website/ — 落地页

`index.html` 是**单文件**落地页：无构建、无依赖、无外部请求（字体走系统栈），
直接传到任何静态托管就能用。

```bash
# 本地看
python3 -m http.server -d website 8000     # → http://localhost:8000

# 或者直接发文件给对方
open website/index.html
```

## 挂到 GitHub Pages

仓库 Settings → Pages → Source 选 "Deploy from a branch" → Branch `main` +
folder `/website`。之后 `https://<user>.github.io/nyat-bot/` 就是这个页面。

## 内容口径

页面上每个数字都来自仓库或生产日志，**没有营销话术**：

- 165k 行 / 400+ commit / MIT —— `git ls-files '*.ts' | xargs wc -l` 和 `git rev-list --count`
- 心流裁决 10k+ 次 P50 4.8s —— `npm run measure:voice`（或直接数 `Heart decision`）
- 回复率 8.2/百条 —— 同上

改页面时保持这个口径：**能对上才是真的**。这个仓库的 CONTRIBUTING 第 3 条
就是"文档说它会跑，它就得会跑"。
