  // ==UserScript==
  // @name         GLM Coding Plan Pro 自动抢购
  // @namespace    https://bigmodel.cn
  // @version      1.4.0
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
      // 套餐优先级列表，按顺序尝试；第一个为首选，后续为候补
      // 每项: { plan: 'lite'|'pro'|'max', billingPeriod: 'monthly'|'quarterly'|'yearly' }
      planPriority: [
        { plan: 'pro', billingPeriod: 'quarterly' },
        // { plan: 'lite', billingPeriod: 'quarterly' }, // 候补（取消注释以启用）
      ],
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

    // 当前正在尝试的套餐索引
    let _currentPlanIdx = 0;
    function currentPlan()   { return CONFIG.planPriority[_currentPlanIdx].plan; }
    function currentPeriod() { return CONFIG.planPriority[_currentPlanIdx].billingPeriod; }

    // ==================== 状态 ====================
    let state = {
      retryCount: 0,
      isRunning: false,
      orderCreated: false,
      modalVisible: false,  // 检测到弹窗（验证码/支付）后停止一切刷新
      preheated: false,     // TCP 预热是否已完成
      switchingPlan: false, // tryNextPlan 切换中，防止 setupAutoSnipeOnReady 并发触发
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

    // 实际抢购时间窗口（目标时刻含 advanceMs 提前量 到 后30分钟），不含1分钟预热期
    // 用于 setupAutoSnipeOnReady / init / 倒计时"抢购中"显示，避免提前1分钟触发
    function isInPurchaseTime() {
      const now = new Date();
      const target = new Date(now);
      target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
      const diff = target - now;
      return diff <= CONFIG.advanceMs && diff >= -1800000;
    }

    let _confirmedSoldOut = false;

    function isInRushWindow() {
      // 10:00~10:02 强制拦截窗口
      const now = new Date();
      const target = new Date(now);
      target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
      const elapsed = now - target;
      return elapsed >= 0 && elapsed < 120000;
    }

    function shouldInterceptSoldOut() {
      return isInRushWindow();
    }

    // 通过价格静默识别套餐名（不输出日志，用于 soldOut 检测）
    function getPlanFromPrice(price) {
      if (!price) return null;
      for (const [name, p] of Object.entries(PLAN_PRICE_MAP)) {
        if (price === p) return name;
      }
      for (const [name, [min, max]] of Object.entries(PLAN_PRICE_RANGES)) {
        if (price >= min && price <= max) return name;
      }
      return null;
    }

    // 本轮已确认售罄的套餐集合（key = plan_period），走完一圈全售罄才停
    const _soldOutInCycle = new Set();
    // 连续全售罄的圈数（防止单套餐一次波动就立即 confirmSoldOut）
    let _soldOutCycleCount = 0;
    const SOLD_OUT_CYCLES_REQUIRED = 3;
    // 防止同一 API 响应内多次触发切换
    let _planSwitchPending = false;

    // 切换到下一个候补套餐，循环尝试直到一整圈全售罄
    function tryNextPlan() {
      if (state.orderCreated) return false;
      // 互斥锁：统一在此处持有，使 probeSoldOutStatus / deepModifySoldOut 均受约束，避免并发双跳
      if (_planSwitchPending) { log('[候补] 切换进行中，跳过重复触发'); return false; }
      _planSwitchPending = true;
      try {
        // 标记当前套餐本轮已售罄
        _soldOutInCycle.add(currentPlan() + '_' + currentPeriod());

        const prev = CONFIG.planPriority[_currentPlanIdx];
        _currentPlanIdx++;

        if (_currentPlanIdx >= CONFIG.planPriority.length) {
          // 走完一圈：检查是否全部售罄
          if (_soldOutInCycle.size >= CONFIG.planPriority.length) {
            _soldOutCycleCount++;
            if (_soldOutCycleCount >= SOLD_OUT_CYCLES_REQUIRED) {
              log(`[候补] 所有套餐已连续 ${SOLD_OUT_CYCLES_REQUIRED} 圈售罄，停止抢购`);
              _planSwitchPending = false;
              confirmSoldOut();
              return false;
            }
            log(`[候补] 全圈售罄 (第 ${_soldOutCycleCount}/${SOLD_OUT_CYCLES_REQUIRED} 圈)，继续轮询...`);
          } else {
            // 本圈并非全部售罄（可能是波动），重置连续计数，重新从头开始
            _soldOutCycleCount = 0;
            log(`[候补] 轮询一圈未全售罄，重新从 ${CONFIG.planPriority[0].plan} 开始...`);
          }
          _currentPlanIdx = 0;
          _soldOutInCycle.clear();
        }

        const next = CONFIG.planPriority[_currentPlanIdx];
        const isSamePlan = prev.plan === next.plan && prev.billingPeriod === next.billingPeriod;
        if (isSamePlan) {
          log(`[候补] ${prev.plan}/${prev.billingPeriod} 售罄，继续轮询...`);
        } else {
          log(`[候补] ${prev.plan}/${prev.billingPeriod} 售罄 → 切换到 ${next.plan}/${next.billingPeriod}`);
          notify('GLM 候补切换', `${prev.plan} 已售罄，正在尝试 ${next.plan}`);
        }
        _capturedProductId = null;
        getProductId();
        updateTargetDisplay();
        setStatus(`候补: ${next.plan.toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[next.billingPeriod]||'包季'}`, '#ffaa00');
        if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
        state.switchingPlan = true; // Fix 6: 防止 setupAutoSnipeOnReady 并发触发
        state.isRunning = false;
        state.retryCount = 0;      // Fix 2: 重置重试计数，候补套餐获得完整的重试次数
        setTimeout(() => {
          _planSwitchPending = false;  // 解除互斥锁，允许下一次候补切换
          state.switchingPlan = false; // 无论是否立即触发，都要解除锁定
          if (isInPurchaseTime()) {    // 只在目标时间到达后才直接重启（避免提前60秒误触发）
            state.isRunning = true;
            startSnipe();
          }
          // 未到时间时由倒计时 / setupAutoSnipeOnReady 在目标时刻正常触发
        }, 200);
        return true;
      } catch (e) {
        _planSwitchPending = false;
        log(`[候补] 切换异常: ${e.message}`);
        return false;
      }
    }

    // 更新 overlay 中的套餐显示
    function updateTargetDisplay() {
      const el = document.getElementById('glm-target');
      if (!el) return;
      const periodLabel = {monthly:'包月', quarterly:'包季', yearly:'包年'}[currentPeriod()] || '包季';
      el.textContent = `目标: ${currentPlan().toUpperCase()} / ${periodLabel}`;
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
        const data = originalParse(await resp.text()); // 绕过拦截器，直接读原始数据
        const productList = data?.data?.productList || data?.productList || [];
        log(`[探测] productList 共 ${productList.length} 条: ${productList.map(i => `${i?.monthlyOriginalAmount}/${i?.soldOut ?? i?.isSoldOut}`).join(', ')}`);

        // 遍历所有已配置套餐，统计各自 soldOut 状态（按 plan_period 精确匹配，避免混淆同套餐不同周期）
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
        // 严格判定：所有配置的套餐必须都被 API 确认（在 soldOutMap 中）且为 true
        // 若某条目被 API 静默过滤（不返回），foundKeys 不含它，旧写法会误判为全售罄
        const allSoldOut = configuredKeys.length > 0 && configuredKeys.every(k => soldOutMap[k] === true);
        const currentPlanSoldOut = soldOutMap[currentKey];

        if (allSoldOut) {
          // 所有配置套餐均已确认售罄，此时可以直接停止，无需等候补机制走完
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
      const now = new Date();
      const end = new Date(now);
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
      setStatus('已售罄，明日再抢', '#ff4444');
      // 停止所有正在运行的抢购逻辑
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
      state.isRunning = false;
      state.switchingPlan = false; // 防止切换途中被 confirmSoldOut 锁死 setupAutoSnipeOnReady
      notify('GLM 抢购失败', '今日已售罄，明天 10:00 再来！');
      // 同步 DOM：将购买按钮还原为禁用状态，与服务端数据一致
      disablePurchaseButtons();
    }

    function disablePurchaseButtons() {
      const keywords = ['购买', '订阅', '订购', '立即购买', '立即订阅', '特惠订阅', 'Subscribe', 'Buy', 'Purchase'];
      document.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]').forEach((btn) => {
        if (btn.closest('#glm-sniper-overlay')) return; // 不影响脚本自身的按钮
        const text = (btn.textContent || '').trim();
        if (keywords.some((kw) => text.includes(kw))) {
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
    // 价格范围兜底：当 monthlyOriginalAmount 为折后价时精确匹配会失败，用范围兜底
    // 三档之间差距足够大，范围不会重叠，即使打折也安全
    const PLAN_PRICE_RANGES = { lite: [30, 80], pro: [100, 200], max: [350, 550] };

    // 周期关键词表：覆盖常见中文表达，防止平台文案微调导致识别失败
    const PERIOD_PATTERNS = {
      quarterly: ['包季', '季度', '季卡', '3个月', '三个月'],
      yearly:    ['包年', '年度', '年卡', '12个月', '一年'],
    };

    // 静默识别套餐计费周期（不输出日志，专供 deepModifySoldOut 热路径使用）
    function getPeriodFromItem(item) {
      const campaigns = item?.campaignDiscountDetails || [];
      for (const c of campaigns) {
        const cn = c.campaignName || '';
        for (const [p, patterns] of Object.entries(PERIOD_PATTERNS)) {
          if (patterns.some(kw => cn.includes(kw))) return p;
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
          log(`[识别] 价格 ${price} 精确匹配失败，范围兜底 → ${plan}（原价可能已变，建议更新 PLAN_PRICE_MAP）`);
        } else {
          log(`[识别失败] 未知价格: ${price}, productId=${item.productId} — 超出所有已知范围，请更新 PLAN_PRICE_MAP/PLAN_PRICE_RANGES`);
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

      log(`[识别] 价格=${price} → ${plan} | campaignName="${matchedCampaign}" → ${period} | productId=${item.productId}`);
      return { plan, period };
    }

    function captureProductIdFromData(obj) {
      if (!obj || typeof obj !== 'object') return;

      // 检测 batch-preview 响应结构: { data: { productList: [...] } }
      if (obj.productList && Array.isArray(obj.productList)) {
        // 未命中 PLAN_PRICE_MAP 时，输出全部价格集合辅助诊断
        const unknownPrices = obj.productList
          .filter(item => item && !Object.values(PLAN_PRICE_MAP).includes(item.monthlyOriginalAmount))
          .map(item => item.monthlyOriginalAmount);
        if (unknownPrices.length > 0) {
          log(`[诊断] productList 中存在未知价格: [${unknownPrices.join(', ')}] — 若套餐调价请更新 PLAN_PRICE_MAP`);
        }

        for (const item of obj.productList) {
          if (!item || !item.productId) continue;
          const info = identifyPlanFromProduct(item);
          if (!info) continue;
          const key = `${info.plan}_${info.period}`;
          _allProductIds[key] = item.productId;
          if (info.plan === currentPlan() && info.period === currentPeriod()) {
            _capturedProductId = item.productId;
            // 持久化到 localStorage，刷新后立即可用，无需等 API 响应
            try {
              localStorage.setItem('glm_sniper_pid', JSON.stringify({
                id: item.productId, plan: currentPlan(),
                period: currentPeriod(), ts: Date.now(),
              }));
            } catch (e) {}
          }
        }
        if (Object.keys(_allProductIds).length > 0 && !_capturedProductId) {
          log(`[捕获] 找到${Object.keys(_allProductIds).length}个产品，但未匹配目标套餐 ${currentPlan()}/${currentPeriod()}`);
          log(`[诊断] 已捕获套餐: [${Object.keys(_allProductIds).join(', ')}]`);
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
      const exactKey = `${currentPlan()}_${currentPeriod()}`;
      if (_allProductIds[exactKey]) {
        _capturedProductId = _allProductIds[exactKey];
        log(`[回退] 精确匹配 productId=${_capturedProductId} (${exactKey})`);
        return _capturedProductId;
      }
      // 同套餐不同周期
      for (const [key, pid] of Object.entries(_allProductIds)) {
        if (key.startsWith(currentPlan() + '_')) {
          _capturedProductId = pid;
          log(`[回退] 同套餐匹配 productId=${pid} (${key})`);
          return pid;
        }
      }
      // 任意回退已移除：防止静默下错套餐。若无精确匹配或同套餐匹配，返回 null 并警告。
      if (Object.keys(_allProductIds).length > 0) {
        log(`[警告] 已捕获产品但无法匹配 ${currentPlan()}/${currentPeriod()}，拒绝回退`);
      }
      // localStorage 兜底：读取上次捕获的值（12小时内有效）
      try {
        const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
        if (saved && saved.id && saved.plan === currentPlan() &&
            saved.period === currentPeriod() && Date.now() - saved.ts < 43200000) {
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
            if (shouldInterceptSoldOut()) {
              obj[key] = false;
              log(`[拦截] 将 ${key} 从 true 改为 false`);
            } else {
              // 窗口外：soldOut=true 原样透传 Vue；若是当前目标套餐则切换候补
              const price = obj.monthlyOriginalAmount;
              const planName = price != null ? getPlanFromPrice(price) : null;
              if (price == null) {
                // Fix 4: 无价格字段，无法识别套餐，静默跳过（避免误切换）
              } else if (!planName) {
                log(`[候补] 检测到 soldOut=true，但价格 ${price} 超出已知范围，无法识别套餐（请更新 PLAN_PRICE_MAP）`);
              // 只在目标时间后才触发候补切换（10:00前 soldOut=true 是"未开放"状态，不代表真正售罄）
              } else if (isInPurchaseTime() && planName === currentPlan() && getPeriodFromItem(obj) === currentPeriod() && !_planSwitchPending) {
                // tryNextPlan 内部持有锁；此处检查 _planSwitchPending 仅为减少无效调度
                setTimeout(tryNextPlan, 100);
              }
            }
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
            if (bodyObj.productId) {
              if (!_capturedProductId) {
                // 价格识别尚未完成，先暂存请求中的 productId
                _capturedProductId = bodyObj.productId;
                log(`[捕获] productId=${_capturedProductId}`);
              } else if (bodyObj.productId !== _capturedProductId) {
                if (_forcePayDialogCalled || state.orderCreated) {
                  // 支付流程已进行中，不修正 productId，避免弹窗数据错乱
                  log(`[跳过修正] 支付进行中，保留 productId=${bodyObj.productId}`);
                } else {
                  // 请求中的 productId 与目标套餐不符（前端默认选了其他套餐），替换为正确的
                  log(`[修正] productId 不符: ${bodyObj.productId} → ${_capturedProductId}`);
                  bodyObj.productId = _capturedProductId;
                  args[1] = { ...args[1], body: JSON.stringify(bodyObj) };
                }
              }
            } else if (_capturedProductId && !_forcePayDialogCalled && !state.orderCreated) {
              // 请求中没有 productId，注入（仅在支付未开始前注入）
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

      // 从 API 响应中捕获 productId（复用价格映射策略，与 JSON.parse 拦截保持一致）
      if (!_capturedProductId && /coding|plan|product|package/i.test(url)) {
        try {
          const clone = response.clone();
          const parsed = await clone.json();
          captureProductIdFromData(parsed?.data || parsed);
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
              if (!_capturedProductId) {
                _capturedProductId = bodyObj.productId;
                log(`[捕获] productId=${_capturedProductId} (XHR)`);
              } else if (bodyObj.productId !== _capturedProductId) {
                if (_forcePayDialogCalled || state.orderCreated) {
                  log(`[跳过修正] 支付进行中，保留 productId=${bodyObj.productId} (XHR)`);
                } else {
                  log(`[修正] productId 不符: ${bodyObj.productId} → ${_capturedProductId} (XHR)`);
                  bodyObj.productId = _capturedProductId;
                  args[0] = JSON.stringify(bodyObj);
                }
              }
            } else if (_capturedProductId && !_forcePayDialogCalled && !state.orderCreated) {
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
            GLM Coding Plan Sniper <span style="color:#888;font-size:11px">${typeof GM_info !== 'undefined' ? 'v' + GM_info.script.version : ''}</span>
          </div>
          <div id="glm-target" style="color: #ffcc00; margin-bottom: 4px;">
            目标: ${currentPlan().toUpperCase()} / ${{monthly:'包月',quarterly:'包季',yearly:'包年'}[currentPeriod()]||'包季'}
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
      let _prewarmDone = false; // 防止多次预热

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
          // 正在抢购时段 (isRunning 或已到目标时刻) 不显示倒计时；已确认售罄则跳过
          if (!_confirmedSoldOut && (state.isRunning || isInPurchaseTime())) {
            el.textContent = '抢购中...';
            el.style.color = '#00ff88';
          } else if (diff <= 60000 && diff > 0) {
            // 最后60秒显示毫秒倒计时
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

        // 提前60秒预热：直接调API捕获 productId（不经过Vue数据流，不更新Vue soldOut状态）
        // 注意：不在此处调用 selectBillingPeriod()，避免9:59的响应把 soldOut=true 写入Vue state
        // 到10:00 selectBillingPeriod() + forceSoldOutFalse() 才让Vue得到 soldOut=false
        if (diff <= 60000 && diff > 0 && !_prewarmDone && !state.isRunning) {
          _prewarmDone = true;
          log('预热: 直接捕获 productId（不触发 Vue 状态更新）...');
          setStatus('准备中...', '#ffcc00');
          fetchProductIdDirectly();
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

    // ==================== 4d. 主动获取 productId（降级策略）====================
    // waitForProductId 超时后的最后手段：直接调用产品列表 API
    async function fetchProductIdDirectly() {
      if (_capturedProductId) return true;
      log('[主动获取] 尝试直接调用产品列表 API...');
      try {
        const resp = await originalFetch(location.origin + '/api/biz/pay/batch-preview', {
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
            log(`[主动获取] 成功: productId=${_capturedProductId}`);
            return true;
          }
        }
      } catch (e) {}
      log('[主动获取] batch-preview 无响应或未匹配到目标套餐');
      return false;
    }

    // ==================== 5. 核心抢购逻辑 ====================
    function selectBillingPeriod() {
      const periodKeywords = {
        monthly:   { match: '包月', exclude: ['包季', '包年'], label: '连续包月' },
        quarterly: { match: '包季', exclude: ['包月', '包年'], label: '连续包季' },
        yearly:    { match: '包年', exclude: ['包月', '包季'], label: '连续包年' },
      };
      const period = periodKeywords[currentPeriod()] || periodKeywords.quarterly;

      // Fix 3: 先定位目标套餐卡片，避免点到其他套餐的计费周期 tab
      const planKeywords = {
        lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
        pro:  ['pro', 'Pro', 'PRO', '专业', '进阶'],
        max:  ['max', 'Max', 'MAX', '旗舰', '高级'],
      };
      const targetPlanKeys = planKeywords[currentPlan()] || [];
      let searchRoot = document;
      for (const el of document.querySelectorAll('div, section, article, li')) {
        const text = el.textContent || '';
        if (targetPlanKeys.some(k => text.includes(k)) && el.offsetHeight < 800 && el.offsetWidth < 600) {
          searchRoot = el;
          break;
        }
      }

      const tabs = searchRoot.querySelectorAll('div, span, button, a, li, label');
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
      if (state.timerId) { log('[保护] timerId 已存在，跳过重复启动'); return; }
      _forcePayDialogCalled = false; // 新轮次重置，允许支付弹窗再次被触发
      state.switchingPlan = false; // Fix 6: 切换完成，解除锁定
      state.isRunning = true;      // 统一在此设置，防止调用方（tryNextPlan）漏设导致倒计时重复触发
      // 已确认售罄时不启动抢购
      if (_confirmedSoldOut) {
        log('已确认售罄，不启动抢购');
        setStatus('已售罄，明日再抢', '#ff4444');
        state.isRunning = false;
        return;
      }

      // 先选择计费周期（点击会触发 batch-preview API，进而捕获 productId）
      selectBillingPeriod();
      // 直接将 Vue 响应式 soldOut 状态强制置 false（应对预热缓存导致 Vue 仍持有 soldOut=true）
      forceSoldOutFalse();
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
          // 降级：主动调用产品 API 获取
          log('主动获取 productId...');
          setStatus('主动获取 productId...', '#ffcc00');
          const fetched = await fetchProductIdDirectly();
          if (!fetched) {
            log('警告: productId 获取失败，强行继续（请求可能报错）');
            setStatus('productId 未获取，强行继续...', '#ff8800');
          }
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

      const targetPlanKeys = planKeywords[currentPlan()] || [];

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
        `[data-plan="${currentPlan()}"]`,
        `[data-type="${currentPlan()}"]`,
        `#${currentPlan()}-buy-btn`,
        `#buy-${currentPlan()}`,
        `.${currentPlan()}-purchase`,
        `[data-plan-type="${currentPlan()}"]`,
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
        // 抢购时间窗口内才尝试恢复（与 isNearTargetTime 保持一致）
        if (!isNearTargetTime()) return;
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
      // 每2秒检测：如果已到目标时刻（含 advanceMs），页面正常，且还没开始抢购，就自动开始
      setInterval(() => {
        if (!isInPurchaseTime()) return;
        if (state.isRunning || state.orderCreated || state.modalVisible || _confirmedSoldOut || state.switchingPlan) return;

        // 检测页面是否有购买按钮（说明页面正常加载了）
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

        // 页面正常且有购买按钮，自动触发抢购
        log('页面恢复正常，自动触发抢购!');
        setStatus('页面恢复，正在抢购...', '#00ff88');
        state.isRunning = true;
        startSnipe();
      }, 2000);
    }

    // ==================== 10. Vue 组件直接操作 ====================

    // --- Vue 版本检测 + 统一 walker ---
    function getVueRoot() {
      const app = document.querySelector('#app');
      if (!app) return null;
      if (app.__vue__)              return { ver: 2, root: app.__vue__ };          // Vue 2
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

    // 确保 Vue 组件中 productId 存在，防止验证码后数据丢失
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
            log(`[Vue${ver}] 已设置 ${key}=${pid}`);
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
              log(`[Vue${ver}] 强制设置 ${key}=${pid}`);
              return;
            }
          }
        });
      }
    }

    // 直接将 Vue 组件树中所有 soldOut 类响应式属性强制设为 false
    // 应对预热阶段 batch-preview 将 soldOut=true 写入 Vue state 导致 click handler 内部短路的问题
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

    // Fix 5: 防止 forcePayDialog 在用户关闭弹窗后 1.5s 又重新打开
    let _forcePayDialogCalled = false;

    // 抢购成功后，如果支付弹窗没自动弹出，直接操作 Vue 组件
    function forcePayDialog() {
      if (_forcePayDialogCalled) return; // 只触发一次，避免重开已关弹窗
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
      log(`[Vue${payComp.ver}] 已直接设置 payDialogVisible=true`);
    }

    // 定时 patch Vue 组件的 isServerBusy
    function patchVueServerBusy() {
      let attempts = 0;
      const tid = setInterval(() => {
        if (++attempts > 30) { clearInterval(tid); return; }
        const vr = getVueRoot();
        if (!vr) return;
        let patched = 0;
        // 支付弹窗已打开（有真实订单数据），不再清除 isServerBusy
        // 否则 555 响应后平台标记 isServerBusy=true，清除会导致弹窗显示 undefined
        if (_forcePayDialogCalled || state.orderCreated) { clearInterval(tid); return; }
        walkVueTree(vr.root, vr.ver, 0, (vm, ver) => {
          const data = getVMData(vm, ver);
          if (data.isServerBusy === true) {
            setVMProp(vm, ver, 'isServerBusy', false);
            patched++;
          }
        });
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

      // 通知权限：不自动请求（避免被浏览器静默拒绝），由用户点击悬浮窗按钮触发
      // 已授权时更新按钮文字
      if (Notification.permission === 'granted') {
        setTimeout(() => {
          const btn = document.getElementById('glm-notif-btn');
          if (btn) btn.textContent = '🔔 通知已开启';
        }, 500);
      }

      // 从 localStorage 预加载上次捕获的 productId（刷新后立即可用）
      try {
        const saved = JSON.parse(localStorage.getItem('glm_sniper_pid') || 'null');
        if (saved && saved.id && saved.plan === currentPlan() &&
            saved.period === currentPeriod() && Date.now() - saved.ts < 43200000) {
          _capturedProductId = saved.id;
          log(`[localStorage] 预加载 productId=${saved.id}`);
        }
      } catch (e) {}

      // 强制拦截窗口结束时（10:02）改为同步服务端 soldOut 状态
      scheduleWindowEnd();

      // 延迟校准时间 + patch Vue isServerBusy + 定期捕获 productId
      setTimeout(calibrateTime, 2000);
      patchVueServerBusy();
      // 定期检查 productId 是否已捕获（直到成功）
      const pidTimer = setInterval(() => {
        if (_capturedProductId) { clearInterval(pidTimer); return; }
        getProductId();
      }, 3000);

      const planList = CONFIG.planPriority.map((p, i) => `${i === 0 ? '首选' : '候补' + i}: ${p.plan}/${p.billingPeriod}`).join('，');
      log(`脚本已启动 - ${planList}`);
      log(`抢购时间: 每天 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2, '0')}:${String(CONFIG.targetSecond).padStart(2, '0')}`);
      log('提前10秒自动刷新，到点自动抢购');
      log('页面加载失败会自动强刷');
      log('检测到验证码/支付弹窗会冻结刷新');

      // 如果当前已经是抢购时间窗口内（刚好打开页面），立即开始
      if (isInPurchaseTime()) {
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

    /* 调试用：暴露内部状态到 window（控制台可用 __glmSniper.xxx 访问）
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
    */

    init();
  })();
