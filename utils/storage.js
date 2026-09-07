/**
 * FB 评论私信管家 v2.12.1
 * Storage layer for settings, reverse-keyword rules, processed comments,
 * user cooldown, retry state, logs, worker reservations and runtime stats.
 */

const DEFAULT_SETTINGS = {
  isRunning: false,
  isPaused: false,
  monitorMode: 'comments_manager',
  scanIntervalSeconds: 3,
  dmIntervalSeconds: 0,
  dmCooldownHours: 72,
  globalCooldownHours: 72,
  processOlderComments: true,
  maxCommentAgeDays: 7, // 只处理最近 7 天评论
  forceAllCommentsFilter: true, // 自动把“你未回复/你已回复”切换为“所有评论”
  refreshAfterSuccess: false, // 发送成功后不立即刷新；记录成功后直接继续下一条
  refreshAfterSuccessDelaySeconds: 0,
  idleRefreshEnabled: true, // 兼容旧字段：是否启用周期刷新
  idleRefreshSeconds: 300, // 兼容旧字段：由 periodicRefreshMinutes 自动同步
  periodicRefreshEnabled: true, // 控制面板可开关页面周期刷新
  periodicRefreshMinutes: 5, // 控制面板可调整，例如 2 / 3 / 5 分钟
  lastPeriodicRefreshAt: 0,
  nextPeriodicRefreshAt: 0,
  pendingPeriodicRefresh: false, // 到点时若正在发私信，记下待补刷，发送结束后立刻刷新
  autoSelectFacebookComments: true,
  replyAllComments: true,
  reverseKeywordMode: true,
  emergencyBrakeEnabled: true,
  emergencyBrakeReason: '',
  maxSendRetries: 1, // 发送失败不重试，直接跳过当前评论
  retryBackoffSeconds: 3,
  singleWorkerMode: true, // v2.12.1 固定单工作页：启动时只打开 1 个评论管理工具标签页
  strictSequentialSend: true, // 单工作页内严格串行：当前评论处理结束后才进入下一条
  pauseOnSendFailure: false, // 发送失败直接跳过，不会暂停整个插件
  privateDialogOpenTimeoutSeconds: 15, // 点击评论行“发消息”后，等待 Messenger 私信框出现
  privateDialogOpenRetryClicks: 2, // 单次发送尝试内，如弹框未出现，最多重新点击“发消息”的次数
  sendConfirmTimeoutSeconds: 30, // 点击真正发送按钮后，基础确认等待时间
  sendInProgressGraceSeconds: 45, // 检测到“正在发送/Sending”状态时额外等待，避免网络慢时误判失败
  assumeSuccessAfterClickNoError: true, // 已明确点击 Messenger 发送且未出现失败提示时，超时按成功记录，防止实际已发送却重复重试
  postSendWaitSeconds: 10,
  workerTaskTimeoutSeconds: 75,
  blockingFailedCommentKey: '',
  commentsManagerUrl: 'https://www.facebook.com/professional_dashboard/comments_manager',
  inboxUrl: 'https://www.facebook.com/professional_dashboard/comments_manager/',
  controllerTabId: 0,
  workerTabIds: [],
  workerHeartbeats: {},
  activeWorkerCount: 0,
  persistentWorkerMode: true,
  themeColor: 'cyan', // 控制台与 Popup 的主题强调色：cyan / violet / emerald / amber / rose
  appearanceMode: 'light', // 界面亮暗模式：light / dark；新安装默认亮色
  statusMessage: '\u7cfb\u7edf\u5c31\u7eea\uff0c\u7b49\u5f85\u542f\u52a8 Facebook \u8bc4\u8bba\u7ba1\u7406\u5de5\u5177...',
  lastInboxHeartbeat: 0,
  lastScanAt: 0,
  stats: {
    totalSeen: 0,
    totalProcessed: 0,
    totalDmSent: 0,
    totalSkippedCooldown: 0,
    totalBlockedKeyword: 0,
    totalNoRule: 0,
    totalErrors: 0,
    totalFailedSkipped: 0,
    totalSkippedOld: 0,
    totalDispatched: 0
  }
};

const DEFAULT_RULES = [
  {
    id: 'default_reverse_rule_1',
    name: '\u9ed8\u8ba4\u53cd\u5411\u5173\u952e\u8bcd\u4e0e\u79c1\u4fe1\u8bdd\u672f',
    matchType: 'contains',
    keywords: [],
    dmTemplates: [
      'Zdravo [FirstName], hvala ti na komentaru. \ud83d\ude4f'
    ]
  }
];

const PLAIN_BACKUP_FORMAT = 'fb-comment-dm-manager-full-backup';
const DEFAULT_COMMENTS_MANAGER_URL = 'https://www.facebook.com/professional_dashboard/comments_manager';
const THEME_COLOR_IDS = ['cyan', 'violet', 'emerald', 'amber', 'rose'];
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IMPORT_LIMITS = {
  maxLogs: 3000,
  maxProcessedComments: 16000,
  maxProcessedMeta: 16000,
  maxUserHistoryKeys: 20000,
  maxFailedCommentKeys: 5000,
  maxRules: 50,
  maxKeywordsPerRule: 500,
  maxTemplatesPerRule: 50,
  maxTemplateLength: 8000,
  maxKeywordLength: 200,
  maxRuleNameLength: 200,
  maxStringField: 2000,
  maxStatusMessage: 500,
  maxCommentText: 5000,
  maxBackupBytes: 8 * 1024 * 1024
};

const SETTINGS_NUMBER_FIELDS = {
  scanIntervalSeconds: [2, 120, 3],
  dmIntervalSeconds: [0, 600, 0],
  dmCooldownHours: [0, 720, 72],
  globalCooldownHours: [0, 720, 72],
  maxCommentAgeDays: [1, 30, 7],
  refreshAfterSuccessDelaySeconds: [0, 120, 0],
  idleRefreshSeconds: [60, 3600, 300],
  periodicRefreshMinutes: [1, 60, 5],
  lastPeriodicRefreshAt: [0, Number.MAX_SAFE_INTEGER, 0],
  nextPeriodicRefreshAt: [0, Number.MAX_SAFE_INTEGER, 0],
  maxSendRetries: [1, 1, 1],
  retryBackoffSeconds: [1, 60, 3],
  privateDialogOpenTimeoutSeconds: [5, 45, 15],
  privateDialogOpenRetryClicks: [1, 3, 2],
  sendConfirmTimeoutSeconds: [10, 90, 30],
  sendInProgressGraceSeconds: [15, 90, 45],
  postSendWaitSeconds: [1, 20, 10],
  workerTaskTimeoutSeconds: [15, 180, 75],
  controllerTabId: [0, 1e9, 0],
  activeWorkerCount: [0, 1, 0],
  lastInboxHeartbeat: [0, Number.MAX_SAFE_INTEGER, 0],
  lastScanAt: [0, Number.MAX_SAFE_INTEGER, 0]
};

const SETTINGS_BOOL_FIELDS = [
  'isRunning', 'isPaused', 'processOlderComments', 'forceAllCommentsFilter',
  'refreshAfterSuccess', 'idleRefreshEnabled', 'periodicRefreshEnabled', 'pendingPeriodicRefresh',
  'autoSelectFacebookComments', 'replyAllComments', 'reverseKeywordMode',
  'emergencyBrakeEnabled', 'singleWorkerMode', 'strictSequentialSend',
  'pauseOnSendFailure', 'assumeSuccessAfterClickNoError', 'persistentWorkerMode'
];

const SecurityUtil = {
  isDangerousKey(key) {
    return DANGEROUS_KEYS.has(String(key || ''));
  },

  isFacebookHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return host === 'facebook.com' || host.endsWith('.facebook.com');
  },

  isFacebookHttpsUrl(raw) {
    try {
      const url = new URL(String(raw || ''));
      return url.protocol === 'https:' && this.isFacebookHost(url.hostname);
    } catch (e) {
      return false;
    }
  },

  isFacebookTabUrl(raw) {
    return this.isFacebookHttpsUrl(raw);
  },

  sanitizeFacebookHttpsUrl(raw) {
    try {
      const url = new URL(String(raw || ''));
      if (url.protocol !== 'https:') return '';
      if (!this.isFacebookHost(url.hostname)) return '';
      if (url.username || url.password) return '';
      url.hash = '';
      return url.href;
    } catch (e) {
      return '';
    }
  },

  normalizeCommentsManagerUrl(url) {
    try {
      const parsed = new URL(String(url || DEFAULT_COMMENTS_MANAGER_URL));
      if (parsed.protocol !== 'https:') return DEFAULT_COMMENTS_MANAGER_URL;
      if (!this.isFacebookHost(parsed.hostname)) return DEFAULT_COMMENTS_MANAGER_URL;
      if (!parsed.pathname.includes('/professional_dashboard/comments_manager')) {
        return DEFAULT_COMMENTS_MANAGER_URL;
      }
      if (parsed.username || parsed.password) return DEFAULT_COMMENTS_MANAGER_URL;
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return DEFAULT_COMMENTS_MANAGER_URL;
    }
  },

  clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  },

  clampInt(value, min, max, fallback) {
    return Math.round(this.clampNumber(value, min, max, fallback));
  },

  copyPlainObject(value, maxKeys = 20000) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (this.isDangerousKey(key)) continue;
      out[String(key).slice(0, 200)] = item;
      count += 1;
      if (count >= maxKeys) break;
    }
    return out;
  },

  sanitizeStats(stats) {
    const out = { ...DEFAULT_SETTINGS.stats };
    if (!stats || typeof stats !== 'object') return out;
    for (const key of Object.keys(DEFAULT_SETTINGS.stats)) {
      const n = Number(stats[key]);
      out[key] = Number.isFinite(n) ? Math.max(0, Math.min(1e12, Math.floor(n))) : 0;
    }
    return out;
  },

  sanitizeWorkerTabIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 5);
  },

  sanitizeWorkerHeartbeats(map) {
    const src = this.copyPlainObject(map, 20);
    const out = {};
    for (const [key, rec] of Object.entries(src)) {
      if (!rec || typeof rec !== 'object') continue;
      out[String(Number(key) || key).slice(0, 32)] = {
        slot: this.clampInt(rec.slot, 0, 5, 0),
        at: this.clampInt(rec.at, 0, Number.MAX_SAFE_INTEGER, 0)
      };
    }
    return out;
  },

  sanitizeSettingsObject(input = {}, options = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const out = { ...DEFAULT_SETTINGS };
    for (const [key, range] of Object.entries(SETTINGS_NUMBER_FIELDS)) {
      out[key] = this.clampNumber(src[key], range[0], range[1], range[2]);
    }
    for (const key of SETTINGS_BOOL_FIELDS) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
    }
    out.monitorMode = 'comments_manager';
    out.singleWorkerMode = true;
    out.persistentWorkerMode = true;
    out.strictSequentialSend = true;
    out.pauseOnSendFailure = false;
    out.maxSendRetries = 1;
    out.forceAllCommentsFilter = src.forceAllCommentsFilter !== false;
    out.themeColor = THEME_COLOR_IDS.includes(src.themeColor) ? src.themeColor : 'cyan';
    out.appearanceMode = src.appearanceMode === 'dark' ? 'dark' : 'light';
    out.statusMessage = String(src.statusMessage || DEFAULT_SETTINGS.statusMessage).slice(0, IMPORT_LIMITS.maxStatusMessage);
    out.emergencyBrakeReason = String(src.emergencyBrakeReason || '').slice(0, IMPORT_LIMITS.maxStatusMessage);
    out.blockingFailedCommentKey = String(src.blockingFailedCommentKey || '').slice(0, 200);
    out.commentsManagerUrl = this.normalizeCommentsManagerUrl(src.commentsManagerUrl || DEFAULT_COMMENTS_MANAGER_URL);
    out.inboxUrl = this.normalizeCommentsManagerUrl(src.inboxUrl || out.commentsManagerUrl);
    out.workerTabIds = this.sanitizeWorkerTabIds(src.workerTabIds);
    out.workerHeartbeats = this.sanitizeWorkerHeartbeats(src.workerHeartbeats);
    out.stats = this.sanitizeStats(src.stats);
    out.idleRefreshSeconds = Number(out.periodicRefreshMinutes) * 60;
    out.idleRefreshEnabled = out.periodicRefreshEnabled !== false;
    if (options.forImport) {
      out.isRunning = false;
      out.isPaused = false;
      out.workerTabIds = [];
      out.workerHeartbeats = {};
      out.activeWorkerCount = 0;
      out.nextPeriodicRefreshAt = 0;
      out.pendingPeriodicRefresh = false;
      out.controllerTabId = 0;
    }
    return out;
  },

  sanitizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.slice(0, IMPORT_LIMITS.maxRules).map((rule, index) => ({
      id: String(rule?.id || `rule_${Date.now()}_${index}`).slice(0, 80),
      name: String(rule?.name || '未命名规则').slice(0, IMPORT_LIMITS.maxRuleNameLength),
      matchType: rule?.matchType === 'exact' ? 'exact' : 'contains',
      keywords: (Array.isArray(rule?.keywords) ? rule.keywords : [])
        .map(item => String(item || '').slice(0, IMPORT_LIMITS.maxKeywordLength).trim())
        .filter(Boolean)
        .slice(0, IMPORT_LIMITS.maxKeywordsPerRule),
      dmTemplates: (Array.isArray(rule?.dmTemplates) ? rule.dmTemplates : [])
        .map(item => String(item || '').replace(/\r\n?/g, '\n').slice(0, IMPORT_LIMITS.maxTemplateLength).trim())
        .filter(Boolean)
        .slice(0, IMPORT_LIMITS.maxTemplatesPerRule)
    }));
  },

  sanitizeLogItem(item) {
    if (!item || typeof item !== 'object') return null;
    const level = item.level === 'warning' || item.level === 'error' ? item.level : 'info';
    return {
      id: String(item.id || `log_${Date.now()}`).slice(0, 80),
      timestamp: String(item.timestamp || '').slice(0, 40),
      userName: String(item.userName || '').slice(0, 200),
      userKey: String(item.userKey || '').slice(0, 200),
      postTitle: String(item.postTitle || '').slice(0, 500),
      postUrl: this.sanitizeFacebookHttpsUrl(item.postUrl),
      profileLink: this.sanitizeFacebookHttpsUrl(item.profileLink),
      commentKey: String(item.commentKey || '').slice(0, 200),
      commentText: String(item.commentText || '').slice(0, IMPORT_LIMITS.maxCommentText),
      matchedKeyword: String(item.matchedKeyword || '-').slice(0, 200),
      dmStatus: String(item.dmStatus || '').slice(0, 300),
      reason: String(item.reason || '').slice(0, 500),
      workerTabId: this.clampInt(item.workerTabId, 0, 1e9, 0),
      level
    };
  },

  sanitizeLogs(logs) {
    if (!Array.isArray(logs)) return [];
    return logs.map(item => this.sanitizeLogItem(item)).filter(Boolean).slice(0, IMPORT_LIMITS.maxLogs);
  },

  sanitizeStringArray(list, maxItems, maxLength) {
    if (!Array.isArray(list)) return [];
    return list.map(item => String(item || '').slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
  },

  sanitizeProcessedMeta(map) {
    const src = this.copyPlainObject(map, IMPORT_LIMITS.maxProcessedMeta);
    const out = {};
    for (const [key, rec] of Object.entries(src)) {
      if (!rec || typeof rec !== 'object') continue;
      out[String(key).slice(0, 200)] = {
        reason: String(rec.reason || '').slice(0, 200),
        userName: String(rec.userName || '').slice(0, 200),
        userKey: String(rec.userKey || '').slice(0, 200),
        commentText: String(rec.commentText || '').slice(0, IMPORT_LIMITS.maxCommentText),
        postTitle: String(rec.postTitle || '').slice(0, 500),
        matchedKeyword: String(rec.matchedKeyword || '').slice(0, 200),
        verification: String(rec.verification || '').slice(0, 120),
        processedAt: this.clampInt(rec.processedAt, 0, Number.MAX_SAFE_INTEGER, Date.now())
      };
    }
    return out;
  },

  sanitizeUserHistory(map) {
    const src = this.copyPlainObject(map, IMPORT_LIMITS.maxUserHistoryKeys);
    const out = {};
    for (const [key, rec] of Object.entries(src)) {
      if (!rec || typeof rec !== 'object') continue;
      out[String(key).slice(0, 200)] = {
        userKey: String(rec.userKey || key).slice(0, 200),
        userName: String(rec.userName || '').slice(0, 200),
        profileLink: this.sanitizeFacebookHttpsUrl(rec.profileLink),
        lastTriggerTime: this.clampInt(rec.lastTriggerTime, 0, Number.MAX_SAFE_INTEGER, 0),
        lastDmTime: this.clampInt(rec.lastDmTime, 0, Number.MAX_SAFE_INTEGER, 0),
        dmSentSuccess: rec.dmSentSuccess === true,
        lastCommentKey: String(rec.lastCommentKey || '').slice(0, 200),
        lastPostTitle: String(rec.lastPostTitle || '').slice(0, 500),
        aliasUserKey: String(rec.aliasUserKey || '').slice(0, 200)
      };
    }
    return out;
  },

  sanitizeFailedComments(map) {
    const src = this.copyPlainObject(map, IMPORT_LIMITS.maxFailedCommentKeys);
    const out = {};
    for (const [key, rec] of Object.entries(src)) {
      if (!rec || typeof rec !== 'object') continue;
      out[String(key).slice(0, 200)] = {
        count: this.clampInt(rec.count, 0, 100, 0),
        lastAttempt: this.clampInt(rec.lastAttempt, 0, Number.MAX_SAFE_INTEGER, 0),
        errorMessage: String(rec.errorMessage || '').slice(0, 500)
      };
    }
    return out;
  },

  isPlainBackup(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.format === PLAIN_BACKUP_FORMAT) return true;
    return !!(data.settings && typeof data.settings === 'object') || Array.isArray(data.rules);
  }
};

let settingsWriteChain = Promise.resolve();

const StorageUtil = {
  async getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['settings'], (res) => {
        resolve(SecurityUtil.sanitizeSettingsObject(res.settings || {}));
      });
    });
  },

  async saveSettings(newSettings) {
    const run = settingsWriteChain.then(async () => {
      const current = await this.getSettings();
      const merged = {
        ...current,
        ...(newSettings && typeof newSettings === 'object' ? newSettings : {}),
        stats: newSettings && newSettings.stats
          ? { ...current.stats, ...newSettings.stats }
          : current.stats
      };
      const updated = SecurityUtil.sanitizeSettingsObject(merged);
      return new Promise((resolve) => {
        chrome.storage.local.set({ settings: updated }, () => resolve(updated));
      });
    });
    settingsWriteChain = run.catch(() => {});
    return run;
  },

  async updateStats(delta = {}) {
    const settings = await this.getSettings();
    const stats = { ...settings.stats };
    for (const [key, value] of Object.entries(delta)) {
      stats[key] = Math.max(0, Number(stats[key] || 0) + Number(value || 0));
    }
    await this.saveSettings({ stats });
    return stats;
  },

  async resetStats() {
    const stats = { ...DEFAULT_SETTINGS.stats };
    await this.saveSettings({ stats });
    return stats;
  },

  async getRules() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['rules'], (res) => {
        resolve(SecurityUtil.sanitizeRules(Array.isArray(res.rules) ? res.rules : DEFAULT_RULES));
      });
    });
  },

  async saveRules(rules) {
    const sanitized = SecurityUtil.sanitizeRules(Array.isArray(rules) ? rules : []);
    return new Promise((resolve) => {
      chrome.storage.local.set({ rules: sanitized }, () => resolve(sanitized));
    });
  },

  async getUserHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['userHistory'], (res) => {
        resolve(SecurityUtil.sanitizeUserHistory(res.userHistory || {}));
      });
    });
  },

  async recordUserTouch(userKey, record = {}) {
    const key = String(userKey || '').slice(0, 200);
    if (!key || SecurityUtil.isDangerousKey(key)) return null;
    const history = SecurityUtil.sanitizeUserHistory(await this.getUserHistory());
    const current = history[key] || {};
    const now = Date.now();
    history[key] = {
      ...current,
      userKey: key,
      userName: String(record.userName || current.userName || '').slice(0, 200),
      profileLink: SecurityUtil.sanitizeFacebookHttpsUrl(record.profileLink || current.profileLink || ''),
      lastTriggerTime: now,
      lastDmTime: record.dmSentSuccess ? now : Number(current.lastDmTime || 0),
      dmSentSuccess: record.dmSentSuccess === true || current.dmSentSuccess === true,
      lastCommentKey: String(record.lastCommentKey || current.lastCommentKey || '').slice(0, 200),
      lastPostTitle: String(record.lastPostTitle || current.lastPostTitle || '').slice(0, 500),
      aliasUserKey: String(record.aliasUserKey || current.aliasUserKey || '').slice(0, 200)
    };
    return new Promise((resolve) => {
      chrome.storage.local.set({ userHistory: history }, () => resolve(history[key]));
    });
  },

  async isUserInDmCooldown(userKey, hours) {
    if (!userKey || Number(hours) <= 0) return false;
    const history = await this.getUserHistory();
    const rec = history[userKey];
    if (!rec || !rec.lastDmTime) return false;
    return (Date.now() - Number(rec.lastDmTime)) < Number(hours) * 60 * 60 * 1000;
  },

  async clearUserHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ userHistory: {} }, () => resolve({}));
    });
  },

  async getProcessedComments() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['processedComments'], (res) => resolve(res.processedComments || []));
    });
  },

  async isCommentProcessed(commentKey) {
    if (!commentKey || SecurityUtil.isDangerousKey(commentKey)) return false;
    const list = await this.getProcessedComments();
    return list.includes(commentKey);
  },

  async markCommentProcessed(commentKey, meta = {}) {
    if (!commentKey || SecurityUtil.isDangerousKey(commentKey)) return false;
    const commentId = String(commentKey).slice(0, 200);
    commentKey = commentId;
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(['processedComments', 'processedCommentMeta'], resolve);
    });
    const list = data.processedComments || [];
    const metaMap = data.processedCommentMeta || {};
    if (!list.includes(commentKey)) list.push(commentKey);
    while (list.length > 16000) {
      const removed = list.shift();
      delete metaMap[removed];
    }
    const sanitizedMeta = SecurityUtil.sanitizeProcessedMeta({ [commentKey]: { ...meta, processedAt: Date.now() } });
    metaMap[commentKey] = sanitizedMeta[commentKey] || { processedAt: Date.now() };
    return new Promise((resolve) => {
      chrome.storage.local.set({ processedComments: list, processedCommentMeta: metaMap }, () => resolve(true));
    });
  },

  async clearProcessedComments() {
    return new Promise((resolve) => {
      chrome.storage.local.set({
        processedComments: [],
        processedCommentMeta: {},
        failedComments: {},
        workerReservations: {}
      }, () => resolve(true));
    });
  },

  async getFailedComments() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['failedComments'], (res) => resolve(res.failedComments || {}));
    });
  },

  async recordCommentFailure(commentKey, errorMessage = '') {
    const failed = await this.getFailedComments();
    const rec = failed[commentKey] || { count: 0, lastAttempt: 0, errorMessage: '' };
    failed[commentKey] = {
      count: Number(rec.count || 0) + 1,
      lastAttempt: Date.now(),
      errorMessage: String(errorMessage || '')
    };
    return new Promise((resolve) => {
      chrome.storage.local.set({ failedComments: failed }, () => resolve(failed[commentKey]));
    });
  },

  async clearCommentFailure(commentKey) {
    const failed = await this.getFailedComments();
    if (failed[commentKey]) delete failed[commentKey];
    return new Promise((resolve) => {
      chrome.storage.local.set({ failedComments: failed }, () => resolve(true));
    });
  },

  async canRetryComment(commentKey, maxRetries = 3, backoffSeconds = 45) {
    const failed = await this.getFailedComments();
    const rec = failed[commentKey];
    if (!rec) return { canRetry: true, count: 0 };
    if (Number(rec.count || 0) >= Number(maxRetries || 3)) {
      return { canRetry: false, count: rec.count, exhausted: true };
    }
    const elapsed = Date.now() - Number(rec.lastAttempt || 0);
    const waitMs = Number(backoffSeconds || 45) * 1000;
    if (elapsed < waitMs) {
      return { canRetry: false, count: rec.count, exhausted: false, waitMs: waitMs - elapsed };
    }
    return { canRetry: true, count: rec.count };
  },

  async getWorkerReservations() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['workerReservations'], (res) => resolve(res.workerReservations || {}));
    });
  },

  async cleanupStaleWorkerReservations(maxAgeMs = 12 * 60 * 1000) {
    const map = await this.getWorkerReservations();
    const now = Date.now();
    let changed = false;
    const removed = [];
    for (const [key, rec] of Object.entries(map)) {
      if (!rec || now - Number(rec.createdAt || 0) > maxAgeMs) {
        removed.push(rec || { taskKey: key });
        delete map[key];
        changed = true;
      }
    }
    if (changed) {
      await new Promise((resolve) => chrome.storage.local.set({ workerReservations: map }, resolve));
    }
    return { map, removed };
  },

  async reserveTask(task) {
    if (!task || !task.commentKey || SecurityUtil.isDangerousKey(task.commentKey)) return { ok: false, reason: 'INVALID_TASK' };
    const map = await this.getWorkerReservations();
    if (map[task.commentKey]) return { ok: false, reason: 'TASK_RESERVED', reservation: map[task.commentKey] };
    if (task.userKey) {
      const sameUser = Object.values(map).find(rec => rec && rec.userKey && rec.userKey === task.userKey);
      if (sameUser) return { ok: false, reason: 'USER_RESERVED', reservation: sameUser };
    }
    const rec = {
      taskKey: task.commentKey,
      userKey: task.userKey || '',
      task,
      tabId: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    map[task.commentKey] = rec;
    return new Promise((resolve) => {
      chrome.storage.local.set({ workerReservations: map }, () => resolve({ ok: true, reservation: rec }));
    });
  },

  async bindWorkerTab(taskKey, tabId) {
    const map = await this.getWorkerReservations();
    if (!map[taskKey]) return false;
    map[taskKey].tabId = Number(tabId || 0);
    map[taskKey].updatedAt = Date.now();
    return new Promise((resolve) => {
      chrome.storage.local.set({ workerReservations: map }, () => resolve(true));
    });
  },

  async getWorkerAssignmentByTabId(tabId) {
    const map = await this.getWorkerReservations();
    return Object.values(map).find(rec => Number(rec?.tabId || 0) === Number(tabId || 0)) || null;
  },

  async getWorkerReservation(taskKey) {
    const map = await this.getWorkerReservations();
    return map[taskKey] || null;
  },

  async updateWorkerReservation(taskKey, updates = {}) {
    if (!taskKey) return null;
    const map = await this.getWorkerReservations();
    if (!map[taskKey]) return null;
    const current = map[taskKey];
    map[taskKey] = {
      ...current,
      ...updates,
      task: updates.task ? { ...(current.task || {}), ...updates.task } : current.task,
      updatedAt: Date.now()
    };
    return new Promise((resolve) => {
      chrome.storage.local.set({ workerReservations: map }, () => resolve(map[taskKey]));
    });
  },

  async isTaskReserved(taskKey) {
    if (!taskKey) return false;
    const map = await this.getWorkerReservations();
    return !!map[taskKey];
  },

  async isUserReserved(userKey) {
    if (!userKey) return false;
    const map = await this.getWorkerReservations();
    return Object.values(map).some(rec => rec && rec.userKey === userKey);
  },

  async releaseWorkerReservation(taskKey) {
    const map = await this.getWorkerReservations();
    const rec = map[taskKey] || null;
    if (map[taskKey]) delete map[taskKey];
    return new Promise((resolve) => {
      chrome.storage.local.set({ workerReservations: map }, () => resolve(rec));
    });
  },

  async releaseWorkerReservationByTabId(tabId) {
    const map = await this.getWorkerReservations();
    let released = null;
    for (const [key, rec] of Object.entries(map)) {
      if (Number(rec?.tabId || 0) === Number(tabId || 0)) {
        released = rec;
        delete map[key];
        break;
      }
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ workerReservations: map }, () => resolve(released));
    });
  },

  async clearWorkerReservations() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ workerReservations: {} }, () => resolve(true));
    });
  },

  async getLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['logs'], (res) => resolve(SecurityUtil.sanitizeLogs(res.logs || [])));
    });
  },

  async addLog(logEntry = {}) {
    const logs = await this.getLogs();
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const item = SecurityUtil.sanitizeLogItem({
      id: `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timestamp: timeStr,
      userName: logEntry.userName || '\u672a\u77e5\u7528\u6237',
      userKey: logEntry.userKey || '',
      postTitle: logEntry.postTitle || '',
      postUrl: logEntry.postUrl || '',
      profileLink: logEntry.profileLink || '',
      commentKey: logEntry.commentKey || '',
      commentText: logEntry.commentText || '',
      matchedKeyword: logEntry.matchedKeyword || '-',
      dmStatus: logEntry.dmStatus || '\u672a\u53d1\u9001',
      reason: logEntry.reason || '',
      workerTabId: logEntry.workerTabId || 0,
      level: logEntry.level || 'info'
    });
    logs.unshift(item);
    if (logs.length > 3000) logs.length = 3000;
    return new Promise((resolve) => {
      chrome.storage.local.set({ logs }, () => resolve(item));
    });
  },

  async clearLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ logs: [] }, () => resolve([]));
    });
  },

  async exportFullBackup() {
    const settings = await this.getSettings();
    const rules = await this.getRules();
    const raw = await new Promise((resolve) => {
      chrome.storage.local.get([
        'userHistory',
        'processedComments',
        'processedCommentMeta',
        'failedComments',
        'logs'
      ], resolve);
    });

    const safeSettings = SecurityUtil.sanitizeSettingsObject(settings, { forImport: true });

    const userHistory = raw.userHistory || {};
    const processedComments = Array.isArray(raw.processedComments) ? raw.processedComments : [];
    const processedCommentMeta = raw.processedCommentMeta || {};
    const failedComments = raw.failedComments || {};
    const logs = Array.isArray(raw.logs) ? raw.logs : [];

    return {
      format: PLAIN_BACKUP_FORMAT,
      version: '2.12.1',
      exportDate: new Date().toISOString(),
      settings: safeSettings,
      rules: SecurityUtil.sanitizeRules(rules),
      userHistory: SecurityUtil.sanitizeUserHistory(userHistory),
      processedComments: SecurityUtil.sanitizeStringArray(processedComments, IMPORT_LIMITS.maxProcessedComments, 200),
      processedCommentMeta: SecurityUtil.sanitizeProcessedMeta(processedCommentMeta),
      failedComments: SecurityUtil.sanitizeFailedComments(failedComments),
      logs: SecurityUtil.sanitizeLogs(logs),
      summary: {
        usersWithHistory: Object.keys(userHistory).length,
        processedComments: processedComments.length,
        failedCommentRecords: Object.keys(failedComments).length,
        logs: logs.length
      }
    };
  },

  async importFullBackup(data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('INVALID_BACKUP');
    if (!SecurityUtil.isPlainBackup(data)) throw new Error('INVALID_BACKUP');

    const importedSettings = data.settings && typeof data.settings === 'object'
      ? SecurityUtil.sanitizeSettingsObject(data.settings, { forImport: true })
      : null;
    if (importedSettings) await this.saveSettings(importedSettings);
    if (Array.isArray(data.rules)) await this.saveRules(data.rules);

    const patch = {
      workerReservations: {},
      filterGuards: {}
    };
    if (data.userHistory && typeof data.userHistory === 'object') {
      patch.userHistory = SecurityUtil.sanitizeUserHistory(data.userHistory);
    }
    if (Array.isArray(data.processedComments)) {
      patch.processedComments = SecurityUtil.sanitizeStringArray(
        data.processedComments,
        IMPORT_LIMITS.maxProcessedComments,
        200
      );
    }
    if (data.processedCommentMeta && typeof data.processedCommentMeta === 'object') {
      patch.processedCommentMeta = SecurityUtil.sanitizeProcessedMeta(data.processedCommentMeta);
    }
    if (data.failedComments && typeof data.failedComments === 'object') {
      patch.failedComments = SecurityUtil.sanitizeFailedComments(data.failedComments);
    }
    if (Array.isArray(data.logs)) patch.logs = SecurityUtil.sanitizeLogs(data.logs);
    await new Promise((resolve) => chrome.storage.local.set(patch, resolve));

    const restoredSettings = await this.getSettings();
    return {
      settingsRestored: !!importedSettings,
      rulesRestored: Array.isArray(data.rules) ? data.rules.length : 0,
      usersRestored: patch.userHistory ? Object.keys(patch.userHistory).length : 0,
      processedRestored: Array.isArray(patch.processedComments) ? patch.processedComments.length : 0,
      logsRestored: Array.isArray(patch.logs) ? patch.logs.length : 0,
      themeColor: restoredSettings.themeColor || 'cyan',
      appearanceMode: restoredSettings.appearanceMode || 'light'
    };
  },

  async clearAllRuntimeHistory() {
    await this.clearUserHistory();
    await this.clearProcessedComments();
    await this.clearLogs();
    await this.clearWorkerReservations();
    await this.resetStats();
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.StorageUtil = StorageUtil;
  globalThis.SecurityUtil = SecurityUtil;
  globalThis.DEFAULT_COMMENTS_MANAGER_URL = DEFAULT_COMMENTS_MANAGER_URL;
  globalThis.IMPORT_LIMITS = IMPORT_LIMITS;
}
if (typeof window !== 'undefined') {
  window.StorageUtil = StorageUtil;
  window.SecurityUtil = SecurityUtil;
}
