/**
 * FB 评论私信管家 - 评论管理工具单工作页版 v2.12.1
 *
 * 核心架构：
 * 1. 启动时固定只创建 1 个 Facebook 评论管理工具工作标签页。
 * 2. 单工作页严格串行：扫描最新评论 -> 打开 Messenger 私信框 -> 发送并记录 -> 再处理下一条。
 * 3. 评论去重、用户冷却和失败记录统一写入 chrome.storage.local，避免重复发送。
 * 4. 页面刷新只由后台可配置周期定时器触发，不因发送成功/失败而额外刷新。
 */

importScripts('../utils/storage.js');

const VERSION = '2.12.1';
let claimChain = Promise.resolve();
let reconcilingWorkers = false;
const WATCHDOG_ALARM = 'fb_inbox_watchdog';
const REFRESH_ALARM = 'fb_worker_periodic_refresh';

console.log(`FB Comment DM Manager Service Worker v${VERSION} initialized.`);

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  await chrome.alarms.clear(REFRESH_ALARM);
  const existing = await StorageUtil.getSettings();
  const refreshMinutes = clamp(
    Number(existing.periodicRefreshMinutes || Math.round(Number(existing.idleRefreshSeconds || 300) / 60) || 5),
    1,
    60
  );
  await StorageUtil.saveSettings({
    isRunning: false,
    isPaused: false,
    workerTabIds: [],
    activeWorkerCount: 0,
    replyAllComments: true,
    reverseKeywordMode: true,
    singleWorkerMode: true,
    persistentWorkerMode: true,
    strictSequentialSend: true,
    pauseOnSendFailure: false,
    maxSendRetries: 1,
    retryBackoffSeconds: Number(existing.retryBackoffSeconds || 3),
    privateDialogOpenTimeoutSeconds: Number(existing.privateDialogOpenTimeoutSeconds || 15),
    privateDialogOpenRetryClicks: Number(existing.privateDialogOpenRetryClicks || 2),
    sendConfirmTimeoutSeconds: Number(existing.sendConfirmTimeoutSeconds || 30),
    sendInProgressGraceSeconds: Number(existing.sendInProgressGraceSeconds || 45),
    monitorMode: 'comments_manager',
    maxCommentAgeDays: Number(existing.maxCommentAgeDays || 7),
    forceAllCommentsFilter: true,
    refreshAfterSuccess: false,
    refreshAfterSuccessDelaySeconds: 0,
    idleRefreshEnabled: existing.periodicRefreshEnabled !== false,
    idleRefreshSeconds: refreshMinutes * 60,
    periodicRefreshEnabled: existing.periodicRefreshEnabled !== false,
    periodicRefreshMinutes: refreshMinutes,
    lastPeriodicRefreshAt: Number(existing.lastPeriodicRefreshAt || 0),
    nextPeriodicRefreshAt: 0,
    assumeSuccessAfterClickNoError: existing.assumeSuccessAfterClickNoError !== false,
    commentsManagerUrl: existing.commentsManagerUrl || DEFAULT_COMMENTS_MANAGER_URL
  });
  await cleanupDeadReservations();
  await syncWorkerCount();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  chrome.alarms.clear(REFRESH_ALARM);
  await cleanupDeadReservations();
  const settings = await StorageUtil.getSettings();
  if (settings.isRunning && !settings.isPaused) {
    await ensureWorkerTabs(false);
    await startPeriodicRefreshAlarm();
  } else {
    await chrome.alarms.clear(REFRESH_ALARM);
    await syncWorkerCount();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    await cleanupDeadReservations();
    const settings = await StorageUtil.getSettings();
    // Watchdog 只补齐唯一工作标签页，绝不改写现有页面 URL，避免形成导航/刷新循环。
    if (settings.isRunning && !settings.isPaused) await ensureWorkerTabs(false);
    await syncWorkerCount();
    return;
  }

  if (alarm.name === REFRESH_ALARM) {
    await refreshAllIdleWorkersOnce();
  }
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local' || !changes.settings) return;
  const before = changes.settings.oldValue || {};
  const after = changes.settings.newValue || {};

  const beforeRefreshMin = clamp(Number(before.periodicRefreshMinutes || Math.round(Number(before.idleRefreshSeconds || 300) / 60) || 5), 1, 60);
  const afterRefreshMin = clamp(Number(after.periodicRefreshMinutes || Math.round(Number(after.idleRefreshSeconds || 300) / 60) || 5), 1, 60);
  const refreshConfigChanged = beforeRefreshMin !== afterRefreshMin || before.periodicRefreshEnabled !== after.periodicRefreshEnabled;
  if (refreshConfigChanged) {
    if (after.isRunning && !after.isPaused && after.periodicRefreshEnabled !== false) {
      await startPeriodicRefreshAlarm();
    } else {
      await chrome.alarms.clear(REFRESH_ALARM);
      await StorageUtil.saveSettings({ nextPeriodicRefreshAt: 0 });
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeWorkerTabId(tabId);
  await StorageUtil.releaseWorkerReservationByTabId(tabId);
  await removeFilterGuard(tabId);
  await syncWorkerCount();
  const settings = await StorageUtil.getSettings();
  if (settings.isRunning && !settings.isPaused) {
    setTimeout(() => ensureWorkerTabs(false), 700);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const slot = await getWorkerSlotByTabId(tabId);
  if (!slot) return;
  try {
    chrome.tabs.sendMessage(tabId, { action: 'WAKE_INBOX_WORKER', slot }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      if (!req || typeof req !== 'object') {
        sendResponse({ status: 'IGNORED' });
        return;
      }
      if (!isTrustedExtensionSender(sender)) {
        sendResponse({ status: 'FORBIDDEN' });
        return;
      }

      const action = String(req.action || '');
      const senderTabId = Number(sender?.tab?.id || 0);
      const fromExtensionPage = isExtensionPageSender(sender);
      const fromContentScript = isContentScriptSender(sender);

      switch (action) {
        case 'START_MONITOR':
          if (!fromExtensionPage) { sendResponse({ status: 'FORBIDDEN' }); return; }
          await startMonitoring();
          sendResponse({ status: 'STARTED' });
          break;

        case 'PAUSE_MONITOR':
          if (!fromExtensionPage) { sendResponse({ status: 'FORBIDDEN' }); return; }
          await pauseMonitoring();
          sendResponse({ status: 'PAUSED' });
          break;

        case 'STOP_MONITOR':
          if (!fromExtensionPage) { sendResponse({ status: 'FORBIDDEN' }); return; }
          await stopMonitoring();
          sendResponse({ status: 'STOPPED' });
          break;

        case 'OPEN_INBOX': {
          if (!fromExtensionPage) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const tabId = await openOrFocusInbox();
          sendResponse({ status: 'OPENED', tabId });
          break;
        }

        case 'GET_TAB_ROLE': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const slot = senderTabId ? await getWorkerSlotByTabId(senderTabId) : 0;
          sendResponse({ status: 'OK', role: slot ? 'worker' : 'idle', slot });
          break;
        }

        case 'GET_FILTER_GUARD': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const at = senderTabId ? await getFilterGuard(senderTabId) : 0;
          sendResponse({ status: 'OK', at });
          break;
        }

        case 'SET_FILTER_GUARD': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          if (senderTabId) await setFilterGuard(senderTabId, Number(req.at || Date.now()));
          sendResponse({ status: 'OK' });
          break;
        }

        case 'SET_STATUS_MESSAGE': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const slot = senderTabId ? await getWorkerSlotByTabId(senderTabId) : 0;
          if (!slot) { sendResponse({ status: 'NOT_WORKER_TAB' }); return; }
          await StorageUtil.saveSettings({
            statusMessage: String(req.message || '').slice(0, 500)
          });
          sendResponse({ status: 'OK' });
          break;
        }

        case 'WORKER_HEARTBEAT': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          if (senderTabId) await touchWorkerTab(senderTabId, req.slot || 0);
          await StorageUtil.saveSettings({
            lastInboxHeartbeat: Date.now(),
            lastScanAt: Number(req.lastScanAt || Date.now())
          });
          sendResponse({ status: 'ACK' });
          break;
        }

        case 'CLAIM_COMMENT': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const result = await withClaimLock(() => claimComment(req.task || {}, senderTabId));
          sendResponse(result);
          break;
        }

        case 'VALIDATE_CLAIM_DETAILS': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const result = await withClaimLock(() => validateClaimDetails(req.taskKey || '', req.task || {}, senderTabId));
          sendResponse(result);
          break;
        }

        case 'TASK_RESULT': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const result = await withClaimLock(() => handleTaskResult(req.taskKey || '', req.result || {}, req.task || {}, senderTabId));
          sendResponse(result);
          break;
        }

        case 'ABANDON_TASK': {
          if (!fromContentScript) { sendResponse({ status: 'FORBIDDEN' }); return; }
          const released = await withClaimLock(() => abandonTask(req.taskKey || '', senderTabId, req.reason || 'abandoned'));
          sendResponse({ status: released ? 'RELEASED' : 'NOT_FOUND' });
          break;
        }

        case 'REQUEST_WORKER_REFRESH': {
          sendResponse({ status: 'REFRESH_DISABLED_IN_CONTENT' });
          break;
        }

        case 'TRIGGER_EMERGENCY_BRAKE': {
          if (!fromContentScript && !fromExtensionPage) { sendResponse({ status: 'FORBIDDEN' }); return; }
          if (fromContentScript) {
            const slot = senderTabId ? await getWorkerSlotByTabId(senderTabId) : 0;
            if (!slot) { sendResponse({ status: 'NOT_WORKER_TAB' }); return; }
          }
          await triggerEmergencyBrake(req.reason || '检测到 Facebook 风控或安全验证');
          sendResponse({ status: 'BRAKED' });
          break;
        }

        default:
          sendResponse({ status: 'IGNORED' });
      }
    } catch (err) {
      console.error('service worker message error:', err);
      sendResponse({ status: 'ERROR', message: err?.message || String(err) });
    }
  })();
  return true;
});

async function startMonitoring() {
  const settings = await StorageUtil.getSettings();
  const refreshMinutes = clamp(
    Number(settings.periodicRefreshMinutes || Math.round(Number(settings.idleRefreshSeconds || 300) / 60) || 5),
    1,
    60
  );
  await cleanupDeadReservations();
  await StorageUtil.clearWorkerReservations();
  await new Promise(resolve => chrome.storage.local.set({ filterGuards: {} }, resolve));
  const discoveredUrl = await discoverCommentsManagerUrl();
  await StorageUtil.saveSettings({
    commentsManagerUrl: discoveredUrl,
    monitorMode: 'comments_manager',
    isRunning: true,
    isPaused: false,
    emergencyBrakeReason: '',
    blockingFailedCommentKey: '',
    singleWorkerMode: true,
    persistentWorkerMode: true,
    strictSequentialSend: true,
    pauseOnSendFailure: false,
    maxCommentAgeDays: Number(settings.maxCommentAgeDays || 7),
    forceAllCommentsFilter: true,
    refreshAfterSuccess: false,
    idleRefreshEnabled: settings.periodicRefreshEnabled !== false,
    idleRefreshSeconds: refreshMinutes * 60,
    periodicRefreshEnabled: settings.periodicRefreshEnabled !== false,
    periodicRefreshMinutes: refreshMinutes,
    nextPeriodicRefreshAt: 0,
    assumeSuccessAfterClickNoError: settings.assumeSuccessAfterClickNoError !== false,
    statusMessage: `正在启动 Facebook 评论管理工具：固定单工作页串行处理，自动切换“所有评论”，只处理最近 ${Number(settings.maxCommentAgeDays || 7)} 天；页面按 ${refreshMinutes} 分钟周期刷新。`
  });
  await ensureWorkerTabs(true);
  await startPeriodicRefreshAlarm();
  await wakeAllWorkers();
}

async function pauseMonitoring() {
  await StorageUtil.saveSettings({
    isRunning: true,
    isPaused: true,
    statusMessage: '任务已暂停；工作标签页保留，继续运行后从最新评论重新检查。'
  });
  await chrome.alarms.clear(REFRESH_ALARM);
  await StorageUtil.saveSettings({ nextPeriodicRefreshAt: 0 });
  await wakeAllWorkers();
}

async function stopMonitoring() {
  await StorageUtil.saveSettings({
    isRunning: false,
    isPaused: false,
    statusMessage: '任务已停止，正在关闭工作标签页...'
  });
  await chrome.alarms.clear(REFRESH_ALARM);
  await StorageUtil.saveSettings({ nextPeriodicRefreshAt: 0 });
  await closeAllWorkerTabs();
  await StorageUtil.clearWorkerReservations();
  await StorageUtil.saveSettings({ workerTabIds: [], activeWorkerCount: 0 });
}

async function ensureWorkerTabs(focusFirst) {
  if (reconcilingWorkers) return;
  reconcilingWorkers = true;
  try {
    const settings = await StorageUtil.getSettings();
    if (!settings.isRunning || settings.isPaused) return;

    const desired = 1; // v2.12.1 固定单工作页，彻底移除多线程配置
    const inboxUrl = normalizeCommentsManagerUrl(settings.commentsManagerUrl || DEFAULT_COMMENTS_MANAGER_URL);
    let ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number).filter(Boolean) : [];
    const alive = [];

    for (const id of ids) {
      const tab = await safeGetTab(id);
      if (!tab) continue;
      const url = String(tab.url || tab.pendingUrl || '');
      // 工作页必须仍停留在专业面板。若用户已导航到其他网站，则不再把它当工作页。
      if (/^https?:/i.test(url) && !(SecurityUtil.isFacebookHttpsUrl(url) && url.includes('/professional_dashboard/'))) {
        continue;
      }
      alive.push(id);
    }
    ids = alive;

    while (ids.length > desired) {
      const id = ids.pop();
      try { await chrome.tabs.remove(id); } catch (e) { /* ignore */ }
      await StorageUtil.releaseWorkerReservationByTabId(id);
    }

    while (ids.length < desired) {
      const slot = ids.length + 1;
      const tab = await chrome.tabs.create({
        url: inboxUrl,
        active: !!focusFirst && slot === 1
      });
      if (tab?.id) ids.push(Number(tab.id));
      await StorageUtil.saveSettings({
        workerTabIds: ids,
        activeWorkerCount: ids.length,
        statusMessage: '正在打开唯一的评论管理工作标签页...'
      });
    }

    await StorageUtil.saveSettings({
      workerTabIds: ids,
      activeWorkerCount: ids.length,
      statusMessage: '已启动单个评论管理工作标签页；最新评论优先，发送成功并记录后继续下一条。'
    });

    for (let i = 0; i < ids.length; i++) {
      try {
        chrome.tabs.sendMessage(ids[i], { action: 'WAKE_INBOX_WORKER', slot: i + 1 }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
    }
  } finally {
    reconcilingWorkers = false;
  }
}

async function openOrFocusInbox() {
  const settings = await StorageUtil.getSettings();
  const ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number).filter(Boolean) : [];
  for (const id of ids) {
    const tab = await safeGetTab(id);
    if (tab) {
      await chrome.tabs.update(id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return id;
    }
  }
  const tab = await chrome.tabs.create({ url: normalizeCommentsManagerUrl(settings.commentsManagerUrl || DEFAULT_COMMENTS_MANAGER_URL), active: true });
  return Number(tab?.id || 0);
}

async function claimComment(task, senderTabId) {
  if (!task?.commentKey) return { status: 'INVALID_TASK' };
  const slot = await getWorkerSlotByTabId(senderTabId);
  if (!slot) return { status: 'NOT_WORKER_TAB' };

  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused) return { status: 'NOT_RUNNING' };

  await cleanupDeadReservations();

  if (await StorageUtil.isCommentProcessed(task.commentKey)) return { status: 'ALREADY_PROCESSED' };

  // 发送失败过的评论直接跳过，不再重试。
  const retryState = await StorageUtil.canRetryComment(task.commentKey, 1, 0);
  if (!retryState.canRetry) {
    if (retryState.exhausted) {
      await StorageUtil.markCommentProcessed(task.commentKey, {
        reason: 'send_failed_exhausted',
        userName: task.userName,
        userKey: task.userKey,
        commentText: task.commentText,
        postTitle: task.postTitle
      });
      return { status: 'RETRY_EXHAUSTED', retryCount: Number(retryState.count || 0) };
    }
    return { status: 'RETRY_WAIT', retryCount: Number(retryState.count || 0), waitMs: Number(retryState.waitMs || 0) };
  }

  const reservations = await StorageUtil.getWorkerReservations();
  if (reservations[task.commentKey]) return { status: 'TASK_RESERVED' };
  if (task.userKey) {
    const sameUser = Object.values(reservations).find(rec => rec?.userKey && rec.userKey === task.userKey);
    if (sameUser) return { status: 'USER_RESERVED' };
  }

  const maxCommentAgeDays = Math.max(1, Number(settings.maxCommentAgeDays || 7));
  const maxCommentAgeMs = maxCommentAgeDays * 24 * 60 * 60 * 1000;
  if (task.commentAgeKnown === true && Number.isFinite(Number(task.commentAgeMs)) && Number(task.commentAgeMs) > maxCommentAgeMs) {
    await markSkippedComment(task, 'older_than_window', `⏭ 超过最近 ${maxCommentAgeDays} 天范围，已跳过`, '-', {
      totalProcessed: 1,
      totalSkippedOld: 1
    });
    return { status: 'SKIPPED_OLD', maxCommentAgeDays };
  }

  await StorageUtil.updateStats({ totalSeen: 1 });

  const cooldownHours = Number(settings.dmCooldownHours ?? settings.globalCooldownHours ?? 72);
  if (task.userKey && await StorageUtil.isUserInDmCooldown(task.userKey, cooldownHours)) {
    await markSkippedComment(task, 'user_cooldown', `⏭ 冷却期跳过 (${cooldownHours}小时)`, '-', {
      totalProcessed: 1,
      totalSkippedCooldown: 1
    });
    return { status: 'SKIPPED_COOLDOWN' };
  }

  const rules = await StorageUtil.getRules();
  const blocked = findBlockingRule(task.commentText, rules);
  if (blocked) {
    await markSkippedComment(task, 'blocked_keyword', '⛔ 反向关键词跳过', blocked.matchedKeyword, {
      totalProcessed: 1,
      totalBlockedKeyword: 1,
      totalNoRule: 1
    });
    return { status: 'SKIPPED_BLOCKED', matchedKeyword: blocked.matchedKeyword };
  }

  const templates = getAllTemplates(rules);
  if (!templates.length) return { status: 'NO_TEMPLATE' };

  const safeName = sanitizeCommenterName(task.userName);
  if (safeName && safeName !== task.userName) {
    task = { ...task, userName: safeName };
  }

  const reserve = await StorageUtil.reserveTask({ ...task, workerTabId: senderTabId, workerSlot: slot });
  if (!reserve.ok) return { status: reserve.reason || 'RESERVE_FAILED' };
  await StorageUtil.bindWorkerTab(task.commentKey, senderTabId);
  if (StorageUtil.updateWorkerReservation) {
    await StorageUtil.updateWorkerReservation(task.commentKey, { workerSlot: slot, workerTabId: senderTabId });
  }

  const template = templates[Math.floor(Math.random() * templates.length)];
  const dmText = renderTemplate(template, task);
  await StorageUtil.saveSettings({
    statusMessage: `工作页已锁定 ${task.userName || '用户'}，正在打开 Messenger 私信弹窗...`
  });

  return {
    status: 'CLAIMED',
    taskKey: task.commentKey,
    dmText,
    slot
  };
}

async function validateClaimDetails(taskKey, enrichedTask, senderTabId) {
  if (!taskKey) return { status: 'INVALID_TASK' };
  const reservation = await StorageUtil.getWorkerReservation(taskKey);
  if (!reservation) return { status: 'CLAIM_LOST' };
  if (Number(reservation.tabId || reservation.workerTabId || 0) !== Number(senderTabId || 0)) {
    return { status: 'CLAIM_OWNER_MISMATCH' };
  }

  const settings = await StorageUtil.getSettings();
  const finalTask = { ...(reservation.task || {}), ...enrichedTask, commentKey: enrichedTask.commentKey || taskKey };

  if (finalTask.commentKey !== taskKey && await StorageUtil.isCommentProcessed(finalTask.commentKey)) {
    await StorageUtil.markCommentProcessed(taskKey, { reason: 'alias_processed' });
    await StorageUtil.releaseWorkerReservation(taskKey);
    return { status: 'SKIPPED_PROCESSED' };
  }

  const map = await StorageUtil.getWorkerReservations();
  if (finalTask.userKey) {
    const otherSameUser = Object.values(map).find(rec => rec?.taskKey !== taskKey && rec?.userKey === finalTask.userKey);
    if (otherSameUser) {
      await StorageUtil.releaseWorkerReservation(taskKey);
      return { status: 'USER_RESERVED' };
    }

    const cooldownHours = Number(settings.dmCooldownHours ?? settings.globalCooldownHours ?? 72);
    if (await StorageUtil.isUserInDmCooldown(finalTask.userKey, cooldownHours)) {
      await StorageUtil.markCommentProcessed(taskKey, {
        reason: 'user_cooldown', userName: finalTask.userName, userKey: finalTask.userKey, commentText: finalTask.commentText
      });
      if (finalTask.commentKey && finalTask.commentKey !== taskKey) {
        await StorageUtil.markCommentProcessed(finalTask.commentKey, {
          reason: 'user_cooldown', userName: finalTask.userName, userKey: finalTask.userKey, commentText: finalTask.commentText
        });
      }
      await StorageUtil.releaseWorkerReservation(taskKey);
      await StorageUtil.updateStats({ totalProcessed: 1, totalSkippedCooldown: 1 });
      await StorageUtil.addLog({
        ...finalTask,
        matchedKeyword: '-',
        dmStatus: `⏭ 冷却期跳过 (${cooldownHours}小时)`,
        reason: 'user_cooldown',
        level: 'warning'
      });
      return { status: 'SKIPPED_COOLDOWN' };
    }
  }

  if (StorageUtil.updateWorkerReservation) {
    await StorageUtil.updateWorkerReservation(taskKey, {
      userKey: finalTask.userKey || reservation.userKey || '',
      task: finalTask,
      updatedAt: Date.now()
    });
  }
  return { status: 'OK', task: finalTask };
}

async function handleTaskResult(taskKey, result, task, senderTabId) {
  if (!taskKey) return { status: 'INVALID_TASK' };
  const reservation = await StorageUtil.getWorkerReservation(taskKey);
  if (!reservation) return { status: 'CLAIM_NOT_FOUND' };
  if (Number(reservation.tabId || reservation.workerTabId || 0) !== Number(senderTabId || 0)) {
    return { status: 'CLAIM_OWNER_MISMATCH' };
  }

  const finalTask = { ...(reservation.task || {}), ...task };
  const slot = Number(reservation.workerSlot || finalTask.workerSlot || 0);

  if (result?.ok) {
    await StorageUtil.clearCommentFailure(taskKey);
    if (finalTask.commentKey && finalTask.commentKey !== taskKey) {
      await StorageUtil.clearCommentFailure(finalTask.commentKey);
    }

    const meta = {
      reason: 'dm_sent',
      userName: finalTask.userName,
      userKey: finalTask.userKey,
      commentText: finalTask.commentText,
      postTitle: finalTask.postTitle,
      matchedKeyword: '(all)',
      verification: result.verification || 'dm_sent'
    };
    await StorageUtil.markCommentProcessed(taskKey, meta);
    if (finalTask.commentKey && finalTask.commentKey !== taskKey) {
      await StorageUtil.markCommentProcessed(finalTask.commentKey, meta);
    }

    if (finalTask.userKey) {
      await StorageUtil.recordUserTouch(finalTask.userKey, {
        userName: finalTask.userName,
        profileLink: finalTask.profileLink,
        dmSentSuccess: true,
        lastCommentKey: finalTask.commentKey || taskKey,
        lastPostTitle: finalTask.postTitle
      });
    }
    const originalUserKey = reservation.task?.userKey || '';
    if (originalUserKey && originalUserKey !== finalTask.userKey) {
      await StorageUtil.recordUserTouch(originalUserKey, {
        userName: finalTask.userName,
        profileLink: finalTask.profileLink,
        dmSentSuccess: true,
        lastCommentKey: finalTask.commentKey || taskKey,
        aliasUserKey: finalTask.userKey || ''
      });
    }

    await StorageUtil.updateStats({ totalProcessed: 1, totalDmSent: 1 });
    await StorageUtil.addLog({
      ...finalTask,
      matchedKeyword: '(all)',
      dmStatus: '✅ 私信发送成功',
      reason: formatVerificationReason(result.verification || 'dm_sent'),
      level: 'info'
    });
    await StorageUtil.releaseWorkerReservation(taskKey);
    await StorageUtil.saveSettings({
      statusMessage: `✅ 已发送给 ${finalTask.userName || '用户'}；正在重新检查最新评论...`
    });
    await wakeAllWorkers();
    return { status: 'RECORDED_SUCCESS' };
  }

  const rec = await StorageUtil.recordCommentFailure(taskKey, result?.reason || 'send_failed');
  await StorageUtil.updateStats({ totalErrors: 1, totalProcessed: 1, totalFailedSkipped: 1 });
  const meta = {
    reason: 'send_failed_exhausted',
    userName: finalTask.userName,
    userKey: finalTask.userKey,
    commentText: finalTask.commentText,
    postTitle: finalTask.postTitle,
    attempts: Number(rec.count || 1),
    lastError: result?.reason || 'send_failed'
  };
  await StorageUtil.markCommentProcessed(taskKey, meta);
  if (finalTask.commentKey && finalTask.commentKey !== taskKey) {
    await StorageUtil.markCommentProcessed(finalTask.commentKey, meta);
  }
  await StorageUtil.releaseWorkerReservation(taskKey);
  await StorageUtil.addLog({
    ...finalTask,
    commentKey: taskKey,
    matchedKeyword: '(all)',
    dmStatus: '❌ 发送失败，已跳过',
    reason: formatFailureReason(result?.reason || rec.errorMessage || 'send_failed'),
    level: 'error'
  });
  await StorageUtil.saveSettings({
    statusMessage: `⏭ ${finalTask.userName || '当前用户'} 发送失败，已跳过；正在处理下一条...`
  });
  await wakeAllWorkers();
  return { status: 'FAILURE_EXHAUSTED_RELEASED', retryCount: Number(rec.count || 1) };
}


function formatVerificationReason(code) {
  const map = {
    dm_sent: 'Messenger 已确认发送',
    dialog_closed_after_send: '点击发送后私信框关闭，确认成功',
    composer_removed_after_send: '发送后输入框消失，确认成功',
    composer_cleared_after_send: '发送后输入框清空，确认成功',
    composer_nearly_cleared_after_send: '发送后输入内容清空，确认成功',
    sent_status_text_detected: '检测到 Facebook 已发送状态',
    sent_message_echo_detected: '检测到已发送消息内容',
    private_dialog_enter_confirmed: 'Messenger 回车发送已确认',
    send_click_no_error_assumed_success: '发送按钮已点击，未检测到失败提示，按成功记录以避免重复发送',
    send_progress_no_error_assumed_success: '检测到 Facebook「正在发送」，延长等待后未出现失败提示，按成功记录避免重复发送',
    enter_send_no_error_assumed_success: 'Messenger 回车已执行，未检测到失败提示，按成功记录以避免重复发送'
  };
  return map[String(code || '')] || String(code || 'Messenger 已发送');
}

function formatFailureReason(reason) {
  const raw = String(reason || '发送失败');
  const map = {
    send_failed: '发送失败',
    send_failed_exhausted: '多次尝试仍无法发送',
    claim_validation_failed: '评论任务校验失败'
  };
  return map[raw] || raw;
}

async function abandonTask(taskKey, senderTabId, reason) {
  const rec = await StorageUtil.getWorkerReservation(taskKey);
  if (!rec) return false;
  if (senderTabId && Number(rec.tabId || rec.workerTabId || 0) !== Number(senderTabId)) return false;
  await StorageUtil.releaseWorkerReservation(taskKey);
  await StorageUtil.addLog({
    ...(rec.task || {}),
    commentKey: taskKey,
    matchedKeyword: '(all)',
    dmStatus: '⚠️ 任务释放',
    reason,
    level: 'warning'
  });
  return true;
}

async function markSkippedComment(task, reason, dmStatus, matchedKeyword, statsDelta) {
  await StorageUtil.markCommentProcessed(task.commentKey, {
    reason,
    userName: task.userName,
    userKey: task.userKey,
    commentText: task.commentText,
    postTitle: task.postTitle,
    matchedKeyword
  });
  await StorageUtil.updateStats(statsDelta || { totalProcessed: 1 });
  await StorageUtil.addLog({
    ...task,
    matchedKeyword,
    dmStatus,
    reason,
    level: reason === 'user_cooldown' ? 'warning' : 'info'
  });
}

async function cleanupDeadReservations() {
  const settings = await StorageUtil.getSettings();
  const ids = new Set((Array.isArray(settings.workerTabIds) ? settings.workerTabIds : []).map(Number).filter(Boolean));
  const map = await StorageUtil.getWorkerReservations();
  let changed = false;
  for (const [key, rec] of Object.entries(map)) {
    const tabId = Number(rec?.tabId || rec?.workerTabId || 0);
    if (!tabId || !ids.has(tabId) || !(await safeGetTab(tabId))) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) {
    await new Promise(resolve => chrome.storage.local.set({ workerReservations: map }, resolve));
  }
}

async function closeAllWorkerTabs() {
  const settings = await StorageUtil.getSettings();
  const ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number).filter(Boolean) : [];
  for (const id of ids) {
    try { await chrome.tabs.remove(id); } catch (e) { /* ignore */ }
  }
}

async function removeWorkerTabId(tabId) {
  const settings = await StorageUtil.getSettings();
  const ids = (Array.isArray(settings.workerTabIds) ? settings.workerTabIds : []).map(Number).filter(id => id && id !== Number(tabId));
  if (ids.length !== (settings.workerTabIds || []).length) {
    await StorageUtil.saveSettings({ workerTabIds: ids, activeWorkerCount: ids.length });
  }
}

async function getWorkerSlotByTabId(tabId) {
  if (!tabId) return 0;
  const settings = await StorageUtil.getSettings();
  const ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number) : [];
  const idx = ids.indexOf(Number(tabId));
  return idx >= 0 ? idx + 1 : 0;
}

async function touchWorkerTab(tabId, slot) {
  const settings = await StorageUtil.getSettings();
  const map = { ...(settings.workerHeartbeats || {}) };
  map[String(tabId)] = { slot: Number(slot || 0), at: Date.now() };
  await StorageUtil.saveSettings({ workerHeartbeats: map });
}

async function syncWorkerCount() {
  const settings = await StorageUtil.getSettings();
  const ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number).filter(Boolean) : [];
  let alive = 0;
  for (const id of ids) if (await safeGetTab(id)) alive++;
  await StorageUtil.saveSettings({ activeWorkerCount: alive });
  return alive;
}

async function wakeAllWorkers() {
  const settings = await StorageUtil.getSettings();
  const ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number).filter(Boolean) : [];
  for (let i = 0; i < ids.length; i++) {
    try {
      chrome.tabs.sendMessage(ids[i], { action: 'WAKE_INBOX_WORKER', slot: i + 1 }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }
}

async function getFilterGuards() {
  return new Promise(resolve => chrome.storage.local.get(['filterGuards'], res => resolve(res.filterGuards || {})));
}

async function getFilterGuard(tabId) {
  const guards = await getFilterGuards();
  return Number(guards[String(Number(tabId || 0))] || 0);
}

async function setFilterGuard(tabId, at) {
  const guards = await getFilterGuards();
  guards[String(Number(tabId || 0))] = Number(at || Date.now());
  return new Promise(resolve => chrome.storage.local.set({ filterGuards: guards }, resolve));
}

async function removeFilterGuard(tabId) {
  const guards = await getFilterGuards();
  delete guards[String(Number(tabId || 0))];
  return new Promise(resolve => chrome.storage.local.set({ filterGuards: guards }, resolve));
}

async function startPeriodicRefreshAlarm() {
  await chrome.alarms.clear(REFRESH_ALARM);
  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused || settings.periodicRefreshEnabled === false) {
    await StorageUtil.saveSettings({ nextPeriodicRefreshAt: 0 });
    return;
  }

  const minutes = clamp(
    Number(settings.periodicRefreshMinutes || Math.round(Number(settings.idleRefreshSeconds || 300) / 60) || 5),
    1,
    60
  );
  const now = Date.now();
  const nextAt = now + minutes * 60 * 1000;
  chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
  await StorageUtil.saveSettings({
    periodicRefreshMinutes: minutes,
    idleRefreshSeconds: minutes * 60,
    idleRefreshEnabled: true,
    nextPeriodicRefreshAt: nextAt
  });
}

async function refreshAllIdleWorkersOnce() {
  const settings = await StorageUtil.getSettings();
  if (!settings.isRunning || settings.isPaused || settings.periodicRefreshEnabled === false) return;

  const ids = Array.isArray(settings.workerTabIds) ? settings.workerTabIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return;

  const reservations = await StorageUtil.getWorkerReservations();
  const busyTabIds = new Set(Object.values(reservations || {}).map(rec => Number(rec?.tabId || 0)).filter(Boolean));
  const refreshed = [];
  const skippedBusy = [];

  for (const tabId of ids) {
    const tab = await safeGetTab(tabId);
    if (!tab) continue;
    if (busyTabIds.has(tabId)) {
      skippedBusy.push(tabId);
      continue;
    }
    // 只刷新已经存在的 Facebook 工作标签页；绝不改写 URL。
    if (!SecurityUtil.isFacebookTabUrl(tab.url)) continue;
    try {
      await chrome.tabs.reload(tabId, { bypassCache: false });
      refreshed.push(tabId);
    } catch (e) { /* ignore */ }
  }

  const intervalMinutes = clamp(Number(settings.periodicRefreshMinutes || 5), 1, 60);
  const refreshedAt = Date.now();
  await StorageUtil.saveSettings({
    lastPeriodicRefreshAt: refreshedAt,
    nextPeriodicRefreshAt: refreshedAt + intervalMinutes * 60 * 1000,
    statusMessage: refreshed.length
      ? `🔄 ${intervalMinutes} 分钟刷新周期到达：工作页已刷新。`
      : `⏳ ${intervalMinutes} 分钟刷新周期到达，但当前工作页正在发私信，本轮跳过刷新，不会打断发送。`
  });
}

async function triggerEmergencyBrake(reason) {
  const settings = await StorageUtil.getSettings();
  if (settings.emergencyBrakeEnabled === false) return;
  const alertMsg = String(reason || '检测到 Facebook 安全验证提示，系统已自动停止。').slice(0, 180);
  await StorageUtil.saveSettings({
    isRunning: false,
    isPaused: false,
    emergencyBrakeReason: alertMsg,
    statusMessage: '🚨 触发紧急熔断保护，任务已停止！'
  });
  await closeAllWorkerTabs();
  await StorageUtil.clearWorkerReservations();
  await StorageUtil.saveSettings({ workerTabIds: [], activeWorkerCount: 0 });
  await StorageUtil.addLog({
    userName: '风控引擎',
    matchedKeyword: '熔断报警',
    dmStatus: '紧急刹车',
    reason: alertMsg,
    level: 'error'
  });
  try {
    chrome.notifications.create('fb_inbox_emergency_brake', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icon128.png'),
      title: 'FB 评论私信管家 - 紧急熔断',
      message: alertMsg
    });
  } catch (e) { /* ignore */ }
}

function findBlockingRule(commentText, rules) {
  const text = normalizeForMatch(commentText);
  for (const rule of Array.isArray(rules) ? rules : []) {
    for (const raw of Array.isArray(rule?.keywords) ? rule.keywords : []) {
      const kw = normalizeForMatch(raw);
      if (!kw) continue;
      const matched = rule.matchType === 'exact' ? text === kw : text.includes(kw);
      if (matched) return { rule, matchedKeyword: raw };
    }
  }
  return null;
}

function getAllTemplates(rules) {
  const out = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    for (const t of Array.isArray(rule?.dmTemplates) ? rule.dmTemplates : []) {
      const text = String(t || '').trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function sanitizeCommenterName(name) {
  const t = String(name || '').replace(/\u00a0/g, ' ').normalize('NFKC').trim();
  if (!t) return '';
  const cleaned = t
    .replace(/[\s·•\-–—]*((?:约\s*|約\s*)?(?:\d+(?:\.\d+)?|几|幾|a\s+few)\s*(?:秒|秒钟|秒鐘|分钟|分鐘|分|小时|小時|时|時|天|日|周|週|星期|个月|個月|月|年|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)(?:\s*(?:前|ago))?|刚刚|剛剛|just now)\s*$/i, '')
    .replace(/[\s·•\-–—]+$/g, '')
    .trim();
  return cleaned;
}

function renderTemplate(template, task) {
  const full = sanitizeCommenterName(task?.userName || '');
  const first = full.split(/\s+/).filter(Boolean)[0] || full;
  const commentText = String(task?.commentText || '');
  const postTitle = String(task?.postTitle || '');
  // 只统一换行符，不压缩空格/换行。模板里在控制台保存了几行，发到 Messenger 就保持几行。
  return String(template || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[FirstName\]/gi, first)
    .replace(/\[FullName\]/gi, full)
    .replace(/\[Name\]/gi, full)
    .replace(/\{userName\}/g, full)
    .replace(/\{commentText\}/g, commentText)
    .replace(/\{postTitle\}/g, postTitle);
}

function normalizeForMatch(text) {
  return String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

async function discoverCommentsManagerUrl() {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://*.facebook.com/professional_dashboard/*',
        'https://facebook.com/professional_dashboard/*'
      ]
    });
    const exact = tabs.find(tab => {
      try {
        const url = new URL(String(tab.url || ''));
        return SecurityUtil.isFacebookHost(url.hostname)
          && url.protocol === 'https:'
          && url.pathname.includes('/professional_dashboard/comments_manager');
      } catch (e) {
        return false;
      }
    });
    if (exact?.url) return normalizeCommentsManagerUrl(exact.url);
  } catch (e) { /* ignore */ }
  const settings = await StorageUtil.getSettings();
  return normalizeCommentsManagerUrl(settings.commentsManagerUrl || DEFAULT_COMMENTS_MANAGER_URL);
}

function normalizeCommentsManagerUrl(url) {
  return SecurityUtil.normalizeCommentsManagerUrl(url);
}

function isTrustedExtensionSender(sender) {
  return !!(sender && sender.id === chrome.runtime.id);
}

function isExtensionPageSender(sender) {
  if (!isTrustedExtensionSender(sender)) return false;
  const extOrigin = `chrome-extension://${chrome.runtime.id}`;
  const origin = String(sender.origin || '');
  const url = String(sender.url || sender.tab?.url || '');
  if (origin === extOrigin || url.startsWith(`${extOrigin}/`)) return true;
  return !sender.tab && !origin && !url;
}

function isContentScriptSender(sender) {
  if (!isTrustedExtensionSender(sender) || !sender.tab?.id) return false;
  if (isExtensionPageSender(sender)) return false;
  const url = String(sender.url || sender.tab.url || '');
  return SecurityUtil.isFacebookTabUrl(url);
}

async function safeGetTab(tabId) {
  try { return await chrome.tabs.get(Number(tabId)); } catch (e) { return null; }
}

function withClaimLock(fn) {
  const run = claimChain.then(fn, fn);
  claimChain = run.catch(() => {});
  return run;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
