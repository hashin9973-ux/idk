(() => {
  const byId = id => document.getElementById(id);
  const clientId = byId('github-client-id');
  const status = byId('github-status');
  const login = byId('github-login');
  const logout = byId('github-logout');
  const device = byId('github-device');
  const userCode = byId('github-user-code');
  const bridgeRepository = byId('github-repository');
  const bridgeBranch = byId('github-branch');
  const allowPublic = byId('github-allow-public');
  const bridgeStatus = byId('github-bridge-status');
  let timer = null;
  let busy = false;
  function message(text, kind = '') {
    status.textContent = String(text || '');
    status.classList.remove('error', 'success');
    if (kind) status.classList.add(kind);
  }
  async function refresh() {
    try {
      const state = await window.assistantOverlay.getGitHubState();
      if (state.clientId && !clientId.value) clientId.value = state.clientId;
      if (bridgeRepository && !bridgeRepository.value && state.repository) bridgeRepository.value = state.repository;
      if (bridgeBranch && (!bridgeBranch.value || bridgeBranch.value === 'main') && state.branch) bridgeBranch.value = state.branch;
      if (allowPublic) allowPublic.checked = state.allowPublicRepository === true;
      if (state.authenticated) {
        message('Connected to GitHub as @' + (state.login || 'user') + '.', 'success');
        logout.hidden = false;
        login.textContent = 'Refresh GitHub connection';
      } else {
        message(state.error ? 'Not connected. ' + state.error :
          (state.configured ? 'Not connected to GitHub.' : 'Enter your OAuth App client ID to configure sign-in.'));
        logout.hidden = true;
        login.textContent = 'Sign in with GitHub';
      }
      return state;
    } catch (error) {
      message(error.message || error, 'error');
      return null;
    }
  }
  byId('github-save-client').addEventListener('click', async () => {
    const button = byId('github-save-client');
    button.disabled = true;
    try {
      const result = await window.assistantOverlay.setGitHubClientId(clientId.value);
      clientId.value = result.clientId;
      message('Client ID saved. You can now sign in with GitHub.');
    } catch (error) { message(error.message || error, 'error'); }
    finally { button.disabled = false; }
  });

  byId('github-save-bridge').addEventListener('click', async () => {
    const button = byId('github-save-bridge');
    button.disabled = true;
    bridgeStatus.classList.remove('error', 'success');
    bridgeStatus.textContent = 'Saving repository bridge configuration…';
    try {
      const config = await window.assistantOverlay.setGitHubBridgeConfig({
        repository: bridgeRepository.value,
        branch: bridgeBranch.value || 'main',
        allowPublicRepository: allowPublic.checked
      });
      bridgeRepository.value = config.repository;
      bridgeBranch.value = config.branch;
      allowPublic.checked = config.allowPublicRepository;
      bridgeStatus.textContent = config.repository
        ? 'Saved. The app will poll ' + config.repository + '@' + config.branch + ' for requests and commit results there.'
        : 'Repository bridge is not configured.';
      bridgeStatus.classList.add('success');
      refreshBridgeStatus();
    } catch (error) {
      bridgeStatus.textContent = error.message || String(error);
      bridgeStatus.classList.add('error');
    } finally { button.disabled = false; }
  });

  async function refreshBridgeStatus(statusValue) {
    if (!bridgeStatus) return;
    let current = statusValue;
    if (!current) {
      try { current = await window.assistantOverlay.getRepositoryBridgeStatus(); }
      catch (error) { current = { state: 'error', message: error.message || String(error) }; }
    }
    if (!current || !current.message) return;
    bridgeStatus.textContent = current.message + (current.repository ? ' (' + current.repository + '@' + (current.branch || 'main') + ')' : '');
    bridgeStatus.classList.remove('error', 'success');
    if (current.state === 'error' || current.state === 'not_authenticated' || current.state === 'not_configured') {
      bridgeStatus.classList.add('error');
    } else if (current.state === 'idle' || current.state === 'active') {
      bridgeStatus.classList.add('success');
    }
  }
  window.assistantOverlay.onRepositoryBridgeStatus(refreshBridgeStatus);
  function stopPolling() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    busy = false;
  }
  function schedulePoll(seconds) {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await window.assistantOverlay.pollGitHubLogin();
        if (result.status === 'authenticated') {
          stopPolling();
          device.hidden = true;
          message('Connected to GitHub as @' + result.login + '.', 'success');
          logout.hidden = false;
          login.textContent = 'Refresh GitHub connection';
          return;
        }
        if (result.status === 'pending') {
          message('Waiting for GitHub authorization…');
          busy = false;
          schedulePoll(Math.max(5, result.intervalSeconds || seconds));
          return;
        }
        stopPolling();
        device.hidden = true;
        message(result.message || 'GitHub authorization was not completed.', result.status === 'denied' ? 'error' : '');
      } catch (error) {
        stopPolling();
        message(error.message || error, 'error');
      } finally { busy = false; }
    }, Math.max(5, seconds) * 1000);
  }
  login.addEventListener('click', async () => {
    login.disabled = true;
    try {
      const state = await refresh();
      if (state && state.authenticated) return;
      const flow = await window.assistantOverlay.startGitHubLogin();
      device.hidden = false;
      userCode.textContent = flow.userCode;
      message('GitHub verification opened. Enter the displayed one-time code there.');
      schedulePoll(flow.intervalSeconds || 5);
    } catch (error) { message(error.message || error, 'error'); }
    finally { login.disabled = false; }
  });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      stopPolling();
      await window.assistantOverlay.logoutGitHub();
      device.hidden = true;
      message('Signed out of GitHub. The saved credential was removed.');
      logout.hidden = true;
      login.textContent = 'Sign in with GitHub';
    } catch (error) { message(error.message || error, 'error'); }
    finally { logout.disabled = false; }
  });
  byId('chatgpt-login').addEventListener('click', async () => {
    const area = byId('chatgpt-status');
    try {
      await window.assistantOverlay.openChatGPTLogin();
      area.textContent = 'ChatGPT sign-in opened in the embedded conversation window. Complete login there, then return here.';
      area.classList.remove('error');
      area.classList.add('success');
    } catch (error) {
      area.textContent = error.message || String(error);
      area.classList.add('error');
    }
  });
  window.addEventListener('beforeunload', stopPolling);
  refresh();
  refreshBridgeStatus();
})();
