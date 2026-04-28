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

  const VERSION = '1.4.0';

  const CONFIG = {
    // 套餐优先级列表，按顺序尝试；第一个为首选，后续为候补
    // 每项: { plan: 'lite'|'pro'|'max', billingPeriod: 'monthly'|'quarterly'|'yearly' }
    planPriority: [
      { plan: 'pro', billingPeriod: 'quarterly' },
      // { plan: 'lite', billingPeriod: 'quarterly' }, // 候补（取消注释以启用）
    ],
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0,
    advanceMs: 200,           // 提前多少ms开始点击
    retryInterval: 100,       // 点击间隔(ms)
    maxRetries: 300,          // 最大重试次数 (300次 * 100ms = 30秒)
  };

  let _currentPlanIdx = 0;
  function currentPlan()   { return CONFIG.planPriority[_currentPlanIdx].plan; }
  function currentPeriod() { return CONFIG.planPriority[_currentPlanIdx].billingPeriod; }

  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    modalVisible: false,
    preheated: false,
    switchingPlan: false, // Fix 6: tryNextPlan 切换中，防止 setupAutoSnipeOnReady 并发触发
    timerId: null,
  };

  // ===== 时间窗口检查: 只在 10:00 前1分钟 ~ 后30分钟内拦截 (9:59 ~ 10:30) =====
  function isNearTarget() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = t - now;
    return diff <= 60000 && diff >= -1800000;
  }

  // 实际抢购时间窗口（目标时刻含 advanceMs 到 后30分钟），不含1分钟预热期
  function isInPurchaseTime() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = t - now;
    return diff <= CONFIG.advanceMs && diff >= -1800000;
  }

  // ===== 售罄确认机制 =====
  let _confirmedSoldOut = false;

  function isInRushWindow() {
    // 10:00~10:02 强制拦截窗口
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const elapsed = now - t;
    return elapsed >= 0 && elapsed < 120000;
  }

  function shouldInterceptSoldOut() {
    return isInRushWindow();
  }

  function getPlanFromPrice(price) {
    if (!price) return null;
    for (var name in PLAN_PRICE_MAP) {
      if (PLAN_PRICE_MAP[name] === price) return name;
    }
    for (var name2 in PLAN_PRICE_RANGES) {
      var r = PLAN_PRICE_RANGES[name2];
      if (price >= r[0] && price <= r[1]) return name2;
    }
    return null;
  }

  var _soldOutInCycle = new Set();
  var _soldOutCycleCount = 0;    // Fix 1: 连续全售罄圈数
  var SOLD_OUT_CYCLES_REQUIRED = 3;
  var _planSwitchPending = false;

  function tryNextPlan() {
    if (state.orderCreated) return false;
    // 互斥锁：统一在此处持有，使 probeSoldOutStatus / fixSoldOut 均受约束，避免并发双跳
    if (_planSwitchPending) { log('[候补] 切换进行中，跳过重复触发'); return false; }
    _planSwitchPending = true;
    try {
      _soldOutInCycle.add(currentPlan() + '_' + currentPeriod());

      var prev = CONFIG.planPriority[_currentPlanIdx];
      _currentPlanIdx++;

      if (_currentPlanIdx >= CONFIG.planPriority.length) {
        if (_soldOutInCycle.size >= CONFIG.planPriority.length) {
          _soldOutCycleCount++;
          if (_soldOutCycleCount >= SOLD_OUT_CYCLES_REQUIRED) {
            log('[候补] 所有套餐已连续 ' + SOLD_OUT_CYCLES_REQUIRED + ' 圈售罄，停止抢购');
            _planSwitchPending = false;
            confirmSoldOut();
            return false;
          }
          log('[候补] 全圈售罄 (第 ' + _soldOutCycleCount + '/' + SOLD_OUT_CYCLES_REQUIRED + ' 圈)，继续轮询...');
        } else {
          _soldOutCycleCount = 0;
          log('[候补] 轮询一圈未全售罄，重新从 ' + CONFIG.planPriority[0].plan + ' 开始...');
        }
        _currentPlanIdx = 0;
        _soldOutInCycle.clear();
      }

      var next = CONFIG.planPriority[_currentPlanIdx];
      var isSamePlan = prev.plan === next.plan && prev.billingPeriod === next.billingPeriod;
      if (isSamePlan) {
        log('[候补] ' + prev.plan + '/' + prev.billingPeriod + ' 售罄，继续轮询...');
      } else {
        log('[候补] ' + prev.plan + '/' + prev.billingPeriod + ' 售罄 → 切换到 ' + next.plan + '/' + next.billingPeriod);
        notify('GLM 候补切换', prev.plan + ' 已售罄，正在尝试 ' + next.plan);
      }
      _capturedProductId = null;
      getProductId();
      updateTargetDisplay();
      var periodLabel = {monthly:'包月', quarterly:'包季', yearly:'包年'}[next.billingPeriod] || '包季';
      setStatus('候补: ' + next.plan.toUpperCase() + ' / ' + periodLabel, '#ffaa00');
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
      state.switchingPlan = true;
      state.isRunning = false;
      state.retryCount = 0;
      setTimeout(function() {
        _planSwitchPending = false;  // 解除互斥锁，允许下一次候补切换
        state.switchingPlan = false;
        if (isInPurchaseTime()) {
          state.isRunning = true;
          startSnipe();
        }
      }, 200);
      return true;
    } catch (e) {
      _planSwitchPending = false;
      log('[候补] 切换异常: ' + e.message);
      return false;
    }
  }

  function updateTargetDisplay() {
    var el = document.getElementById('glm-target');
    if (!el) return;
    var periodLabel = {monthly:'包月', quarterly:'包季', yearly:'包年'}[currentPeriod()] || '包季';
    el.textContent = '目标: ' + currentPlan().toUpperCase() + ' / ' + periodLabel;
  }

  // 主动探测一次服务端 soldOut 状态，直接解析不依赖拦截链（isNearTargetTime 可能为 false）
  async function probeSoldOutStatus() {
    if (state.orderCreated || _confirmedSoldOut) return;
    log('[探测] 主动同步服务端 soldOut 状态...');
    try {
      const resp = await originalFetch(location.origin + '/api/biz/pay/batch-preview', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', 'accept': 'application/json, text/plain, */*' },
        body: '{}',
      });
      if (!resp.ok) { log(`[探测] HTTP ${resp.status}，跳过`); return; }
      const data = _parse(await resp.text()); // 绕过拦截器，直接读原始数据
      const productList = data?.data?.productList || data?.productList || [];
      log(`[探测] productList 共 ${productList.length} 条: ${productList.map(i => `${i?.monthlyOriginalAmount}/${i?.soldOut ?? i?.isSoldOut}`).join(', ')}`);

      // 遍历所有已配置套餐，统计各自 soldOut 状态（按 plan_period 精确匹配）
      const configuredKeys = CONFIG.planPriority.map(p => `${p.plan}_${p.billingPeriod}`);
      const soldOutMap = {}; // plan_period → soldOut bool
      for (const item of productList) {
        if (!item) continue;
        const info = identifyPlanFromProduct(item);
        if (!info) continue;
        const key = `${info.plan}_${info.period}`;
        if (!configuredKeys.includes(key) || key in soldOutMap) continue;
        soldOutMap[key] = item.soldOut === true || item.isSoldOut === true;
      }

      const currentKey = `${currentPlan()}_${currentPeriod()}`;
      // 严格判定：所有配置套餐必须都被 API 确认且为 true
      const allSoldOut = configuredKeys.length > 0 && configuredKeys.every(k => soldOutMap[k] === true);
      const currentPlanSoldOut = soldOutMap[currentKey];

      if (allSoldOut) {
        log(`[探测] 所有已配置套餐均售罄 (${configuredKeys.join(', ')})，停止抢购`);
        confirmSoldOut();
      } else if (currentPlanSoldOut === true) {
        // 服务端明确确认售罄，直接停止，无需等候补机制走完 3 轮
        log(`[探测] 服务端确认 ${currentKey} 售罄，停止抢购`);
        confirmSoldOut();
      } else if (currentPlanSoldOut === false) {
        log(`[探测] 服务端确认 ${currentKey} 有货，继续抢购`);
      } else {
        log(`[探测] 未找到当前套餐 ${currentKey} 的数据，忽略`);
      }
    } catch (e) { log(`[探测] 异常: ${e.message}`); }
  }

  function scheduleWindowEnd() {
    const now = new Date(), end = new Date(now);
    end.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond + 120, 0); // +120s = 10:02
    const ms = end - now;

    const onWindowEnd = () => {
      log('[10:02] 强制拦截窗口结束，改为同步服务端 soldOut 状态');
      if (!state.orderCreated) probeSoldOutStatus();
    };

    if (ms <= 0) {
      // 已过窗口期（如下午打开页面）：立即探测，由服务端决定是否售罄
      onWindowEnd();
      return;
    }
    setTimeout(onWindowEnd, ms);
  }

  function confirmSoldOut() {
    if (_confirmedSoldOut) return;
    _confirmedSoldOut = true;
    log('已确认售罄，停止抢购');
    setStatus('已售罄，明日再抢', '#f44');
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
    state.isRunning = false;
    state.switchingPlan = false; // 防止切换途中被 confirmSoldOut 锁死 setupAutoSnipeOnReady
    notify('GLM 抢购失败', '今日已售罄，明天 10:00 再来！');
    // 同步 DOM：将购买按钮还原为禁用状态，与服务端数据一致
    disablePurchaseButtons();
  }

  function disablePurchaseButtons() {
    const keywords = ['购买', '订阅', '订购', '立即购买', '立即订阅', '特惠订阅', 'Subscribe', 'Buy', 'Purchase'];
    document.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]').forEach(function(btn) {
      if (btn.closest('#glm-sniper-overlay')) return;
      const text = (btn.textContent || '').trim();
      if (keywords.some(function(kw) { return text.includes(kw); })) {
        btn.disabled = true;
        btn.setAttribute('disabled', 'disabled');
        btn.style.pointerEvents = 'none';
        btn.style.opacity = '0.5';
      }
    });
    log('[DOM] 已禁用购买按钮，与服务端售罄状态同步');
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
  // 价格范围兜底：当 monthlyOriginalAmount 为折后价时精确匹配会失败，用范围兜底
  // 三档之间差距足够大，范围不会重叠，即使打折也安全
  const PLAN_PRICE_RANGES = { lite: [30, 80], pro: [100, 200], max: [350, 550] };

  // 周期关键词表：覆盖常见中文表达，防止平台文案微调导致识别失败
  const PERIOD_PATTERNS = {
    quarterly: ['包季', '季度', '季卡', '3个月', '三个月'],
    yearly:    ['包年', '年度', '年卡', '12个月', '一年'],
  };

  // 静默识别套餐计费周期（不输出日志，专供 fixSoldOut 热路径使用）
  function getPeriodFromItem(item) {
    var campaigns = (item && item.campaignDiscountDetails) || [];
    for (var _c = 0; _c < campaigns.length; _c++) {
      var cn = campaigns[_c].campaignName || '';
      for (var _p in PERIOD_PATTERNS) {
        if (PERIOD_PATTERNS[_p].some(function(kw) { return cn.includes(kw); })) return _p;
      }
    }
    return 'monthly';
  }

  function identifyPlanFromProduct(item) {
    const price = item.monthlyOriginalAmount;
    let plan = null;
    for (const [name, p] of Object.entries(PLAN_PRICE_MAP)) {
      if (price === p) { plan = name; break; }
    }
    if (!plan) {
      // 精确匹配失败（可能是折后价），用范围兜底
      for (const [name, [min, max]] of Object.entries(PLAN_PRICE_RANGES)) {
        if (price >= min && price <= max) { plan = name; break; }
      }
      if (plan) {
        log('[识别] 价格 ' + price + ' 精确匹配失败，范围兜底 → ' + plan + '（原价可能已变，建议更新 PLAN_PRICE_MAP）');
      } else {
        log('[识别失败] 未知价格: ' + price + ', productId=' + item.productId + ' — 超出所有已知范围，请更新 PLAN_PRICE_MAP/PLAN_PRICE_RANGES');
        return null;
      }
    }
    let period = 'monthly';
    let matchedCampaign = '';
    const campaigns = item.campaignDiscountDetails || [];
    outer: for (const c of campaigns) {
      const cn = c.campaignName || '';
      for (const [p, patterns] of Object.entries(PERIOD_PATTERNS)) {
        if (patterns.some(kw => cn.includes(kw))) {
          period = p;
          matchedCampaign = cn;
          break outer;
        }
      }
    }
    log('[识别] 价格=' + price + ' → ' + plan + ' | campaignName="' + matchedCampaign + '" → ' + period + ' | productId=' + item.productId);
    return { plan, period };
  }

  function captureProductIdFromData(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.productList && Array.isArray(obj.productList)) {
      // 未命中 PLAN_PRICE_MAP 时，输出全部价格集合辅助诊断
      const unknownPrices = obj.productList
        .filter(item => item && !Object.values(PLAN_PRICE_MAP).includes(item.monthlyOriginalAmount))
        .map(item => item.monthlyOriginalAmount);
      if (unknownPrices.length > 0) {
        log('[诊断] productList 中存在未知价格: [' + unknownPrices.join(', ') + '] — 若套餐调价请更新 PLAN_PRICE_MAP');
      }

      for (const item of obj.productList) {
        if (!item || !item.productId) continue;
        const info = identifyPlanFromProduct(item);
        if (!info) continue;
        const key = info.plan + '_' + info.period;
        _allProductIds[key] = item.productId;
        if (info.plan === currentPlan() && info.period === currentPeriod()) {
          _capturedProductId = item.productId;
          try {
            localStorage.setItem('glm_sniper_pid', JSON.stringify({
              id: item.productId, plan: currentPlan(),
              period: currentPeriod(), ts: Date.now(),
            }));
          } catch (e) {}
        }
      }
      if (Object.keys(_allProductIds).length > 0 && !_capturedProductId) {
        log('[捕获] 找到' + Object.keys(_allProductIds).length + '个产品，但未匹配目标套餐 ' + currentPlan() + '/' + currentPeriod());
        log('[诊断] 已捕获套餐: [' + Object.keys(_allProductIds).join(', ') + ']');
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
    var exactKey = currentPlan() + '_' + currentPeriod();
    if (_allProductIds[exactKey]) {
      _capturedProductId = _allProductIds[exactKey];
      log('[回退] 精确匹配 productId=' + _capturedProductId);
      return _capturedProductId;
    }
    for (const [key, pid] of Object.entries(_allProductIds)) {
      if (key.startsWith(currentPlan() + '_')) {
        _capturedProductId = pid;
        log('[回退] 同套餐匹配 productId=' + pid + ' (' + key + ')');
        return pid;
      }
    }
    if (Object.keys(_allProductIds).length > 0) {
      log('[警告] 已捕获产品但无法匹配 ' + currentPlan() + '/' + currentPeriod() + '，拒绝回退');
    }
    try {
      const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
      if (saved && saved.id && saved.plan === currentPlan() &&
          saved.period === currentPeriod() && Date.now() - saved.ts < 43200000) {
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
        if (shouldInterceptSoldOut()) {
          obj[k] = false;
          log('[拦截] ' + k + ' -> false');
        } else {
          // Fix 4: 区分无价格字段（静默跳过）和价格超范围（输出警告）
          var price = obj.monthlyOriginalAmount;
          var planName = price != null ? getPlanFromPrice(price) : null;
          if (price == null) {
            // 无价格字段，无法识别套餐，静默跳过
          } else if (!planName) {
            log('[候补] 检测到 soldOut=true，但价格 ' + price + ' 超出已知范围，无法识别套餐（请更新 PLAN_PRICE_MAP）');
          // 只在目标时间后才触发候补切换（10:00前 soldOut=true 是"未开放"，不是真售罄）
          } else if (isInPurchaseTime() && planName === currentPlan() && getPeriodFromItem(obj) === currentPeriod() && !_planSwitchPending) {
            // tryNextPlan 内部持有锁；此处检查 _planSwitchPending 仅为减少无效调度
            setTimeout(tryNextPlan, 100);
          }
        }
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
            if (!_capturedProductId) {
              _capturedProductId = bodyObj.productId;
              log('[捕获] productId=' + _capturedProductId);
            } else if (bodyObj.productId !== _capturedProductId) {
              if (_forcePayDialogCalled || state.orderCreated) {
                log('[跳过修正] 支付进行中，保留 productId=' + bodyObj.productId);
              } else {
                log('[修正] productId 不符: ' + bodyObj.productId + ' → ' + _capturedProductId);
                bodyObj.productId = _capturedProductId;
                args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
              }
            }
          } else if (_capturedProductId && !_forcePayDialogCalled && !state.orderCreated) {
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

    // 从 API 响应中捕获 productId（复用价格映射策略，与 JSON.parse 拦截保持一致）
    if (!_capturedProductId && /coding|plan|product|package/i.test(url)) {
      try {
        const clone = res.clone();
        const parsed = await clone.json();
        captureProductIdFromData(parsed?.data || parsed);
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
            if (!_capturedProductId) {
              _capturedProductId = bodyObj.productId;
              log('[捕获] productId=' + _capturedProductId + ' (XHR)');
            } else if (bodyObj.productId !== _capturedProductId) {
              if (_forcePayDialogCalled || state.orderCreated) {
                log('[跳过修正] 支付进行中，保留 productId=' + bodyObj.productId + ' (XHR)');
              } else {
                log('[修正] productId 不符: ' + bodyObj.productId + ' → ' + _capturedProductId + ' (XHR)');
                bodyObj.productId = _capturedProductId;
                args[0] = JSON.stringify(bodyObj);
              }
            }
          } else if (_capturedProductId && !_forcePayDialogCalled && !state.orderCreated) {
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
        GLM Sniper <span style="color:#888;font-size:11px">v${VERSION} console</span>
      </div>
      <div id="glm-target" style="color:#fc0;margin-bottom:4px">目标: ${currentPlan().toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[currentPeriod()]||'包季'}</div>
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

  let _prewarmDone = false; // 防止倒计时预热多次触发

  setInterval(() => {
    const diff = getTarget() - new Date();
    const el = document.getElementById('glm-cd');
    if (!el) return;

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    const ms = diff % 1000;

    if (!_confirmedSoldOut && (state.isRunning || isInPurchaseTime())) {
      el.textContent = '抢购中...';
      el.style.color = '#0f8';
    } else if (diff <= 60000 && diff > 0) {
      el.textContent = s + '.' + String(ms).padStart(3, '0') + 's';
      el.style.color = '#f44';
    } else {
      el.textContent = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
      el.style.color = diff <= 300000 ? '#fc0' : '#fff';
    }

    // 提前60秒预热：直接调API捕获 productId，不调 selectBilling() 避免 soldOut=true 写入 Vue state
    if (diff <= 60000 && diff > 0 && !_prewarmDone && !state.isRunning) {
      _prewarmDone = true;
      log('预热: 直接捕获 productId（不触发 Vue 状态更新）...');
      setStatus('准备中...', '#fc0');
      fetchProductIdDirectly();
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
    const p = periods[currentPeriod()] || periods.quarterly;
    // Fix 3: 先定位目标套餐卡片，避免点到其他套餐的计费周期 tab
    const planWords = {
      lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
      pro:  ['pro', 'Pro', 'PRO', '专业', '进阶'],
      max:  ['max', 'Max', 'MAX', '旗舰', '高级'],
    }[currentPlan()] || [];
    let searchRoot = document;
    for (const el of document.querySelectorAll('div,section,article,li')) {
      const t = el.textContent || '';
      if (planWords.some(k => t.includes(k)) && el.offsetHeight < 800 && el.offsetWidth < 600) {
        searchRoot = el;
        break;
      }
    }
    for (const el of searchRoot.querySelectorAll('div,span,button,a,li,label')) {
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

  async function fetchProductIdDirectly() {
    if (_capturedProductId) return true;
    log('[主动获取] 尝试直接调用产品列表 API...');
    try {
      const resp = await _fetch(location.origin + '/api/biz/pay/batch-preview', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'accept': 'application/json, text/plain, */*',
        },
        body: '{}',
      });
      if (resp.ok) {
        const data = await resp.json();
        captureProductIdFromData(data?.data || data);
        if (_capturedProductId) {
          log('[主动获取] 成功: productId=' + _capturedProductId);
          return true;
        }
      }
    } catch (e) {}
    log('[主动获取] batch-preview 无响应或未匹配到目标套餐');
    return false;
  }

  async function startSnipe() {
    if (state.timerId) { log('[保护] timerId 已存在，跳过重复启动'); return; }
    _forcePayDialogCalled = false; // 新轮次重置，允许支付弹窗再次被触发
    state.switchingPlan = false; // Fix 6: 切换完成，解除锁定
    state.isRunning = true;      // 统一在此设置，防止调用方漏设导致倒计时重复触发
    if (_confirmedSoldOut) {
      log('已确认售罄，不启动抢购');
      setStatus('已售罄，明日再抢', '#f44');
      state.isRunning = false;
      return;
    }
    selectBilling();
    forceSoldOutFalse();
    unlock();
    if (!getProductId()) {
      log('productId 未就绪，等待 batch-preview 响应...');
      setStatus('等待 productId...', '#fc0');
      const got = await waitForProductId(3000);
      if (got) {
        log('productId 已就绪: ' + _capturedProductId);
        setStatus('productId 就绪，开始抢购...', '#0f8');
      } else {
        // 降级：主动调用产品 API 获取
        log('主动获取 productId...');
        setStatus('主动获取 productId...', '#fc0');
        const fetched = await fetchProductIdDirectly();
        if (!fetched) {
          log('警告: productId 获取失败，强行继续（请求可能报错）');
          setStatus('productId 未获取，强行继续...', '#f80');
        }
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
    }[currentPlan()] || [];

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
      if (!isInPurchaseTime()) return;
      if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut || state.switchingPlan) return;

      const bodyText = document.body?.textContent || '';
      const hasError = ['访问人数较多', '请刷新重试', '服务繁忙'].some(kw => bodyText.includes(kw));
      if (hasError) return;

      // 必须找到套餐专属的购买按钮（排除"即刻订阅"等通用 CTA），且按钮不含售罄字样
      const buyKeywords = ['特惠订阅', '特惠购买', '立即购买', '立即订购', '立即订阅'];
      const soldOutKeywords = ['售罄', '补货'];
      const hasBuyButton = Array.from(document.querySelectorAll('button')).some(btn => {
        if (btn.offsetParent === null) return false;
        const text = (btn.textContent || '').trim();
        if (soldOutKeywords.some(kw => text.includes(kw))) return false;
        return buyKeywords.some(kw => text.includes(kw));
      });
      if (!hasBuyButton) return;

      log('页面恢复正常，自动触发抢购!');
      setStatus('页面恢复，正在抢购...', '#0f8');
      state.isRunning = true;
      startSnipe();
    }, 2000);
  }

  // ===== 9. Vue 组件直接操作 =====

  // --- Vue 版本检测 + 统一 walker ---
  function getVueRoot() {
    const app = document.querySelector('#app');
    if (!app) return null;
    if (app.__vue__)               return { ver: 2, root: app.__vue__ };          // Vue 2
    if (app.__vue_app__?._instance) return { ver: 3, root: app.__vue_app__._instance }; // Vue 3
    return null;
  }

  // 统一遍历 Vue 2/3 组件树，对每个组件实例调用 fn(vm, ver)
  function walkVueTree(vm, ver, depth, fn) {
    if (!vm || depth > 10) return;
    fn(vm, ver);
    if (ver === 2) {
      for (const child of (vm.$children || [])) walkVueTree(child, 2, depth + 1, fn);
    } else {
      // Vue 3：通过 subTree vnode 找子组件实例
      const walkVNode = (vnode, d) => {
        if (!vnode || d > 12) return;
        if (vnode.component) walkVueTree(vnode.component, 3, d, fn);
        if (Array.isArray(vnode.children)) {
          vnode.children.forEach(c => c && typeof c === 'object' && walkVNode(c, d + 1));
        }
      };
      if (vm.subTree) walkVNode(vm.subTree, depth + 1);
    }
  }

  // 读取组件数据（Vue 2: $data；Vue 3: proxy 代理对象）
  function getVMData(vm, ver) {
    if (ver === 2) return vm.$data || {};
    return vm.proxy || {};
  }

  // 向组件写入属性
  function setVMProp(vm, ver, key, val) {
    try {
      if (ver === 2) vm[key] = val;
      else if (vm.proxy) vm.proxy[key] = val;
    } catch (e) {}
  }

  function ensureProductId() {
    const pid = getProductId();
    if (!pid) { log('[Vue] 没有捕获到 productId，无法恢复'); return; }

    const vr = getVueRoot();
    if (!vr) { log('[Vue] 未检测到 Vue 实例'); return; }

    let fixed = 0;
    // 第一遍：只修复空值字段
    walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
      const data = getVMData(vm, ver);
      for (const key of Object.keys(data)) {
        if (/product.?id/i.test(key) && !data[key]) {
          setVMProp(vm, ver, key, pid);
          fixed++;
          log('[Vue' + ver + '] 已设置 ' + key + '=' + pid);
        }
      }
    });
    if (fixed === 0) {
      log('[Vue] 未找到空的 productId 字段，尝试广搜...');
      // 第二遍：找到任意 productId 字段强制覆盖
      walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
        if (fixed > 0) return;
        const data = getVMData(vm, ver);
        for (const key of Object.keys(data)) {
          if (/product.?id/i.test(key)) {
            setVMProp(vm, ver, key, pid);
            fixed++;
            log('[Vue' + ver + '] 强制设置 ' + key + '=' + pid);
            return;
          }
        }
      });
    }
  }

  // 直接将 Vue 组件树中所有 soldOut 类响应式属性强制设为 false
  function forceSoldOutFalse() {
    const vr = getVueRoot();
    if (!vr) return;
    let patched = 0;
    walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
      const data = getVMData(vm, ver);
      for (const key of Object.keys(data)) {
        if (/soldOut|isSoldOut|sold_out|is_sold_out/i.test(key) && data[key] === true) {
          setVMProp(vm, ver, key, false);
          patched++;
        }
      }
    });
    if (patched > 0) log(`[Vue] 强制 soldOut=false (${patched}个字段)`);
  }

  // Fix 5: 防止 forcePayDialog 在用户关闭后 1.5s 又重新打开
  var _forcePayDialogCalled = false;

  // 抢购成功后，如果支付弹窗没自动弹出，直接操作 Vue 组件
  function forcePayDialog() {
    if (_forcePayDialogCalled) return;
    _forcePayDialogCalled = true;
    const vr = getVueRoot();
    if (!vr) return;

    let payComp = null;
    walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
      if (payComp) return;
      const data = getVMData(vm, ver);
      if ('payDialogVisible' in data) payComp = { vm, ver };
    });

    if (!payComp) { log('[Vue] 未找到支付组件'); return; }
    const data = getVMData(payComp.vm, payComp.ver);
    if (data.payDialogVisible) { log('[Vue] 支付弹窗已显示'); return; }

    setVMProp(payComp.vm, payComp.ver, 'payDialogVisible', true);
    log('[Vue' + payComp.ver + '] 已直接设置 payDialogVisible=true');
  }

  function patchVueServerBusy() {
    let attempts = 0;
    const tid = setInterval(() => {
      if (++attempts > 30) { clearInterval(tid); return; }
      const vr = getVueRoot();
      if (!vr) return;
      // 支付弹窗已打开后不再清除 isServerBusy，否则 555 响应后弹窗显示 undefined
      if (_forcePayDialogCalled || state.orderCreated) { clearInterval(tid); return; }
      let patched = 0;
      walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
        const data = getVMData(vm, ver);
        if (data.isServerBusy === true) {
          setVMProp(vm, ver, 'isServerBusy', false);
          patched++;
        }
      });
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
    if (saved && saved.id && saved.plan === currentPlan() &&
        saved.period === currentPeriod() && Date.now() - saved.ts < 43200000) {
      _capturedProductId = saved.id;
      log('[localStorage] 预加载 productId=' + saved.id);
    }
  } catch (e) {}
  scheduleWindowEnd();
  var planList = CONFIG.planPriority.map(function(p, i) { return (i === 0 ? '首选' : '候补' + i) + ': ' + p.plan + '/' + p.billingPeriod; }).join('，');
  log('脚本已启动 - ' + planList);
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
  if (isInPurchaseTime()) {
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

  // 调试用：暴露内部状态到 window（控制台可用 __glmSniper.xxx 访问）
  window.__glmSniper = {
    get state() { return state; },
    get confirmedSoldOut() { return _confirmedSoldOut; },
    get cycleCount() { return _soldOutCycleCount; },
    get soldOutInCycle() { return [..._soldOutInCycle]; },
    get planIdx() { return _currentPlanIdx; },
    probe() { return probeSoldOutStatus(); },
    reset() {
      _confirmedSoldOut = false;
      _soldOutCycleCount = 0;
      _soldOutInCycle.clear();
      _planSwitchPending = false;
      _currentPlanIdx = 0;
      _forcePayDialogCalled = false;
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
      state.isRunning = false;
      state.switchingPlan = false;
      log('[Debug] 状态已重置');
    }
  };

  console.log('%c[GLM Sniper] 脚本加载成功! 看右上角悬浮窗', 'color:#0f8;font-size:16px;font-weight:bold');
})();
