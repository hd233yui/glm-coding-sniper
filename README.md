> **⚠️ NOTICE / 提示：This script is still in testing phase. Use at your own risk. / 当前脚本仍处于测试阶段，使用风险自负。**

[English](#english) | [中文](#中文)

---

<a id="english"></a>

# GLM Coding Plan Sniper

Auto-purchase script for Zhipu's GLM Coding Plan — automatically places orders at 10:00 AM daily.

## Why

GLM Coding Plan releases limited stock at 10:00 AM (UTC+8) daily and sells out within seconds. This script automates the entire flow: intercept sold-out status -> click purchase -> confirm order. All you need to do is scan the QR code to pay.

## Features

- **Sold-out Bypass** — Intercepts `soldOut` flags during the purchase window (9:59 ~ 10:30) to enable buttons
- **Plan Selection** — Defaults to Pro + Quarterly billing (configurable via `targetPlan` and `billingPeriod`)
- **Precision Timing** — Auto-clicks the purchase button at 10:00:00 with 100ms retry interval, up to 300 retries (30 seconds per round)
- **Auto Confirm** — Automatically clicks confirm/pay buttons in popups
- **QR Detection** — Plays an alert sound when the payment QR code appears
- **Overlay UI** — Real-time countdown, log, and payment safety warning displayed in the top-right corner
- **Auto Refresh** — Refreshes the page at 9:59:50 to fetch the latest state
- **API Auto-Retry** — Automatically retries failed fetch/XHR requests (429/500/502/503) up to 8 times with incremental delay
- **Smart Modal Protection** — Detects CAPTCHA and payment modals by content (not just CSS class), freezes all refresh logic to protect them; auto-resumes when modal disappears
- **Auto Re-trigger** — After each retry round or page recovery, automatically re-triggers the purchase flow (no manual intervention needed throughout 10:30)
- **Error Page Recovery** — Three-tier recovery when the page shows "too many visitors":
  1. DOM-level suppression: hides the error and re-triggers SPA data loading via `pushState`/`popstate`
  2. Full page refresh with cache-busting as fallback
  3. Recovery window covers 10:30, ensuring continued retries

## Two Versions

| File | Description |
|------|-------------|
| `glm-coding-sniper.user.js` | **Tampermonkey userscript** — runs automatically after installation (recommended) |
| `glm-coding-sniper-console.js` | **Browser console version** — paste into F12 Console, fallback when Tampermonkey is unavailable (now feature-complete with Tampermonkey version) |

## Usage

### Tampermonkey (Recommended)

**One-click install:** Install [Tampermonkey](https://www.tampermonkey.net/) first, then click 👉 [**Install Script**](https://github.com/hd233yui/glm-coding-sniper/raw/master/glm-coding-sniper.user.js) — Tampermonkey will automatically pop up the install page.

Or install manually:

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Enable **Developer Mode** in Chrome (`chrome://extensions`, top-right toggle)
3. Create a new script in Tampermonkey, paste the contents of `glm-coding-sniper.user.js`, and save
4. Open https://open.bigmodel.cn/glm-coding around **9:55 AM** and make sure you're logged in
5. A black overlay in the top-right corner = script is running
6. **Do not click any buttons manually — let the script handle it**
7. When you hear the beep, scan the QR code to pay immediately

### Console Version

1. Open the purchase page around **9:59 AM** and log in
2. Press `F12` -> Console tab
3. Paste the entire contents of `glm-coding-sniper-console.js` and press Enter
4. Overlay appears = success (**you'll need to re-paste after any page refresh**)

## Configuration

Edit the `CONFIG` object at the top of the script:

```javascript
const CONFIG = {
  targetPlan: 'pro',           // 'lite' | 'pro' | 'max'
  billingPeriod: 'quarterly',  // 'monthly' | 'quarterly' | 'yearly'
  targetHour: 10,              // target hour
  targetMinute: 0,             // target minute
  advanceMs: 200,              // ms to start early (compensate network latency)
  retryInterval: 100,          // retry interval in ms
  maxRetries: 300,             // max retry attempts per round (300 * 100ms = 30s)
};
```

## How It Works

This script **does not call backend APIs directly**. It automates button clicks on the page — all requests are sent by the page's own frontend framework.

```
Page loads → Intercept soldOut to enable buttons → Auto-click "Subscribe" at 10:00
→ Auto-click confirm popup → CAPTCHA appears (manual) → QR code appears → Scan to pay
```

If the purchase attempt times out (30 seconds), the script resets and waits for the page to recover, then automatically re-triggers — this cycle repeats throughout 10:30.

If the page shows "too many visitors" error, the script handles it in layers:

```
API returns 429/5xx → fetch/XHR auto-retry (up to 8 times, incremental delay)
→ If error page still renders → DOM suppression (hide error + pushState re-trigger)
→ If still broken → full page refresh with cache-busting (every 2s, until 10:30)
```

If a CAPTCHA or payment modal appears, the script detects it by content (verification/payment keywords) and freezes all refresh logic to protect it. Once the modal disappears, auto-purchasing resumes.

**The script cannot bypass CAPTCHAs.** If a slider or image verification appears after clicking the purchase button, you need to complete it manually. The script's value is:

1. **Speed** — clicks at exactly 10:00:00, hundreds of ms faster than a human
2. **Fewer steps** — auto-selects billing period, auto-clicks purchase and confirm, you only handle CAPTCHA + payment
3. **Anti-cache** — intercepts `soldOut` flags so buttons don't stay grayed out due to stale frontend state
4. **Resilience** — automatically recovers from "too many visitors" errors without manual intervention

## Important Notes

- **Buttons stay disabled outside the purchase window** — sold-out interception only activates during 9:59~11:00
- **Don't open multiple tabs** — one is enough, more tabs cause lag
- **Have your payment app ready** — QR codes expire quickly
- **Don't pay if the order shows no amount** — if the payment QR appears without a price, do not scan it
- **Frontend only** — backend inventory validation is unaffected; if it's truly out of stock, the script can't help

## Alternatives

If you can't get it after multiple days:

- **International version** [z.ai](https://z.ai/subscribe) — no purchase limits, AFF + annual discount brings the price close to domestic
- **Alibaba Cloud Bailian** — call GLM-5.1 directly on-demand, restocks daily at 9:30 AM

## License

MIT

---

<a id="中文"></a>

[English](#english) | [中文](#中文)

# GLM Coding Plan 自动抢购脚本

智谱 GLM Coding Plan 自动抢购脚本，每天 10:00 自动下单。

## 为什么需要

GLM Coding Plan 每天 10:00 限量放货，几秒售罄，纯手动根本抢不到。此脚本自动完成"拦截售罄状态 -> 点击购买 -> 确认订单"全流程，你只需扫码付款。

## 功能

- **售罄状态拦截** — 在抢购窗口期（9:59 ~ 10:30）自动将 `soldOut` 改为 `false`，让按钮可点击
- **自动选择套餐** — 默认选择 Pro + 连续包季（可通过 `targetPlan` 和 `billingPeriod` 配置）
- **精准定时** — 10:00:00 自动点击购买按钮，100ms 间隔重试，每轮最多 300 次（30秒）
- **自动确认** — 自动点击弹窗中的确认/支付按钮
- **二维码检测** — 检测到支付二维码后播放提示音
- **悬浮窗** — 右上角实时显示倒计时、运行日志和付款安全提示
- **自动刷新** — 9:59:50 自动刷新页面获取最新状态
- **API 自动重试** — fetch/XHR 请求遇到 429/500/502/503 自动重试最多 8 次，递增延迟
- **智能弹窗保护** — 通过内容（而非 CSS 类名）检测验证码/支付弹窗，出现时冻结所有刷新逻辑；弹窗消失后自动恢复
- **自动重新触发** — 每轮重试结束或页面恢复后自动重新发起抢购，10:30无需手动干预
- **错误页面自动恢复** — "访问人数较多"三级恢复策略：
  1. DOM 级抑制：隐藏错误内容，通过 `pushState`/`popstate` 触发 SPA 重新加载数据
  2. 全页面强制刷新（带 cache-busting 参数）兜底
  3. 恢复窗口覆盖10:30，确保持续重试

## 两个版本

| 文件 | 说明 |
|------|------|
| `glm-coding-sniper.user.js` | **Tampermonkey 油猴脚本**，安装后自动运行，推荐使用 |
| `glm-coding-sniper-console.js` | **浏览器控制台版**，直接粘贴到 F12 Console 运行，Tampermonkey 不可用时的备选（已与油猴版功能同步） |

## 使用方法

### Tampermonkey 版（推荐）

**一键安装：** 先安装 [Tampermonkey](https://www.tampermonkey.net/)，然后点击 👉 [**安装脚本**](https://github.com/hd233yui/glm-coding-sniper/raw/master/glm-coding-sniper.user.js) — Tampermonkey 会自动弹出安装页面。

或手动安装：

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 确保 Chrome 已开启**开发者模式**（`chrome://extensions` 右上角）
3. 在 Tampermonkey 中创建新脚本，粘贴 `glm-coding-sniper.user.js` 的内容，保存
4. **9:55** 左右打开 https://open.bigmodel.cn/glm-coding ，确保已登录
5. 右上角出现黑色悬浮窗 = 脚本运行中
6. **不要手动点任何按钮，等脚本自动操作**
7. 听到"嘟嘟嘟"提示音后立即扫码付款

### 控制台版

1. **9:59** 打开购买页面并登录
2. 按 `F12` -> Console 标签
3. 粘贴 `glm-coding-sniper-console.js` 全部内容，回车
4. 看到悬浮窗 = 成功（**刷新页面后需重新粘贴**）

## 配置

修改脚本顶部 `CONFIG` 对象：

```javascript
const CONFIG = {
  targetPlan: 'pro',           // 'lite' | 'pro' | 'max'
  billingPeriod: 'quarterly',  // 'monthly' | 'quarterly' | 'yearly'
  targetHour: 10,              // 抢购小时
  targetMinute: 0,             // 抢购分钟
  advanceMs: 200,              // 提前多少ms开始（补偿网络延迟）
  retryInterval: 100,          // 重试间隔ms
  maxRetries: 300,             // 每轮最大重试次数（300次 * 100ms = 30秒）
};
```

## 工作原理

脚本**不会直接调用后端 API**，本质上就是替你点按钮，所有请求都由页面前端框架发出。

```
页面加载 → 拦截 soldOut 让按钮可点 → 10:00 自动点"特惠订阅"
→ 自动点确认弹窗 → 弹出验证码（需手动完成）→ 弹出支付二维码 → 扫码付款
```

如果本轮重试超时（30秒），脚本会自动重置状态并等待页面恢复后重新触发，10:30持续循环。

如果页面显示"当前访问人数较多"，脚本会分层处理：

```
API 返回 429/5xx → fetch/XHR 自动重试（最多8次，递增延迟）
→ 错误页面仍然渲染 → DOM 级抑制（隐藏错误 + pushState 触发重新加载）
→ 仍然异常 → 全页面强刷（每2秒，带时间戳绕缓存，持续到10:30）
```

如果出现验证码或支付弹窗，脚本通过内容关键词（验证/滑动/支付等）检测，冻结所有刷新逻辑以保护弹窗；弹窗消失后自动恢复抢购。

**脚本无法绕过验证码。** 如果点击购买按钮后弹出滑块或图形验证，需要你手动完成。脚本的价值在于：

1. **抢时间** — 10:00:00 精准点击，比手动快几百毫秒
2. **省操作** — 自动选包季、自动点购买、自动点确认，你只管过验证码 + 扫码付款
3. **防缓存** — 拦截 `soldOut` 状态，防止按钮因前端缓存显示灰色
4. **抗限流** — "访问人数较多"自动恢复，无需手动刷新

## 注意事项

- **非抢购时段点击无效** — 售罄拦截只在 9:59~11:00 窗口期生效，其他时间按钮保持原样
- **不要开多个标签页** — 一个就够，多了浏览器卡反而慢
- **提前准备支付** — 把支付宝/微信打开，二维码有效期很短
- **订单无金额不要付款** — 如果支付二维码出现但订单没有显示金额，请不要扫码
- **脚本只改前端** — 后端库存校验不受影响，抢不到说明确实没货了

## 替代方案

如果连续多天抢不到，考虑：

- **国际版** [z.ai](https://z.ai/subscribe) — 不限购，AFF + 包年折扣后价格接近国内
- **阿里云百炼** — 可直接按量调用 GLM-5.1，每日 9:30 补货

## License

MIT
