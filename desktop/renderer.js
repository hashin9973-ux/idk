(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const githubRow = byId('github-row');
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
      githubLabel.textContent = 'GitHub connected';
      githubLabel.title = githubState.login ? 'Connected as @' + githubState.login : 'Connected to GitHub';
      setDot(githubDot, 'online');
      githubRow.disabled = false;
      return;
    }

    if (authBusy) {
      githubLabel.textContent = 'GitHub waiting for approval';
      githubLabel.title = loginCode ? 'Enter the device code ' + loginCode + ' in the browser' : 'Approve the GitHub request in your browser';
      setDot(githubDot, 'waiting');
      githubRow.disabled = true;
      return;
    }

    const networkUnavailable = /network|offline|fetch failed|enotfound|econn|timed out|unable to connect/i.test(String(githubState.error || ''));
    githubLabel.textContent = networkUnavailable ? 'GitHub unavailable' : 'GitHub not connected';
    githubLabel.title = githubState.error || 'Click to connect this app to GitHub';
    setDot(githubDot, networkUnavailable ? 'error' : 'waiting');
    githubRow.disabled = false;
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

  async function connectGitHub() {
    if (authBusy) return;
    try {
      const existing = await window.windowsBridge.getGitHubState();
      if (existing.authenticated) {
        renderGitHub(existing);
        return;
      }
      const flow = await window.windowsBridge.startGitHubLogin();
      if (flow.status === 'authenticated') {
        await refreshState();
        return;
      }
      authBusy = true;
      loginCode = flow.userCode || '';
      renderGitHub({ authenticated: false });
      scheduleAuthPoll(flow.intervalSeconds || 3);
    } catch (error) {
      stopAuthPolling();
      renderGitHub({ authenticated: false, error: String(error && error.message || error) });
    }
  }

  githubRow.addEventListener('click', connectGitHub);
  workspaceRow.addEventListener('click', chooseWorkspace);
  autoAcceptRow.addEventListener('click', toggleAutoAcceptAll);
  minimizeButton.addEventListener('click', () => window.windowsBridge.minimizeToTray().catch(() => {}));
  quitButton.addEventListener('click', () => window.windowsBridge.quit().catch(() => {}));
  window.windowsBridge.onBridgeState(renderWorker);
  window.addEventListener('beforeunload', stopAuthPolling);

  refreshState();
  window.setInterval(refreshState, 15000);
})();
