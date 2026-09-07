document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const statusBadge = $('statusBadge');
  const statusText = $('statusText');
  const liveStatusContent = $('liveStatusContent');
  const emergencyAlert = $('emergencyAlert');
  const emergencyDesc = $('emergencyDesc');
  const btnStart = $('btnStart');
  const btnPause = $('btnPause');
  const btnStop = $('btnStop');
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
    if ($('appearanceButtonText')) $('appearanceButtonText').textContent = normalized === 'dark' ? '暗色' : '亮色';
    const btn = $('btnAppearanceMode');
    if (btn) {
      const first = btn.childNodes[0];
      if (first) first.nodeValue = (normalized === 'dark' ? '🌙 界面：' : '☀️ 界面：');
      btn.title = normalized === 'dark' ? '当前为暗色模式，点击切换亮色' : '当前为亮色模式，点击切换暗色';
    }
    return normalized;
  }

  function applyTheme(themeId) {
    const theme = THEME_PRESETS.find(t => t.id === themeId) || THEME_PRESETS[0];
    document.documentElement.dataset.theme = theme.id;
    if ($('themeButtonText')) $('themeButtonText').textContent = theme.label;
    return theme.id;
  }

  async function refreshUI() {
    let settings;
    try {
      settings = await StorageUtil.getSettings();
    } catch (e) {
      liveStatusContent.textContent = '存储读取失败，请重新加载插件。';
      return;
    }

    const stats = settings.stats || {};
    $('statSeen').textContent = stats.totalSeen || 0;
    $('statDm').textContent = stats.totalDmSent || 0;
    $('statSkipped').textContent = stats.totalSkippedCooldown || 0;
    $('statErrors').textContent = stats.totalErrors || 0;
    if ($('statWorkers')) {
      $('statWorkers').textContent = `${Math.min(1, Number(settings.activeWorkerCount || 0))}/1`;
    }
    liveStatusContent.textContent = settings.statusMessage || '等待任务启动...';
    applyTheme(settings.themeColor || 'cyan');
    applyAppearanceMode(settings.appearanceMode || 'light');
    updateRefreshCountdown(settings);

    if (settings.emergencyBrakeReason) {
      statusBadge.className = 'status-badge brake';
      statusText.textContent = '熔断锁定';
      emergencyAlert.style.display = 'block';
      emergencyDesc.textContent = settings.emergencyBrakeReason;
      btnStart.disabled = true;
      btnPause.disabled = true;
      btnStop.disabled = true;
      return;
    }

    emergencyAlert.style.display = 'none';

    if (settings.isRunning && !settings.isPaused) {
      statusBadge.className = 'status-badge running';
      statusText.textContent = '运行中 🟢';
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
      btnStart.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      btnStart.style.boxShadow = '0 0 14px rgba(16,185,129,0.5)';
      btnStart.querySelector('span:last-child').textContent = '🟢 评论私信运行中';
    } else if (settings.isRunning && settings.isPaused) {
      statusBadge.className = 'status-badge paused';
      statusText.textContent = '已暂停 ⏸';
      btnStart.disabled = false;
      btnPause.disabled = true;
      btnStop.disabled = false;
      btnStart.style.background = '';
      btnStart.style.boxShadow = '';
      btnStart.querySelector('span:last-child').textContent = '▶ 继续运行';
    } else {
      statusBadge.className = 'status-badge';
      statusText.textContent = '就绪';
      btnStart.disabled = false;
      btnPause.disabled = true;
      btnStop.disabled = true;
      btnStart.style.background = '';
      btnStart.style.boxShadow = '';
      btnStart.querySelector('span:last-child').textContent = '启动评论管理工具';
    }
  }

  function updateRefreshCountdown(settings) {
    const intervalMinutes = Math.max(1, Number(settings.periodicRefreshMinutes || Math.round(Number(settings.idleRefreshSeconds || 300) / 60) || 5));
    const intervalEl = $('popupRefreshInterval');
    const countdownEl = $('popupRefreshCountdown');
    if (intervalEl) intervalEl.textContent = settings.periodicRefreshEnabled === false ? '定时刷新已关闭' : `周期 ${intervalMinutes} 分钟`;
    if (!countdownEl) return;
    if (!settings.isRunning || settings.isPaused || settings.periodicRefreshEnabled === false) {
      countdownEl.textContent = '--:--';
      countdownEl.classList.remove('soon', 'soon-text');
      return;
    }
    if (settings.pendingPeriodicRefresh) {
      countdownEl.textContent = '发送后补刷';
      countdownEl.classList.add('soon', 'soon-text');
      return;
    }
    countdownEl.classList.remove('soon-text');
    const nextAt = Number(settings.nextPeriodicRefreshAt || 0);
    if (!nextAt) {
      countdownEl.textContent = '等待';
      countdownEl.classList.remove('soon');
      return;
    }
    const secTotal = Math.ceil(Math.max(0, nextAt - Date.now()) / 1000);
    const min = Math.floor(secTotal / 60);
    const sec = secTotal % 60;
    countdownEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    countdownEl.classList.toggle('soon', secTotal <= 30);
  }

  function sendMessageSafe(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  btnStart.addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    if (settings.emergencyBrakeReason) return;
    await StorageUtil.saveSettings({
      isRunning: true,
      isPaused: false,
      statusMessage: '🚀 正在启动 Facebook 评论管理工具...'
    });
    sendMessageSafe({ action: 'START_MONITOR' });
    await refreshUI();
  });

  btnPause.addEventListener('click', async () => {
    await StorageUtil.saveSettings({ isRunning: true, isPaused: true, statusMessage: '⏸ 评论管理任务已暂停' });
    sendMessageSafe({ action: 'PAUSE_MONITOR' });
    await refreshUI();
  });

  btnStop.addEventListener('click', async () => {
    await StorageUtil.saveSettings({ isRunning: false, isPaused: false, statusMessage: '⏹ 评论管理任务已停止' });
    sendMessageSafe({ action: 'STOP_MONITOR' });
    await refreshUI();
  });

  $('btnResetBrake').addEventListener('click', async () => {
    await StorageUtil.saveSettings({
      isRunning: false,
      isPaused: false,
      emergencyBrakeReason: '',
      statusMessage: '已解除熔断，系统恢复就绪'
    });
    await refreshUI();
  });

  $('btnOpenInbox').addEventListener('click', () => sendMessageSafe({ action: 'OPEN_INBOX' }));
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
  $('btnOpenDashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());

  await refreshUI();
  const timer = setInterval(refreshUI, 1200);
  window.addEventListener('unload', () => clearInterval(timer));
});
