document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const THEME_PRESETS = [
    { id: 'cyan', label: '蓝青' },
    { id: 'violet', label: '紫罗兰' },
    { id: 'emerald', label: '翡翠绿' },
    { id: 'amber', label: '琥珀橙' },
    { id: 'rose', label: '玫瑰红' }
  ];

  function applyAppearanceMode(mode) {
    const normalized = mode === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.appearance = normalized;
    const text = $('appearanceButtonText');
    if (text) text.textContent = normalized === 'dark' ? '暗色' : '亮色';
    const btn = $('btnAppearanceMode');
    if (btn) {
      const icon = normalized === 'dark' ? '🌙' : '☀️';
      btn.childNodes[0].nodeValue = icon + ' ';
      btn.title = normalized === 'dark' ? '当前为暗色模式，点击切换亮色' : '当前为亮色模式，点击切换暗色';
    }
    return normalized;
  }

  function applyTheme(themeId) {
    const theme = THEME_PRESETS.find(t => t.id === themeId) || THEME_PRESETS[0];
    document.documentElement.dataset.theme = theme.id;
    const text = $('themeButtonText');
    if (text) text.textContent = theme.label;
    return theme.id;
  }

  async function loadTheme() {
    const settings = await StorageUtil.getSettings();
    applyTheme(settings.themeColor || 'cyan');
    applyAppearanceMode(settings.appearanceMode || 'light');
  }

  const navItems = document.querySelectorAll('.nav-item');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const pageTitle = $('pageTitle');
  const tabTitles = {
    'tab-monitor': 'Facebook 评论管理工具监控',
    'tab-rules': '反向关键词与私信',
    'tab-strategy': '优先级与去重策略',
    'tab-logs': '运行日志与导出',
    'tab-backup': '配置导入与备份'
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.dataset.tab;
      navItems.forEach(i => i.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      item.classList.add('active');
      $(targetTab).classList.add('active');
      pageTitle.textContent = tabTitles[targetTab] || '控制台';
      if (targetTab === 'tab-logs') renderLogs();
      if (targetTab === 'tab-rules') renderRules();
      if (targetTab === 'tab-strategy') loadStrategy();
    });
  });

  async function updateStatusIndicator() {
    const settings = await StorageUtil.getSettings();
    const sideStatusDot = $('sideStatusDot');
    const sideStatusText = $('sideStatusText');
    const topBtnStart = $('topBtnStart');
    const topBtnStartText = $('topBtnStartText');
    const topBtnStop = $('topBtnStop');
    const topStatusPill = $('topStatusPill');
    const topStatusPillText = $('topStatusPillText');

    if (settings.emergencyBrakeReason) {
      sideStatusDot.className = 'status-indicator-dot';
      sideStatusText.textContent = '风控熔断';
      topBtnStart.className = 'btn-top btn-top-start idle';
      topBtnStartText.textContent = '解除后启动';
      topBtnStop.disabled = true;
      topStatusPill.className = 'live-status-pill idle';
      topStatusPillText.textContent = '🚨 已熔断';
    } else if (settings.isRunning && !settings.isPaused) {
      sideStatusDot.className = 'status-indicator-dot active';
      sideStatusText.textContent = '评论监控运行中';
      topBtnStart.className = 'btn-top btn-top-start running';
      topBtnStartText.textContent = '🟢 监控进行中';
      topBtnStop.disabled = false;
      topStatusPill.className = 'live-status-pill running';
      topStatusPillText.textContent = '🟢 最新评论优先';
    } else if (settings.isRunning && settings.isPaused) {
      sideStatusDot.className = 'status-indicator-dot';
      sideStatusText.textContent = '任务已暂停';
      topBtnStart.className = 'btn-top btn-top-start idle';
      topBtnStartText.textContent = '继续运行';
      topBtnStop.disabled = false;
      topStatusPill.className = 'live-status-pill idle';
      topStatusPillText.textContent = '⏸ 已暂停';
    } else {
      sideStatusDot.className = 'status-indicator-dot';
      sideStatusText.textContent = '系统就绪';
      topBtnStart.className = 'btn-top btn-top-start idle';
      topBtnStartText.textContent = '启动任务';
      topBtnStop.disabled = true;
      topStatusPill.className = 'live-status-pill idle';
      topStatusPillText.textContent = '系统就绪';
    }

    const stats = settings.stats || {};
    $('dashSeen').textContent = stats.totalSeen || 0;
    $('dashSent').textContent = stats.totalDmSent || 0;
    $('dashCooldown').textContent = stats.totalSkippedCooldown || 0;
    $('dashNoRule').textContent = stats.totalBlockedKeyword || stats.totalNoRule || 0;
    if ($('dashWorkers')) {
      $('dashWorkers').textContent = `${Math.min(1, Number(settings.activeWorkerCount || 0))}/1`;
    }
    $('dashErrors').textContent = stats.totalErrors || 0;
    $('monitorStatusMessage').textContent = settings.statusMessage || '等待启动...';
    $('lastScanText').textContent = formatRelativeTime(settings.lastScanAt || settings.lastInboxHeartbeat || 0);
    updateRefreshCountdown(settings);
  }

  $('topBtnStart').addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    if (settings.emergencyBrakeReason) {
      alert('当前仍处于风控熔断状态，请先在插件 Popup 中解除熔断。');
      return;
    }
    await StorageUtil.saveSettings({ isRunning: true, isPaused: false, statusMessage: '正在启动 Facebook 评论管理工具...' });
    sendMessageSafe({ action: 'START_MONITOR' });
    await updateStatusIndicator();
  });

  $('topBtnStop').addEventListener('click', async () => {
    await StorageUtil.saveSettings({ isRunning: false, isPaused: false, statusMessage: '任务已停止' });
    sendMessageSafe({ action: 'STOP_MONITOR' });
    await updateStatusIndicator();
  });

  $('btnOpenInbox').addEventListener('click', () => sendMessageSafe({ action: 'OPEN_INBOX' }));

  // ---------------- Strategy ----------------
  async function loadStrategy() {
    const s = await StorageUtil.getSettings();
    $('inputDialogOpenTimeout').value = s.privateDialogOpenTimeoutSeconds ?? 15;
    $('inputSendConfirmTimeout').value = s.sendConfirmTimeoutSeconds ?? 30;
    $('inputPostSendWait').value = s.postSendWaitSeconds ?? 10;
    $('inputRefreshMinutes').value = s.periodicRefreshMinutes ?? Math.max(1, Math.round((s.idleRefreshSeconds || 300) / 60));
    $('checkPeriodicRefresh').checked = s.periodicRefreshEnabled !== false;
    $('checkAssumeSuccessNoError').checked = s.assumeSuccessAfterClickNoError !== false;
    $('inputScanInterval').value = s.scanIntervalSeconds ?? 3;
    $('inputCooldown').value = s.dmCooldownHours ?? s.globalCooldownHours ?? 72;
    $('inputMaxCommentAgeDays').value = s.maxCommentAgeDays ?? 7;
    $('checkProcessOlder').checked = s.processOlderComments !== false;
    $('checkAutoSelect').checked = s.autoSelectFacebookComments !== false;
    $('checkEmergencyBrake').checked = s.emergencyBrakeEnabled !== false;
  }

  async function saveStrategy() {
    const privateDialogOpenTimeoutSeconds = clampInt($('inputDialogOpenTimeout').value, 5, 45, 15);
    const sendConfirmTimeoutSeconds = clampInt($('inputSendConfirmTimeout').value, 10, 90, 30);
    const postSendWaitSeconds = clampInt($('inputPostSendWait').value, 1, 20, 10);
    const scanIntervalSeconds = clampInt($('inputScanInterval').value, 2, 120, 3);
    const periodicRefreshMinutes = clampInt($('inputRefreshMinutes').value, 1, 60, 5);
    const periodicRefreshEnabled = $('checkPeriodicRefresh').checked;
    const dmCooldownHours = clampInt($('inputCooldown').value, 0, 720, 72);
    const maxCommentAgeDays = clampInt($('inputMaxCommentAgeDays').value, 1, 30, 7);
    await StorageUtil.saveSettings({
      singleWorkerMode: true,
      persistentWorkerMode: true,
      strictSequentialSend: true,
      pauseOnSendFailure: false,
      privateDialogOpenTimeoutSeconds,
      privateDialogOpenRetryClicks: 2,
      sendConfirmTimeoutSeconds,
      sendInProgressGraceSeconds: 45,
      postSendWaitSeconds,
      scanIntervalSeconds,
      periodicRefreshMinutes,
      periodicRefreshEnabled,
      idleRefreshSeconds: periodicRefreshMinutes * 60,
      idleRefreshEnabled: periodicRefreshEnabled,
      dmCooldownHours,
      globalCooldownHours: dmCooldownHours,
      maxSendRetries: 1,
      maxCommentAgeDays,
      forceAllCommentsFilter: true,
      refreshAfterSuccess: false,
      processOlderComments: $('checkProcessOlder').checked,
      autoSelectFacebookComments: $('checkAutoSelect').checked,
      replyAllComments: true,
      reverseKeywordMode: true,
      emergencyBrakeEnabled: $('checkEmergencyBrake').checked,
      assumeSuccessAfterClickNoError: $('checkAssumeSuccessNoError').checked
    });
    $('tipSaveStrategy').textContent = '✓ 策略已保存';
    setTimeout(() => $('tipSaveStrategy').textContent = '', 2500);
  }

  $('btnSaveStrategy').addEventListener('click', saveStrategy);
  ['inputDialogOpenTimeout', 'inputSendConfirmTimeout', 'inputPostSendWait', 'inputScanInterval', 'inputRefreshMinutes', 'inputCooldown', 'inputMaxCommentAgeDays'].forEach(id => {
    $(id).addEventListener('change', saveStrategy);
  });
  ['checkProcessOlder', 'checkAutoSelect', 'checkPeriodicRefresh', 'checkAssumeSuccessNoError', 'checkEmergencyBrake'].forEach(id => {
    $(id).addEventListener('change', saveStrategy);
  });

  $('btnResetUserHistory').addEventListener('click', async () => {
    if (!confirm('确定清空用户冷却记录吗？清空后之前私信过的用户可以再次触发。')) return;
    await StorageUtil.clearUserHistory();
    alert('已清空用户冷却记录。');
  });

  $('btnClearProcessed').addEventListener('click', async () => {
    if (!confirm('确定清空评论去重记录吗？清空后已经扫描过的评论可能重新进入处理流程。')) return;
    await StorageUtil.clearProcessedComments();
    alert('已清空评论去重记录。');
  });

  // ---------------- Rules ----------------
  const rulesContainer = $('rulesContainer');
  const ruleModal = $('ruleModal');
  let editingRuleId = null;

  async function renderRules() {
    const rules = await StorageUtil.getRules();
    rulesContainer.innerHTML = '';
    if (!rules.length) {
      rulesContainer.innerHTML = '<div class="empty-cell">尚无规则，请添加一套私信话术。反向关键词可以留空。</div>';
      return;
    }
    rules.forEach(rule => {
      const card = document.createElement('div');
      card.className = 'rule-item-card';
      card.innerHTML = `
        <div class="rule-item-info">
          <h4>${escapeHtml(rule.name || '未命名规则')}</h4>
          <div class="rule-tags">
            <span class="tag tag-cyan">${rule.matchType === 'exact' ? '排除：完全等于' : '排除：包含即跳过'}</span>
            <span class="tag tag-purple">默认全部评论私信</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">反向关键词 ${(rule.keywords || []).length} 个 · 私信模板 ${(rule.dmTemplates || []).length} 套</div>
        </div>
        <div class="rule-actions">
          <button class="btn btn-secondary btn-edit-rule" data-id="${escapeAttr(rule.id)}">编辑</button>
          <button class="btn btn-danger-outline btn-del-rule" data-id="${escapeAttr(rule.id)}">删除</button>
        </div>`;
      rulesContainer.appendChild(card);
    });
    document.querySelectorAll('.btn-edit-rule').forEach(btn => btn.addEventListener('click', () => openRuleModal(btn.dataset.id)));
    document.querySelectorAll('.btn-del-rule').forEach(btn => btn.addEventListener('click', () => deleteRule(btn.dataset.id)));
  }

  function renderKeywordGrid(items = []) {
    const container = $('keywordsGrid');
    container.innerHTML = '';
    (items.length ? items : ['']).forEach(v => addKeywordCell(v));
  }

  function renderTemplateGrid(items = []) {
    const container = $('dmTemplatesGrid');
    container.innerHTML = '';
    (items.length ? items : ['']).forEach(v => addTemplateCell(v));
  }

  function addKeywordCell(value = '') {
    const container = $('keywordsGrid');
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    const input = document.createElement('input');
    input.className = 'grid-cell-input';
    input.type = 'text';
    input.value = value;
    input.placeholder = '反向关键词';
    const del = document.createElement('button');
    del.className = 'btn-delete-cell';
    del.innerHTML = '&times;';
    del.addEventListener('click', () => { cell.remove(); if (!container.children.length) addKeywordCell(''); });
    cell.append(input, del);
    container.appendChild(cell);
  }

  function addTemplateCell(value = '') {
    const container = $('dmTemplatesGrid');
    const cell = document.createElement('div');
    cell.className = 'grid-cell-template';
    const content = document.createElement('div');
    content.className = 'template-content';
    const textarea = document.createElement('textarea');
    textarea.className = 'grid-cell-textarea';
    textarea.value = value;
    textarea.placeholder = '输入私信内容...';
    const toolbar = document.createElement('div');
    toolbar.className = 'template-toolbar';
    [
      ['[FirstName]', '🧑 名字'],
      ['[FullName]', '👤 全名'],
      ['{commentText}', '💬 评论'],
      ['{postTitle}', '📝 贴文']
    ].forEach(([token, label]) => {
      const btn = document.createElement('button');
      btn.className = 'btn-tool';
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => insertTextAtCursor(textarea, token));
      toolbar.appendChild(btn);
    });
    content.append(textarea, toolbar);
    const del = document.createElement('button');
    del.className = 'btn-delete-cell';
    del.innerHTML = '&times;';
    del.addEventListener('click', () => { cell.remove(); if (!container.children.length) addTemplateCell(''); });
    cell.append(content, del);
    container.appendChild(cell);
  }

  function insertTextAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
  }

  function getGridValues(id) {
    return Array.from($(id).querySelectorAll('.grid-cell-input, .grid-cell-textarea'))
      .map(el => el.value.trim())
      .filter(Boolean);
  }

  function parseKeywordPaste(text) {
    return String(text || '').split(/[\n\r\t,，]/).map(v => v.trim()).filter(Boolean);
  }

  document.addEventListener('paste', (e) => {
    const grid = e.target.closest('#keywordsGrid');
    if (!grid) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!/[\n\r\t,，]/.test(text)) return;
    e.preventDefault();
    const items = [...getGridValues('keywordsGrid'), ...parseKeywordPaste(text)];
    renderKeywordGrid(items);
  }, true);

  function openRuleModal(ruleId = null) {
    editingRuleId = ruleId;
    if (!ruleId) {
      $('modalTitle').textContent = '新建排除规则';
      $('ruleName').value = '反向关键词与私信话术';
      $('ruleMatchType').value = 'contains';
      renderKeywordGrid(['']);
      renderTemplateGrid(['Zdravo [FirstName], hvala ti na komentaru. 🙏']);
      ruleModal.classList.add('active');
      return;
    }
    StorageUtil.getRules().then(rules => {
      const rule = rules.find(r => r.id === ruleId);
      if (!rule) return;
      $('modalTitle').textContent = '编辑排除规则';
      $('ruleName').value = rule.name || '';
      $('ruleMatchType').value = rule.matchType || 'contains';
      renderKeywordGrid(rule.keywords || []);
      renderTemplateGrid(rule.dmTemplates || []);
      ruleModal.classList.add('active');
    });
  }

  async function saveRule() {
    const rules = await StorageUtil.getRules();
    const rule = {
      id: editingRuleId || `rule_${Date.now()}`,
      name: $('ruleName').value.trim() || '未命名规则',
      matchType: $('ruleMatchType').value,
      keywords: getGridValues('keywordsGrid'),
      dmTemplates: getGridValues('dmTemplatesGrid')
    };
    if (editingRuleId) {
      const idx = rules.findIndex(r => r.id === editingRuleId);
      if (idx >= 0) rules[idx] = rule; else rules.push(rule);
    } else {
      rules.push(rule);
    }
    await StorageUtil.saveRules(rules);
    ruleModal.classList.remove('active');
    await renderRules();
  }

  async function deleteRule(id) {
    if (!confirm('确定删除这条规则吗？')) return;
    const rules = (await StorageUtil.getRules()).filter(r => r.id !== id);
    await StorageUtil.saveRules(rules);
    await renderRules();
  }

  $('btnAddRule').addEventListener('click', () => openRuleModal());
  $('btnModalClose').addEventListener('click', () => ruleModal.classList.remove('active'));
  $('btnModalCancel').addEventListener('click', () => ruleModal.classList.remove('active'));
  $('btnModalSave').addEventListener('click', saveRule);
  $('btnAddKeywordCell').addEventListener('click', () => addKeywordCell(''));
  $('btnAddDmCell').addEventListener('click', () => addTemplateCell(''));
  $('btnClearKeywordsGrid').addEventListener('click', () => renderKeywordGrid(['']));
  $('btnClearDmGrid').addEventListener('click', () => renderTemplateGrid(['']));

  // ---------------- Logs ----------------
  async function renderLogs() {
    const logs = await StorageUtil.getLogs();
    const body = $('logsTableBody');
    body.innerHTML = '';
    if (!logs.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-cell">暂无日志数据</td></tr>';
      return;
    }
    logs.forEach(item => {
      const tr = document.createElement('tr');
      const profileHref = SecurityUtil.sanitizeFacebookHttpsUrl(item.profileLink);
      const postHref = SecurityUtil.sanitizeFacebookHttpsUrl(item.postUrl);
      const user = profileHref
        ? `<a href="${escapeAttr(profileHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.userName || '用户')}</a>`
        : `<b>${escapeHtml(item.userName || '用户')}</b>`;
      const post = postHref
        ? `<a href="${escapeAttr(postHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.postTitle || '贴文')}</a>`
        : escapeHtml(item.postTitle || '-');
      tr.innerHTML = `
        <td>${escapeHtml(item.timestamp || '')}</td>
        <td>${user}</td>
        <td><div style="max-width:280px;max-height:54px;overflow:auto">${escapeHtml(item.commentText || '')}</div></td>
        <td>${post}</td>
        <td><span class="tag tag-cyan">${escapeHtml(item.matchedKeyword || '-')}</span></td>
        <td>${escapeHtml(formatDmStatus(item.dmStatus || ''))}</td>
        <td><div style="max-width:280px;max-height:54px;overflow:auto;color:var(--text-muted)">${escapeHtml(formatReasonLabel(item.reason || ''))}</div></td>`;
      body.appendChild(tr);
    });
  }

  $('btnExportExcel').addEventListener('click', async () => {
    const logs = await StorageUtil.getLogs();
    ExcelExporter.exportLogsToCSV(logs, `FB_Comment_DM_Logs_${Date.now()}.csv`);
  });
  $('btnClearLogs').addEventListener('click', async () => {
    if (!confirm('确定清空所有日志吗？')) return;
    await StorageUtil.clearLogs();
    renderLogs();
  });
  $('btnResetStats').addEventListener('click', async () => {
    if (!confirm('确定重置统计数字吗？不会清空评论去重和用户冷却。')) return;
    await StorageUtil.resetStats();
    updateStatusIndicator();
  });

  // ---------------- Backup ----------------
  $('btnExportConfig').addEventListener('click', async () => {
    const backupData = await StorageUtil.exportFullBackup();
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FB_Comment_DM_Manager_FullBackup_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const summary = backupData.summary || {};
    alert(`完整备份已导出。\n已处理评论：${summary.processedComments || 0}\n用户历史：${summary.usersWithHistory || 0}\n日志：${summary.logs || 0}`);
  });
  $('btnImportConfig').addEventListener('click', () => $('fileImportConfig').click());
  $('fileImportConfig').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const maxBytes = (typeof IMPORT_LIMITS !== 'undefined' && IMPORT_LIMITS.maxBackupBytes) || (8 * 1024 * 1024);
    if (file.size > maxBytes) {
      alert('备份文件过大，已拒绝导入。');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const rawText = String(evt.target.result || '');
        if (rawText.length > maxBytes) throw new Error('BACKUP_TOO_LARGE');
        const data = JSON.parse(rawText);
        if (!SecurityUtil.isPlainBackup(data)) throw new Error('INVALID_BACKUP');
        try { await new Promise(resolve => chrome.runtime.sendMessage({ action: 'STOP_MONITOR' }, () => resolve())); } catch (err) {}
        const result = await StorageUtil.importFullBackup(data);
        await loadTheme();
        await loadStrategy();
        await renderRules();
        await renderLogs();
        await updateStatusIndicator();
        alert(`备份导入成功。\n恢复已处理评论：${result.processedRestored || 0}\n恢复用户历史：${result.usersRestored || 0}\n恢复日志：${result.logsRestored || 0}\n任务保持停止状态，请确认后再启动。`);
      } catch (err) {
        alert('配置文件格式错误或内容不安全，导入失败。');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  $('btnAppearanceMode').addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    const nextMode = (settings.appearanceMode || 'light') === 'dark' ? 'light' : 'dark';
    applyAppearanceMode(nextMode);
    await StorageUtil.saveSettings({ appearanceMode: nextMode });
  });

  $('btnThemeColor').addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    const current = settings.themeColor || 'cyan';
    const idx = Math.max(0, THEME_PRESETS.findIndex(t => t.id === current));
    const next = THEME_PRESETS[(idx + 1) % THEME_PRESETS.length];
    applyTheme(next.id);
    await StorageUtil.saveSettings({ themeColor: next.id });
  });

  function sendMessageSafe(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  function updateRefreshCountdown(settings) {
    const intervalMinutes = Math.max(1, Number(settings.periodicRefreshMinutes || Math.round(Number(settings.idleRefreshSeconds || 300) / 60) || 5));
    const intervalEl = $('refreshIntervalText');
    const countdownEl = $('refreshCountdown');
    if (intervalEl) intervalEl.textContent = settings.periodicRefreshEnabled === false ? '已关闭' : `${intervalMinutes} 分钟`;
    if (!countdownEl) return;
    if (!settings.isRunning || settings.isPaused || settings.periodicRefreshEnabled === false) {
      countdownEl.textContent = '--:--';
      countdownEl.classList.remove('countdown-soon');
      return;
    }
    const nextAt = Number(settings.nextPeriodicRefreshAt || 0);
    if (!nextAt) {
      countdownEl.textContent = '等待定时器';
      countdownEl.classList.remove('countdown-soon');
      return;
    }
    const remaining = Math.max(0, nextAt - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    countdownEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    countdownEl.classList.toggle('countdown-soon', totalSec <= 30);
  }

  function formatReasonLabel(reason) {
    const raw = String(reason || '');
    const map = {
      dm_sent: 'Messenger 已确认发送',
      dialog_closed_after_send: '点击发送后私信框关闭，确认成功',
      composer_removed_after_send: '发送后输入框消失，确认成功',
      composer_cleared_after_send: '发送后输入框清空，确认成功',
      composer_nearly_cleared_after_send: '发送后输入内容清空，确认成功',
      sent_status_text_detected: '检测到 Facebook 已发送状态',
      sent_message_echo_detected: '检测到已发送消息内容',
      private_dialog_enter_confirmed: 'Messenger 回车发送已确认',
      send_click_no_error_assumed_success: '发送按钮已点击，未检测到失败提示，按成功记录',
      enter_send_no_error_assumed_success: '回车发送已执行，未检测到失败提示，按成功记录',
      send_failed_exhausted: '发送失败，已跳过当前评论'
    };
    return map[raw] || raw;
  }

  function formatDmStatus(status) {
    const raw = String(status || '');
    if (raw.includes('连续失败') && raw.includes('已跳过')) return '⏭ 无法私信，已跳过';
    return raw;
  }

  function formatRelativeTime(ts) {
    if (!ts) return '尚未扫描';
    const diff = Date.now() - Number(ts);
    if (diff < 5000) return '刚刚';
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    return new Date(Number(ts)).toLocaleString();
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    const next = changes.settings.newValue || {};
    applyTheme(next.themeColor || 'cyan');
    applyAppearanceMode(next.appearanceMode || 'light');
  });

  await loadTheme();
  await loadStrategy();
  await renderRules();
  await renderLogs();
  await updateStatusIndicator();

  setInterval(updateStatusIndicator, 1500);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings) updateStatusIndicator();
  });
});
