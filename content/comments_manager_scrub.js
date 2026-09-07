/**
 * FB 评论私信管家 - Facebook 评论管理工具单工作页 v2.12.2
 *
 * 每个工作标签页执行同一套循环：
 * 最新评论优先 -> 单工作页锁定 -> 直接点击该评论行的“发消息” ->
 * 必须弹出 Messenger 私信框 -> 写入并发送 -> 确认成功 -> 记录去重 ->
 * 回到顶部重新检查最新评论。顶部没有可处理评论时才继续向下滚动旧评论。
 *
 * v2.12.2：兼容评论管理工具新 DOM（role=article 评论行、html-li 内 div[role=button]「发消息」、
 * 点击后打开 docked Messenger 聊天窗而不是旧的 “通过 Messenger 回复” dialog）。旧结构识别逻辑保留。
 * v2.12.3：拆开粘在用户名后的相对时间（几秒前/幾分鐘前/a few seconds ago），避免私信模板带上中文时间。
 */

(() => {
  'use strict';

  const VERSION = '1.0.3';
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function setStatusMessage(message) {
    return sendRuntimeMessage({ action: 'SET_STATUS_MESSAGE', message: String(message || '').slice(0, 500) });
  }

  const MESSAGE_WORDS = [
    '发消息', '發消息', '发送消息', '發送訊息', '傳送訊息',
    'Send message', 'Message', 'Pošalji poruku', 'Pošalji',
    'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message'
  ];
  const REPLY_WORDS = ['回复', '回覆', 'Reply', 'Odgovori', 'Responder', 'Répondre'];
  const VIEW_REPLY_WORDS = ['查看回复', '查看回覆', 'View replies', 'View reply', 'Prikaži odgovore', 'Pogledaj odgovore'];
  const HIDE_WORDS = ['隐藏', '隱藏', 'Hide', 'Sakrij', 'Ocultar', 'Masquer'];
  const SEND_WORDS = [
    '发送', '發送', '传送', '傳送',
    'Send', 'Pošalji', 'Enviar', 'Envoyer',
    '按 Enter 发送', '按 Enter 發送', 'Press Enter to send'
  ];
  const BACK_WORDS = [
    '返回评论', '返回評論', '返回', 'Back to comment', 'Back', 'Nazad',
    '关闭', '關閉', 'Close', 'Zatvori', '取消', 'Cancel', 'Otkaži'
  ];
  const SHARE_WORDS = ['分享', 'Share', 'Podeli', 'Compartir', 'Partager'];
  const PRIVATE_DIALOG_WORDS = [
    '通过 Messenger 回复', '通過 Messenger 回覆', 'Reply via Messenger',
    'Reply through Messenger', 'Respond via Messenger', 'Odgovori putem Messengera',
    'Odgovori preko Messengera',
    '发消息给', '發消息給', '发送消息给', '發送訊息給', 'Send message to',
    '在 Messenger 悄悄回复', '在 Messenger 悄悄回覆', 'privately in Messenger',
    'Pošalji poruku', 'Pošalji poruku korisniku',
    '按 Enter 发送', '按 Enter 發送', 'Press Enter to send'
  ];
  const MESSENGER_COMPOSER_LABELS = [
    'aa', '发消息', '發消息', '写消息', '寫訊息', '输入消息', '輸入訊息',
    'message', 'send a message', 'poruka'
  ];
  const STOP_WORDS = [
    '验证码', '安全检查', 'Security Check Required', 'Security check',
    "You're Temporarily Blocked", 'Action Blocked', '您已被限制使用此功能',
    '你的账户暂时受到限制', '账号受到限制', '帳號受到限制',
    'Confirm your identity', 'Potvrdite svoj identitet'
  ];
  const ACTION_WORDS = [...MESSAGE_WORDS, ...REPLY_WORDS, ...VIEW_REPLY_WORDS, ...HIDE_WORDS];
  const ALL_COMMENTS_WORDS = ['所有评论', '所有評論', 'All comments', 'Svi komentari'];
  const UNREPLIED_WORDS = ['你未回复', '你未回覆', '未回复', '未回覆', "You haven't replied", 'Not replied', 'Niste odgovorili'];
  const REPLIED_WORDS = ['你已回复', '你已回覆', '已回复', '已回覆', 'You replied', 'Replied', 'Odgovorili ste'];

  let monitorPromise = null;
  let workerSlot = 0;
  let mutationWake = false;
  let observer = null;
  let historyScrollTop = 0;
  let currentTaskKey = '';
  let lastFilterAttemptAt = 0;
  let filterHandledThisDocument = false;
  let filterChangeInFlight = false;
  let filterRetryNotBefore = 0;
  const FILTER_ATTEMPT_TS_KEY = 'fb_dm_all_comments_filter_attempt_ts_v290';

  console.log(`FB Comments Manager Scrub v${VERSION} loaded.`);

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req.action === 'WAKE_INBOX_WORKER' || req.action === 'WAKE_COMMENTS_MANAGER_WORKER') {
      mutationWake = true;
      if (req.slot) workerSlot = Number(req.slot || workerSlot || 0);
      boot();
      sendResponse({ status: 'AWAKE', slot: workerSlot });
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.settings || changes.workerReservations || changes.rules || changes.processedComments) mutationWake = true;
  });

  attachObserver();
  boot();

  async function boot() {
    if (monitorPromise) return monitorPromise;
    monitorPromise = (async () => {
      const role = await sendRuntimeMessage({ action: 'GET_TAB_ROLE' });
      if (!role || role.status !== 'OK' || role.role !== 'worker') return;
      workerSlot = Number(role.slot || 0);
      if (!workerSlot) return;
      await runWorker(workerSlot);
    })().finally(() => {
      monitorPromise = null;
      currentTaskKey = '';
    });
    return monitorPromise;
  }

  function attachObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => { mutationWake = true; });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function runWorker(slot) {
    await heartbeat(slot);

    while (true) {
      const settings = await StorageUtil.getSettings();
      if (!settings.isRunning) return;

      if (settings.isPaused) {
        await heartbeat(slot);
        await sleep(900);
        continue;
      }

      if (!isCommentsManagerPage()) {
        // v2.12.1: 内容脚本绝不主动改写 location.href。
        // Facebook 评论管理工具可能会被内部路由重写 URL；旧版在这里强制跳回固定地址，
        // 会与 Facebook 自己的路由来回打架，造成看起来“无限刷新”。
        await setStatusMessage(`工作页 当前未识别到评论管理工具界面；插件不会自动跳转或刷新，请保持此工作标签页停留在“评论管理工具”。`);
        await heartbeat(slot);
        await waitForWake(4000);
        continue;
      }

      if (checkEmergencyBrake(settings)) return;

      const ready = await waitForCommentsManagerReady(18000);
      if (!ready) {
        await setStatusMessage(`工作页 正在等待评论管理工具正常加载；不会因为加载中而反复刷新。`);
        await heartbeat(slot);
        await waitForWake(2200);
        continue;
      }

      // 只通过界面点击把“你未回复/你已回复”切到“所有评论”。
      // 这里绝不刷新页面，避免筛选动作形成刷新死循环。
      if (settings.forceAllCommentsFilter !== false) {
        const filter = await ensureAllCommentsFilter(slot);
        // 筛选失败不再阻塞评论扫描，更不会为了筛选而刷新页面。
        // 如果 Facebook 自己因为切换筛选发生导航，sessionStorage 的跨页面保护会阻止短时间内再次点击形成循环。
        if (filter.changed) {
          await sleep(900);
          await waitForCommentsManagerReady(12000);
        }
      }

      // v2.12.1：内容脚本完全没有刷新权限。
      // 唯一的刷新来自后台 chrome.alarms，周期由控制面板设置。

      const scrollHost = findCommentsScrollHost();
      await heartbeat(slot);
      const claimed = await findAndClaimNextTask(scrollHost, settings, slot);

      if (!claimed) {
        await setStatusMessage(`工作页 暂无可处理评论；保持当前页面稳定。后台会按控制面板设置的分钟周期刷新，不会高频刷新。`);

        // v2.12.1：空闲时只补扫当前 DOM；页面刷新由后台可配置的周期定时器统一控制。
        await waitForWake(Math.max(1200, Number(settings.scanIntervalSeconds || 3) * 1000));
        continue;
      }

      currentTaskKey = claimed.taskKey;
      const outcome = await processClaimedTask(claimed, scrollHost, settings, slot);
      currentTaskKey = '';

      if (outcome?.outcome === 'sent') {
        // v2.12.1：发送成功后只做两件事：成功记录已经由后台完成；然后继续扫描下一条。
        // 不刷新页面。这样连续处理时页面不会抖动，也不会出现“刚发一条就一直刷新”的状态。
        const waitMs = Math.max(300, Number(settings.postSendWaitSeconds ?? 10) * 1000);
        await sleep(waitMs);
        setScrollTop(scrollHost, 0);
        await sleep(350);
        continue;
      }

      // 失败达到上限/冷却/任务已被占用等情况不刷新，直接继续下一条，避免页面抖动。
      setScrollTop(scrollHost, 0);
      await sleep(Math.max(350, Number(settings.scanIntervalSeconds || 3) * 350));
    }
  }

  async function ensureAllCommentsFilter(slot) {
    const now = Date.now();
    const current = findCommentFilterButton();

    if (current && isAllCommentsLabel(getControlLabel(current))) {
      filterHandledThisDocument = true;
      try { sessionStorage.setItem(FILTER_ATTEMPT_TS_KEY, String(now)); } catch (e) {}
      try { await sendRuntimeMessage({ action: 'SET_FILTER_GUARD', at: now }); } catch (e) {}
      return { ok: true, changed: false, stable: true };
    }

    // 关键修复：这个保护跨 document reload 保留。
    // 旧版只用 filterHandledThisDocument（纯内存变量），Facebook 一旦因为筛选切换做一次导航，
    // 变量就会清零，脚本又会再次点击“所有评论”，从而形成 筛选->加载->再筛选->再加载 的死循环。
    let lastPersistentAttempt = 0;
    try { lastPersistentAttempt = Number(sessionStorage.getItem(FILTER_ATTEMPT_TS_KEY) || 0); } catch (e) {}
    try {
      const guardReply = await sendRuntimeMessage({ action: 'GET_FILTER_GUARD' });
      lastPersistentAttempt = Math.max(lastPersistentAttempt, Number(guardReply?.at || 0));
    } catch (e) {}
    if (lastPersistentAttempt && now - lastPersistentAttempt < 4.5 * 60 * 1000) {
      filterHandledThisDocument = true;
      return { ok: true, changed: false, guarded: true };
    }

    if (filterHandledThisDocument) return { ok: true, changed: false, stable: true };

    if (!current) {
      if (now - lastFilterAttemptAt > 5000) {
        lastFilterAttemptAt = now;
        await setStatusMessage(`工作页 暂未找到评论筛选按钮；继续扫描当前评论，不刷新页面。`);
      }
      return { ok: true, changed: false };
    }

    if (filterChangeInFlight || now < filterRetryNotBefore) return { ok: true, changed: false };

    filterChangeInFlight = true;
    lastFilterAttemptAt = now;
    // 先写持久保护，再点击。即便点击后 Facebook 立刻触发完整页面导航，下一份 content script 也不会重复点击。
    try { sessionStorage.setItem(FILTER_ATTEMPT_TS_KEY, String(now)); } catch (e) {}
    try { await sendRuntimeMessage({ action: 'SET_FILTER_GUARD', at: now }); } catch (e) {}
    filterHandledThisDocument = true;

    try {
      safeClick(current);
      await sleep(650);

      const allOption = findVisibleAllCommentsOption(current);
      if (!allOption) {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        } catch (e) {}
        filterRetryNotBefore = Date.now() + 4.5 * 60 * 1000;
        await setStatusMessage(`工作页 本轮未找到“所有评论”菜单项；5分钟内不会再次点击筛选，也不会刷新页面。`);
        return { ok: true, changed: false };
      }

      safeClick(allOption);
      await setStatusMessage(`工作页 已尝试切换到“所有评论”。5分钟内不会再次点击筛选；等待 Facebook 自己完成列表加载。`);
      await waitForCommentRowsAfterFilter(15000);
      return { ok: true, changed: true, stable: true };
    } finally {
      filterChangeInFlight = false;
    }
  }

  function findCommentFilterButton() {
    const candidates = Array.from(document.querySelectorAll('[role="button"], button, [aria-haspopup="menu"], [aria-haspopup="listbox"]')).filter(isVisible);
    const labels = [...ALL_COMMENTS_WORDS, ...UNREPLIED_WORDS, ...REPLIED_WORDS];
    const hits = [];
    for (const el of candidates) {
      const value = getControlLabel(el);
      if (!value || value.length > 80) continue;
      if (!labels.some(word => exactishMatch(value, word))) continue;
      const r = el.getBoundingClientRect();
      const score = (r.top < Math.max(360, window.innerHeight * 0.45) ? 10 : 0) + r.left / Math.max(1, window.innerWidth);
      hits.push({ el, score, r });
    }
    hits.sort((a, b) => b.score - a.score || b.r.left - a.r.left);
    return hits[0]?.el || null;
  }

  function findVisibleAllCommentsOption(filterButton) {
    const br = filterButton?.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 };
    const menuRoots = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')).filter(isVisible);
    const roots = menuRoots.length ? menuRoots : [document];
    const hits = [];

    for (const rootNode of roots) {
      const nodes = Array.from(rootNode.querySelectorAll('[role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"], label, [role="button"]')).filter(isVisible);
      for (const node of nodes) {
        const value = getControlLabel(node);
        if (!isAllCommentsLabel(value)) continue;
        const clickable = node.closest('[role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"], [role="button"], button, label, [tabindex="0"]') || node;
        if (!isVisible(clickable) || clickable === filterButton) continue;
        const r = clickable.getBoundingClientRect();
        if (r.top < br.top - 80 || r.left < br.left - 260 || r.left > br.right + 420) continue;
        const distance = Math.abs(r.left - br.left) + Math.abs(r.top - br.bottom);
        hits.push({ el: clickable, distance });
      }
    }

    hits.sort((a, b) => a.distance - b.distance);
    return hits[0]?.el || null;
  }

  async function waitForCommentRowsAfterFilter(timeoutMs) {
    const start = Date.now();
    let lastCount = -1;
    let stableTicks = 0;
    while (Date.now() - start < timeoutMs) {
      const count = collectCommentRows(false).length;
      if (count > 0) {
        if (count === lastCount) stableTicks++; else stableTicks = 0;
        lastCount = count;
        if (stableTicks >= 2) return true;
      }
      await sleep(500);
    }
    return collectCommentRows(false).length > 0;
  }

  function getControlLabel(el) {
    return `${getText(el)} ${el?.getAttribute?.('aria-label') || ''} ${el?.getAttribute?.('title') || ''}`.replace(/\s+/g, ' ').trim();
  }

  function isAllCommentsLabel(value) {
    return ALL_COMMENTS_WORDS.some(word => exactishMatch(value, word));
  }

  async function waitForCommentsManagerReady(timeoutMs) {
    const start = Date.now();
    let lastStatusAt = 0;
    while (Date.now() - start < timeoutMs) {
      if (!isCommentsManagerPage()) return false;

      // 只有真实评论行出现才算“可操作”。
      // 旧版只看到“评论管理工具”标题就算 ready，骨架屏期间就去点筛选，容易造成反复重新加载。
      const rows = collectCommentRows(false);
      if (rows.length > 0) return true;

      if (Date.now() - lastStatusAt > 3000) {
        lastStatusAt = Date.now();
        const settings = await StorageUtil.getSettings();
        const slot = workerSlot || '?';
        if (settings.isRunning && !settings.isPaused) {
          await setStatusMessage(`工作页 正在等待评论数据真正加载完成（骨架屏不操作、不刷新）...`);
        }
      }
      await sleep(550);
    }
    return false;
  }

  async function findAndClaimNextTask(scrollHost, settings, slot) {
    const maxAgeMs = Math.max(1, Number(settings.maxCommentAgeDays || 7)) * 24 * 60 * 60 * 1000;

    // 1. 每轮都先回顶部。刷新后的最新评论一定先检查。
    setScrollTop(scrollHost, 0);
    await sleep(520);
    let hit = await tryClaimVisibleRows(scrollHost, slot, settings, maxAgeMs);
    if (hit?.claimed) return hit.claimed;
    if (hit?.reachedAgeLimit) return null;

    if (settings.processOlderComments === false) return null;

    // 2. 顶部没有可处理的最新评论，才向下滚动，严格从新到旧回溯。
    let maxScroll = getMaxScroll(scrollHost);
    if (maxScroll <= 5) return null;

    const step = Math.max(320, getViewportHeight(scrollHost) * 0.72);
    let pos = Math.min(maxScroll, Math.max(step, Number(historyScrollTop || 0)));

    for (let pass = 0; pass < 70; pass++) {
      setScrollTop(scrollHost, pos);
      await sleep(620);
      maxScroll = getMaxScroll(scrollHost);

      hit = await tryClaimVisibleRows(scrollHost, slot, settings, maxAgeMs);
      if (hit?.claimed) {
        historyScrollTop = Math.min(maxScroll, getScrollTop(scrollHost) + Math.max(70, hit.claimed.row?.getBoundingClientRect?.().height || 90));
        return hit.claimed;
      }
      if (hit?.reachedAgeLimit) {
        historyScrollTop = 0;
        setScrollTop(scrollHost, 0);
        return null;
      }

      const before = getScrollTop(scrollHost);
      const next = Math.min(maxScroll, before + step);
      historyScrollTop = next;
      if (next >= maxScroll - 4 || Math.abs(next - before) < 3) {
        historyScrollTop = 0;
        setScrollTop(scrollHost, 0);
        await sleep(250);
        return null;
      }
      pos = next;
    }

    return null;
  }

  async function tryClaimVisibleRows(scrollHost, slot, settings, maxAgeMs) {
    const rows = collectCommentRows(false);
    if (!rows.length) return { claimed: null, reachedAgeLimit: false };

    // Facebook 评论管理工具本身通常已从新到旧排列；同时利用解析到的评论年龄再次排序，
    // 避免局部 DOM 重排让较旧评论跑到较新评论前面。
    const items = rows.map((row, index) => ({ row, index, snapshot: buildCommentSnapshot(row) }));
    items.sort((a, b) => {
      const ak = a.snapshot.commentAgeKnown ? Number(a.snapshot.commentAgeMs) : Number.POSITIVE_INFINITY;
      const bk = b.snapshot.commentAgeKnown ? Number(b.snapshot.commentAgeMs) : Number.POSITIVE_INFINITY;
      if (ak !== bk) return ak - bk;
      return a.index - b.index;
    });

    for (const item of items) {
      const row = item.row;
      const snapshot = item.snapshot;
      if (!snapshot.commentKey) continue;

      if (snapshot.commentAgeKnown && Number(snapshot.commentAgeMs) > maxAgeMs) {
        return { claimed: null, reachedAgeLimit: true };
      }

      snapshot.sourceScrollTop = getScrollTop(scrollHost);
      snapshot.maxCommentAgeDays = Number(settings.maxCommentAgeDays || 7);

      const reply = await sendRuntimeMessage({ action: 'CLAIM_COMMENT', task: snapshot, slot });
      const status = reply?.status || '';

      if (status === 'CLAIMED') {
        return {
          claimed: {
            taskKey: reply.taskKey || snapshot.commentKey,
            dmText: reply.dmText || '',
            task: snapshot,
            row,
            slot
          },
          reachedAgeLimit: false
        };
      }

      if (status === 'SKIPPED_OLD') return { claimed: null, reachedAgeLimit: true };
      if (status === 'NO_TEMPLATE') {
        await setStatusMessage('没有可用的私信话术，请先在插件规则中添加私信内容。');
        return { claimed: null, reachedAgeLimit: false };
      }
      if (status === 'NOT_RUNNING' || status === 'NOT_WORKER_TAB') return { claimed: null, reachedAgeLimit: false };

      if ([
        'ALREADY_PROCESSED', 'TASK_RESERVED', 'USER_RESERVED', 'SKIPPED_COOLDOWN',
        'SKIPPED_BLOCKED', 'RETRY_WAIT', 'RETRY_EXHAUSTED', 'RESERVE_FAILED'
      ].includes(status)) continue;
    }
    return { claimed: null, reachedAgeLimit: false };
  }

  async function processClaimedTask(claimed, scrollHost, settings, slot) {
    let task = { ...claimed.task, element: claimed.row, workerSlot: slot };
    const taskKey = claimed.taskKey;
    const dmText = claimed.dmText;
    const maxRetries = Math.max(1, Number(settings.maxSendRetries || 3));
    let attempts = 0;

    while (attempts < maxRetries) {
      const live = await StorageUtil.getSettings();
      if (!live.isRunning) {
        await sendRuntimeMessage({ action: 'ABANDON_TASK', taskKey, reason: 'stopped' });
        return { outcome: 'stopped', taskKey };
      }
      if (live.isPaused) {
        await sleep(900);
        continue;
      }

      attempts++;
      await closeOpenPrivateReplyDialogs();

      if (!task.element || !document.contains(task.element)) {
        task.element = await locateAssignedTaskRow(scrollHost, task, 18000);
      }

      if (!task.element) {
        const failure = await reportFailure(taskKey, task, `工作页 无法重新定位当前评论`);
        if (failure?.status === 'FAILURE_EXHAUSTED_RELEASED') return { outcome: 'failed_skipped', taskKey };
        await waitBeforeRetry(live, slot, task, attempts, maxRetries);
        continue;
      }

      const fresh = buildCommentSnapshot(task.element);
      task = { ...task, ...fresh, element: task.element, workerSlot: slot, commentKey: task.commentKey || fresh.commentKey };
      const validation = await sendRuntimeMessage({ action: 'VALIDATE_CLAIM_DETAILS', taskKey, task });
      if (!validation || validation.status !== 'OK') {
        if (['SKIPPED_PROCESSED', 'SKIPPED_COOLDOWN', 'USER_RESERVED', 'CLAIM_LOST'].includes(validation?.status)) {
          return { outcome: 'skipped', taskKey };
        }
        const failure = await reportFailure(taskKey, task, validation?.status || 'claim_validation_failed');
        if (failure?.status === 'FAILURE_EXHAUSTED_RELEASED') return { outcome: 'failed_skipped', taskKey };
        await waitBeforeRetry(live, slot, task, attempts, maxRetries);
        continue;
      }
      if (validation.task) task = { ...task, ...validation.task, element: task.element, workerSlot: slot };

      const sent = await performRowPrivateMessage(task.element, dmText, live);
      if (sent.ok) {
        const recorded = await recordConfirmedSuccessWithAck(taskKey, task, sent.verification || 'dm_sent');
        if (!recorded) {
          await StorageUtil.markCommentProcessed(taskKey, {
            reason: 'dm_sent_local_fallback', userName: task.userName, userKey: task.userKey,
            commentText: task.commentText, postTitle: task.postTitle, verification: sent.verification || 'dm_sent'
          });
          if (task.userKey) {
            await StorageUtil.recordUserTouch(task.userKey, {
              userName: task.userName, profileLink: task.profileLink, dmSentSuccess: true,
              lastCommentKey: task.commentKey || taskKey, lastPostTitle: task.postTitle
            });
          }
          await StorageUtil.releaseWorkerReservation(taskKey);
        }

        await closeOpenPrivateReplyDialogs();
        await setStatusMessage(`✅ 工作页 已发送给 ${task.userName || '用户'}并记录去重；正在继续扫描下一条评论。`);
        return { outcome: 'sent', taskKey, task };
      }

      const failure = await reportFailure(taskKey, task, sent.error || '私信发送失败', !!sent.uncertain);
      if (failure?.status === 'FAILURE_EXHAUSTED_RELEASED') {
        await closeOpenPrivateReplyDialogs();
        return { outcome: 'failed_skipped', taskKey };
      }

      await closeOpenPrivateReplyDialogs();
      await waitBeforeRetry(live, slot, task, attempts, maxRetries);
    }

    await StorageUtil.markCommentProcessed(taskKey, {
      reason: 'local_retry_exhausted_fallback', userName: task.userName, userKey: task.userKey,
      commentText: task.commentText, postTitle: task.postTitle, attempts: maxRetries
    });
    await StorageUtil.releaseWorkerReservation(taskKey);
    await sendRuntimeMessage({ action: 'ABANDON_TASK', taskKey, reason: 'local_retry_exhausted_fallback' });
    await closeOpenPrivateReplyDialogs();
    return { outcome: 'failed_skipped', taskKey };
  }

  async function performRowPrivateMessage(row, dmText, settings) {
    if (!row || !document.contains(row)) return { ok: false, error: '当前评论行已失效' };

    const dialogOpenTimeoutMs = Math.max(5000, Math.min(45000, Number(settings.privateDialogOpenTimeoutSeconds || 15) * 1000));
    const dialogOpenClicks = Math.max(1, Math.min(3, Number(settings.privateDialogOpenRetryClicks || 2)));
    let opened = null;
    let lastOpenError = '';

    // “发消息”本身是一个独立步骤：每次都重新 hover、重新定位按钮、重新点击，
    // 然后等待 Messenger 私信框真正出现。这样 Facebook React 重建 DOM 后不会拿着旧按钮一直等。
    for (let openAttempt = 1; openAttempt <= dialogOpenClicks; openAttempt++) {
      if (!row || !document.contains(row)) {
        return { ok: false, error: '准备打开私信时，当前评论行已经被 Facebook 重建' };
      }

      try {
        row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        hoverElement(row);
      } catch (e) { /* ignore */ }
      await sleep(220 + (openAttempt - 1) * 180);

      const messageBtn = findMessageButtonInRow(row);
      if (!messageBtn) {
        lastOpenError = `第 ${openAttempt}/${dialogOpenClicks} 次没有找到当前评论的「发消息」按钮`;
        await sleep(450);
        continue;
      }

      // 新版评论行把 handler 挂在按钮自身的 Pressable 上，只 hover 整行不够。
      hoverElement(messageBtn);
      await sleep(160);
      const beforeInputs = captureVisibleComposerElements();
      // 打开私信框优先原生 click；pointer-only 在部分评论管理工具版本上不会触发。
      safeClick(messageBtn, { mode: openAttempt === 1 ? 'click' : 'press' });
      clickMessageButtonFallback(messageBtn);
      opened = await waitForPrivateReplyDialogAndInput(dialogOpenTimeoutMs, beforeInputs, { afterMessageClick: true });
      if (opened?.dialog && opened?.input) break;

      lastOpenError = `第 ${openAttempt}/${dialogOpenClicks} 次点击「发消息」后，${Math.round(dialogOpenTimeoutMs / 1000)} 秒内没有识别到 Messenger 私信框`;
      await sleep(650);
    }

    if (!opened?.dialog || !opened?.input) {
      return { ok: false, error: `${lastOpenError || '点击「发消息」后没有识别到 Messenger 私信框'}；已重新定位并重试弹框` };
    }

    const { dialog, input } = opened;
    if (!isConfirmedPrivateMessengerDialog(dialog, input, { afterMessageClick: true })) {
      await closePrivateReplyDialog(dialog);
      return { ok: false, error: '打开的浮层无法确认为 Messenger 私信框，已中止以免误发公开评论' };
    }
    const inserted = await injectText(input, dmText);
    if (!inserted) {
      await closePrivateReplyDialog(dialog);
      return { ok: false, error: 'Messenger 私信框已弹出，但无法按原格式写入私信内容（包含换行校验）' };
    }
    if (composerLooksDuplicated(readInputText(input), dmText)) {
      await closePrivateReplyDialog(dialog);
      return { ok: false, error: 'Messenger 私信框写入了重复内容，已中止以免发出两遍' };
    }

    await nudgeComposerForSend(input);
    await sleep(280);
    const beforeText = readInputText(input);
    const beforeEchoes = captureMessageEchoes(dialog, input);
    const sendBtn = await waitForEnabledSendButton(dialog, input, 2500);
    const timeoutMs = Math.max(10000, Math.min(90000, Number(settings.sendConfirmTimeoutSeconds || 30) * 1000));
    const progressGraceMs = Math.max(15000, Math.min(90000, Number(settings.sendInProgressGraceSeconds || 45) * 1000));

    if (sendBtn) {
      safeClick(sendBtn, { mode: 'click' });
      const confirmed = await waitForSendConfirmation(input, dialog, beforeText, timeoutMs, dmText, beforeEchoes, sendBtn, progressGraceMs);
      if (confirmed.ok) {
        await closePrivateReplyDialog(dialog);
        return { ok: true, verification: confirmed.verification || 'send_confirmed' };
      }
      if (confirmed.definiteFailure) {
        await closePrivateReplyDialog(dialog);
        return { ok: false, uncertain: false, error: confirmed.error || 'Facebook 明确提示发送失败' };
      }

      // 已真正点击 Messenger 发送按钮且完整等待期间没有任何 Facebook 失败提示：
      // 优先按成功记录，防止“消息已经发出但 UI 没有给确认状态”导致重复私信。
      if (settings.assumeSuccessAfterClickNoError !== false) {
        await closePrivateReplyDialog(dialog);
        return {
          ok: true,
          verification: confirmed.inProgress
            ? 'send_progress_no_error_assumed_success'
            : 'send_click_no_error_assumed_success'
        };
      }
      return {
        ok: false,
        uncertain: true,
        error: confirmed.inProgress
          ? 'Facebook 一直显示「正在发送」，延长等待后仍没有明确结果'
          : `已点击发送，但 ${Math.round(timeoutMs / 1000)} 秒内没有检测到明确成功状态`
      };
    }

    // 只有明确识别到 Messenger 私信浮层时，才允许 Enter 作为最后兜底，避免误发公开评论。
    const enterResult = await tryPrivateDialogEnterSend(input, dialog, beforeText, timeoutMs, dmText, beforeEchoes, progressGraceMs);
    if (enterResult.ok) {
      await closePrivateReplyDialog(dialog);
      return { ok: true, verification: enterResult.verification || 'private_dialog_enter_confirmed' };
    }
    if (enterResult.definiteFailure) {
      await closePrivateReplyDialog(dialog);
      return { ok: false, error: enterResult.error || 'Messenger 回车发送失败' };
    }
    return { ok: false, error: enterResult.enterDispatched
      ? 'Messenger 私信框已弹出，但未找到明确发送按钮；Enter 已执行但仍没有确认成功'
      : 'Messenger 私信框已弹出，但未找到可用发送按钮，Enter 兜底也没有执行成功' };
  }

  function controlActionLabel(el) {
    const text = String(el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const label = String(el?.getAttribute?.('aria-label') || '').trim();
    const title = String(el?.getAttribute?.('title') || '').trim();
    const value = `${text.length <= 80 ? text : ''} ${label} ${title}`.replace(/\s+/g, ' ').trim();
    return value;
  }

  function isHeaderMessengerLabel(value) {
    const v = normalizeForMatch(value);
    if (/未读消息|未讀訊息|查看所有对话|查看所有對話|在 messenger 中/.test(v)) return true;
    return /^messenger\b/.test(v) && !/发消息|發消息|send message/.test(v);
  }

  function isMessageActionLabel(value) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length > 80) return false;
    if (isHeaderMessengerLabel(raw)) return false;
    if (VIEW_REPLY_WORDS.some(word => looseMatch(raw, word))) return false;
    if (REPLY_WORDS.some(word => exactishMatch(raw, word))) return false;
    if (SHARE_WORDS.some(word => exactishMatch(raw, word))) return false;
    if (HIDE_WORDS.some(word => exactishMatch(raw, word))) return false;
    return MESSAGE_WORDS.some(word => {
      if (exactishMatch(raw, word)) return true;
      // 单词 "Message" 会误匹配顶栏 Messenger 图标，只允许精确命中。
      if (normalizeForMatch(word) === 'message') return false;
      return raw.length <= 40 && looseMatch(raw, word);
    });
  }

  function findMessageButtonInRow(row) {
    if (!row) return null;
    const nodes = [];
    if (row.matches?.('[role="button"], button, a, [tabindex="0"]')) nodes.push(row);
    nodes.push(...row.querySelectorAll('[role="button"], button, a[role="link"], a, [tabindex="0"]'));
    const hits = [];
    const seen = new Set();
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const value = controlActionLabel(el);
      if (!isMessageActionLabel(value)) continue;
      const clickable = el.closest('[role="button"], button, a, [tabindex="0"]') || el;
      if (!isVisible(clickable) || !row.contains(clickable) || seen.has(clickable)) continue;
      seen.add(clickable);
      const r = clickable.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const exact = MESSAGE_WORDS.some(word => exactishMatch(value, word));
      hits.push({ el: clickable, r, exact, area: r.width * r.height });
    }
    if (!hits.length) {
      for (const el of row.querySelectorAll('span, div')) {
        if (!isVisible(el)) continue;
        const value = controlActionLabel(el);
        if (!isMessageActionLabel(value)) continue;
        const clickable = el.closest('[role="button"], button, a, [tabindex="0"]') || el;
        if (!isVisible(clickable) || !row.contains(clickable) || seen.has(clickable)) continue;
        seen.add(clickable);
        const r = clickable.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const exact = MESSAGE_WORDS.some(word => exactishMatch(value, word));
        hits.push({ el: clickable, r, exact, area: r.width * r.height });
      }
    }
    // 优先精确文案「发消息」，再取更小的真实按钮，避免点到包住整行动作区的容器。
    hits.sort((a, b) => Number(b.exact) - Number(a.exact) || a.area - b.area || b.r.left - a.r.left);
    return hits[0]?.el || null;
  }

  function captureVisibleComposerElements() {
    return new Set(Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], [role="textbox"]')).filter(isVisible));
  }

  function isSearchLikeInput(input) {
    const label = `${input?.getAttribute?.('aria-label') || ''} ${input?.getAttribute?.('placeholder') || ''} ${input?.getAttribute?.('aria-placeholder') || ''}`.toLowerCase();
    return label.includes('search') || label.includes('搜索') || label.includes('搜尋') || label.includes('pretraži') || label.includes('pretrazi');
  }

  function findComposerInSurface(surface) {
    if (!surface) return null;
    return Array.from(surface.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], [role="textbox"]'))
      .filter(isVisible)
      .find(el => !isSearchLikeInput(el)) || null;
  }

  function isOversizedPageSurface(surface) {
    const r = surface.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.92 || r.height >= window.innerHeight * 0.88;
  }

  function isPublicCommentComposer(input) {
    if (!input) return false;
    const label = normalizeForMatch(`${input.getAttribute('aria-label') || ''} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-placeholder') || ''}`);
    return /写评论|寫評論|write a comment|write a reply|leave a comment|公开评论|公開評論|comment as/.test(label);
  }

  function isInsideCommentArticle(el) {
    const article = el?.closest?.('[role="article"]');
    if (!(article && isCommentArticle(article))) return false;
    // 私信输入框有时会内嵌在评论卡片里，不能一律当成公开评论框。
    if (el && (isMessengerComposerInput(el) || !isPublicCommentComposer(el))) return false;
    return true;
  }

  function clickMessageButtonFallback(btn) {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const x = r.left + Math.max(2, r.width / 2);
    const y = r.top + Math.max(2, r.height / 2);
    let top = null;
    try { top = document.elementFromPoint(x, y); } catch (e) { /* ignore */ }
    const wrap = btn.closest('li, [role="button"]') || btn;
    if (top && wrap.contains(top) && top !== btn) {
      try { top.click(); } catch (e) { /* ignore */ }
    }
  }

  function isMessengerComposerInput(input) {
    if (!input || isSearchLikeInput(input)) return false;
    const label = normalizeForMatch(`${input.getAttribute('aria-label') || ''} ${input.getAttribute('placeholder') || ''} ${input.getAttribute('aria-placeholder') || ''}`);
    if (!label) return false;
    return MESSENGER_COMPOSER_LABELS.some(word => label === word || label.startsWith(`${word} `) || label.endsWith(` ${word}`));
  }

  function isCompactChatPanel(surface) {
    if (!surface) return false;
    const r = surface.getBoundingClientRect();
    return r.width >= 260 && r.width <= 760 && r.height >= 160 && r.height <= 980;
  }

  function hasMessengerChrome(surface, input) {
    if (isMessengerComposerInput(input)) return true;
    const aria = normalizeForMatch(`${surface?.getAttribute?.('aria-label') || ''} ${getText(surface).slice(0, 600)}`);
    if (PRIVATE_DIALOG_WORDS.some(word => aria.includes(normalizeForMatch(word)))) return true;
    if (/发消息给|發消息給|新消息|通过 messenger|reply via messenger/.test(aria)) return true;
    const buttons = Array.from(surface.querySelectorAll('[role="button"], button')).filter(isVisible);
    for (const b of buttons) {
      const v = normalizeForMatch(`${b.getAttribute('aria-label') || ''} ${getText(b)}`);
      if (!v || v.length > 60) continue;
      if (/按 enter 发送|按 enter 發送|press enter to send/.test(v)) return true;
    }
    return false;
  }

  function looksLikePrivateReplySurface(surface, input = null) {
    if (!surface || !isVisible(surface)) return false;
    if (input && isSearchLikeInput(input)) return false;
    if (input && isPublicCommentComposer(input)) return false;
    if (input && isInsideCommentArticle(input) && !isMessengerComposerInput(input)) return false;
    if (isOversizedPageSurface(surface) && surface.getAttribute('role') !== 'dialog' && surface.getAttribute('aria-modal') !== 'true') {
      return false;
    }
    const text = normalizeForMatch(getText(surface));
    if (PRIVATE_DIALOG_WORDS.some(word => text.includes(normalizeForMatch(word)))) return true;

    const hasMessenger = text.includes('messenger');
    const hasReplyContext = text.includes('回复') || text.includes('回覆') || text.includes('reply') || text.includes('private') || text.includes('悄悄') || text.includes('odgovori') || text.includes('poruku');
    if (hasMessenger && hasReplyContext) return true;
    if (isMessengerComposerInput(input || findComposerInSurface(surface))) return true;
    return isCompactChatPanel(surface) && hasMessengerChrome(surface, input || findComposerInSurface(surface));
  }

  function isConfirmedPrivateMessengerDialog(dialog, input, options = {}) {
    if (!dialog || !input || !isVisible(dialog) || !isVisible(input)) return false;
    if (isSearchLikeInput(input)) return false;
    if (isPublicCommentComposer(input)) return false;
    if (!dialog.contains(input)) return false;
    if (isInsideCommentArticle(input) && !isMessengerComposerInput(input) && !options.afterMessageClick) return false;
    if (options.afterMessageClick && dialog.contains(input) && !isOversizedPageSurface(dialog)) return true;
    if (!looksLikePrivateReplySurface(dialog, input)) return false;
    const role = String(dialog.getAttribute('role') || '');
    const modal = String(dialog.getAttribute('aria-modal') || '');
    if (role === 'dialog' || modal === 'true') return true;
    if (isOversizedPageSurface(dialog)) return false;
    if (isMessengerComposerInput(input) || (isCompactChatPanel(dialog) && hasMessengerChrome(dialog, input))) return true;
    const text = normalizeForMatch(getText(dialog));
    const hasExplicitPrivateWords = PRIVATE_DIALOG_WORDS.some(word => text.includes(normalizeForMatch(word)));
    const r = dialog.getBoundingClientRect();
    return hasExplicitPrivateWords && r.width >= 280 && r.height >= 140;
  }

  function findPrivateReplySurfaceForInput(input) {
    let p = input;
    for (let depth = 0; depth < 16 && p && p !== document.body; depth++, p = p.parentElement) {
      if (!(p instanceof Element) || !isVisible(p)) continue;
      if (p.getAttribute('role') === 'dialog' || p.getAttribute('aria-modal') === 'true') {
        if (looksLikePrivateReplySurface(p, input)) return p;
      }
      if (looksLikePrivateReplySurface(p, input)) {
        const r = p.getBoundingClientRect();
        if (r.width >= 280 && r.height >= 140) return p;
        if (isCompactChatPanel(p) && hasMessengerChrome(p, input)) return p;
        if (isMessengerComposerInput(input) && r.width >= 200 && r.height >= 70) return p;
      }
    }
    return null;
  }

  function findVisiblePrivateReplySurface(beforeInputs = new Set(), options = {}) {
    const afterMessageClick = !!options.afterMessageClick;
    const modalCandidates = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [aria-label*="发消息给"], [aria-label*="發消息給"], [aria-label*="新消息"], [aria-label*="Send message to"]'
    )).filter(isVisible);
    for (const surface of modalCandidates) {
      const input = findComposerInSurface(surface);
      if (input && looksLikePrivateReplySurface(surface, input)) return { dialog: surface, input };
    }

    const inputs = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], [role="textbox"]'))
      .filter(isVisible)
      .filter(el => !isSearchLikeInput(el))
      .filter(el => !isPublicCommentComposer(el));
    for (const input of inputs) {
      const isNew = !beforeInputs.has(input);
      const surface = findPrivateReplySurfaceForInput(input);
      if (surface && (isNew || looksLikePrivateReplySurface(surface, input))) return { dialog: surface, input };
      if (afterMessageClick && isNew) {
        const fallback = input.closest('[role="dialog"], [aria-modal="true"]') || input.parentElement;
        if (fallback && isVisible(fallback) && !isOversizedPageSurface(fallback)) {
          return { dialog: fallback, input };
        }
      }
    }
    return null;
  }

  async function waitForPrivateReplyDialogAndInput(timeoutMs, beforeInputs = new Set(), options = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = findVisiblePrivateReplySurface(beforeInputs, options);
      if (found?.dialog && found?.input) return found;
      await sleep(220);
    }
    return null;
  }

  function isPrivateReplyDialog(dialog) {
    if (!dialog) return false;
    const input = findComposerInSurface(dialog);
    return looksLikePrivateReplySurface(dialog, input);
  }

  function normalizeDmLineEndings(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u2028|\u2029/g, '\n');
  }

  function composerTextForCompare(text) {
    return normalizeDmLineEndings(text)
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map(line => line.replace(/[\t ]+/g, ' ').trimEnd())
      .join('\n')
      .trim();
  }

  function countNeedle(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let pos = 0;
    while (pos <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, pos);
      if (idx < 0) break;
      count += 1;
      pos = idx + Math.max(1, needle.length);
    }
    return count;
  }

  function composerLooksDuplicated(actual, expected) {
    const e = composerTextForCompare(expected);
    const a = composerTextForCompare(actual);
    if (!e || !a) return false;
    const eFlat = e.replace(/\s+/g, ' ').trim();
    const aFlat = a.replace(/\s+/g, ' ').trim();
    if (aFlat === eFlat) return false;
    if (eFlat.length >= 2 && countNeedle(aFlat, eFlat) >= 2) return true;
    if (aFlat === `${eFlat} ${eFlat}` || aFlat === `${eFlat}${eFlat}`) return true;
    const eC = eFlat.replace(/\s+/g, '');
    const aC = aFlat.replace(/\s+/g, '');
    if (eC.length >= 4 && countNeedle(aC, eC) >= 2) return true;
    if (eC.length >= 4 && aC === eC + eC) return true;
    if (aFlat.length >= Math.max(eFlat.length * 1.8, eFlat.length + 8)) return true;
    const aLines = a.split('\n').map(s => s.trim()).filter(Boolean);
    const eLines = e.split('\n').map(s => s.trim()).filter(Boolean);
    if (eLines.length && aLines.length === eLines.length * 2) {
      const half = aLines.length / 2;
      if (aLines.slice(0, half).join('\n') === aLines.slice(half).join('\n')) return true;
    }
    return false;
  }

  function insertedTextLooksCorrect(input, expectedText) {
    const expected = composerTextForCompare(expectedText);
    const actual = composerTextForCompare(readInputText(input));
    if (!expected || !actual) return false;
    if (composerLooksDuplicated(actual, expected)) return false;
    if (expected.includes('\n')) {
      const expectedBreaks = (expected.match(/\n/g) || []).length;
      const actualBreaks = (actual.match(/\n/g) || []).length;
      if (actualBreaks < Math.max(1, Math.floor(expectedBreaks * 0.75))) return false;
    }
    const eFlat = expected.replace(/\s+/g, ' ').trim();
    const aFlat = actual.replace(/\s+/g, ' ').trim();
    if (aFlat === eFlat) return true;
    if (aFlat.length > eFlat.length + Math.max(4, Math.ceil(eFlat.length * 0.12))) return false;
    return aFlat.includes(eFlat.slice(0, Math.min(80, eFlat.length)));
  }

  function fireBeforeInput(input, inputType, data = null, dataTransfer = null) {
    const init = { bubbles: true, cancelable: true, composed: true, inputType, data };
    try {
      const event = new InputEvent('beforeinput', dataTransfer ? { ...init, dataTransfer } : init);
      if (dataTransfer && !event.dataTransfer) {
        try { Object.defineProperty(event, 'dataTransfer', { get: () => dataTransfer }); } catch (e) { /* ignore */ }
      }
      return input.dispatchEvent(event);
    } catch (e) {
      try {
        return input.dispatchEvent(new InputEvent('beforeinput', init));
      } catch (e2) {
        return false;
      }
    }
  }

  async function clearComposer(input) {
    try { input.focus(); } catch (e) { /* ignore */ }
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      try { document.execCommand('selectAll', false, null); } catch (e2) { /* ignore */ }
    }
    fireBeforeInput(input, 'deleteContentBackward');
    try { document.execCommand('delete', false, null); } catch (e) { /* ignore */ }
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      try {
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, ''); else input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) { /* ignore */ }
    }
    await sleep(80);
  }

  function insertLexicalByPaste(input, value) {
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    // 只发 beforeinput。再发 paste / execCommand('insertText') 会被 Lexical 再写入一遍。
    fireBeforeInput(input, 'insertFromPaste', value, dt);
  }

  function insertLexicalByBeforeInputLines(input, value) {
    const lines = String(value || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) fireBeforeInput(input, 'insertText', lines[i]);
      if (i < lines.length - 1) fireBeforeInput(input, 'insertLineBreak');
    }
  }

  async function injectText(input, text) {
    const value = normalizeDmLineEndings(text);
    try {
      input.focus();
      await sleep(120);

      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        await clearComposer(input);
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, value); else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(180);
        return insertedTextLooksCorrect(input, value);
      }

      const attempts = [
        async () => {
          await clearComposer(input);
          insertLexicalByPaste(input, value);
        },
        async () => {
          await clearComposer(input);
          insertLexicalByBeforeInputLines(input, value);
        },
        async () => {
          await clearComposer(input);
          const dt = new DataTransfer();
          dt.setData('text/plain', value);
          input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        }
      ];

      for (const attempt of attempts) {
        await attempt();
        await sleep(220);
        if (insertedTextLooksCorrect(input, value)) return true;
        if (composerLooksDuplicated(readInputText(input), value)) {
          await clearComposer(input);
          await sleep(80);
          if (composerLooksDuplicated(readInputText(input), value) || readInputText(input)) {
            return false;
          }
        }
      }

      return insertedTextLooksCorrect(input, value);
    } catch (e) {
      return false;
    }
  }

  function isDisabledControl(el) {
    if (!el || !(el instanceof Element)) return true;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return true;
    const parent = el.closest('[aria-disabled="true"], [disabled]');
    if (parent && parent !== el.closest('[role="dialog"], [aria-modal="true"]')) return true;
    try {
      if (getComputedStyle(el).pointerEvents === 'none') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function isSendButtonLabel(value) {
    const raw = String(value || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length > 80) return false;
    const v = normalizeForMatch(raw);
    if (BACK_WORDS.some(word => looseMatch(raw, word))) return false;
    if (/发消息给|發消息給|send message to|查看回复|查看回覆/.test(v)) return false;
    if (SEND_WORDS.some(word => exactishMatch(raw, word) || (word.length > 5 && looseMatch(raw, word)))) return true;
    // 部分弹层主按钮文案就是「发消息」，但必须是短标签。
    if (MESSAGE_WORDS.some(word => exactishMatch(raw, word))) return true;
    return false;
  }

  function findSendButton(dialog, input, privateConfirmed) {
    if (!dialog || !input) return null;
    const inputRect = input.getBoundingClientRect();
    const nodes = Array.from(dialog.querySelectorAll('[role="button"], button, [tabindex="0"]')).filter(isVisible);
    const labeled = [];
    const seen = new Set();
    for (const node of nodes) {
      const clickable = node.closest('[role="button"], button, [tabindex="0"]') || node;
      if (!clickable || seen.has(clickable) || !dialog.contains(clickable)) continue;
      seen.add(clickable);
      const value = controlActionLabel(clickable);
      if (!isSendButtonLabel(value)) continue;
      const r = clickable.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      const distance = Math.abs(r.top - inputRect.top) + Math.abs(r.left - inputRect.right);
      labeled.push({ el: clickable, r, distance, area: r.width * r.height, disabled: isDisabledControl(clickable) });
    }
    labeled.sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.distance - b.distance || a.area - b.area);
    if (labeled[0] && !labeled[0].disabled) return labeled[0].el;

    if (!privateConfirmed) {
      return labeled[0] && !labeled[0].disabled ? labeled[0].el : null;
    }

    const icons = nodes
      .map(el => {
        const clickable = el.closest('[role="button"], button, [tabindex="0"]') || el;
        return { el: clickable, r: clickable.getBoundingClientRect(), text: controlActionLabel(clickable) };
      })
      .filter((x, idx, arr) => x.el && arr.findIndex(y => y.el === x.el) === idx)
      .filter(x => !isDisabledControl(x.el))
      .filter(x => !BACK_WORDS.some(word => looseMatch(x.text, word)))
      .filter(x => !/发消息给|發消息給|send message to/.test(normalizeForMatch(x.text)))
      .filter(x => {
        const nearY = x.r.top < inputRect.bottom + 28 && x.r.bottom > inputRect.top - 28;
        const toRight = x.r.left >= inputRect.right - 12;
        const compact = x.r.width >= 20 && x.r.width <= 72 && x.r.height >= 20 && x.r.height <= 72;
        return nearY && toRight && compact;
      })
      .sort((a, b) => a.r.left - b.r.left || a.r.width - b.r.width);
    return icons[0]?.el || (labeled[0] && !labeled[0].disabled ? labeled[0].el : null);
  }

  async function nudgeComposerForSend(input) {
    if (!input) return;
    try { input.focus(); } catch (e) { /* ignore */ }
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
    fireBeforeInput(input, 'insertText', ' ');
    await sleep(50);
    fireBeforeInput(input, 'deleteContentBackward');
    await sleep(80);
  }

  async function waitForEnabledSendButton(dialog, input, timeoutMs) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      last = findSendButton(dialog, input, true);
      if (last && !isDisabledControl(last)) return last;
      await sleep(180);
    }
    return last && !isDisabledControl(last) ? last : last;
  }

  async function waitForSendConfirmation(input, dialog, beforeText, timeoutMs, dmText, beforeEchoes, clickedSendButton = null, progressGraceMs = 45000) {
    const start = Date.now();
    const baseline = String(beforeText || '').trim();
    const sentWords = ['消息已发送', '已发送', 'Message sent', 'Sent', 'Poruka je poslata', 'Poslato', 'Envoyé', 'Enviado'];
    const sendingWords = ['正在发送', '正在發送', '发送中', '傳送中', 'Sending', 'Sending…', 'Šalje se', 'Salje se', 'Slanje'];
    const failWords = [
      '发送失败', '未能发送', '无法发送', '重试',
      'Failed to send', "Couldn't send", 'Could not send', 'Try again', 'Something went wrong',
      'Nije poslato', 'Slanje nije uspelo', 'Pokušaj ponovo', 'Pokusaj ponovo', 'Greška', 'Greska'
    ];
    let sendButtonGoneSince = 0;
    let sawSendingState = false;
    const baseDeadline = start + timeoutMs;
    const hardDeadline = start + timeoutMs + Math.max(15000, progressGraceMs);
    let deadline = baseDeadline;

    while (Date.now() < deadline) {
      await sleep(250);
      if (!document.contains(dialog) || !isVisible(dialog)) return { ok: true, verification: 'dialog_closed_after_send' };
      if (!document.contains(input) || !isVisible(input)) return { ok: true, verification: 'composer_removed_after_send' };

      const dialogText = getText(dialog);
      const normalizedDialog = normalizeForMatch(dialogText);
      const failHit = failWords.find(word => normalizedDialog.includes(normalizeForMatch(word)));
      if (failHit) return { ok: false, definiteFailure: true, error: `Facebook 提示发送失败：${failHit}` };

      const sendingHit = sendingWords.find(word => normalizedDialog.includes(normalizeForMatch(word)));
      if (sendingHit) {
        sawSendingState = true;
        // 截图中的“正在发送”代表 Facebook 仍在处理网络请求，不应在基础 20/30 秒到点时直接失败。
        deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + Math.max(15000, progressGraceMs)));
      }

      const nowText = readInputText(input);
      if (baseline && !nowText) return { ok: true, verification: 'composer_cleared_after_send' };
      if (baseline && nowText.length <= Math.max(1, Math.floor(baseline.length * 0.08))) return { ok: true, verification: 'composer_nearly_cleared_after_send' };

      if (sentWords.some(word => normalizedDialog.includes(normalizeForMatch(word)))) {
        return { ok: true, verification: 'sent_status_text_detected' };
      }
      if (detectNewMessageEcho(dialog, input, dmText, beforeEchoes)) return { ok: true, verification: 'sent_message_echo_detected' };

      if (clickedSendButton && (!document.contains(clickedSendButton) || !isVisible(clickedSendButton))) {
        if (!sendButtonGoneSince) sendButtonGoneSince = Date.now();
        if (Date.now() - sendButtonGoneSince > 700 && baseline && nowText !== baseline && nowText.length < baseline.length * 0.7) {
          return { ok: true, verification: 'composer_nearly_cleared_after_send' };
        }
      } else {
        sendButtonGoneSince = 0;
      }
    }
    return { ok: false, definiteFailure: false, inProgress: sawSendingState };
  }

  function captureMessageEchoes(dialog, input) {
    const set = new Set();
    for (const el of Array.from(dialog.querySelectorAll('div, span, p'))) {
      if (!isVisible(el) || el === input || el.contains(input) || input.contains?.(el)) continue;
      const t = normalizeForMatch(getText(el));
      if (t.length >= 8 && t.length <= 1400) set.add(t);
    }
    return set;
  }

  function detectNewMessageEcho(dialog, input, dmText, beforeEchoes) {
    const normalized = normalizeForMatch(dmText);
    if (normalized.length < 4) return false;
    const head = normalized.slice(0, Math.min(48, normalized.length));
    const tail = normalized.slice(-Math.min(32, normalized.length));
    for (const el of Array.from(dialog.querySelectorAll('div, span, p'))) {
      if (!isVisible(el) || el === input || el.contains(input) || input.contains?.(el)) continue;
      const t = normalizeForMatch(getText(el));
      if (t.length < 4 || beforeEchoes.has(t)) continue;
      if (t.includes(head) && (tail.length < 8 || t.includes(tail))) return true;
    }
    return false;
  }

  async function tryPrivateDialogEnterSend(input, dialog, beforeText, timeoutMs, dmText, beforeEchoes, progressGraceMs = 45000) {
    if (!isConfirmedPrivateMessengerDialog(dialog, input)) return { ok: false, enterDispatched: false };
    try {
      input.focus();
      const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      input.dispatchEvent(new KeyboardEvent('keydown', enter));
      input.dispatchEvent(new KeyboardEvent('keyup', enter));
      const confirmed = await waitForSendConfirmation(input, dialog, beforeText, timeoutMs, dmText, beforeEchoes, null, progressGraceMs);
      if (confirmed.ok) return { ok: true, enterDispatched: true, verification: 'private_dialog_enter_confirmed' };
      if (confirmed.definiteFailure) return { ok: false, enterDispatched: true, definiteFailure: true, error: confirmed.error };
      return { ok: false, enterDispatched: true };
    } catch (e) {
      return { ok: false, enterDispatched: false, error: e?.message || String(e) };
    }
  }

  async function closeOpenPrivateReplyDialogs() {
    const surfaces = [];
    const seen = new Set();
    const modals = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(isVisible);
    for (const surface of modals) {
      if (isPrivateReplyDialog(surface) && !seen.has(surface)) {
        seen.add(surface);
        surfaces.push(surface);
      }
    }
    const fallback = findVisiblePrivateReplySurface(new Set());
    if (fallback?.dialog && !seen.has(fallback.dialog)) surfaces.push(fallback.dialog);
    for (const dialog of surfaces) await closePrivateReplyDialog(dialog);
    await sleep(150);
    const remaining = findVisiblePrivateReplySurface(new Set());
    return remaining?.dialog ? 1 : 0;
  }

  async function closePrivateReplyDialog(dialog) {
    if (!dialog || !document.contains(dialog) || !isVisible(dialog)) return true;
    const candidates = [];
    for (const el of Array.from(dialog.querySelectorAll('[role="button"], button, [aria-label], span, div')).filter(isVisible)) {
      const value = `${getText(el)} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
      if (!value || value.length > 100) continue;
      if (!BACK_WORDS.some(word => looseMatch(value, word))) continue;
      const clickable = el.closest('[role="button"], button, [tabindex="0"], a') || el;
      candidates.push({ el: clickable, r: clickable.getBoundingClientRect() });
    }
    candidates.sort((a, b) => b.r.bottom - a.r.bottom || a.r.left - b.r.left);
    if (candidates[0]) {
      safeClick(candidates[0].el);
      const start = Date.now();
      while (Date.now() - start < 2200) {
        if (!document.contains(dialog) || !isVisible(dialog)) return true;
        await sleep(150);
      }
    }
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      await sleep(250);
    } catch (e) { /* ignore */ }
    return !document.contains(dialog) || !isVisible(dialog);
  }

  function isCommentArticle(el) {
    if (!el || el.getAttribute('role') !== 'article') return false;
    const aria = String(el.getAttribute('aria-label') || '');
    if (/评论者|評論者|commenter|comment by|komentarisao|komentirao/i.test(aria)) return true;
    const lines = splitLines(getText(el));
    if (lines.length < 2 || lines.length > 40) return false;
    const hasTime = lines.some(hasRelativeTime) || hasRelativeTime(aria) || /秒前|小时前|小時前|分钟前|分鐘前|天前|刚刚|剛剛|几秒|幾秒/.test(aria);
    const hasReply = lines.some(line => REPLY_WORDS.some(w => exactishMatch(line, w) || (line.length <= 16 && looseMatch(line, w))));
    const hasMsg = lines.some(line => MESSAGE_WORDS.some(w => exactishMatch(line, w)));
    const hasHide = HIDE_WORDS.some(w => looseMatch(aria, w)) || lines.some(line => HIDE_WORDS.some(w => looseMatch(line, w)));
    return hasTime && (hasReply || hasMsg || hasHide);
  }

  function collectCommentRows(quickMode = false) {
    const selectors = '[role="button"], button, a, span';
    const actionNodes = Array.from(document.querySelectorAll(selectors)).filter(el => {
      if (!isVisible(el)) return false;
      const value = `${getText(el)} ${el.getAttribute('aria-label') || ''}`.trim();
      if (!value || value.length > 80) return false;
      return ACTION_WORDS.some(word => looseMatch(value, word));
    });

    const candidates = [];
    const seen = new Set();
    const addCandidate = (p, lines, hasReply, hasHide) => {
      const r = p.getBoundingClientRect();
      const key = `${Math.round(r.top)}:${Math.round(r.height)}:${Math.round(r.left)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ el: p, r, score: rowScore(p, lines, hasReply, hasHide) });
    };

    for (const action of actionNodes) {
      const article = action.closest?.('[role="article"]');
      if (article && isVisible(article) && isCommentArticle(article)) {
        const r = article.getBoundingClientRect();
        if (r.bottom >= 0 && r.top <= window.innerHeight && r.width >= 180 && r.height >= 40 && r.height <= 900) {
          const lines = splitLines(getText(article));
          const hasReply = lines.some(line => REPLY_WORDS.some(w => looseMatch(line, w)));
          const hasHide = lines.some(line => HIDE_WORDS.some(w => looseMatch(line, w)))
            || HIDE_WORDS.some(w => looseMatch(article.getAttribute('aria-label') || '', w));
          addCandidate(article, lines, hasReply, hasHide);
          if (quickMode && candidates.length >= 8) break;
          continue;
        }
      }

      let p = action;
      for (let depth = 0; depth < 10 && p && p !== document.body; depth++, p = p.parentElement) {
        if (!(p instanceof Element)) break;
        const r = p.getBoundingClientRect();
        if (r.width < Math.min(520, window.innerWidth * 0.42) || r.height < 48 || r.height > 280) continue;
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const lines = splitLines(getText(p));
        if (lines.length < 3 || lines.length > 30) continue;
        const hasReply = lines.some(line => REPLY_WORDS.some(w => looseMatch(line, w)));
        const hasHide = lines.some(line => HIDE_WORDS.some(w => looseMatch(line, w)));
        const hasTime = lines.some(line => hasRelativeTime(line)) || lines.some(line => hasAbsolutePostTime(line));
        if (!hasTime || (!hasReply && !hasHide)) continue;
        addCandidate(p, lines, hasReply, hasHide);
        break;
      }
      if (quickMode && candidates.length >= 8) break;
    }

    if (!quickMode || candidates.length < 8) {
      for (const article of document.querySelectorAll('[role="article"]')) {
        if (!isVisible(article) || !isCommentArticle(article)) continue;
        const r = article.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        if (r.width < 180 || r.height < 40 || r.height > 900) continue;
        const lines = splitLines(getText(article));
        const hasReply = lines.some(line => REPLY_WORDS.some(w => looseMatch(line, w)));
        const hasHide = lines.some(line => HIDE_WORDS.some(w => looseMatch(line, w)))
          || HIDE_WORDS.some(w => looseMatch(article.getAttribute('aria-label') || '', w));
        addCandidate(article, lines, hasReply, hasHide);
        if (quickMode && candidates.length >= 8) break;
      }
    }

    // 同一行可能从多个动作按钮找到，按 top 合并，优先更小更精确的容器。
    candidates.sort((a, b) => a.r.top - b.r.top || b.score - a.score || a.r.height - b.r.height);
    const groups = [];
    for (const item of candidates) {
      let g = groups.find(x => Math.abs(x.top - item.r.top) <= 6);
      if (!g) groups.push({ top: item.r.top, best: item });
      else if (item.score > g.best.score || (item.score === g.best.score && item.r.height < g.best.r.height)) g.best = item;
    }
    return groups.map(g => g.best.el).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  function rowScore(el, lines, hasReply, hasHide) {
    let score = 0;
    if (el?.getAttribute?.('role') === 'article') score += 4;
    if (hasReply) score += 3;
    if (hasHide) score += 3;
    if (lines.some(hasRelativeTime)) score += 5;
    if (Array.from(el.querySelectorAll('img')).some(img => {
      const r = img.getBoundingClientRect();
      return isVisible(img) && r.width >= 24 && r.width <= 80 && r.height >= 24 && r.height <= 80;
    })) score += 3;
    if (lines.length >= 5 && lines.length <= 18) score += 2;
    return score;
  }

  function buildCommentSnapshot(row) {
    const rawText = getText(row);
    const lines = splitLines(rawText);
    const actionLine = (line) => ACTION_WORDS.some(w => looseMatch(line, w)) || SHARE_WORDS.some(w => exactishMatch(line, w)) || /^\.{3}$/.test(line) || line === '·' || line === '•';
    const contentLines = lines.filter(line => !actionLine(line));

    const fromAria = parseCommenterAriaLabel(row?.getAttribute?.('aria-label') || '');
    const fromLink = pickUserNameFromProfileLinks(row);
    const fromLines = parseUserTimeFromLines(contentLines);

    let userName = (fromAria?.userName || fromLink?.userName || fromLines?.userName || '').trim();
    let timeText = (fromAria?.timeText || fromLines?.timeText || '').trim();
    let nameIdx = Number.isInteger(fromLines?.nameIdx) ? fromLines.nameIdx : -1;

    if (!userName) userName = pickLikelyUserName(row, contentLines, '');
    {
      const cleaned = splitNameAndTime(userName);
      if (cleaned.userName) userName = cleaned.userName;
      if (cleaned.timeText && !timeText) timeText = cleaned.timeText;
    }
    if (userName && nameIdx < 0) {
      nameIdx = contentLines.findIndex(line => {
        const a = normalizeForMatch(line), b = normalizeForMatch(userName);
        return a === b || a.startsWith(b) || b.startsWith(a);
      });
    }

    const postMetaIdx = contentLines.findIndex(hasAbsolutePostTime);
    let postTitle = '';
    if (postMetaIdx > 0) {
      const maybe = contentLines[postMetaIdx - 1] || '';
      if (maybe && normalizeForMatch(maybe) !== normalizeForMatch(userName) && !hasRelativeTime(maybe)) postTitle = maybe;
    }

    let commentText = '';
    if (nameIdx >= 0) {
      const after = [];
      for (let i = nameIdx + 1; i < contentLines.length && after.length < 4; i++) {
        const line = contentLines[i];
        if (!line || line === postTitle || hasAbsolutePostTime(line) || hasRelativeTime(line)) continue;
        if (normalizeForMatch(line) === normalizeForMatch(userName)) continue;
        after.push(line);
      }
      commentText = after.join(' ').trim();
    }
    if (!commentText) commentText = pickLikelyCommentText(contentLines, postTitle, userName);
    if (userName && commentText && normalizeForMatch(userName) === normalizeForMatch(commentText)) {
      userName = fromAria?.userName || fromLink?.userName || userName;
      commentText = pickLikelyCommentText(contentLines, postTitle, userName);
    }
    {
      const cleaned = splitNameAndTime(userName);
      if (cleaned.userName) userName = cleaned.userName;
      if (cleaned.timeText && !timeText) timeText = cleaned.timeText;
    }

    const links = Array.from(row.querySelectorAll('a[href]'));
    const profileLink = fromLink?.profileLink || pickProfileLink(links, userName);
    const postUrl = pickPostUrl(links);
    const nativeCommentId = extractNativeCommentId(row, links);
    const userKey = buildUserKey(profileLink, userName, row);
    const commentAgeMs = parseRelativeAgeMs(timeText);
    const commentAgeKnown = Number.isFinite(commentAgeMs);
    const commentKey = nativeCommentId
      ? `cmt_${nativeCommentId}`
      : `cmt_hash_${hashString([userKey, postUrl || postTitle, normalizeForMatch(commentText), normalizeForMatch(timeText)].join('|'))}`;

    return {
      commentKey,
      nativeCommentId,
      userKey,
      userName: userName || '未知用户',
      commentText: commentText || rawText.slice(0, 500),
      postTitle: postTitle || '',
      postUrl: postUrl || '',
      profileLink: profileLink || '',
      timeText,
      commentAgeKnown,
      commentAgeMs: commentAgeKnown ? commentAgeMs : null,
      rawText
    };
  }

  const RELATIVE_TIME_UNITS = '秒钟|秒鐘|秒|分钟|分鐘|分|小时|小時|时|時|个月|個月|月|星期|天|日|周|週|年|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|sec|min|hr|wk|mo|yr|s|m|h|d|w|y';
  const RELATIVE_TIME_QTY = '(?:约\\s*|約\\s*)?(?:\\d+(?:\\.\\d+)?|几|幾|a\\s+few)';
  const RELATIVE_TIME_NAMED = '刚刚|剛剛|just now|今天|昨天|前天|today|yesterday|danas|juče|juce|upravo sada';
  const RELATIVE_TIME_EXPR = `(?:${RELATIVE_TIME_QTY}\\s*(?:${RELATIVE_TIME_UNITS})(?:\\s*(?:前|ago))?|${RELATIVE_TIME_NAMED}|周[一二三四五六日天]|星期[一二三四五六日天]|\\d{1,2}月\\d{1,2}日)`;
  const RELATIVE_TIME_TOKEN_RE = new RegExp(`^${RELATIVE_TIME_EXPR}$`, 'i');
  const NAME_TIME_SPLIT_RE = new RegExp(`^(.*?)[\\s·•\\-–—]*?(${RELATIVE_TIME_EXPR})$`, 'i');

  function parseRelativeAgeMs(text) {
    const raw = normalizeForMatch(text).replace(/^约\s*|^約\s*/, '').replace(/(?:前|ago)$/i, '').replace(/^(?:几|幾|a\s+few)(?=\s*[\p{L}\u4e00-\u9fff])/u, '3').trim();
    if (!raw) return null;
    if (['刚刚', '剛剛', 'just now', 'upravo sada', 'sada'].includes(raw)) return 0;
    if (['今天', 'today', 'danas'].includes(raw)) return 6 * 60 * 60 * 1000;
    if (['昨天', 'yesterday', 'juče', 'juce'].includes(raw)) return 24 * 60 * 60 * 1000;
    if (['前天'].includes(raw)) return 2 * 24 * 60 * 60 * 1000;

    const weekdayMap = { '周日': 0, '周天': 0, '星期日': 0, '星期天': 0, '周一': 1, '星期一': 1, '周二': 2, '星期二': 2, '周三': 3, '星期三': 3, '周四': 4, '星期四': 4, '周五': 5, '星期五': 5, '周六': 6, '星期六': 6 };
    if (Object.prototype.hasOwnProperty.call(weekdayMap, raw)) {
      const today = new Date().getDay();
      const diff = (today - weekdayMap[raw] + 7) % 7;
      return diff * 24 * 60 * 60 * 1000;
    }

    const md = raw.match(/^(\d{1,2})月(\d{1,2})日$/);
    if (md) {
      const now = new Date();
      let d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]), 0, 0, 0, 0);
      if (d.getTime() > now.getTime() + 12 * 60 * 60 * 1000) d = new Date(now.getFullYear() - 1, Number(md[1]) - 1, Number(md[2]), 0, 0, 0, 0);
      return Math.max(0, now.getTime() - d.getTime());
    }

    const m = raw.match(/^(\d+(?:\.\d+)?)\s*([\p{L}\u4e00-\u9fff]+)/u);
    if (!m) return null;
    const n = Number(m[1]);
    const u = m[2];
    if (!Number.isFinite(n)) return null;

    const sec = 1000;
    const minute = 60 * sec;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (/^(秒|秒钟|秒鐘|s|sec|secs|second|seconds)$/i.test(u)) return n * sec;
    if (/^(分钟|分鐘|分|min|mins|minute|minutes)$/i.test(u)) return n * minute;
    if (/^(小时|小時|时|時|h|hr|hrs|hour|hours|sat|sati)$/i.test(u)) return n * hour;
    if (/^(天|日|d|day|days|dan|dana)$/i.test(u)) return n * day;
    if (/^(周|週|星期|w|wk|wks|week|weeks|ned|nedelja|nedelje)$/i.test(u)) return n * 7 * day;
    if (/^(个月|個月|月|mo|month|months|mesec|meseca)$/i.test(u)) return n * 30 * day;
    if (/^(年|y|yr|yrs|year|years|god|godina|godine)$/i.test(u)) return n * 365 * day;
    return null;
  }

  function splitNameAndTime(text) {
    const t = String(text || '').replace(/\u00a0/g, ' ').normalize('NFKC').trim();
    if (!t) return { userName: '', timeText: '' };
    if (RELATIVE_TIME_TOKEN_RE.test(t)) return { userName: '', timeText: t };
    const m = t.match(NAME_TIME_SPLIT_RE);
    if (!m) return { userName: t, timeText: '' };
    const userName = String(m[1] || '').replace(/[\s·•\-–—]+$/g, '').trim();
    const timeText = String(m[2] || '').trim();
    if (!userName || !timeText) return { userName: t, timeText: '' };
    return { userName, timeText };
  }

  function parseCommenterAriaLabel(aria) {
    const raw = String(aria || '').replace(/\u00a0/g, ' ').trim();
    if (!raw) return null;
    const m = raw.match(/^(?:评论者|評論者|commenter|comment by)\s*[:：]?\s*(.+)$/i);
    if (!m) return null;
    const split = splitNameAndTime(m[1]);
    if (!looksLikeUserName(split.userName)) return split.timeText ? split : null;
    return split;
  }

  function isProfileHref(href) {
    const h = String(href || '');
    if (!h) return false;
    if (/\/professional_dashboard\//i.test(h)) return false;
    if (/[?&]comment_id=/i.test(h)) return false;
    if (/\/(posts|reel|reels|videos|permalink|photo|watch|story)\b/i.test(h)) return false;
    if (/profile\.php\?id=\d+/i.test(h)) return true;
    if (/\/people\//i.test(h)) return true;
    if (/\/user\/\d+/i.test(h)) return true;
    if (/facebook\.com\/(?:profile\.php|people\/)/i.test(h)) return true;
    return false;
  }

  function looksLikeUserName(text) {
    const s = String(text || '').trim();
    if (s.length < 2 || s.length > 80) return false;
    if (ACTION_WORDS.some(w => exactishMatch(s, w) || (s.length <= 16 && looseMatch(s, w)))) return false;
    if (SHARE_WORDS.some(w => exactishMatch(s, w))) return false;
    if (hasAbsolutePostTime(s) || hasRelativeTime(s) || looksLikeRelativeTimeToken(s)) return false;
    if (splitNameAndTime(s).timeText) return false;
    if (/^https?:/i.test(s)) return false;
    if (/^[·•\-–—|]+$/.test(s)) return false;
    if (s.split(/\s+/).length > 8) return false;
    if (s.length > 42 && /[.!?。！？]/.test(s)) return false;
    return true;
  }

  function pickUserNameFromProfileLinks(row) {
    const links = Array.from(row?.querySelectorAll?.('a[href]') || []).filter(isVisible);
    for (const a of links) {
      const href = a.getAttribute('href') || a.href || '';
      if (!isProfileHref(href)) continue;
      const t = getText(a).trim();
      const name = splitNameAndTime(t).userName || t;
      if (!looksLikeUserName(name)) continue;
      return { userName: name, profileLink: SecurityUtil.sanitizeFacebookHttpsUrl(a.href || href) || href };
    }
    return null;
  }

  function parseUserTimeLine(line) {
    const t = String(line || '').trim();
    if (!hasRelativeTime(t)) return null;
    const separators = [' · ', ' ·', '· ', '·', ' - ', ' – ', ' — '];
    for (const sep of separators) {
      const idx = t.lastIndexOf(sep);
      if (idx <= 0) continue;
      const left = t.slice(0, idx).trim();
      const right = t.slice(idx + sep.length).trim();
      if (left.length >= 2 && left.length <= 120 && looksLikeRelativeTimeToken(right)) {
        return { userName: splitNameAndTime(left).userName || left, timeText: right };
      }
    }
    const split = splitNameAndTime(t);
    if (split.userName && split.timeText && looksLikeUserName(split.userName)) {
      return { userName: split.userName, timeText: split.timeText };
    }
    return null;
  }

  function parseUserTimeFromLines(lines) {
    const list = Array.isArray(lines) ? lines : [];
    for (let i = 0; i < list.length; i++) {
      const parsed = parseUserTimeLine(list[i]);
      if (parsed?.userName) return { ...parsed, nameIdx: i };
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const b = list[i + 1] || '';
      const c = list[i + 2] || '';
      if (looksLikeUserName(a) && looksLikeRelativeTimeToken(b)) {
        return { userName: a, timeText: b, nameIdx: i };
      }
      if (looksLikeUserName(a) && looksLikeRelativeTimeToken(c) && /^[·•\-–—]$/.test(b)) {
        return { userName: a, timeText: c, nameIdx: i };
      }
    }
    return null;
  }

  function pickLikelyUserName(row, lines, postTitle) {
    const fromLink = pickUserNameFromProfileLinks(row);
    if (fromLink?.userName) return fromLink.userName;
    const fromAria = parseCommenterAriaLabel(row?.getAttribute?.('aria-label') || '');
    if (fromAria?.userName) return fromAria.userName;

    const els = Array.from(row.querySelectorAll('strong, b, a[href], span')).filter(isVisible);
    const tryPick = (skipLeftColumn) => {
      for (const el of els) {
        const t = getText(el);
        const name = splitNameAndTime(t).userName || t;
        if (!name || name === postTitle || !looksLikeUserName(name)) continue;
        const r = el.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        if (skipLeftColumn && r.left < rr.left + rr.width * 0.28) continue;
        return name;
      }
      return '';
    };
    return tryPick(false) || tryPick(true);
  }

  function pickLikelyCommentText(lines, postTitle, userName) {
    const filtered = lines.filter(line => {
      if (!line || line === postTitle) return false;
      if (userName && normalizeForMatch(line) === normalizeForMatch(userName)) return false;
      if (hasAbsolutePostTime(line) || hasRelativeTime(line)) return false;
      return true;
    });
    if (!filtered.length) return '';
    if (userName) {
      const idx = lines.findIndex(line => normalizeForMatch(line) === normalizeForMatch(userName));
      if (idx >= 0) {
        const after = filtered.filter(line => lines.indexOf(line) > idx);
        if (after[0]) return after[0];
      }
    }
    return filtered[filtered.length - 1] || '';
  }

  async function locateAssignedTaskRow(scrollHost, task, timeoutMs) {
    const start = Date.now();
    setScrollTop(scrollHost, Math.max(0, Number(task.sourceScrollTop || 0)));
    await sleep(550);
    let passes = 0;

    while (Date.now() - start < timeoutMs) {
      for (const row of collectCommentRows(false)) {
        const snap = buildCommentSnapshot(row);
        if (snapshotMatchesTask(snap, task)) return row;
      }
      const max = getMaxScroll(scrollHost);
      const before = getScrollTop(scrollHost);
      if (before >= max - 4) {
        passes++;
        if (passes >= 2) break;
        setScrollTop(scrollHost, 0);
      } else {
        setScrollTop(scrollHost, Math.min(max, before + Math.max(300, getViewportHeight(scrollHost) * 0.72)));
      }
      await sleep(650);
    }
    return null;
  }

  function snapshotMatchesTask(a, b) {
    if (!a || !b) return false;
    if (a.nativeCommentId && b.nativeCommentId && a.nativeCommentId === b.nativeCommentId) return true;
    if (a.commentKey && b.commentKey && a.commentKey === b.commentKey) return true;
    const sameUser = normalizeForMatch(a.userName) === normalizeForMatch(b.userName);
    const ca = normalizeForMatch(a.commentText), cb = normalizeForMatch(b.commentText);
    const sameComment = ca && cb && (ca === cb || ca.includes(cb) || cb.includes(ca));
    const pa = normalizeForMatch(a.postTitle), pb = normalizeForMatch(b.postTitle);
    const samePost = !pa || !pb || pa === pb || pa.includes(pb) || pb.includes(pa);
    return sameUser && sameComment && samePost;
  }

  function findCommentsScrollHost() {
    const rows = collectCommentRows(true);
    for (const row of rows) {
      let p = row.parentElement;
      for (let i = 0; i < 10 && p && p !== document.body; i++, p = p.parentElement) {
        const style = getComputedStyle(p);
        if (!/(auto|scroll)/.test(style.overflowY || '')) continue;
        if (p.scrollHeight > p.clientHeight + 200 && p.clientHeight > 300) return p;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function isDocumentScrollHost(host) {
    return host === document.scrollingElement || host === document.documentElement || host === document.body;
  }
  function getScrollTop(host) {
    return isDocumentScrollHost(host) ? (window.scrollY || document.documentElement.scrollTop || 0) : Number(host.scrollTop || 0);
  }
  function setScrollTop(host, value) {
    const top = Math.max(0, Number(value || 0));
    if (isDocumentScrollHost(host)) window.scrollTo({ top, left: 0, behavior: 'instant' });
    else host.scrollTop = top;
  }
  function getMaxScroll(host) {
    if (isDocumentScrollHost(host)) {
      const doc = document.scrollingElement || document.documentElement;
      return Math.max(0, Number(doc.scrollHeight || 0) - window.innerHeight);
    }
    return Math.max(0, Number(host.scrollHeight || 0) - Number(host.clientHeight || 0));
  }
  function getViewportHeight(host) {
    return isDocumentScrollHost(host) ? window.innerHeight : Math.max(1, Number(host.clientHeight || window.innerHeight));
  }

  function pickProfileLink(links, userName) {
    for (const a of links || []) {
      const href = SecurityUtil.sanitizeFacebookHttpsUrl(a.href || a.getAttribute?.('href') || '');
      if (!href) continue;
      const text = getText(a);
      if (/\/professional_dashboard\//i.test(href)) continue;
      if (/\/(posts|reel|videos|permalink|story)\b/i.test(href)) continue;
      if (userName && text && normalizeForMatch(text) === normalizeForMatch(userName)) return href;
      if (isProfileHref(href)) return href;
    }
    return '';
  }

  function pickPostUrl(links) {
    for (const a of links || []) {
      const href = SecurityUtil.sanitizeFacebookHttpsUrl(a.href || '');
      if (!href) continue;
      if (/\/(posts|reel|videos)\//i.test(href) || /permalink\.php|story_fbid|comment_id/.test(href)) return href;
    }
    return '';
  }

  function extractNativeCommentId(row, links = []) {
    const direct = row?.getAttribute?.('data-comment-id') || row?.dataset?.commentId;
    if (direct) return String(direct);
    const regexes = [
      /[?&]comment_id=(\d+)/i, /[?&]reply_comment_id=(\d+)/i, /\/comments\/(\d+)/i,
      /comment_id%3D(\d+)/i, /"comment_id"\s*:\s*"?(\d+)/i, /comment[_-]?id[=:"']+(\d+)/i
    ];
    for (const el of [row, ...(links || [])]) {
      if (!el) continue;
      const values = [];
      if (el.href) values.push(el.href);
      if (el.outerHTML) values.push(el.outerHTML.slice(0, 6000));
      for (const value of values) {
        for (const re of regexes) {
          const m = String(value).match(re);
          if (m) return m[1];
        }
      }
    }
    return '';
  }

  function buildUserKey(profileLink, userName, row) {
    const href = profileLink || '';
    let m = href.match(/[?&]id=(\d+)/);
    if (m) return `usr_id_${m[1]}`;
    m = href.match(/\/people\/[^/]+\/(\d+)/i);
    if (m) return `usr_id_${m[1]}`;
    if (href) return `usr_url_${hashString(normalizeProfileUrl(href))}`;
    if (row) {
      const html = row.outerHTML || '';
      const idMatch = html.match(/(?:profile|user|actor)[_-]?id[^0-9]{0,20}(\d{5,})/i);
      if (idMatch) return `usr_id_${idMatch[1]}`;
    }
    return `usr_name_${hashString(normalizeForMatch(userName || 'unknown'))}`;
  }

  function normalizeProfileUrl(url) {
    const safe = SecurityUtil.sanitizeFacebookHttpsUrl(url);
    if (!safe) return '';
    try {
      const u = new URL(safe);
      ['__cft__[0]', '__tn__', 'fbclid'].forEach(k => u.searchParams.delete(k));
      return `${u.origin}${u.pathname}${u.search}`;
    } catch (e) { return safe; }
  }

  function hasAbsolutePostTime(text) {
    const t = String(text || '').trim();
    return /\b20\d{2}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\b/.test(t) || /\b20\d{2}年\d{1,2}月\d{1,2}日\b/.test(t);
  }

  function looksLikeRelativeTimeToken(text) {
    const t = normalizeForMatch(text);
    return !!t && RELATIVE_TIME_TOKEN_RE.test(t);
  }

  function hasRelativeTime(text) {
    const t = String(text || '').replace(/\u00a0/g, ' ').normalize('NFKC').trim();
    if (!t) return false;
    if (looksLikeRelativeTimeToken(t)) return true;
    if (/(?:^|[·•\-–—]\s*)(?:约\s*|約\s*)?(?:\d+(?:\.\d+)?|几|幾)\s*(?:秒|分钟|分鐘|小时|小時|天|周|週|个月|個月|年)\s*前?\s*$/i.test(t)) return true;
    return /(?:约\s*|約\s*)?(?:\d+(?:\.\d+)?|几|幾)\s*(?:秒钟|秒鐘|秒|分钟|分鐘|分|小时|小時|时|時|天|日|周|週|星期|个月|個月|月|年)\s*前\s*$/.test(t);
  }

  function checkEmergencyBrake(settings) {
    if (settings.emergencyBrakeEnabled === false) return false;
    const text = document.body ? (document.body.innerText || '') : '';
    const hit = STOP_WORDS.find(word => text.includes(word));
    if (!hit) return false;
    sendRuntimeMessage({ action: 'TRIGGER_EMERGENCY_BRAKE', reason: `检测到 Facebook 安全/限制提示：${hit}` });
    return true;
  }

  async function recordConfirmedSuccessWithAck(taskKey, task, verification) {
    for (let i = 0; i < 3; i++) {
      const recorded = await sendRuntimeMessage({ action: 'TASK_RESULT', taskKey, task, result: { ok: true, verification } });
      if (recorded?.status === 'RECORDED_SUCCESS') return true;
      if (await StorageUtil.isCommentProcessed(taskKey)) return true;
      await sleep(300 + i * 200);
    }
    return await StorageUtil.isCommentProcessed(taskKey);
  }

  async function reportFailure(taskKey, task, reason, uncertain = false) {
    return sendRuntimeMessage({ action: 'TASK_RESULT', taskKey, task, result: { ok: false, uncertain, reason: String(reason || 'send_failed') } });
  }

  async function waitBeforeRetry(settings, slot, task, attempts, maxRetries) {
    if (attempts >= maxRetries) return;
    const backoff = Math.max(1, Math.min(60, Number(settings.retryBackoffSeconds || 3)));
    await setStatusMessage(`工作页：${task.userName || '当前用户'} 第 ${attempts}/${maxRetries} 次未发送成功，${backoff} 秒后重试；达到上限后自动跳过。`);
    await sleep(backoff * 1000);
  }

  async function heartbeat(slot) {
    await sendRuntimeMessage({ action: 'WORKER_HEARTBEAT', slot, lastScanAt: Date.now() });
  }

  async function waitForWake(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (mutationWake) {
        mutationWake = false;
        await sleep(220);
        return;
      }
      await sleep(250);
    }
  }

  function isCommentsManagerPage() {
    if (location.protocol !== 'https:' || !SecurityUtil.isFacebookHost(location.hostname)) return false;
    const path = String(location.pathname || '').toLowerCase();
    if (path.includes('/professional_dashboard/comments_manager')) return true;

    // Facebook 会把专业面板内部页面重写成不同路由；用 DOM 再确认一次，避免误判后强制跳转。
    const bodyText = String(document.body?.innerText || '');
    const hasManagerTitle = bodyText.includes('评论管理工具') || bodyText.includes('評論管理工具') || /comments manager/i.test(bodyText);
    if (!hasManagerTitle) return false;
    const hasCommentControls = [...ALL_COMMENTS_WORDS, ...UNREPLIED_WORDS, ...REPLIED_WORDS, ...MESSAGE_WORDS]
      .some(word => normalizeForMatch(bodyText).includes(normalizeForMatch(word)));
    return hasCommentControls;
  }

  function readInputText(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return normalizeDmLineEndings(String(input.value || '')).trim();
    }
    // innerText 会把 <br>/<div> 还原为换行；textContent 会吞掉 <br>，所以只作为兜底。
    const inner = typeof input.innerText === 'string' ? input.innerText : '';
    if (inner) return normalizeDmLineEndings(inner).trim();
    return normalizeDmLineEndings(String(input.textContent || '')).trim();
  }

  function splitLines(text) {
    return String(text || '').split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  function getText(el) {
    return String(el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function normalizeForMatch(text) {
    return String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  }

  function exactishMatch(value, word) {
    const a = normalizeForMatch(value), b = normalizeForMatch(word);
    return a === b || a.startsWith(`${b} `) || a.endsWith(` ${b}`);
  }

  function looseMatch(value, word) {
    const a = normalizeForMatch(value), b = normalizeForMatch(word);
    if (!a || !b) return false;
    return a === b || a.includes(b);
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0 && r.top <= window.innerHeight && r.left <= window.innerWidth;
  }

  function hoverElement(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + Math.max(1, r.width / 2);
    const y = r.top + Math.max(1, r.height / 2);
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, composed: true };
    try { el.dispatchEvent(new MouseEvent('mouseover', base)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mousemove', base)); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false })); } catch (e) { /* ignore */ }
    try {
      if (typeof PointerEvent === 'function') {
        const p = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerover', p));
        el.dispatchEvent(new PointerEvent('pointerenter', { ...p, bubbles: false }));
        el.dispatchEvent(new PointerEvent('pointermove', p));
      }
    } catch (e) { /* ignore */ }
  }

  function safeClick(el, options = {}) {
    if (!el) return;
    const mode = options.mode || 'press';
    const clickable = el.closest?.('[role="button"], button, a, [tabindex="0"]') || el;
    try { clickable.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) { /* ignore */ }
    hoverElement(clickable);
    const r = clickable.getBoundingClientRect();
    const x = r.left + Math.max(2, r.width / 2);
    const y = r.top + Math.max(2, r.height / 2);
    const mouse = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1, composed: true, detail: 1
    };
    let target = clickable;
    try {
      const topEl = document.elementFromPoint(x, y);
      if (topEl && (clickable === topEl || clickable.contains(topEl))) target = topEl;
    } catch (e) { /* ignore */ }
    try {
      if (mode === 'click') {
        // 弹层里的发送按钮走原生 click。pointerup+click 叠在一起会连发两条；只 pointer 又经常点不动。
        target.dispatchEvent(new MouseEvent('mousedown', mouse));
        target.dispatchEvent(new MouseEvent('mouseup', { ...mouse, buttons: 0 }));
        target.click();
        return;
      }
      if (typeof PointerEvent === 'function') {
        const p = { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 };
        target.dispatchEvent(new PointerEvent('pointerdown', p));
        target.dispatchEvent(new MouseEvent('mousedown', mouse));
        try { target.focus?.(); } catch (e3) { /* ignore */ }
        target.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0, pressure: 0 }));
        target.dispatchEvent(new MouseEvent('mouseup', { ...mouse, buttons: 0 }));
      } else {
        target.dispatchEvent(new MouseEvent('mousedown', mouse));
        target.dispatchEvent(new MouseEvent('mouseup', { ...mouse, buttons: 0 }));
        target.click();
      }
    } catch (e) {
      try { clickable.click(); } catch (e2) { /* ignore */ }
    }
  }

  function hashString(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function sendRuntimeMessage(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, response => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response || null);
        });
      } catch (e) { resolve(null); }
    });
  }
})();
