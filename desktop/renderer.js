(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const body = document.body;
  const form = byId('bridge-config-form');
  const ownerInput = byId('repo-owner'), repoInput = byId('repo-name'), branchInput = byId('repo-branch');
  const clientIdInput = byId('github-client-id'), publicWarning = byId('public-warning');
  const settingsPanel = byId('settings-panel'), statusPill = byId('status-pill'), statusDot = byId('status-dot'), statusLabel = byId('status-label');
  const workerTitle = byId('worker-title'), requestCount = byId('request-count'), activeRequest = byId('active-request');
  const lastPoll = byId('last-poll'), lastErrorRow = byId('last-error-row'), lastError = byId('last-error');
  const workspaceName = byId('workspace-name'), workspacePath = byId('workspace-path'), appMessage = byId('app-message');
  const saveButton = byId('save-config'), workerToggle = byId('worker-toggle'), selectWorkspaceButton = byId('select-workspace');
  const githubStatus = byId('github-status'), githubLogin = byId('github-login'), githubLogout = byId('github-logout');
  const githubCodePanel = byId('github-code-panel'), githubUserCode = byId('github-user-code');
  const openGitHubOAuthSettingsButton = byId('open-github-oauth-settings');
  const collapseButton = byId('collapse'), quitButton = byId('quit'), ballButton = byId('assistant-ball'), openChatGPTButton = byId('open-chatgpt');
  let busy = false, authBusy = false, currentState = null, githubState = null, authTimer = null;

  function setMessage(message, kind = '') {
    appMessage.textContent = String(message || '');
    appMessage.classList.remove('error', 'success');
    if (kind) appMessage.classList.add(kind);
  }
  function formatTime(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  function shorten(value, max = 36) {
    const text = String(value || '');
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
  function renderWorkspace(root) {
    const value = String(root || ''), parts = value.replace(/[\\/]+$/, '').split(/[\\/]/);
    workspaceName.textContent = parts[parts.length - 1] || 'No workspace selected';
    workspacePath.textContent = value;
    workspacePath.title = value;
  }
  function renderState(state) {
    currentState = state || {};
    const running = Boolean(currentState.running);
    body.classList.toggle('worker-running', running);
    statusPill.classList.toggle('is-running', running);
    statusDot.classList.toggle('is-running', running);
    statusLabel.textContent = running ? 'Worker running' : 'Worker stopped';
    workerTitle.textContent = running ? (currentState.activeRequestId ? 'Worker is processing a request' : 'Worker is running') : 'Worker is stopped';
    workerToggle.textContent = running ? 'Stop worker' : 'Start worker';
    workerToggle.classList.toggle('danger-button', running);
    requestCount.textContent = String(Number(currentState.pendingCount) || 0);
    activeRequest.textContent = currentState.activeRequestId ? shorten(currentState.activeRequestId, 28) : 'None';
    activeRequest.title = currentState.activeRequestId || '';
    lastPoll.textContent = formatTime(currentState.lastPollAt);
    lastErrorRow.hidden = !currentState.lastError;
    lastError.textContent = String(currentState.lastError || '');
    workerToggle.disabled = busy;
    selectWorkspaceButton.disabled = busy;
  }
  function renderGitHub(state) {
    githubState = state || {};
    if (githubState.authenticated) {
      githubStatus.textContent = 'Connected as @' + (githubState.login || 'GitHub user');
      githubStatus.classList.add('success-text');
      githubLogin.textContent = 'Connected';
      githubLogin.disabled = true;
      githubLogout.hidden = false;
      githubLogout.disabled = busy || authBusy;
    } else {
      githubStatus.textContent = githubState.configured ? 'Not connected. Sign in to let the Windows worker access the mailbox.' : 'One-time setup: add your GitHub OAuth client ID in Connection settings.';
      githubStatus.classList.remove('success-text');
      githubLogin.textContent = authBusy ? 'Waiting for GitHub…' : (githubState.configured ? 'Sign in with GitHub' : 'Set up GitHub sign-in');
      // Keep this entry point clickable: without a client ID it guides the user
      // to the one-time setup field instead of looking broken/disabled.
      githubLogin.disabled = authBusy || busy;
      githubLogout.hidden = true;
    }
    if (githubState.clientId && !clientIdInput.value) clientIdInput.value = githubState.clientId;
  }
  async function refreshGitHubState() {
    const state = await window.windowsBridge.getGitHubState();
    renderGitHub(state);
    return state;
  }
  async function loadState() {
    try {
      const snapshot = await window.windowsBridge.getState();
      renderWorkspace(snapshot.workspaceRoot);
      const config = snapshot.bridge || {};
      ownerInput.value = config.owner || 'hashin9973-ux';
      repoInput.value = config.repo || 'qdqwg';
      branchInput.value = config.branch || 'bridge-mailbox';
      publicWarning.checked = Boolean(config.allowPublicMailbox);
      renderState(config);
      const github = await refreshGitHubState();
      settingsPanel.open = !config.configured || !github.configured;
    } catch (error) { setMessage(error.message || error, 'error'); }
  }
  function readBridgeConfig() {
    return { owner: ownerInput.value.trim(), repo: repoInput.value.trim(), branch: branchInput.value.trim(), allowPublicMailbox: publicWarning.checked };
  }
  async function saveSettings() {
    const state = await window.windowsBridge.saveBridgeConfig(readBridgeConfig());
    const clientId = clientIdInput.value.trim();
    if (clientId) await window.windowsBridge.setGitHubClientId(clientId);
    renderState(state);
    await refreshGitHubState();
    return state;
  }
  async function runWorkerAction() {
    if (busy) return;
    busy = true; workerToggle.disabled = true; setMessage('');
    try {
      if (currentState && currentState.running) {
        const state = await window.windowsBridge.stopBridge();
        renderState(state); setMessage('Worker stopped.', 'success');
      } else {
        await saveSettings();
        const auth = await refreshGitHubState();
        if (!auth.authenticated) { settingsPanel.open = true; throw new Error('Sign in with GitHub before starting the worker.'); }
        const state = await window.windowsBridge.startBridge();
        renderState(state); settingsPanel.open = false; setMessage('Worker started. It is checking the configured mailbox.', 'success');
      }
    } catch (error) { setMessage(error.message || error, 'error'); }
    finally { busy = false; if (currentState) renderState(currentState); renderGitHub(githubState); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; saveButton.disabled = true; setMessage('Saving connection settings…');
    try {
      await saveSettings(); setMessage('Settings saved.', 'success');
      if (githubState && githubState.configured) settingsPanel.open = false;
    } catch (error) { setMessage(error.message || error, 'error'); }
    finally { busy = false; saveButton.disabled = false; if (currentState) renderState(currentState); renderGitHub(githubState); }
  });
  function stopAuthPolling() {
    if (authTimer !== null) window.clearTimeout(authTimer);
    authTimer = null; authBusy = false;
  }
  function scheduleAuthPoll(seconds = 5) {
    if (authTimer !== null) window.clearTimeout(authTimer);
    authTimer = window.setTimeout(async () => {
      try {
        const result = await window.windowsBridge.pollGitHubLogin();
        if (result.status === 'authenticated') {
          stopAuthPolling(); githubCodePanel.hidden = true; await refreshGitHubState();
          setMessage('GitHub connected. Returning to the app.', 'success'); return;
        }
        if (result.status === 'pending') {
          githubStatus.textContent = 'Waiting for approval in your browser…';
          scheduleAuthPoll(Math.max(5, result.intervalSeconds || seconds)); return;
        }
        stopAuthPolling(); githubCodePanel.hidden = true; await refreshGitHubState();
        setMessage(result.message || 'GitHub authorization was not completed.', result.status === 'denied' ? 'error' : '');
      } catch (error) {
        stopAuthPolling(); setMessage(error.message || error, 'error'); await refreshGitHubState().catch(() => {});
      }
    }, Math.max(5, seconds) * 1000);
  }
  githubLogin.addEventListener('click', async () => {
    if (authBusy || busy) return;
    try {
      const existing = await refreshGitHubState();
      if (existing.authenticated) { setMessage('Already connected to GitHub.', 'success'); return; }
      if (!existing.configured) {
        settingsPanel.open = true;
        clientIdInput.focus();
        clientIdInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setMessage('GitHub sign-in needs a one-time OAuth App client ID. Use the link under Connection settings, enable Device Flow, paste the Client ID, and save settings.');
        return;
      }
      const flow = await window.windowsBridge.startGitHubLogin();
      authBusy = true; renderGitHub(githubState);
      githubUserCode.textContent = flow.userCode || '';
      githubCodePanel.hidden = !flow.userCode;
      setMessage('GitHub opened in your default browser. Approve access there; the app will return to the foreground automatically.');
      scheduleAuthPoll(flow.intervalSeconds || 5);
    } catch (error) {
      stopAuthPolling(); setMessage(error.message || error, 'error'); await refreshGitHubState().catch(() => {});
    }
  });
  githubLogout.addEventListener('click', async () => {
    if (busy || authBusy) return;
    busy = true; githubLogout.disabled = true;
    try {
      stopAuthPolling(); await window.windowsBridge.logoutGitHub(); await refreshGitHubState();
      const state = await window.windowsBridge.getState(); renderState(state.bridge || {});
      setMessage('GitHub disconnected.', 'success');
    } catch (error) { setMessage(error.message || error, 'error'); }
    finally { busy = false; if (currentState) renderState(currentState); renderGitHub(githubState); }
  });
  selectWorkspaceButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true; selectWorkspaceButton.disabled = true;
    try {
      const result = await window.windowsBridge.selectWorkspace();
      if (!result.canceled) { renderWorkspace(result.workspaceRoot); setMessage('Workspace selected.', 'success'); }
    } catch (error) { setMessage(error.message || error, 'error'); }
    finally { busy = false; if (currentState) renderState(currentState); }
  });
  openGitHubOAuthSettingsButton.addEventListener('click', async () => {
    try {
      await window.windowsBridge.openGitHubOAuthSettings();
      setMessage('GitHub Developer settings opened in your default browser. Create an OAuth App, enable Device Flow, then paste its Client ID here.', 'success');
    } catch (error) { setMessage(error.message || error, 'error'); }
  });
  openChatGPTButton.addEventListener('click', async () => {
    try {
      await window.windowsBridge.openChatGPT();
      setMessage('ChatGPT login page opened in your default browser. After signing in, use Alt+Tab to return to this app.', 'success');
    } catch (error) { setMessage(error.message || error, 'error'); }
  });
  workerToggle.addEventListener('click', runWorkerAction);
  collapseButton.addEventListener('click', () => window.windowsBridge.collapse().catch(error => setMessage(error.message || error, 'error')));
  ballButton.addEventListener('click', () => window.windowsBridge.expand().catch(error => setMessage(error.message || error, 'error')));
  quitButton.addEventListener('click', () => window.windowsBridge.quit().catch(error => setMessage(error.message || error, 'error')));
  window.windowsBridge.onBridgeState(renderState);
  window.windowsBridge.onWorkspaceChanged(renderWorkspace);
  window.windowsBridge.onCollapsedChanged(value => { body.classList.toggle('is-collapsed', value); ballButton.setAttribute('aria-expanded', String(!value)); });
  window.addEventListener('beforeunload', stopAuthPolling);
  loadState();
})();
