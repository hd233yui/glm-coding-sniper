// ==UserScript==
// @name         GLM Coding Plan Pro 自动抢购
// @namespace    https://bigmodel.cn
// @version      1.0.0
// @description  每天10:00自动抢购GLM Coding Plan Pro套餐，拦截售罄状态+自动点击+自动重试
// @author       qiandai
// @match        https://open.bigmodel.cn/*
// @match        https://www.bigmodel.cn/*
// @match        https://bigmodel.cn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    // 目标套餐: 'lite' | 'pro' | 'max'
    targetPlan: 'pro',
    // 计费周期: 'monthly' | 'quarterly' | 'yearly'
    billingPeriod: 'quarterly',
    // 抢购时间 (24小时制)
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0,
    // 提前多少毫秒开始点击 (补偿网络延迟)
    advanceMs: 200,
    // 点击重试间隔(ms)
    retryInterval: 100,
    // 最大重试次数
    maxRetries: 50,
    // 是否自动刷新页面 (在9:59:50自动刷新一次以获取最新状态)
    autoRefresh: true,
    autoRefreshSecondsBefore: 10,
  };

  // ==================== 状态 ====================
  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    timerId: null,
    countdownId: null,
  };

  // ==================== 1. 拦截 JSON.parse，修改售罄状态 ====================
  // 只在 10:00 前1分钟内才拦截，避免非抢购时段产生无效订单
  function isNearTargetTime() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = target - now;
    // 前1分钟 到 后15分钟 的窗口期内才拦截
    return diff <= 60000 && diff >= -900000;
  }

  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    let result = originalParse.apply(this, args);
    try {
      if (isNearTargetTime()) {
        result = deepModifySoldOut(result);
      }
    } catch (e) {
      // 静默失败，不影响页面正常功能
    }
    return result;
  };

  function deepModifySoldOut(obj) {
    if (obj === null || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(deepModifySoldOut);
    }

    for (const key of Object.keys(obj)) {
      if (
        key === 'isSoldOut' ||
        key === 'soldOut' ||
        key === 'is_sold_out' ||
        key === 'sold_out'
      ) {
        if (obj[key] === true) {
          obj[key] = false;
          log(`[拦截] 将 ${key} 从 true 改为 false`);
        }
      }
      // 递归处理嵌套对象
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        obj[key] = deepModifySoldOut(obj[key]);
      }
    }
    return obj;
  }

  // ==================== 2. 拦截 fetch + XHR (自动重试 + soldOut修改) ====================

  // --- 2a. fetch 拦截 ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    let response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // 抢购窗口内，失败请求自动重试
    if (isNearTargetTime() && [429, 500, 502, 503].includes(response.status)) {
      for (let retry = 1; retry <= 8; retry++) {
        console.log(`[GLM Sniper] fetch ${response.status}，重试${retry}: ${url}`);
        await new Promise(r => setTimeout(r, 300 * retry));
        try {
          response = await originalFetch.apply(this, args);
          if (response.ok) { console.log('[GLM Sniper] fetch 重试成功!'); break; }
        } catch (e) {}
      }
    }

    // soldOut 拦截
    if (!isNearTargetTime()) return response;
    if (/coding|plan|order|subscribe|product|package/i.test(url)) {
      try {
        const text = await response.clone().text();
        const modified = text
          .replace(/"isSoldOut"\s*:\s*true/g, '"isSoldOut":false')
          .replace(/"soldOut"\s*:\s*true/g, '"soldOut":false')
          .replace(/"is_sold_out"\s*:\s*true/g, '"is_sold_out":false')
          .replace(/"sold_out"\s*:\s*true/g, '"sold_out":false');
        if (modified !== text) log('[拦截] 已修改 fetch 响应中的售罄状态');
        return new Response(modified, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) { return response; }
    }
    return response;
  };

  // --- 2b. XMLHttpRequest 拦截 (覆盖不走 fetch 的请求) ---
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._sniperUrl = url;
    this._sniperMethod = method;
    this._sniperArgs = null;
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this._sniperArgs = args;
    if (isNearTargetTime()) {
      this.addEventListener('load', function xhrRetryHandler() {
        if ([429, 500, 502, 503].includes(this.status)) {
          console.log(`[GLM Sniper] XHR ${this.status}，1s后重试: ${this._sniperUrl}`);
          const self = this;
          setTimeout(() => {
            // 用原始方法重新打开并发送
            _xhrOpen.call(self, self._sniperMethod, self._sniperUrl, true);
            _xhrSend.apply(self, self._sniperArgs || []);
          }, 1000);
        }
      });
    }
    return _xhrSend.apply(this, args);
  };

  // --- 2c. 错误页面 DOM 抑制：检测到错误渲染时隐藏并触发重新加载数据 ---
  function setupErrorSuppressor() {
    if (!document.body) {
      setTimeout(setupErrorSuppressor, 200);
      return;
    }

    new MutationObserver(() => {
      if (!isNearTargetTime()) return;

      const bodyText = document.body.textContent || '';
      if (!bodyText.includes('访问人数较多') && !bodyText.includes('请刷新重试') && !bodyText.includes('服务繁忙')) return;

      // 找到包含错误信息的容器并隐藏
      const errorNodes = document.querySelectorAll('div, section, p');
      for (const node of errorNodes) {
        const t = node.textContent || '';
        if ((t.includes('访问人数较多') || t.includes('请刷新重试')) && node.offsetHeight > 50) {
          // 不删除节点（避免SPA报错），只是隐藏
          node.style.display = 'none';
          console.log('[GLM Sniper] 隐藏错误页面，触发重新加载...');

          // 通过 SPA 路由重新触发数据加载
          setTimeout(() => {
            // 方法1: pushState 触发 popstate
            const currentUrl = window.location.href;
            window.history.pushState(null, '', currentUrl);
            window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
          }, 500);

          setTimeout(() => {
            // 方法2: 如果 popstate 没用，用 hashchange
            const hash = window.location.hash;
            window.location.hash = hash + '_retry';
            setTimeout(() => { window.location.hash = hash; }, 100);
          }, 1500);

          break;
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ==================== 3. UI 覆盖层 ====================
  function createOverlay() {
    // 等待 body 存在 (SPA 框架可能延迟创建)
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createOverlay);
      } else {
        // body 还没出现，轮询等待
        setTimeout(createOverlay, 100);
      }
      return;
    }

    // 避免重复创建
    if (document.getElementById('glm-sniper-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'glm-sniper-overlay';
    overlay.innerHTML = `
      <div style="
        position: fixed;
        top: 10px;
        right: 10px;
        z-index: 999999;
        background: rgba(0, 0, 0, 0.85);
        color: #00ff88;
        padding: 16px 20px;
        border-radius: 12px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 14px;
        min-width: 280px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(0, 255, 136, 0.3);
      ">
        <div style="font-size: 16px; font-weight: bold; margin-bottom: 8px;">
          GLM Coding Plan Sniper
        </div>
        <div id="glm-target" style="color: #ffcc00; margin-bottom: 4px;">
          目标: ${CONFIG.targetPlan.toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[CONFIG.billingPeriod]||'包季'}
        </div>
        <div id="glm-countdown" style="font-size: 20px; margin: 8px 0; color: #fff;">
          --:--:--
        </div>
        <div id="glm-status" style="color: #aaa; font-size: 12px;">
          等待初始化...
        </div>
        <div id="glm-log" style="
          margin-top: 8px;
          max-height: 120px;
          overflow-y: auto;
          font-size: 11px;
          color: #888;
          border-top: 1px solid rgba(255,255,255,0.1);
          padding-top: 8px;
        "></div>
      </div>
    `;
    document.body.appendChild(overlay);

    startCountdown();
  }

  function log(msg) {
    console.log(`[GLM Sniper] ${msg}`);
    const logEl = document.getElementById('glm-log');
    if (logEl) {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      logEl.innerHTML =
        `<div>${time} ${msg}</div>` + logEl.innerHTML;
      // 限制日志条数
      if (logEl.children.length > 20) {
        logEl.removeChild(logEl.lastChild);
      }
    }
  }

  function setStatus(msg, color = '#aaa') {
    const el = document.getElementById('glm-status');
    if (el) {
      el.textContent = msg;
      el.style.color = color;
    }
  }

  // ==================== 4. 倒计时 ====================
  function getTargetTime() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);

    // 如果今天已过目标时间，设为明天
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  function startCountdown() {
    const update = () => {
      const now = new Date();
      const target = getTargetTime();
      const diff = target - now;

      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      const ms = diff % 1000;

      const el = document.getElementById('glm-countdown');
      if (el) {
        if (diff <= 60000) {
          // 最后60秒显示毫秒
          el.textContent = `${s}.${String(ms).padStart(3, '0')}s`;
          el.style.color = '#ff4444';
        } else {
          el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          el.style.color = diff <= 300000 ? '#ffcc00' : '#fff';
        }
      }

      // 自动刷新 (提前N秒)
      if (CONFIG.autoRefresh && !state.isRunning) {
        const refreshTime = CONFIG.autoRefreshSecondsBefore * 1000;
        if (diff <= refreshTime && diff > refreshTime - 1000) {
          log('自动刷新页面以获取最新状态...');
          setStatus('刷新中...', '#ffcc00');
          // 延迟一点再刷新，避免刷新太早
          location.reload();
          return;
        }
      }

      // 到点开始抢购
      if (diff <= CONFIG.advanceMs && !state.isRunning) {
        state.isRunning = true;
        log(`开始抢购! (提前${CONFIG.advanceMs}ms)`);
        setStatus('正在抢购...', '#00ff88');
        startSnipe();
      }
    };

    state.countdownId = setInterval(update, 50);
    update();

    log('倒计时已启动');
    setStatus('等待抢购时间...', '#aaa');
  }

  // ==================== 5. 核心抢购逻辑 ====================
  function selectBillingPeriod() {
    const periodKeywords = {
      monthly:   { match: '包月', exclude: ['包季', '包年'], label: '连续包月' },
      quarterly: { match: '包季', exclude: ['包月', '包年'], label: '连续包季' },
      yearly:    { match: '包年', exclude: ['包月', '包季'], label: '连续包年' },
    };
    const period = periodKeywords[CONFIG.billingPeriod] || periodKeywords.quarterly;

    const tabs = document.querySelectorAll('div, span, button, a, li, label');
    for (const tab of tabs) {
      const text = (tab.textContent || '').trim();
      if (text.includes(period.match) && period.exclude.every(ex => !text.includes(ex)) && text.length < 20) {
        tab.click();
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        log('已选择: ' + period.label);
        return true;
      }
    }
    log('未找到' + period.label + '选项，使用页面默认');
    return false;
  }

  function startSnipe() {
    // 先选择计费周期
    selectBillingPeriod();
    // 移除所有disabled属性
    removeAllDisabled();

    // 开始循环尝试点击
    state.timerId = setInterval(() => {
      if (state.orderCreated || state.retryCount >= CONFIG.maxRetries) {
        clearInterval(state.timerId);
        if (!state.orderCreated) {
          log('达到最大重试次数');
          setStatus('抢购超时，请手动操作', '#ff4444');
        }
        return;
      }

      state.retryCount++;
      log(`第 ${state.retryCount} 次尝试...`);

      // 移除disabled
      removeAllDisabled();

      // 尝试查找并点击购买按钮
      const clicked = tryClickPurchaseButton();
      if (clicked) {
        log('已点击购买按钮!');
        setStatus('已点击购买按钮，等待响应...', '#00ff88');
      }

      // 尝试点击确认按钮 (如果弹出了确认对话框)
      tryClickConfirmButton();
    }, CONFIG.retryInterval);
  }

  function removeAllDisabled() {
    // 移除所有按钮的disabled属性
    document.querySelectorAll('button[disabled], a[disabled], input[disabled]').forEach((el) => {
      el.removeAttribute('disabled');
      el.disabled = false;
      el.classList.remove('disabled', 'is-disabled', 'btn-disabled');
      // 移除内联样式中的禁用
      if (el.style.pointerEvents === 'none') {
        el.style.pointerEvents = 'auto';
      }
      if (el.style.opacity === '0.5' || el.style.opacity === '0.6') {
        el.style.opacity = '1';
      }
    });

    // 处理通过 CSS class 禁用的元素
    document
      .querySelectorAll('.disabled, .is-disabled, .btn-disabled, .sold-out')
      .forEach((el) => {
        el.classList.remove('disabled', 'is-disabled', 'btn-disabled', 'sold-out');
        el.style.pointerEvents = 'auto';
        el.style.opacity = '1';
      });
  }

  function tryClickPurchaseButton() {
    // 策略1: 通过文字内容查找按钮
    const keywords = ['购买', '订阅', '订购', '立即购买', '立即订阅', 'Subscribe', 'Buy', 'Purchase'];
    const planKeywords = {
      lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
      pro: ['pro', 'Pro', 'PRO', '专业', '进阶'],
      max: ['max', 'Max', 'MAX', '旗舰', '高级'],
    };

    const targetPlanKeys = planKeywords[CONFIG.targetPlan] || [];

    // 先找到目标套餐区域
    let targetSection = null;
    const allElements = document.querySelectorAll('div, section, article, li');
    for (const el of allElements) {
      const text = el.textContent || '';
      if (targetPlanKeys.some((k) => text.includes(k))) {
        // 确认这是一个套餐卡片而非整个页面
        if (el.offsetHeight < 800 && el.offsetWidth < 600) {
          targetSection = el;
          break;
        }
      }
    }

    // 在目标区域内查找购买按钮
    const searchRoot = targetSection || document;
    const buttons = searchRoot.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]');

    for (const btn of buttons) {
      const btnText = (btn.textContent || '').trim();
      const isActionButton = keywords.some((kw) => btnText.includes(kw));

      if (isActionButton) {
        // 如果有目标区域，直接点击
        // 如果没有目标区域，检查按钮附近是否有套餐标识
        if (targetSection || hasNearbyPlanText(btn, targetPlanKeys)) {
          btn.click();
          // 同时触发各种事件以确保被前端框架捕获
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return true;
        }
      }
    }

    // 策略2: 直接通过data属性或id查找
    const specificSelectors = [
      `[data-plan="${CONFIG.targetPlan}"]`,
      `[data-type="${CONFIG.targetPlan}"]`,
      `#${CONFIG.targetPlan}-buy-btn`,
      `#buy-${CONFIG.targetPlan}`,
      `.${CONFIG.targetPlan}-purchase`,
      `[data-plan-type="${CONFIG.targetPlan}"]`,
    ];

    for (const selector of specificSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
      } catch (e) {
        // 选择器可能无效，跳过
      }
    }

    return false;
  }

  function hasNearbyPlanText(btn, planKeys) {
    // 向上查找3层父元素，看是否包含套餐标识
    let el = btn;
    for (let i = 0; i < 5; i++) {
      el = el.parentElement;
      if (!el) break;
      const text = el.textContent || '';
      if (planKeys.some((k) => text.includes(k))) {
        return true;
      }
    }
    return false;
  }

  function tryClickConfirmButton() {
    // 查找确认对话框中的按钮
    const confirmKeywords = ['确认', '确定', '立即支付', '去支付', '提交订单', 'Confirm', 'OK', 'Submit'];

    // 查找模态框/对话框
    const modals = document.querySelectorAll(
      '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="overlay"], [role="dialog"]'
    );

    for (const modal of modals) {
      if (modal.offsetParent === null) continue; // 不可见的跳过

      const buttons = modal.querySelectorAll('button, a[role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (confirmKeywords.some((kw) => text.includes(kw))) {
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          log(`点击确认按钮: "${text}"`);
          state.orderCreated = true;
          setStatus('订单已创建! 请扫码支付', '#00ff88');
          return true;
        }
      }
    }

    return false;
  }

  // ==================== 6. 监控DOM变化，及时响应 ====================
  function setupMutationObserver() {
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupMutationObserver);
      } else {
        setTimeout(setupMutationObserver, 100);
      }
      return;
    }

    const observer = new MutationObserver((mutations) => {
      // 只在抢购启动后才检测二维码，避免误判页面已有的文字
      if (!state.isRunning) return;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            // 必须是新弹出的模态框/弹窗内的内容，且包含canvas或qr图片
            const hasQR = node.querySelector?.('canvas, img[src*="qr"], img[src*="pay"]');
            const isModal = node.matches?.('[class*="modal"], [class*="dialog"], [role="dialog"]') ||
                            node.closest?.('[class*="modal"], [class*="dialog"], [role="dialog"]');
            const text = node.textContent || '';
            const hasPayText = text.includes('扫码') || text.includes('支付宝') || text.includes('微信支付');

            if (hasQR || (isModal && hasPayText)) {
              log('检测到支付二维码!');
              setStatus('支付二维码已出现! 快扫码!', '#00ff88');
              state.orderCreated = true;
              clearInterval(state.timerId);
              playAlert();
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    log('DOM 监控已启动');
  }

  function playAlert() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 播放3次"嘟"声
      [0, 300, 600].forEach((delay) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.value = 0.3;
        osc.start(ctx.currentTime + delay / 1000);
        osc.stop(ctx.currentTime + delay / 1000 + 0.15);
      });
    } catch (e) {
      // 音频播放失败不影响功能
    }
  }

  // ==================== 7. 时间校准 (使用服务器时间) ====================
  async function calibrateTime() {
    try {
      const res = await originalFetch('https://open.bigmodel.cn/', {
        method: 'HEAD',
        cache: 'no-cache',
      });
      const serverDate = res.headers.get('date');
      if (serverDate) {
        const serverTime = new Date(serverDate);
        const localTime = new Date();
        const offset = serverTime - localTime;
        log(`时间偏差: ${offset}ms (${offset > 0 ? '本地慢' : '本地快'})`);
        if (Math.abs(offset) > 1000) {
          log(`警告: 本地时间偏差较大 (${offset}ms)，建议校准系统时间`);
          setStatus(`时间偏差: ${offset}ms`, '#ffcc00');
        }
      }
    } catch (e) {
      log('时间校准失败，使用本地时间');
    }
  }

  // ==================== 8. 页面加载失败自动恢复 ====================
  let _refreshCount = 0;

  function setupAutoRetryRefresh() {
    function checkAndRecover() {
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes();
      // 10:00 ~ 10:30 窗口内持续尝试恢复
      const inWindow = h === CONFIG.targetHour && m < 30;
      if (!inWindow) return;

      const bodyText = document.body?.textContent || '';
      const errorKeywords = ['访问人数较多', '请刷新重试', '请稍后再试', '服务繁忙', '网络错误', '加载失败'];
      const isError = errorKeywords.some(kw => bodyText.includes(kw));

      // 页面 HTML 都没加载出来（完全空白 / 502 / 503 纯文本）
      const pageBlank = document.body && document.body.children.length < 3 && bodyText.trim().length < 100;

      if (!isError && !pageBlank) {
        // 页面正常，重置计数器
        _refreshCount = 0;
        return;
      }

      _refreshCount++;
      console.log(`[GLM Sniper] 页面异常 (第${_refreshCount}次)，强制刷新...`);

      // 直接强刷，带 cache-busting 绕缓存，不限次数
      const url = new URL(window.location.href);
      url.searchParams.set('_t', Date.now());
      window.location.replace(url.toString());
    }

    // 页面加载完后检查
    if (document.readyState === 'complete') {
      setTimeout(checkAndRecover, 1500);
    } else {
      window.addEventListener('load', () => setTimeout(checkAndRecover, 2000));
    }

    // 持续监控（每2秒检查一次）
    setInterval(checkAndRecover, 2000);
  }

  // ==================== 9. 启动 ====================
  function init() {
    // 启动错误恢复
    setupAutoRetryRefresh();   // 全页面级别的强刷兜底
    setupErrorSuppressor();    // DOM级别的错误抑制 + SPA路由重试

    createOverlay();
    setupMutationObserver();

    // 延迟校准时间
    setTimeout(calibrateTime, 2000);

    log(`脚本已启动 - 目标: ${CONFIG.targetPlan.toUpperCase()}`);
    log(`抢购时间: 每天 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2, '0')}:${String(CONFIG.targetSecond).padStart(2, '0')}`);
    log('提前10秒自动刷新，到点自动抢购');
    log('页面加载失败会自动强刷');

    // 如果当前已经是10:00附近 (比如刚好打开页面)
    const now = new Date();
    if (
      now.getHours() === CONFIG.targetHour &&
      now.getMinutes() <= 15
    ) {
      log('当前正是抢购时间! 立即开始!');
      state.isRunning = true;
      startSnipe();
    }
  }

  init();
})();
