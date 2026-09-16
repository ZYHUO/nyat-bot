# Mini App UI 重构 — macOS Terminal 风格

> 参考 Gloria Shop (https://shop.ciii.club/) 的 macOS 窗口 UI 风格重构 xxb-ts Mini App。

---

## 设计语言

**核心元素（来自 Gloria Shop）：**
- macOS 窗口外壳：titlebar + traffic lights（红绿灯按钮）+ 窗口阴影
- 暗色主题为主，支持 light mode
- CSS 变量驱动的主题系统
- 圆角卡片、微妙边框、柔和阴影
- 步骤式流程指示器
- 紧凑的信息密度

**适配 xxb-ts 的调整：**
- 保留 macOS 窗口外壳，但内容改为 bot 管理面板
- 底部 tab bar 改为窗口内的侧边栏或顶部 tab
- 猫娘主题色（粉色/紫色 accent 替代红色）
- Telegram WebApp 适配（深色模式跟随 TG 主题）

---

## 当前功能清单（必须保留）

| Tab | 功能 | 组件 |
|-----|------|------|
| 申请 | 提交入群申请、查看我的申请 | App.vue 内联 |
| 审核 | 待审核列表、AI 审核、批准/拒绝、群管理 | AdminReviewPanel.vue |
| 设置 | 模型路由配置、Sticker 策略、运行时配置 | ModelRoutingPanel.vue |
| 状态 | 健康检查、模型状态 | HealthStatusPanel.vue + ModelStatusBar.vue |

---

## Task 1: 新建 CSS 主题系统

**Files:** Create `miniapp-web/src/assets/theme.css`

- [ ] **Step 1:** 从 Gloria Shop 提取 CSS 变量系统（`--bg`, `--fg`, `--accent`, `--border` 等）
- [ ] **Step 2:** 调整 accent 色为猫娘主题（`--accent: #c084fc` 紫色 或 `--accent: #f472b6` 粉色）
- [ ] **Step 3:** 实现 macOS 窗口组件样式（`.window`, `.titlebar`, `.traffic-lights`, `.dot`）
- [ ] **Step 4:** 实现 Telegram WebApp 主题适配（读取 `window.Telegram.WebApp.themeParams`）

---

## Task 2: 重构布局为 macOS 窗口

**Files:** Modify `miniapp-web/src/App.vue`

- [ ] **Step 1:** 外层包裹 `.window-container` > `.terminal-window`
- [ ] **Step 2:** titlebar 区域：traffic lights + "啾咪囝 Admin" 标题 + 用户信息
- [ ] **Step 3:** 窗口内顶部 tab 栏（替代底部 tab bar），样式参考 Gloria Shop 的步骤指示器
- [ ] **Step 4:** 内容区域使用 `.card-bg` 卡片布局

---

## Task 3: 重构申请页

**Files:** Modify `miniapp-web/src/App.vue`（申请部分）

- [ ] **Step 1:** 输入框样式改为 macOS 风格（圆角、暗色背景、微妙边框）
- [ ] **Step 2:** 申请列表改为卡片式布局
- [ ] **Step 3:** 状态标签（待审核/已通过/已拒绝）用彩色 badge

---

## Task 4: 重构审核页

**Files:** Modify `miniapp-web/src/components/AdminReviewPanel.vue`

- [ ] **Step 1:** 审核列表改为卡片式，每个申请一张卡片
- [ ] **Step 2:** 操作按钮组改为 macOS 风格按钮
- [ ] **Step 3:** AI 审核结果用折叠面板展示
- [ ] **Step 4:** 群管理列表用表格卡片

---

## Task 5: 重构设置页

**Files:** Modify `miniapp-web/src/components/ModelRoutingPanel.vue`

- [ ] **Step 1:** 模型路由配置改为卡片式表单
- [ ] **Step 2:** Sticker 策略用开关 + 下拉选择
- [ ] **Step 3:** 运行时配置用 toggle 开关

---

## Task 6: 重构状态页

**Files:** Modify `miniapp-web/src/components/HealthStatusPanel.vue`, `ModelStatusBar.vue`

- [ ] **Step 1:** 健康状态用 macOS 风格的状态指示器（绿点/红点）
- [ ] **Step 2:** 模型状态用进度条或状态卡片
- [ ] **Step 3:** 延迟数据用 sparkline 或简单图表

---

## Task 7: 构建 + 部署

- [ ] **Step 1:** `cd miniapp-web && npm run build`
- [ ] **Step 2:** 复制构建产物到 `miniapp/`
- [ ] **Step 3:** 验证 Telegram WebApp 内显示正常

---

## 技术约束

- 保持 Vue 3 + Vite 技术栈不变
- 不引入新的 UI 框架（纯 CSS）
- 所有 API 调用逻辑不变，只改 UI 层
- 移动端优先（Telegram WebApp 主要在手机上用）
- 保持 HMAC 认证流程不变
