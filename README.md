[English](#english) | [中文](#中文)

---

<a id="english"></a>

# GLM Coding Plan Sniper

Auto-purchase script for Zhipu's GLM Coding Plan — automatically places orders at 10:00 AM daily.

## Why

GLM Coding Plan releases limited stock at 10:00 AM (UTC+8) daily and sells out within seconds. This script automates the entire flow: intercept sold-out status -> click purchase -> confirm order. All you need to do is scan the QR code to pay.

## Features

- **Sold-out Bypass** — Intercepts `soldOut` flags during the purchase window (9:59 ~ 10:05) to enable buttons
- **Plan Selection** — Defaults to Pro + Quarterly billing (configurable)
- **Precision Timing** — Auto-clicks the purchase button at 10:00:00 with 100ms retry interval
- **Auto Confirm** — Automatically clicks confirm/pay buttons in popups
- **QR Detection** — Plays an alert sound when the payment QR code appears
- **Overlay UI** — Real-time countdown and log displayed in the top-right corner
- **Auto Refresh** — Refreshes the page at 9:59:50 to fetch the latest state

## Two Versions

| File | Description |
|------|-------------|
| `glm-coding-sniper.user.js` | **Tampermonkey userscript** — runs automatically after installation (recommended) |
| `glm-coding-sniper-console.js` | **Browser console version** — paste into F12 Console, fallback when Tampermonkey is unavailable |

## Usage

### Tampermonkey (Recommended)

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
  targetPlan: 'pro',     // 'lite' | 'pro' | 'max'
  targetHour: 10,        // target hour
  targetMinute: 0,       // target minute
  advanceMs: 200,        // ms to start early (compensate network latency)
  retryInterval: 100,    // retry interval in ms
  maxRetries: 50,        // max retry attempts
};
```

## Important Notes

- **Buttons stay disabled outside the purchase window** — sold-out interception only activates during 9:59~10:05
- **Don't open multiple tabs** — one is enough, more tabs cause lag
- **Have your payment app ready** — QR codes expire quickly
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

- **售罄状态拦截** — 在抢购窗口期（9:59 ~ 10:05）自动将 `soldOut` 改为 `false`，让按钮可点击
- **自动选择套餐** — 默认选择 Pro + 连续包季（可在 CONFIG 中修改）
- **精准定时** — 10:00:00 自动点击购买按钮，100ms 间隔重试
- **自动确认** — 自动点击弹窗中的确认/支付按钮
- **二维码检测** — 检测到支付二维码后播放提示音
- **悬浮窗** — 右上角实时显示倒计时和运行日志
- **自动刷新** — 9:59:50 自动刷新页面获取最新状态

## 两个版本

| 文件 | 说明 |
|------|------|
| `glm-coding-sniper.user.js` | **Tampermonkey 油猴脚本**，安装后自动运行，推荐使用 |
| `glm-coding-sniper-console.js` | **浏览器控制台版**，直接粘贴到 F12 Console 运行，Tampermonkey 不可用时的备选 |

## 使用方法

### Tampermonkey 版（推荐）

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
  targetPlan: 'pro',     // 'lite' | 'pro' | 'max'
  targetHour: 10,        // 抢购小时
  targetMinute: 0,       // 抢购分钟
  advanceMs: 200,        // 提前多少ms开始（补偿网络延迟）
  retryInterval: 100,    // 重试间隔ms
  maxRetries: 50,        // 最大重试次数
};
```

## 注意事项

- **非抢购时段点击无效** — 售罄拦截只在 9:59~10:05 窗口期生效，其他时间按钮保持原样
- **不要开多个标签页** — 一个就够，多了浏览器卡反而慢
- **提前准备支付** — 把支付宝/微信打开，二维码有效期很短
- **脚本只改前端** — 后端库存校验不受影响，抢不到说明确实没货了

## 替代方案

如果连续多天抢不到，考虑：

- **国际版** [z.ai](https://z.ai/subscribe) — 不限购，AFF + 包年折扣后价格接近国内
- **阿里云百炼** — 可直接按量调用 GLM-5.1，每日 9:30 补货

## License

MIT
