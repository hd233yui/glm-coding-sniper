/* ========================================
   GLM Coding Plan Pro 自动抢购 (控制台版)

   使用方法:
   1. 9:59 左右打开 https://open.bigmodel.cn/glm-coding 并登录
   2. 按 F12 打开控制台
   3. 粘贴这段代码，按回车
   4. 看到右上角黑色悬浮窗 = 成功
   5. 等到点自动抢购，听到提示音后扫码付款

   注意: 刷新页面后需要重新粘贴!
   ======================================== */

(function () {
  'use strict';

  const CONFIG = {
    targetPlan: 'pro',        // 'lite' | 'pro' | 'max'
    billingPeriod: 'quarterly', // 'monthly' | 'quarterly' | 'yearly'
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0,
    advanceMs: 200,           // 提前多少ms开始点击
    retryInterval: 100,       // 点击间隔(ms)
    maxRetries: 300,          // 最大重试次数 (300次 * 100ms = 30秒)
  };

  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    modalVisible: false,
    preheated: false,
    timerId: null,
  };

  // ===== 时间窗口检查: 只在 10:00 前1分钟 ~ 后30分钟内拦截 (9:59 ~ 10:30) =====
  function isNearTarget() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = t - now;
    return diff <= 60000 && diff >= -1800000;
  }

  // ===== 售罄确认机制 =====
  let _soldOutCount = 0;
  let _confirmedSoldOut = false;

  function isInRushWindow() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const elapsed = now - t;
    return elapsed >= 0 && elapsed < 120000;
  }

  function shouldInterceptSoldOut() {
    if (_confirmedSoldOut) return false;
    if (isInRushWindow()) return true;
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
    setStatus('已售罄，明日再抢', '#f44');
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

  // ===== 1. 拦截 JSON.parse =====
  const _parse = JSON.parse;
  JSON.parse = function (...args) {
    let r = _parse.apply(this, args);
    try {
      // 始终捕获 productId（不受时间窗口限制）
      if (!_capturedProductId) captureProductIdFromData(r);
      if (isNearTarget()) r = fixSoldOut(r);
    } catch (e) {}
    return r;
  };
  Object.defineProperty(JSON.parse, 'toString', {
    value: () => 'function parse() { [native code] }',
  });

  // 按价格+折扣识别目标套餐 (API 返回无 name 字段)
  // Lite: monthlyOriginalAmount=49, Pro: =149, Max: =469
  // monthly: 无折扣, quarterly: campaignName含"包季", yearly: 含"包年"
  let _allProductIds = {};
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
    if (obj.productList && Array.isArray(obj.productList)) {
      for (const item of obj.productList) {
        if (!item || !item.productId) continue;
        const info = identifyPlanFromProduct(item);
        if (!info) continue;
        const key = info.plan + '_' + info.period;
        _allProductIds[key] = item.productId;
        if (info.plan === CONFIG.targetPlan && info.period === CONFIG.billingPeriod) {
          _capturedProductId = item.productId;
          log('[捕获] productId=' + item.productId + ' (' + CONFIG.targetPlan + '/' + CONFIG.billingPeriod + ')');
          try {
            localStorage.setItem('glm_sniper_pid', JSON.stringify({
              id: item.productId, plan: CONFIG.targetPlan,
              period: CONFIG.billingPeriod, ts: Date.now(),
            }));
          } catch (e) {}
        }
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) { if (item && typeof item === 'object') captureProductIdFromData(item); }
    } else {
      for (const v of Object.values(obj)) { if (v && typeof v === 'object') captureProductIdFromData(v); }
    }
  }

  function getProductId() {
    if (_capturedProductId) return _capturedProductId;
    var exactKey = CONFIG.targetPlan + '_' + CONFIG.billingPeriod;
    if (_allProductIds[exactKey]) {
      _capturedProductId = _allProductIds[exactKey];
      log('[回退] 精确匹配 productId=' + _capturedProductId);
      return _capturedProductId;
    }
    for (const [key, pid] of Object.entries(_allProductIds)) {
      if (key.startsWith(CONFIG.targetPlan + '_')) {
        _capturedProductId = pid;
        log('[回退] 同套餐匹配 productId=' + pid + ' (' + key + ')');
        return pid;
      }
    }
    const entries = Object.entries(_allProductIds);
    if (entries.length > 0) {
      _capturedProductId = entries[0][1];
      log('[回退] 使用首个可用 productId=' + _capturedProductId);
      return _capturedProductId;
    }
    // localStorage 兜底（12小时内有效，按 plan/period 隔离）
    try {
      const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
      if (saved && saved.id && saved.plan === CONFIG.targetPlan &&
          saved.period === CONFIG.billingPeriod && Date.now() - saved.ts < 43200000) {
        _capturedProductId = saved.id;
        log('[回退] 从 localStorage 恢复 productId=' + saved.id);
        return _capturedProductId;
      }
    } catch (e) {}
    return null;
  }

  function fixSoldOut(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(fixSoldOut);
    for (const k of Object.keys(obj)) {
      if (/sold.?out/i.test(k) && obj[k] === true) {
        _soldOutCount++;
        if (shouldInterceptSoldOut()) {
          obj[k] = false;
          log('[拦截] ' + k + ' -> false (连续' + _soldOutCount + '次)');
        }
      } else if (/sold.?out/i.test(k)) {
        _soldOutCount = 0;
      }
      if (k === 'isServerBusy' && obj[k] === true) {
        obj[k] = false;
        log('[拦截] isServerBusy -> false');
      }
      if (typeof obj[k] === 'object') obj[k] = fixSoldOut(obj[k]);
    }
    return obj;
  }

  // ===== 2. 拦截 fetch (指纹随机化 + 自动重试 + soldOut修改 + check校验) =====
  let _capturedProductId = null;

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    // 请求指纹随机化
    if (isNearTarget() && args[1]) {
      const headers = new Headers(args[1].headers);
      headers.set('X-Request-Id', Math.random().toString(36).slice(2, 15));
      headers.set('X-Timestamp', String(Date.now()));
      const q = (0.5 + Math.random() * 0.5).toFixed(1);
      headers.set('Accept-Language', 'zh-CN,zh;q=' + q + ',en;q=' + (q * 0.7).toFixed(1));
      args[1] = { ...args[1], headers };
    }

    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    // preview 请求: 捕获 productId + 注入缺失的 productId
    if (/preview/i.test(url) && args[1]?.body) {
      try {
        let bodyObj = typeof args[1].body === 'string' ? JSON.parse(args[1].body) : null;
        if (bodyObj) {
          if (bodyObj.productId) {
            _capturedProductId = bodyObj.productId;
            log('[捕获] productId=' + _capturedProductId);
          }
          if (!bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
            log('[注入] 已补充 productId=' + _capturedProductId);
          }
        }
      } catch (e) {}
    }

    let res = await _fetch.apply(this, args);

    // 抢购窗口内，失败请求自动重试
    if (isNearTarget() && [429, 500, 502, 503].includes(res.status)) {
      for (let retry = 1; retry <= 8; retry++) {
        console.log('[GLM Sniper] fetch ' + res.status + '，重试' + retry + ': ' + url);
        await new Promise(r => setTimeout(r, 300 * retry));
        try {
          res = await _fetch.apply(this, args);
          if (res.ok) { console.log('[GLM Sniper] fetch 重试成功!'); break; }
        } catch (e) {}
      }
    }

    // 从产品列表 API 响应中捕获 productId
    if (!_capturedProductId && /coding|plan|product|package/i.test(url)) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        const planKey = CONFIG.targetPlan.toLowerCase();
        const parsed = JSON.parse(text);
        const findPid = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const name = (item.name || item.title || item.planName || item.planType || '').toLowerCase();
              if (name.includes(planKey) && (item.productId || item.id)) return item.productId || item.id;
              const f = findPid(item); if (f) return f;
            }
          } else {
            for (const v of Object.values(obj)) { const f = findPid(v); if (f) return f; }
          }
          return null;
        };
        const found = findPid(parsed);
        if (found) { _capturedProductId = found; log('[捕获] 从API响应获取 productId=' + found); }
      } catch (e) {}
    }

    if (!isNearTarget()) return res;
    if (/coding|plan|order|subscribe|product|package/i.test(url)) {
      const clone = res.clone();
      try {
        const text = await clone.text();
        const fixed = text
          .replace(/"isSoldOut"\s*:\s*true/g, '"isSoldOut":false')
          .replace(/"soldOut"\s*:\s*true/g, '"soldOut":false')
          .replace(/"is_sold_out"\s*:\s*true/g, '"is_sold_out":false')
          .replace(/"sold_out"\s*:\s*true/g, '"sold_out":false');
        if (fixed !== text) log('[拦截] fetch 响应已修改');
        return new Response(fixed, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } catch (e) { return res; }
    }

    // productId 缺失检测
    if (/preview/i.test(url)) {
      try {
        const clone2 = res.clone();
        const text2 = await clone2.text();
        if (text2.includes('productId') && text2.includes('不能为空')) {
          log('[拦截] 检测到 productId 为空，尝试恢复...');
          ensureProductId();
          selectBilling();
        }
      } catch (e) {}
    }

    // check 校验: preview 请求成功时验证 bizId
    if (/preview/i.test(url)) {
      try {
        const clone = res.clone();
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

    return res;
  };

  // ===== 2a-2. check 校验 =====
  async function checkBizId(bizId) {
    try {
      const checkUrl = location.origin + '/api/biz/pay/check?bizId=' + encodeURIComponent(bizId);
      const resp = await _fetch(checkUrl, { credentials: 'include' });
      const data = await resp.json();
      if (data && data.data === 'EXPIRE') {
        log('[check] bizId=' + bizId + ' 已过期');
        return false;
      }
      log('[check] bizId=' + bizId + ' 校验通过');
      return true;
    } catch (e) {
      log('[check] 校验异常: ' + e.message);
      return true;
    }
  }

  // ===== 2b. XHR 拦截 (覆盖不走 fetch 的请求) =====
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
            log('[捕获] productId=' + _capturedProductId + ' (XHR)');
          }
          if (!bodyObj.productId && _capturedProductId) {
            bodyObj.productId = _capturedProductId;
            args[0] = JSON.stringify(bodyObj);
            log('[注入] 已补充 productId=' + _capturedProductId + ' (XHR)');
          }
        }
      } catch (e) {}
    }

    this._sniperArgs = args;
    if (isNearTarget()) {
      this.addEventListener('load', function xhrRetryHandler() {
        if ([429, 500, 502, 503].includes(this.status)) {
          console.log('[GLM Sniper] XHR ' + this.status + '，1s后重试: ' + this._sniperUrl);
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

  // ===== 2c. 弹窗保护：检测验证码/支付弹窗，冻结刷新 =====
  function setupModalProtector() {
    new MutationObserver(() => {
      const modals = document.querySelectorAll(
        '[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]'
      );
      let foundRealModal = false;
      for (const modal of modals) {
        if (modal.offsetParent === null || modal.offsetHeight < 30) continue;
        const text = modal.textContent || '';
        const isCaptcha = text.includes('验证') || text.includes('滑动') || text.includes('拖动') ||
                          modal.querySelector('[class*="captcha"],[class*="verify"],[class*="slider-"]');
        const isPayment = text.includes('扫码') || text.includes('支付') || text.includes('付款') ||
                          modal.querySelector('canvas, img[src*="qr"], img[src*="pay"]');
        if (isCaptcha || isPayment) {
          foundRealModal = true;
          if (!state.modalVisible) {
            state.modalVisible = true;
            log('检测到' + (isCaptcha ? '验证码' : '支付') + '弹窗，已冻结刷新');
            setStatus('请完成验证码 / 扫码支付!', '#fc0');
            playBeep();
          }
          break;
        }
      }
      if (!foundRealModal && state.modalVisible) {
        state.modalVisible = false;
        log('弹窗已消失，恢复自动抢购');
        setTimeout(() => {
          selectBilling();
          ensureProductId();
        }, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ===== 2d. 错误页面 DOM 抑制 =====
  function setupErrorSuppressor() {
    new MutationObserver(() => {
      if (!isNearTarget() || state.modalVisible) return;
      const bodyText = document.body.textContent || '';
      if (!bodyText.includes('访问人数较多') && !bodyText.includes('请刷新重试') && !bodyText.includes('服务繁忙')) return;

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

  // ===== 3. 悬浮窗 =====
  if (document.getElementById('glm-sniper-overlay')) {
    document.getElementById('glm-sniper-overlay').remove();
  }

  const overlay = document.createElement('div');
  overlay.id = 'glm-sniper-overlay';
  overlay.innerHTML = `
    <div style="
      position:fixed;top:10px;right:10px;z-index:999999;
      background:rgba(0,0,0,0.9);color:#0f8;padding:16px 20px;
      border-radius:12px;font-family:Consolas,Monaco,monospace;
      font-size:14px;min-width:260px;
      box-shadow:0 4px 20px rgba(0,0,0,0.6);
      border:1px solid rgba(0,255,136,0.3);
    ">
      <div style="font-size:16px;font-weight:bold;margin-bottom:6px">
        GLM Sniper <span style="color:#888;font-size:12px">console ver.</span>
      </div>
      <div style="color:#fc0;margin-bottom:4px">目标: ${CONFIG.targetPlan.toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[CONFIG.billingPeriod]||'包季'}</div>
      <div id="glm-cd" style="font-size:22px;margin:6px 0;color:#fff">--:--:--</div>
      <div id="glm-st" style="color:#aaa;font-size:12px">就绪</div>
      <div style="color:#f44;font-size:12px;margin-top:6px;font-weight:bold;line-height:1.4;">
        ⚠ 如果订单没有显示需要支付的金额，请不要扫码付款！
      </div>
      <div style="margin-top:6px;">
        <button id="glm-notif-btn" onclick="(function(){
          if(Notification.permission==='granted'){return;}
          Notification.requestPermission().then(p=>{
            const btn=document.getElementById('glm-notif-btn');
            if(btn) btn.textContent=p==='granted'?'🔔 通知已开启':'🔕 通知被拒绝';
          });
        })()" style="
          background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
          color:#ccc;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;
        ">🔔 开启通知</button>
      </div>
      <div id="glm-log" style="
        margin-top:8px;max-height:100px;overflow-y:auto;
        font-size:11px;color:#888;
        border-top:1px solid rgba(255,255,255,0.1);padding-top:6px;
      "></div>
    </div>`;
  document.body.appendChild(overlay);

  function log(msg) {
    console.log('[GLM Sniper] ' + msg);
    const el = document.getElementById('glm-log');
    if (!el) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    el.innerHTML = '<div>' + t + ' ' + msg + '</div>' + el.innerHTML;
    while (el.children.length > 15) el.removeChild(el.lastChild);
  }

  function setStatus(msg, color) {
    const el = document.getElementById('glm-st');
    if (el) { el.textContent = msg; el.style.color = color || '#aaa'; }
  }

  // ===== 4. TCP 预热 =====
  async function preheat() {
    log('TCP 预热中...');
    try {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = location.origin;
      document.head.appendChild(link);
      _fetch(location.origin + '/favicon.ico', { method: 'HEAD', cache: 'no-cache', credentials: 'include' }).catch(() => {});
      log('预热完成 (preconnect + fetch HEAD)');
    } catch (e) {
      log('预热失败，不影响使用');
    }
  }

  // ===== 5. 倒计时 =====
  function getTarget() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    if (now >= t) t.setDate(t.getDate() + 1);
    return t;
  }

  setInterval(() => {
    const diff = getTarget() - new Date();
    const el = document.getElementById('glm-cd');
    if (!el) return;

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const ms = diff % 1000;

    if (state.isRunning || isNearTarget()) {
      el.textContent = '抢购中...';
      el.style.color = '#0f8';
    } else if (diff <= 60000) {
      el.textContent = s + '.' + String(ms).padStart(3, '0') + 's';
      el.style.color = '#f44';
    } else {
      el.textContent = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
      el.style.color = diff <= 300000 ? '#fc0' : '#fff';
    }

    // TCP 预热 (提前3秒)
    if (diff <= 3000 && diff > 2000 && !state.preheated) {
      state.preheated = true;
      preheat();
    }

    // 到点开抢
    if (diff <= CONFIG.advanceMs && !state.isRunning) {
      state.isRunning = true;
      log('开始抢购!');
      setStatus('正在抢购...', '#0f8');
      startSnipe();
    }
  }, 50);

  // ===== 6. 抢购 =====
  function selectBilling() {
    const periods = {
      monthly:   { match: '包月', exclude: ['包季', '包年'], label: '连续包月' },
      quarterly: { match: '包季', exclude: ['包月', '包年'], label: '连续包季' },
      yearly:    { match: '包年', exclude: ['包月', '包季'], label: '连续包年' },
    };
    const p = periods[CONFIG.billingPeriod] || periods.quarterly;
    for (const el of document.querySelectorAll('div,span,button,a,li,label')) {
      const t = (el.textContent || '').trim();
      if (t.includes(p.match) && p.exclude.every(ex => !t.includes(ex)) && t.length < 20) {
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        log('已选择: ' + p.label);
        return;
      }
    }
    log('未找到' + p.label + '，使用默认');
  }

  function waitForProductId(maxWaitMs = 3000) {
    if (getProductId()) return Promise.resolve(true);
    return new Promise(resolve => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (getProductId()) { clearInterval(timer); resolve(true); }
        else if (Date.now() - start >= maxWaitMs) { clearInterval(timer); resolve(false); }
      }, 100);
    });
  }

  async function startSnipe() {
    if (_confirmedSoldOut) {
      log('已确认售罄，不启动抢购');
      setStatus('已售罄，明日再抢', '#f44');
      state.isRunning = false;
      return;
    }
    selectBilling();
    unlock();
    if (!getProductId()) {
      log('productId 未就绪，等待 batch-preview 响应...');
      setStatus('等待 productId...', '#fc0');
      const got = await waitForProductId(3000);
      if (got) {
        log('productId 已就绪: ' + _capturedProductId);
        setStatus('productId 就绪，开始抢购...', '#0f8');
      } else {
        log('警告: 3s 内未捕获 productId，强行继续');
        setStatus('productId 未捕获，强行继续...', '#f80');
      }
    }
    state.timerId = setInterval(() => {
      if (_confirmedSoldOut) {
        clearInterval(state.timerId);
        state.timerId = null;
        state.isRunning = false;
        log('已确认售罄，停止抢购');
        setStatus('已售罄，明日再抢', '#f44');
        return;
      }
      if (state.orderCreated) {
        clearInterval(state.timerId);
        return;
      }
      if (state.retryCount >= CONFIG.maxRetries) {
        clearInterval(state.timerId);
        state.isRunning = false;
        state.retryCount = 0;
        log('本轮重试结束，等待页面恢复后重新触发...');
        setStatus('等待页面恢复...', '#fc0');
        return;
      }
      state.retryCount++;
      if (state.retryCount % 10 === 1) {
        log('第 ' + state.retryCount + ' 次尝试...');
      }
      unlock();
      if (clickBuy()) {
        log('已点击购买按钮!');
        setStatus('等待响应...', '#0f8');
      }
      clickConfirm();
    }, CONFIG.retryInterval);
  }

  function unlock() {
    document.querySelectorAll('button[disabled],a[disabled]').forEach(el => {
      el.removeAttribute('disabled');
      el.disabled = false;
      el.style.pointerEvents = 'auto';
      el.style.opacity = '1';
    });
    document.querySelectorAll('.disabled,.is-disabled,.sold-out,.btn-disabled').forEach(el => {
      el.classList.remove('disabled', 'is-disabled', 'sold-out', 'btn-disabled');
      el.style.pointerEvents = 'auto';
      el.style.opacity = '1';
    });
  }

  function clickBuy() {
    const buyWords = ['购买', '订阅', '订购', '立即购买', '立即订阅', '特惠购买', '特惠订阅', 'Subscribe', 'Buy'];
    const planWords = {
      lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
      pro: ['pro', 'Pro', 'PRO', '专业', '进阶'],
      max: ['max', 'Max', 'MAX', '旗舰', '高级'],
    }[CONFIG.targetPlan] || [];

    let card = null;
    for (const el of document.querySelectorAll('div,section,li,article')) {
      const t = el.textContent || '';
      if (planWords.some(k => t.includes(k)) && el.offsetHeight < 800 && el.offsetWidth < 600 && el.offsetHeight > 50) {
        card = el;
        break;
      }
    }

    const root = card || document;
    for (const btn of root.querySelectorAll('button,a[role="button"],[class*="btn"],[class*="button"]')) {
      const t = (btn.textContent || '').trim();
      if (buyWords.some(k => t.includes(k))) {
        if (card || nearPlan(btn, planWords)) {
          fire(btn);
          return true;
        }
      }
    }
    return false;
  }

  function nearPlan(btn, words) {
    let el = btn;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el) return false;
      if (words.some(k => (el.textContent || '').includes(k))) return true;
    }
    return false;
  }

  function clickConfirm() {
    const words = ['确认', '确定', '立即支付', '去支付', '提交订单', '确认支付', 'Confirm', 'OK'];
    for (const modal of document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="popup"],[role="dialog"]')) {
      if (modal.offsetParent === null) continue;
      for (const btn of modal.querySelectorAll('button,a[role="button"]')) {
        const t = (btn.textContent || '').trim();
        if (words.some(k => t.includes(k))) {
          fire(btn);
          log('点击确认: ' + t);
          state.orderCreated = true;
          setStatus('订单已创建! 快扫码!', '#0f8');
          playBeep();
          setTimeout(forcePayDialog, 1500);
          return;
        }
      }
    }
  }

  function fire(el) {
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }

  // ===== 7. 监控二维码出现 =====
  new MutationObserver(muts => {
    if (!state.isRunning) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const hasQR = n.querySelector?.('canvas,img[src*="qr"],img[src*="pay"]');
        const isModal = n.matches?.('[class*="modal"],[class*="dialog"],[role="dialog"]') ||
                        n.closest?.('[class*="modal"],[class*="dialog"],[role="dialog"]');
        const t = n.textContent || '';
        const hasPayText = t.includes('扫码') || t.includes('支付宝') || t.includes('微信支付');
        if (hasQR || (isModal && hasPayText)) {
          log('支付二维码出现!');
          setStatus('快扫码支付!', '#0f8');
          state.orderCreated = true;
          clearInterval(state.timerId);
          playBeep();
          notify('GLM 抢购成功！', '支付二维码已出现，快去扫码！');
          setTimeout(forcePayDialog, 1500);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ===== 8. 页面恢复后自动触发抢购 =====
  function setupAutoSnipeOnReady() {
    setInterval(() => {
      const now = new Date();
      if (now.getHours() !== CONFIG.targetHour || now.getMinutes() > 30) return;
      if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut) return;

      const bodyText = document.body?.textContent || '';
      const hasError = ['访问人数较多', '请刷新重试', '服务繁忙'].some(kw => bodyText.includes(kw));
      if (hasError) return;

      const hasBuyButton = ['购买', '订阅', '订购', '特惠订阅', '特惠购买'].some(kw => bodyText.includes(kw));
      if (!hasBuyButton) return;

      log('页面恢复正常，自动触发抢购!');
      setStatus('页面恢复，正在抢购...', '#0f8');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  // ===== 9. Vue 组件直接操作 =====
  function ensureProductId() {
    const pid = getProductId();
    if (!pid) { log('[Vue] 没有捕获到 productId，无法恢复'); return; }
    const app = document.querySelector('#app');
    const vue = app?.__vue__;
    if (!vue) return;
    let fixed = 0;
    const walk = (vm, depth) => {
      if (depth > 10) return;
      if (vm.$data) {
        for (const key of Object.keys(vm.$data)) {
          if (/product.?id/i.test(key) && !vm.$data[key]) {
            vm[key] = _capturedProductId;
            fixed++;
            log('[Vue] 已设置 ' + key + '=' + _capturedProductId);
          }
        }
      }
      for (const child of (vm.$children || [])) walk(child, depth + 1);
    };
    walk(vue, 0);
    if (fixed === 0) {
      const walkAll = (vm, depth) => {
        if (depth > 10 || fixed > 0) return;
        if (vm.$data) {
          for (const key of Object.keys(vm.$data)) {
            if (/product.?id/i.test(key)) {
              vm[key] = _capturedProductId;
              fixed++;
              log('[Vue] 强制设置 ' + key + '=' + _capturedProductId);
              return;
            }
          }
        }
        for (const child of (vm.$children || [])) walkAll(child, depth + 1);
      };
      walkAll(vue, 0);
    }
  }

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
        log('[Vue] 已解除 isServerBusy (' + patched + '个组件)');
        clearInterval(tid);
      }
    }, 500);
  }

  function playBeep() {
    try {
      const c = new AudioContext();
      [0, 0.3, 0.6].forEach(d => {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.frequency.value = 880; g.gain.value = 0.3;
        o.start(c.currentTime + d); o.stop(c.currentTime + d + 0.15);
      });
    } catch (e) {}
  }

  // ===== 10. 启动 =====
  setupModalProtector();
  setupErrorSuppressor();
  setupAutoSnipeOnReady();
  patchVueServerBusy();
  unlock();

  // 通知权限：由用户点击悬浮窗按钮触发，避免被浏览器静默拒绝

  // 从 localStorage 预加载上次捕获的 productId
  try {
    const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
    if (saved && saved.id && saved.plan === CONFIG.targetPlan &&
        saved.period === CONFIG.billingPeriod && Date.now() - saved.ts < 43200000) {
      _capturedProductId = saved.id;
      log('[localStorage] 预加载 productId=' + saved.id);
    }
  } catch (e) {}
  log('脚本已启动 - 目标: ' + CONFIG.targetPlan.toUpperCase());
  log('到 ' + CONFIG.targetHour + ':00 自动抢购');
  log('页面异常自动恢复，弹窗自动冻结刷新');
  log('已启用: TCP预热/指纹随机化/check校验/Vue直接操作');
  setStatus('等待中...', '#aaa');

  // 定期检查 productId 是否已捕获
  const pidTimer = setInterval(() => {
    if (_capturedProductId) { clearInterval(pidTimer); return; }
    getProductId();
  }, 3000);

  // 如果现在刚好是10:00
  const now = new Date();
  if (now.getHours() === CONFIG.targetHour && now.getMinutes() <= 30) {
    // 延迟2秒等待 API 数据加载，以便售罄检测生效
    setTimeout(() => {
      if (_confirmedSoldOut) {
        log('已确认售罄，不启动抢购');
        setStatus('已售罄，明日再抢', '#f44');
        return;
      }
      log('现在就是抢购时间!');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  console.log('%c[GLM Sniper] 脚本加载成功! 看右上角悬浮窗', 'color:#0f8;font-size:16px;font-weight:bold');
})();
