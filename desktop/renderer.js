(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const githubRow = byId('github-row');
  const githubButton = byId('github-signin');
  const githubDot = byId('github-dot');
  const githubLabel = byId('github-status');
  const workerDot = byId('worker-dot');
  const workerLabel = byId('worker-status');
  const workspaceRow = byId('workspace-row');
  const workspaceDot = byId('workspace-dot');
  const workspaceLabel = byId('workspace-status');
  const autoAcceptRow = byId('auto-accept-row');
  const autoAcceptDot = byId('auto-accept-dot');
  const autoAcceptLabel = byId('auto-accept-status');
  const minimizeButton = byId('minimize');
  const quitButton = byId('quit');

  let githubState = null;
  let currentBridgeState = null;
  let authBusy = false;
  let authTimer = null;
  let loginCode = '';
  let autoAcceptAll = false;
  let workspaceBusy = false;

  function setDot(dot, status) {
    dot.className = 'status-dot ' + status;
  }

  function renderGitHub(state) {
    githubState = state || {};
    if (githubState.authenticated) {
      githubButton.disabled = false;
      githubButton.setAttribute('aria-label', 'Sign in again to GitHub');
      githubLabel.textContent = 'GitHub connected';
      githubLabel.title = githubState.login ? 'Connected as @' + githubState.login : 'Connected to GitHub';
      githubButton.textContent = 'Sign in again';
      githubButton.title = 'Sign in again or switch GitHub accounts';
      setDot(githubDot, 'online');
      return;
    }

    if (authBusy) {
      if (loginCode) {
        githubLabel.textContent = 'Enter code at GitHub';
        githubLabel.title = 'Use this one-time code on the GitHub device verification page. Click the code to copy it.';
        githubButton.disabled = false;
        githubButton.textContent = loginCode;
        githubButton.title = 'Click to copy the GitHub device code';
        githubButton.setAttribute('aria-label', 'Copy GitHub device code ' + loginCode);
      } else {
        githubLabel.textContent = 'Waiting for device code…';
        githubLabel.title = 'Waiting for GitHub CLI to provide the one-time device code.';
        githubButton.disabled = true;
        githubButton.textContent = 'Waiting…';
        githubButton.title = 'Waiting for the GitHub device code';
        githubButton.setAttribute('aria-label', 'Waiting for GitHub device code');
      }
      setDot(githubDot, 'waiting');
      return;
    }

    const networkUnavailable = /network|offline|fetch failed|failed to fetch|enotfound|eai_again|econn|timed out|unable to connect|socket|dns/i.test(String(githubState.error || ''));
    githubButton.disabled = false;
    githubButton.setAttribute('aria-label', 'Sign in to GitHub');
    githubLabel.textContent = networkUnavailable ? 'GitHub unavailable' : 'GitHub not connected';
    githubLabel.title = githubState.error || 'Sign in to connect this app to GitHub';
    githubButton.textContent = 'Sign in to GitHub';
    githubButton.title = 'Start GitHub sign-in; this button stays available while offline';
    setDot(githubDot, networkUnavailable ? 'error' : 'waiting');
  }

  function renderWorker(state) {
    currentBridgeState = state || {};
    const status = String(currentBridgeState.workerStatus || (currentBridgeState.running ? 'online' : 'connecting'));
    const labels = {
      online: 'Worker online',
      connecting: 'Worker connecting…',
      offline: 'Worker waiting for internet',
      github: 'Worker waiting for GitHub sign-in',
      setup: 'Worker needs configuration',
      attention: 'Worker needs attention'
    };
    workerLabel.textContent = labels[status] || 'Worker ' + status;
    workerLabel.title = String(currentBridgeState.connectionError || currentBridgeState.lastError || workerLabel.textContent);
    setDot(workerDot, status === 'online' ? 'online' : status === 'offline' || status === 'attention' || status === 'setup' ? 'error' : 'waiting');
    renderAutoAccept(currentBridgeState.autoAcceptAll === true);
  }

  function renderWorkspace(state) {
    const workspace = state || {};
    const root = typeof workspace.root === 'string' ? workspace.root : '';
    const leaf = root.split(/[\\/]/).filter(Boolean).pop() || root;
    const index = workspace.index || {};
    workspaceLabel.textContent = root ? 'Workspace: ' + leaf : 'Choose workspace folder';
    const details = [];
    if (root) details.push('Current folder: ' + root);
    if (Number.isInteger(index.entryCount)) details.push('Indexed entries: ' + index.entryCount);
    if (index.updatedAt) details.push('Last local index update: ' + index.updatedAt);
    if (index.truncated) details.push('Warning: index is incomplete due to size or entry limits.');
    if (workspace.syncError) details.push('Index sync error: ' + workspace.syncError);
    workspaceRow.title = 'Click to choose a different workspace folder. ' +
      (details.length ? details.join(' | ') : 'No workspace selected yet.');
    setDot(workspaceDot, workspace.syncError ? 'error' : index.running ? 'online' : 'waiting');
  }

  async function chooseWorkspace() {
    if (workspaceBusy) return;
    workspaceBusy = true;
    workspaceRow.disabled = true;
    workspaceLabel.textContent = 'Choose workspace folder…';
    try {
      const result = await window.windowsBridge.selectWorkspace();
      if (result && result.workspace) renderWorkspace(result.workspace);
      if (!result || result.canceled) return;
      await refreshState();
    } catch (error) {
      workspaceRow.title = 'Could not select workspace: ' + String(error && error.message || error);
    } finally {
      workspaceBusy = false;
      workspaceRow.disabled = false;
    }
  }

  function renderAutoAccept(enabled) {
    autoAcceptAll = enabled === true;
    autoAcceptLabel.textContent = autoAcceptAll ? 'Auto-accept everything: ON' : 'Auto-accept everything: OFF';
    autoAcceptRow.title = autoAcceptAll
      ? 'Enabled: local requests run without individual approval. Click to disable.'
      : 'Click to enable automatic approval for all local operations. Enabling requires confirmation.';
    autoAcceptRow.setAttribute('aria-pressed', String(autoAcceptAll));
    setDot(autoAcceptDot, autoAcceptAll ? 'error' : 'waiting');
  }

  async function toggleAutoAcceptAll() {
    autoAcceptRow.disabled = true;
    try {
      const result = await window.windowsBridge.setAutoAcceptAll(!autoAcceptAll);
      renderAutoAccept(result.autoAcceptAll);
    } catch (error) {
      autoAcceptRow.title = String(error && error.message || error);
    } finally {
      autoAcceptRow.disabled = false;
    }
  }

  async function refreshState() {
    try {
      const snapshot = await window.windowsBridge.getState();
      renderWorker(snapshot.bridge || {});
      renderWorkspace(snapshot.workspace || {});
    } catch (error) {
      workerLabel.textContent = 'Worker status unavailable';
      workerLabel.title = String(error && error.message || error);
      setDot(workerDot, 'error');
    }
    try {
      renderGitHub(await window.windowsBridge.getGitHubState());
    } catch (error) {
      renderGitHub({ authenticated: false, error: String(error && error.message || error) });
    }
  }

  function stopAuthPolling() {
    if (authTimer !== null) window.clearTimeout(authTimer);
    authTimer = null;
    authBusy = false;
    loginCode = '';
  }

  function scheduleAuthPoll(seconds = 3) {
    if (authTimer !== null) window.clearTimeout(authTimer);
    authTimer = window.setTimeout(async () => {
      try {
        const result = await window.windowsBridge.pollGitHubLogin();
        if (result.status === 'authenticated') {
          stopAuthPolling();
          await refreshState();
          return;
        }
        if (result.status === 'pending') {
          if (result.userCode) loginCode = result.userCode;
          renderGitHub({ authenticated: false });
          scheduleAuthPoll(Math.max(3, result.intervalSeconds || seconds));
          return;
        }
        stopAuthPolling();
        renderGitHub({ authenticated: false, error: result.message || '' });
        if (result.message) githubLabel.title = result.message;
      } catch (error) {
        stopAuthPolling();
        renderGitHub({ authenticated: false, error: String(error && error.message || error) });
      }
    }, Math.max(3, seconds) * 1000);
  }

  async function copyGitHubDeviceCode() {
    if (!loginCode) return;
    try {
      await window.windowsBridge.copyDeviceCode(loginCode);
      githubLabel.textContent = 'Code copied — paste into GitHub';
      githubLabel.title = 'The one-time device code was copied to the clipboard. Return to the GitHub device page and paste it.';
    } catch (error) {
      githubLabel.title = 'Could not copy device code: ' + String(error && error.message || error);
    }
  }

  async function connectGitHub() {
    if (authBusy) return;
    authBusy = true;
    renderGitHub(githubState || { authenticated: false });
    try {
      const existing = await window.windowsBridge.getGitHubState();
      const flow = existing.authenticated
        ? await window.windowsBridge.reconnectGitHub()
        : await window.windowsBridge.startGitHubLogin();
      if (flow && flow.cancelled) {
        stopAuthPolling();
        renderGitHub(existing);
        return;
      }
      if (flow && flow.status === 'authenticated') {
        stopAuthPolling();
        await refreshState();
        return;
      }
      loginCode = flow && flow.userCode || loginCode || '';
      renderGitHub({ authenticated: false });
      scheduleAuthPoll(flow && flow.intervalSeconds || 3);
    } catch (error) {
      stopAuthPolling();
      renderGitHub({ authenticated: false, error: String(error && error.message || error) });
      githubLabel.title = String(error && error.message || error);
    }
  }

  githubButton.addEventListener('click', () => {
    if (authBusy && loginCode) {
      void copyGitHubDeviceCode();
      return;
    }
    void connectGitHub();
  });
  window.windowsBridge.onGitHubDeviceCode(code => {
    const value = String(code || '').toUpperCase();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value) || !authBusy) return;
    loginCode = value;
    renderGitHub({ authenticated: false });
  });
  workspaceRow.addEventListener('click', chooseWorkspace);
  autoAcceptRow.addEventListener('click', toggleAutoAcceptAll);
  minimizeButton.addEventListener('click', () => window.windowsBridge.minimizeToTray().catch(() => {}));
  quitButton.addEventListener('click', () => window.windowsBridge.quit().catch(() => {}));
  window.windowsBridge.onBridgeState(renderWorker);
  window.addEventListener('online', () => {
    window.windowsBridge.retryConnection().catch(() => {});
    void refreshState();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.windowsBridge.retryConnection().catch(() => {});
  });
  window.addEventListener('beforeunload', stopAuthPolling);

  refreshState();
  window.setInterval(refreshState, 15000);
})();
