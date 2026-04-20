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
    retryInterval: 80,        // 点击间隔(ms)
    maxRetries: 80,           // 最大重试次数
  };

  let state = {
    retryCount: 0,
    isRunning: false,
    orderCreated: false,
    timerId: null,
  };

  // ===== 时间窗口检查: 只在 10:00 前1分钟 ~ 后5分钟内拦截 =====
  function isNearTarget() {
    const now = new Date(), t = new Date(now);
    t.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    const diff = t - now;
    return diff <= 60000 && diff >= -300000;
  }

  // ===== 1. 拦截 JSON.parse =====
  const _parse = JSON.parse;
  JSON.parse = function (...args) {
    let r = _parse.apply(this, args);
    try { if (isNearTarget()) r = fixSoldOut(r); } catch (e) {}
    return r;
  };

  function fixSoldOut(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(fixSoldOut);
    for (const k of Object.keys(obj)) {
      if (/sold.?out/i.test(k) && obj[k] === true) {
        obj[k] = false;
        log('[拦截] ' + k + ' -> false');
      }
      if (typeof obj[k] === 'object') obj[k] = fixSoldOut(obj[k]);
    }
    return obj;
  }

  // ===== 2. 拦截 fetch =====
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    if (!isNearTarget()) return res;
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
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
    return res;
  };

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

  // ===== 4. 倒计时 =====
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

    if (diff <= 60000) {
      el.textContent = s + '.' + String(ms).padStart(3, '0') + 's';
      el.style.color = '#f44';
    } else {
      el.textContent = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
      el.style.color = diff <= 300000 ? '#fc0' : '#fff';
    }

    // 到点开抢
    if (diff <= CONFIG.advanceMs && !state.isRunning) {
      state.isRunning = true;
      log('开始抢购!');
      setStatus('正在抢购...', '#0f8');
      startSnipe();
    }
  }, 50);

  // ===== 5. 抢购 =====
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

  function startSnipe() {
    selectBilling();
    unlock();
    state.timerId = setInterval(() => {
      if (state.orderCreated || state.retryCount >= CONFIG.maxRetries) {
        clearInterval(state.timerId);
        if (!state.orderCreated) {
          log('超时，请手动操作');
          setStatus('抢购超时', '#f44');
        }
        return;
      }
      state.retryCount++;
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
    const buyWords = ['购买', '订阅', '订购', '立即购买', '立即订阅', '特惠购买', 'Subscribe', 'Buy'];
    const planWords = {
      lite: ['lite', 'Lite', 'LITE', '基础', '轻量'],
      pro: ['pro', 'Pro', 'PRO', '专业', '进阶'],
      max: ['max', 'Max', 'MAX', '旗舰', '高级'],
    }[CONFIG.targetPlan] || [];

    // 找套餐卡片
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

  // ===== 6. 监控二维码出现 =====
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
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

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

  // ===== 7. 立即执行一次解锁 =====
  unlock();
  log('脚本已启动 - 目标: ' + CONFIG.targetPlan.toUpperCase());
  log('到 ' + CONFIG.targetHour + ':00 自动抢购');
  setStatus('等待中...', '#aaa');

  // 如果现在刚好是10:00
  const now = new Date();
  if (now.getHours() === CONFIG.targetHour && now.getMinutes() === CONFIG.targetMinute && now.getSeconds() <= 5) {
    log('现在就是抢购时间!');
    state.isRunning = true;
    startSnipe();
  }

  console.log('%c[GLM Sniper] 脚本加载成功! 看右上角悬浮窗', 'color:#0f8;font-size:16px;font-weight:bold');
})();
