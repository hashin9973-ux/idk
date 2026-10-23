(() => {
  const byId = id => document.getElementById(id);
  const clientId = byId('github-client-id');
  const status = byId('github-status');
  const login = byId('github-login');
  const logout = byId('github-logout');
  const device = byId('github-device');
  const userCode = byId('github-user-code');
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
})();
