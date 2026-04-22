// ==UserScript==
// @name         GLM Coding Plan Pro 自动抢购
// @namespace    https://bigmodel.cn
// @version      1.2.7
// @description  每天10:00自动抢购GLM Coding Plan Pro套餐，拦截售罄+自动点击+错误恢复+弹窗保护+自动重触发
// @author       hd233yui
// @match        https://open.bigmodel.cn/*
// @match        https://www.bigmodel.cn/*
// @match        https://bigmodel.cn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 0. 限流页面早期退出 ====================
  // 在 rate-limit 页面上运行会触发 CSP 错误，直接跳回购买页
  if (window.location.pathname.includes('rate-limit') || window.location.href.includes('rate-limit.html')) {
    console.log('[GLM Sniper] 检测到限流页，跳回购买页...');
    setTimeout(() => window.location.replace('https://open.bigmodel.cn/glm-coding'), 1000);
    return;
  }

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
    // 最大重试次数 (300次 * 100ms = 30秒)
    maxRetries: 300,
    // 是否自动刷新页面 (在9:59:50自动刷新一次以获取最新状态)
    autoRefresh: true,
    autoRefreshSecondsBefore: 10,
  };

  // ==================== 状态 ====================
  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    modalVisible: false,  // 检测到弹窗（验证码/支付）后停止一切刷新
    preheated: false,     // TCP 预热是否已完成
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
    // 前1分钟 到 后30分钟 的窗口期内才拦截 (9:59 ~ 10:30)
    return diff <= 60000 && diff >= -1800000;
  }

  // 售罄确认机制：前2分钟无条件拦截，之后连续N次soldOut则判定为真正售罄
  let _soldOutCount = 0;          // 连续 soldOut 计数
  let _confirmedSoldOut = false;  // 是否已确认售罄

  function isInRushWindow() {
    // 10:00 后前2分钟 = 黄金抢购窗口，无条件拦截
    const now = new Date();
    const target = new Date(now);
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const elapsed = now - target; // 过了多久
    return elapsed >= 0 && elapsed < 120000; // 0~2分钟
  }

  function shouldInterceptSoldOut() {
    if (_confirmedSoldOut) return false;
    if (isInRushWindow()) return true; // 前2分钟无条件拦截
    // 2分钟后：连续3次soldOut → 快速确认售罄（每次API调用约3个plan，1次调用即可确认）
    if (_soldOutCount >= 3) {
      confirmSoldOut();
      return false;
    }
    return true;
  }

  function confirmSoldOut() {
    if (_confirmedSoldOut) return;
    _confirmedSoldOut = true;
    log('已确认售罄，停止抢购');
    setStatus('已售罄，明日再抢', '#ff4444');
    // 停止所有正在运行的抢购逻辑
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    state.isRunning = false;
    notify('GLM 抢购失败', '今日已售罄，明天 10:00 再来！');
  }

  function notify(title, body) {
    try {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: 'https://open.bigmodel.cn/favicon.ico' });
      }
    } catch (e) {}
  }

  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    let result = originalParse.apply(this, args);
    try {
      // 始终捕获 productId（不受时间窗口限制，页面加载时就捕获）
      if (!_capturedProductId) {
        captureProductIdFromData(result);
      }
      // soldOut 拦截只在抢购窗口期内
      if (isNearTargetTime()) {
        result = deepModifySoldOut(result);
      }
    } catch (e) {
      // 静默失败，不影响页面正常功能
    }
    return result;
  };

  // 伪装拦截后的 JSON.parse，防止被检测
  Object.defineProperty(JSON.parse, 'toString', {
    value: () => 'function parse() { [native code] }',
  });

  // 从 batch-preview 响应中按价格+折扣识别目标套餐的 productId
  // API 返回的 productList 没有 name 字段，只能通过价格区分套餐:
  //   Lite: monthlyOriginalAmount=49, Pro: =149, Max: =469
  // 计费周期通过 campaignDiscountDetails 区分:
  //   monthly: 无折扣, quarterly: "包季", yearly: "包年"
  let _allProductIds = {}; // { 'lite_monthly': productId, ... }

  const PLAN_PRICE_MAP = { lite: 49, pro: 149, max: 469 };

  function identifyPlanFromProduct(item) {
    const price = item.monthlyOriginalAmount;
    let plan = null;
    for (const [name, p] of Object.entries(PLAN_PRICE_MAP)) {
      if (price === p) { plan = name; break; }
    }
    if (!plan) return null;

    let period = 'monthly';
    const campaigns = item.campaignDiscountDetails || [];
    for (const c of campaigns) {
      const cn = c.campaignName || '';
      if (cn.includes('包季')) { period = 'quarterly'; break; }
      if (cn.includes('包年')) { period = 'yearly'; break; }
    }
    return { plan, period };
  }

  function captureProductIdFromData(obj) {
    if (!obj || typeof obj !== 'object') return;

    // 检测 batch-preview 响应结构: { data: { productList: [...] } }
    if (obj.productList && Array.isArray(obj.productList)) {
      for (const item of obj.productList) {
        if (!item || !item.productId) continue;
        const info = identifyPlanFromProduct(item);
        if (!info) continue;
        const key = `${info.plan}_${info.period}`;
        _allProductIds[key] = item.productId;
        if (info.plan === CONFIG.targetPlan && info.period === CONFIG.billingPeriod) {
          _capturedProductId = item.productId;
          _capturedProductInfo = item;
          log(`[捕获] productId=${item.productId} (${CONFIG.targetPlan}/${CONFIG.billingPeriod})`);
          // 持久化到 localStorage，刷新后立即可用，无需等 API 响应
          try {
            localStorage.setItem('glm_sniper_pid', JSON.stringify({
              id: item.productId, plan: CONFIG.targetPlan,
              period: CONFIG.billingPeriod, ts: Date.now(),
            }));
          } catch (e) {}
        }
      }
      if (Object.keys(_allProductIds).length > 0 && !_capturedProductId) {
        log(`[捕获] 找到${Object.keys(_allProductIds).length}个产品，但未匹配目标套餐`);
      }
      return;
    }

    // 递归搜索嵌套的 data 字段
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object') captureProductIdFromData(item);
      }
    } else {
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') captureProductIdFromData(v);
      }
    }
  }

  // 获取 productId（含备选列表回退）
  function getProductId() {
    if (_capturedProductId) return _capturedProductId;
    // 精确匹配
    const exactKey = `${CONFIG.targetPlan}_${CONFIG.billingPeriod}`;
    if (_allProductIds[exactKey]) {
      _capturedProductId = _allProductIds[exactKey];
      log(`[回退] 精确匹配 productId=${_capturedProductId} (${exactKey})`);
      return _capturedProductId;
    }
    // 同套餐不同周期
    for (const [key, pid] of Object.entries(_allProductIds)) {
      if (key.startsWith(CONFIG.targetPlan + '_')) {
        _capturedProductId = pid;
        log(`[回退] 同套餐匹配 productId=${pid} (${key})`);
        return pid;
      }
    }
    // 最后回退：任意可用
    const entries = Object.entries(_allProductIds);
    if (entries.length > 0) {
      _capturedProductId = entries[0][1];
      log(`[回退] 使用首个可用 productId=${_capturedProductId} (${entries[0][0]})`);
      return _capturedProductId;
    }
    // localStorage 兜底：读取上次捕获的值（12小时内有效）
    try {
      const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
      if (saved && saved.id && saved.plan === CONFIG.targetPlan &&
          saved.period === CONFIG.billingPeriod && Date.now() - saved.ts < 43200000) {
        _capturedProductId = saved.id;
        log(`[回退] 从 localStorage 恢复 productId=${saved.id}`);
        return _capturedProductId;
      }
    } catch (e) {}
    return null;
  }

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
          _soldOutCount++;
          if (shouldInterceptSoldOut()) {
            obj[key] = false;
            log(`[拦截] 将 ${key} 从 true 改为 false (连续${_soldOutCount}次)`);
          }
        } else {
          // 非 soldOut → 重置计数
          _soldOutCount = 0;
        }
      }
      if (key === 'isServerBusy' && obj[key] === true) {
        obj[key] = false;
        log('[拦截] 将 isServerBusy 从 true 改为 false');
      }
      // 递归处理嵌套对象
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        obj[key] = deepModifySoldOut(obj[key]);
      }
    }
    return obj;
  }

  // ==================== 2. 拦截 fetch + XHR (自动重试 + soldOut修改) ====================

  // 捕获的 productId (从 JSON.parse / API 响应 / 请求中提取)
  let _capturedProductId = null;
  let _capturedProductInfo = null; // 完整的产品信息

  // --- 2a. fetch 拦截 ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    // 请求指纹随机化 — 每次请求看起来不一样，降低被识别为脚本的概率
    if (isNearTargetTime() && args[1]) {
      const headers = new Headers(args[1].headers);
      headers.set('X-Request-Id', Math.random().toString(36).slice(2, 15));
      headers.set('X-Timestamp', String(Date.now()));
      const q = (0.5 + Math.random() * 0.5).toFixed(1);
      headers.set('Accept-Language', `zh-CN,zh;q=${q},en;q=${(q * 0.7).toFixed(1)}`);
      args[1] = { ...args[1], headers };
    }

    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // preview 请求: 捕获 productId + 注入缺失的 productId
    if (/preview/i.test(url) && args[1]?.body) {
      try {
        let body = args[1].body;
        let bodyObj = typeof body === 'string' ? JSON.parse(body) : null;
        if (bodyObj) {
          // 捕获 productId
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            log(`[捕获] productId=${_capturedProductId}`);
          }
          // 注入缺失的 productId
          if (!bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
            log(`[注入] 已补充 productId=${_capturedProductId}`);
          }
        }
      } catch (e) {}
    }

    let response = await originalFetch.apply(this, args);

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

    // 从产品列表 API 响应中捕获 productId
    if (!_capturedProductId && /coding|plan|product|package/i.test(url)) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        // 匹配目标套餐的 productId
        const planKey = CONFIG.targetPlan.toLowerCase();
        const parsed = JSON.parse(text);
        const findProductId = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const name = (item.name || item.title || item.planName || item.planType || '').toLowerCase();
              if (name.includes(planKey) && (item.productId || item.id)) {
                return item.productId || item.id;
              }
              const found = findProductId(item);
              if (found) return found;
            }
          } else {
            for (const v of Object.values(obj)) {
              const found = findProductId(v);
              if (found) return found;
            }
          }
          return null;
        };
        const found = findProductId(parsed);
        if (found) {
          _capturedProductId = found;
          log(`[捕获] 从API响应获取 productId=${_capturedProductId}`);
        }
      } catch (e) {}
    }

    // soldOut 拦截 (已确认售罄则跳过)
    if (!isNearTargetTime() || _confirmedSoldOut) return response;
    if (/coding|plan|order|subscribe|product|package/i.test(url)) {
      try {
        const text = await response.clone().text();
        if (!shouldInterceptSoldOut()) {
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
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

    // productId 缺失检测: preview 请求返回 productId 不能为空时，自动恢复并重试
    if (/preview/i.test(url)) {
      try {
        const clone2 = response.clone();
        const text2 = await clone2.text();
        if (text2.includes('productId') && text2.includes('不能为空')) {
          log('[拦截] 检测到 productId 为空，尝试恢复...');
          ensureProductId();
          selectBillingPeriod();
        }
      } catch (e) {}
    }

    // check 校验: preview 请求成功时验证 bizId
    if (/preview/i.test(url)) {
      try {
        const clone = response.clone();
        const data = await clone.json();
        if (data?.code === 200 && data?.data?.bizId) {
          const valid = await checkBizId(data.data.bizId);
          if (!valid) {
            return new Response(JSON.stringify({code: -1, msg: 'bizId expired'}), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      } catch (e) {}
    }

    return response;
  };

  // --- 2a-2. check 校验: 验证 bizId 有效性 ---
  async function checkBizId(bizId) {
    try {
      const checkUrl = `${location.origin}/api/biz/pay/check?bizId=${encodeURIComponent(bizId)}`;
      const resp = await originalFetch(checkUrl, { credentials: 'include' });
      const data = await resp.json();
      if (data && data.data === 'EXPIRE') {
        log(`[check] bizId=${bizId} 已过期`);
        return false;
      }
      log(`[check] bizId=${bizId} 校验通过`);
      return true;
    } catch (e) {
      log(`[check] 校验异常: ${e.message}`);
      return true; // 异常时放行
    }
  }

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
    const url = this._sniperUrl || '';

    // XHR preview 请求: 捕获 + 注入 productId
    if (/preview/i.test(url) && args[0]) {
      try {
        let bodyObj = typeof args[0] === 'string' ? JSON.parse(args[0]) : null;
        if (bodyObj) {
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            log(`[捕获] productId=${_capturedProductId} (XHR)`);
          }
          if (!bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[0] = JSON.stringify(bodyObj);
            log(`[注入] 已补充 productId=${_capturedProductId} (XHR)`);
          }
        }
      } catch (e) {}
    }

    this._sniperArgs = args;
    if (isNearTargetTime()) {
      this.addEventListener('load', function xhrRetryHandler() {
        if ([429, 500, 502, 503].includes(this.status)) {
          console.log(`[GLM Sniper] XHR ${this.status}，1s后重试: ${this._sniperUrl}`);
          const self = this;
          setTimeout(() => {
            _xhrOpen.call(self, self._sniperMethod, self._sniperUrl, true);
            _xhrSend.apply(self, self._sniperArgs || []);
          }, 1000);
        }
      });
    }
    return _xhrSend.apply(this, args);
  };

  // --- 2c. 弹窗保护：检测验证码/支付弹窗，一旦出现则冻结所有刷新逻辑 ---
  function setupModalProtector() {
    if (!document.body) {
      setTimeout(setupModalProtector, 200);
      return;
    }

    new MutationObserver(() => {
      // 只检测真正的验证码/支付弹窗，避免误判普通页面元素
      const modals = document.querySelectorAll(
        '[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]'
      );
      let foundRealModal = false;
      for (const modal of modals) {
        if (modal.offsetParent === null || modal.offsetHeight < 30) continue;
        // 必须包含验证码或支付相关内容才算真正的弹窗
        const text = modal.textContent || '';
        const isCaptcha = text.includes('验证') || text.includes('滑动') || text.includes('拖动') ||
                          modal.querySelector('[class*="captcha"],[class*="verify"],[class*="slider-"]');
        const isPayment = text.includes('扫码') || text.includes('支付') || text.includes('付款') ||
                          modal.querySelector('canvas, img[src*="qr"], img[src*="pay"]');
        if (isCaptcha || isPayment) {
          foundRealModal = true;
          if (!state.modalVisible) {
            state.modalVisible = true;
            const type = isCaptcha ? '验证码' : '支付';
            console.log(`[GLM Sniper] 检测到${type}弹窗! 冻结刷新`);
            log(`检测到${type}弹窗，已冻结刷新`);
            setStatus('请完成验证码 / 扫码支付!', '#ffcc00');
            playAlert();
          }
          break;
        }
      }
      // 没有真正的弹窗了
      if (!foundRealModal && state.modalVisible) {
        state.modalVisible = false;
        console.log('[GLM Sniper] 弹窗已消失，恢复正常');
        log('弹窗已消失，恢复自动抢购');
        // 验证码完成后重新选择计费周期，防止产品数据丢失导致 productId 为空
        setTimeout(() => {
          selectBillingPeriod();
          ensureProductId();
        }, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // --- 2d. 错误页面 DOM 抑制：检测到错误渲染时隐藏并触发重新加载数据 ---
  function setupErrorSuppressor() {
    if (!document.body) {
      setTimeout(setupErrorSuppressor, 200);
      return;
    }

    new MutationObserver(() => {
      if (!isNearTargetTime()) return;
      // 有弹窗时不做任何操作，保护验证码/支付弹窗
      if (state.modalVisible) return;

      const bodyText = document.body.textContent || '';
      if (!bodyText.includes('访问人数较多') && !bodyText.includes('请刷新重试') && !bodyText.includes('服务繁忙')) return;

      // 找到包含错误信息的容器并隐藏
      const errorNodes = document.querySelectorAll('div, section, p');
      for (const node of errorNodes) {
        const t = node.textContent || '';
        if ((t.includes('访问人数较多') || t.includes('请刷新重试')) && node.offsetHeight > 50) {
          node.style.display = 'none';
          console.log('[GLM Sniper] 隐藏错误页面，触发重新加载...');

          setTimeout(() => {
            const currentUrl = window.location.href;
            window.history.pushState(null, '', currentUrl);
            window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
          }, 500);

          setTimeout(() => {
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
        <div style="color:#f44;font-size:12px;margin-top:6px;font-weight:bold;line-height:1.4;">
          ⚠ 如果订单没有显示需要支付的金额，请不要扫码付款！
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
        // 正在抢购时段 (isRunning 或在窗口期内) 不显示倒计时
        if (state.isRunning || isNearTargetTime()) {
          el.textContent = '抢购中...';
          el.style.color = '#00ff88';
        } else if (diff <= 60000) {
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

      // TCP 预热 (提前3秒建立连接池)
      if (diff <= 3000 && diff > 2000 && !state.preheated) {
        state.preheated = true;
        preheat();
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

  // ==================== 4b. TCP 预热 ====================
  async function preheat() {
    // 只在目标站点执行，避免跨域 CSP 错误
    if (location.hostname !== 'open.bigmodel.cn') return;
    log('TCP 预热中...');
    try {
      // preconnect 由浏览器原生建立，比 fetch HEAD 更早、更高效
      ['https://open.bigmodel.cn'].forEach(origin => {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        link.crossOrigin = 'use-credentials';
        document.head.appendChild(link);
      });
      // 保留一个 fetch HEAD 触发实际 HTTP 连接（preconnect 仅建立 TCP/TLS）
      originalFetch(location.origin + '/favicon.ico', { method: 'HEAD', cache: 'no-cache', credentials: 'include' }).catch(() => {});
      log('预热完成 (preconnect + fetch HEAD)');
    } catch (e) {
      log('预热失败，不影响使用');
    }
  }

  // ==================== 4c. 等待 productId 捕获 ====================
  // 若 batch-preview 响应还没回来，最多等 maxWaitMs 毫秒再继续
  function waitForProductId(maxWaitMs = 3000) {
    if (getProductId()) return Promise.resolve(true);
    return new Promise(resolve => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (getProductId()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start >= maxWaitMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
    });
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

  async function startSnipe() {
    // 已确认售罄时不启动抢购
    if (_confirmedSoldOut) {
      log('已确认售罄，不启动抢购');
      setStatus('已售罄，明日再抢', '#ff4444');
      state.isRunning = false;
      return;
    }

    // 先选择计费周期（点击会触发 batch-preview API，进而捕获 productId）
    selectBillingPeriod();
    // 移除所有disabled属性
    removeAllDisabled();

    // 若 productId 尚未捕获，等待最多 3 秒
    if (!getProductId()) {
      log('productId 未就绪，等待 batch-preview 响应...');
      setStatus('等待 productId...', '#ffcc00');
      const got = await waitForProductId(3000);
      if (got) {
        log(`productId 已就绪: ${_capturedProductId}`);
        setStatus('productId 就绪，开始抢购...', '#00ff88');
      } else {
        log('警告: 3s 内未捕获 productId，强行继续（可能报错）');
        setStatus('productId 未捕获，强行继续...', '#ff8800');
      }
    }

    // 开始循环尝试点击
    state.timerId = setInterval(() => {
      // 运行中确认售罄 → 立即停止
      if (_confirmedSoldOut) {
        clearInterval(state.timerId);
        state.timerId = null;
        state.isRunning = false;
        log('已确认售罄，停止抢购');
        setStatus('已售罄，明日再抢', '#ff4444');
        return;
      }
      if (state.orderCreated) {
        clearInterval(state.timerId);
        return;
      }
      if (state.retryCount >= CONFIG.maxRetries) {
        clearInterval(state.timerId);
        // 重置状态，允许 setupAutoSnipeOnReady 重新触发
        state.isRunning = false;
        state.retryCount = 0;
        log('本轮重试结束，等待页面恢复后重新触发...');
        setStatus('等待页面恢复...', '#ffcc00');
        return;
      }

      state.retryCount++;
      if (state.retryCount % 10 === 1) {
        log(`第 ${state.retryCount} 次尝试...`);
      }

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
          // 延迟检查支付弹窗是否弹出，没有则直接操作 Vue
          setTimeout(forcePayDialog, 1500);
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
              notify('GLM 抢购成功！', '支付二维码已出现，快去扫码！');
              setTimeout(forcePayDialog, 1500);
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
    // 只在目标站点执行，避免跨域 CSP 错误
    if (location.hostname !== 'open.bigmodel.cn') return;
    try {
      const res = await originalFetch(location.origin + '/', {
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
      const inWindow = h === CONFIG.targetHour && m <= 30;
      if (!inWindow) return;
      // 有弹窗时绝不刷新（保护验证码/支付弹窗）
      if (state.modalVisible) return;

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
      console.log(`[GLM Sniper] 页面异常 (第${_refreshCount}次)，尝试恢复...`);

      // 限制刷新频率：至少间隔5秒
      const lastRefresh = parseInt(sessionStorage.getItem('glm_last_refresh') || '0');
      if (Date.now() - lastRefresh < 5000) return;
      sessionStorage.setItem('glm_last_refresh', String(Date.now()));

      // 如果当前在限流页 (rate-limit.html)，直接跳回购买页
      if (window.location.pathname.includes('rate-limit')) {
        console.log('[GLM Sniper] 检测到限流页，跳回购买页...');
        window.location.replace('https://open.bigmodel.cn/glm-coding');
        return;
      }

      // 正常页面异常：带 cache-busting 强刷
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

  // ==================== 9. 页面恢复后自动触发抢购 ====================
  function setupAutoSnipeOnReady() {
    // 每2秒检测：如果在抢购窗口内，页面正常，且还没开始抢购，就自动开始
    setInterval(() => {
      const now = new Date();
      const h = now.getHours(), m = now.getMinutes();
      if (h !== CONFIG.targetHour || m > 30) return;
      if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut) return;

      // 检测页面是否有购买按钮（说明页面正常加载了）
      const bodyText = document.body?.textContent || '';
      const hasError = ['访问人数较多', '请刷新重试', '服务繁忙'].some(kw => bodyText.includes(kw));
      if (hasError) return;

      const hasBuyButton = ['购买', '订阅', '订购', '特惠订阅', '特惠购买'].some(kw => bodyText.includes(kw));
      if (!hasBuyButton) return;

      // 页面正常且有购买按钮，自动触发抢购
      log('页面恢复正常，自动触发抢购!');
      setStatus('页面恢复，正在抢购...', '#00ff88');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  // ==================== 10. Vue 组件直接操作 ====================

  // 确保 Vue 组件中 productId 存在，防止验证码后数据丢失
  function ensureProductId() {
    const pid = getProductId();
    if (!pid) {
      log('[Vue] 没有捕获到 productId，无法恢复');
      return;
    }

    const app = document.querySelector('#app');
    const vue = app?.__vue__;
    if (!vue) return;

    let fixed = 0;
    const walk = (vm, depth) => {
      if (depth > 10) return;
      if (vm.$data) {
        // 搜索所有包含 productId 相关字段的组件，强制设置
        for (const key of Object.keys(vm.$data)) {
          if (/product.?id/i.test(key) && !vm.$data[key]) {
            vm[key] = _capturedProductId;
            fixed++;
            log(`[Vue] 已设置 ${key}=${_capturedProductId}`);
          }
        }
      }
      for (const child of (vm.$children || [])) walk(child, depth + 1);
    };
    walk(vue, 0);

    if (fixed === 0) {
      // 没找到空的 productId 字段，尝试通过 $set 或直接赋值
      log('[Vue] 未找到空的 productId 字段，尝试广搜...');
      const walkAll = (vm, depth) => {
        if (depth > 10 || fixed > 0) return;
        if (vm.$data) {
          const keys = Object.keys(vm.$data);
          // 找到有 productId 字段的组件（不管是否为空）
          for (const key of keys) {
            if (/product.?id/i.test(key)) {
              vm[key] = _capturedProductId;
              fixed++;
              log(`[Vue] 强制设置 ${key}=${_capturedProductId}`);
              return;
            }
          }
        }
        for (const child of (vm.$children || [])) walkAll(child, depth + 1);
      };
      walkAll(vue, 0);
    }
  }

  // 抢购成功后，如果支付弹窗没自动弹出，直接操作 Vue 组件
  function forcePayDialog() {
    const app = document.querySelector('#app');
    const vue = app?.__vue__;
    if (!vue) return;

    let payComp = null;
    const find = (vm, depth) => {
      if (depth > 8) return;
      if (vm.$data && 'payDialogVisible' in vm.$data) { payComp = vm; return; }
      for (const child of (vm.$children || [])) { find(child, depth + 1); if (payComp) return; }
    };
    find(vue, 0);

    if (!payComp) { log('[Vue] 未找到支付组件'); return; }
    if (payComp.payDialogVisible) { log('[Vue] 支付弹窗已显示'); return; }

    payComp.payDialogVisible = true;
    log('[Vue] 已直接设置 payDialogVisible=true');
  }

  // 定时 patch Vue 组件的 isServerBusy
  function patchVueServerBusy() {
    let attempts = 0;
    const tid = setInterval(() => {
      if (++attempts > 30) { clearInterval(tid); return; }
      const vue = document.querySelector('#app')?.__vue__;
      if (!vue) return;
      let patched = 0;
      const walk = (vm, depth) => {
        if (depth > 8) return;
        if (vm.$data?.isServerBusy === true) { vm.isServerBusy = false; patched++; }
        for (const child of (vm.$children || [])) walk(child, depth + 1);
      };
      walk(vue, 0);
      if (patched > 0) {
        log(`[Vue] 已解除 isServerBusy (${patched}个组件)`);
        clearInterval(tid);
      }
    }, 500);
  }

  // ==================== 11. 启动 ====================
  function init() {
    // 启动错误恢复
    setupAutoRetryRefresh(); // 全页面级别的强刷兜底
    setupErrorSuppressor(); // DOM级别的错误抑制 + SPA路由重试
    setupModalProtector(); // 弹窗保护（验证码/支付）

    createOverlay();
    setupMutationObserver();
    setupAutoSnipeOnReady();   // 页面恢复后自动触发抢购

    // 申请系统通知权限
    if (Notification.permission === 'default') Notification.requestPermission();

    // 从 localStorage 预加载上次捕获的 productId（刷新后立即可用）
    try {
      const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
      if (saved && saved.id && saved.plan === CONFIG.targetPlan &&
          saved.period === CONFIG.billingPeriod && Date.now() - saved.ts < 43200000) {
        _capturedProductId = saved.id;
        log(`[localStorage] 预加载 productId=${saved.id}`);
      }
    } catch (e) {}

    // 延迟校准时间 + patch Vue isServerBusy + 定期捕获 productId
    setTimeout(calibrateTime, 2000);
    patchVueServerBusy();
    // 定期检查 productId 是否已捕获（直到成功）
    const pidTimer = setInterval(() => {
      if (_capturedProductId) { clearInterval(pidTimer); return; }
      getProductId();
    }, 3000);

    log(`脚本已启动 - 目标: ${CONFIG.targetPlan.toUpperCase()}`);
    log(`抢购时间: 每天 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2, '0')}:${String(CONFIG.targetSecond).padStart(2, '0')}`);
    log('提前10秒自动刷新，到点自动抢购');
    log('页面加载失败会自动强刷');
    log('检测到验证码/支付弹窗会冻结刷新');

    // 如果当前已经是10:00附近 (比如刚好打开页面)
    const now = new Date();
    if (
      now.getHours() === CONFIG.targetHour &&
      now.getMinutes() <= 30
    ) {
      // 延迟2秒等待 API 数据加载，以便售罄检测生效
      setTimeout(() => {
        if (_confirmedSoldOut) {
          log('已确认售罄，不启动抢购');
          setStatus('已售罄，明日再抢', '#ff4444');
          return;
        }
        log('当前正是抢购时间! 立即开始!');
        state.isRunning = true;
        startSnipe();
      }, 2000);
    }
  }

  init();
})();
