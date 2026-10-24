(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const body = document.body;
  const form = byId('bridge-config-form');
  const ownerInput = byId('repo-owner');
  const repoInput = byId('repo-name');
  const branchInput = byId('repo-branch');
  const publicWarning = byId('public-warning');
  const statusPill = byId('status-pill');
  const statusDot = byId('status-dot');
  const statusLabel = byId('status-label');
  const workerBadge = byId('worker-badge');
  const requestCount = byId('request-count');
  const activeRequest = byId('active-request');
  const lastPoll = byId('last-poll');
  const lastErrorRow = byId('last-error-row');
  const lastError = byId('last-error');
  const workspaceName = byId('workspace-name');
  const workspacePath = byId('workspace-path');
  const configMessage = byId('config-message');
  const workerMessage = byId('worker-message');
  const saveButton = byId('save-config');
  const startButton = byId('start-worker');
  const stopButton = byId('stop-worker');
  const pollButton = byId('poll-now');
  const selectWorkspaceButton = byId('select-workspace');
  const accountsButton = byId('accounts');
  const collapseButton = byId('collapse');
  const quitButton = byId('quit');
  const ballButton = byId('assistant-ball');

  let busy = false;
  let currentState = null;
  let savedWorkspace = '';

  function setMessage(element, message, kind = '') {
    element.textContent = String(message || '');
    element.classList.remove('error', 'success');
    if (kind) element.classList.add(kind);
  }

  function formatTime(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function shorten(value, max = 36) {
    const text = String(value || '');
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function renderWorkspace(root) {
    savedWorkspace = String(root || '');
    const parts = savedWorkspace.replace(/[\\/]+$/, '').split(/[\\/]/);
    workspaceName.textContent = parts[parts.length - 1] || 'No workspace selected';
    workspacePath.textContent = savedWorkspace;
    workspacePath.title = savedWorkspace;
  }

  function renderState(state) {
    currentState = state || {};
    const running = Boolean(currentState.running);
    body.classList.toggle('worker-running', running);
    statusPill.classList.toggle('is-running', running);
    statusDot.classList.toggle('is-running', running);
    statusLabel.textContent = running ? 'Worker running' : 'Worker stopped';
    workerBadge.textContent = running ? (currentState.activeRequestId ? 'PROCESSING' : 'RUNNING') : 'STOPPED';
    workerBadge.classList.toggle('running', running);
    requestCount.textContent = String(Number(currentState.pendingCount) || 0);
    activeRequest.textContent = currentState.activeRequestId ? shorten(currentState.activeRequestId, 28) : 'None';
    activeRequest.title = currentState.activeRequestId || '';
    lastPoll.textContent = formatTime(currentState.lastPollAt);
    lastErrorRow.hidden = !currentState.lastError;
    lastError.textContent = String(currentState.lastError || '');
    startButton.disabled = running || busy;
    stopButton.disabled = !running || busy;
    pollButton.disabled = !running || busy;
  }

  async function loadState() {
    try {
      const snapshot = await window.windowsBridge.getState();
      renderWorkspace(snapshot.workspaceRoot);
      const config = snapshot.bridge || {};
      if (config.configured) {
        ownerInput.value = config.owner || '';
        repoInput.value = config.repo || '';
        branchInput.value = config.branch || 'bridge-mailbox';
      }
      publicWarning.checked = Boolean(config.allowPublicMailbox);
      renderState(config);
      if (!config.configured) {
        setMessage(configMessage, 'Choose the repository and mailbox branch, then save the connection.');
      } else {
        setMessage(configMessage, 'Connection settings loaded.', 'success');
      }
    } catch (error) {
      setMessage(workerMessage, error.message || error, 'error');
    }
  }

  async function runAction(button, action, successMessage) {
    if (busy) return;
    busy = true;
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    setMessage(workerMessage, '');
    try {
      const state = await action();
      if (state && typeof state === 'object' && ('running' in state || 'configured' in state)) renderState(state);
      if (successMessage) setMessage(workerMessage, successMessage, 'success');
      return state;
    } catch (error) {
      setMessage(workerMessage, error.message || error, 'error');
      return null;
    } finally {
      busy = false;
      button.textContent = previousText;
      if (currentState) renderState(currentState);
      else {
        startButton.disabled = false;
        stopButton.disabled = true;
        pollButton.disabled = true;
      }
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const config = {
      owner: ownerInput.value.trim(),
      repo: repoInput.value.trim(),
      branch: branchInput.value.trim(),
      allowPublicMailbox: publicWarning.checked
    };
    busy = true;
    saveButton.disabled = true;
    setMessage(configMessage, 'Saving connection settings…');
    try {
      const state = await window.windowsBridge.saveBridgeConfig(config);
      renderState(state);
      setMessage(configMessage, 'Connection settings saved. Sign in to GitHub, then start the worker.', 'success');
    } catch (error) {
      setMessage(configMessage, error.message || error, 'error');
    } finally {
      busy = false;
      saveButton.disabled = false;
      if (currentState) renderState(currentState);
    }
  });

  startButton.addEventListener('click', () => runAction(
    startButton,
    async () => {
      const current = currentState || {};
      const configMatches = current.owner === ownerInput.value.trim() &&
        current.repo === repoInput.value.trim() &&
        current.branch === branchInput.value.trim() &&
        Boolean(current.allowPublicMailbox) === publicWarning.checked;
      if (!configMatches) {
        const state = await window.windowsBridge.saveBridgeConfig({
          owner: ownerInput.value.trim(),
          repo: repoInput.value.trim(),
          branch: branchInput.value.trim(),
          allowPublicMailbox: publicWarning.checked
        });
        renderState(state);
      }
      return window.windowsBridge.startBridge();
    },
    'Worker started. It is polling the configured repository branch.'
  ));

  stopButton.addEventListener('click', () => runAction(
    stopButton,
    () => window.windowsBridge.stopBridge(),
    'Worker stopped. No new requests will be claimed.'
  ));

  pollButton.addEventListener('click', () => runAction(
    pollButton,
    () => window.windowsBridge.pollNow(),
    'One mailbox poll completed.'
  ));

  selectWorkspaceButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    selectWorkspaceButton.disabled = true;
    try {
      const result = await window.windowsBridge.selectWorkspace();
      if (!result.canceled) {
        renderWorkspace(result.workspaceRoot);
        setMessage(workerMessage, 'Local workspace selected.', 'success');
      }
    } catch (error) {
      setMessage(workerMessage, error.message || error, 'error');
    } finally {
      busy = false;
      selectWorkspaceButton.disabled = false;
    }
  });

  accountsButton.addEventListener('click', () => {
    window.windowsBridge.openAccounts().catch(error => setMessage(workerMessage, error.message || error, 'error'));
  });

  collapseButton.addEventListener('click', () => {
    window.windowsBridge.collapse().catch(error => setMessage(workerMessage, error.message || error, 'error'));
  });

  ballButton.addEventListener('click', () => {
    window.windowsBridge.expand().catch(error => setMessage(workerMessage, error.message || error, 'error'));
  });

  quitButton.addEventListener('click', () => {
    window.windowsBridge.quit().catch(error => setMessage(workerMessage, error.message || error, 'error'));
  });

  window.windowsBridge.onBridgeState(renderState);
  window.windowsBridge.onWorkspaceChanged(renderWorkspace);
  window.windowsBridge.onCollapsedChanged(value => {
    body.classList.toggle('is-collapsed', value);
    ballButton.setAttribute('aria-expanded', String(!value));
  });

  loadState();
})();
