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
  const visionDot = byId('vision-dot');
  const visionLabel = byId('vision-status');
  const visionSignInButton = byId('vision-signin');
  const visionSetupButton = byId('vision-setup-check');
  const visionSetupDetail = byId('vision-setup-detail');
  const visionMailboxDetail = byId('vision-mailbox-detail');
  const visionColabDetail = byId('vision-colab-detail');
  const visionModelDetail = byId('vision-model-detail');
  const visionMessage = byId('vision-message');
  const minimizeButton = byId('minimize');
  const quitButton = byId('quit');

  let githubState = null;
  let currentBridgeState = null;
  let authBusy = false;
  let authTimer = null;
  let loginCode = '';
  let autoAcceptAll = false;
  let workspaceBusy = false;
  let visionBusy = false;
  let visionSetupSnapshot = null;
  let visionConnectWatchTimer = null;
  let visionConnectWatchDeadline = 0;

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
    const driveRoot = /^[a-z]:[\\/]?$/i.test(root);
    workspaceLabel.textContent = root ? (driveRoot ? 'Workspace: entire drive ' + root : 'Workspace: ' + leaf) : 'Choose workspace folder';
    const details = [];
    if (root) details.push('Current folder: ' + root);
    if (Number.isInteger(index.entryCount)) details.push('Indexed entries: ' + index.entryCount);
    if (index.updatedAt) details.push('Last local index update: ' + index.updatedAt);
    if (index.truncated) details.push('Warning: index is incomplete due to size or entry limits.');
    if (workspace.syncError) details.push('Index sync error: ' + workspace.syncError);
    workspaceRow.title = (driveRoot
      ? 'Entire drive selected. File tools may access every file on this drive. The index lists top-level names only; explore subfolders on demand. '
      : 'Click to choose a different workspace folder or drive. ') +
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

  function setCheckDetail(element, check) {
    const value = check || {};
    const status = String(value.status || 'not_verified');
    const labels = {
      passed: 'OK',
      failed: 'Failed',
      action_required: 'Action needed',
      not_verified: 'Not verified',
      in_progress: 'In progress',
      enabled: 'Enabled',
      disabled: 'Disabled'
    };
    element.textContent = labels[status] || status.replace(/_/g, ' ');
    element.title = String(value.message || '');
    element.dataset.state = status;
  }

  function summarizeVisionFailure(value) {
    const error = String(value || '');
    const http = error.match(/HTTP\s+(\d{3})/i);
    if (http && http[1] === '530') {
      return 'HTTP 530 from Cloudflare. This tunnel is offline; rerun the Colab server cell to get a fresh URL.';
    }
    if (http) return 'Colab returned HTTP ' + http[1] + '. The direct connection failed; see the status tooltip for details.';
    if (/malformed JSON|non-JSON response/i.test(error)) {
      return 'The tunnel returned an error page instead of the health response. Rerun the Colab server cell.';
    }
    if (/timeout|timed out|aborted/i.test(error)) return 'The Colab endpoint timed out. The app will retry while it watches for a fresh URL.';
    if (/fetch failed|network|ENOTFOUND|ECONN|socket/i.test(error)) return 'Could not reach the Colab tunnel. Check that the notebook cell is still running, then rerun it.';
    return error.length > 170 ? error.slice(0, 167) + '…' : error;
  }

  function renderVisionMessage(vision) {
    if (!visionMessage) return;
    const status = String(vision.status || 'unavailable');
    const sourceMessage = String(vision.message || vision.error || '');
    const watchError = String(vision.endpoint_watch_error || '');
    let message = '';
    let state = 'not_verified';

    if (vision.endpoint_test_in_progress === true || status === 'checking_endpoint') {
      message = 'Endpoint copied. Testing the direct HTTPS health response and registration acknowledgement…';
      state = 'in_progress';
    } else if (vision.runtime_fresh === true && ['needs_authentication', 'gpu_unavailable', 'error'].includes(status)) {
      message = 'Colab is connected, but needs attention: ' + summarizeVisionFailure(sourceMessage);
      state = 'failed';
    } else if (vision.runtime_fresh === true && vision.model_loaded === true && vision.enabled === true && status === 'ready') {
      message = 'Connected and ready. Vision is ON; screenshot analysis can run.';
      state = 'passed';
    } else if (vision.runtime_fresh === true && vision.enabled === true) {
      message = 'Connected to Colab. Vision is ON; model setup/loading is still in progress.';
      state = 'in_progress';
    } else if (vision.runtime_fresh === true) {
      message = 'Connected to Colab. Vision is OFF; the model has not been activated or downloaded.';
      state = 'passed';
    } else {
      const lastAttempt = sourceMessage.match(/Last detection attempt:\s*([\s\S]*)$/i);
      const failure = lastAttempt ? lastAttempt[1] : watchError || (/failed|HTTP \d{3}|malformed JSON|timed out|fetch failed/i.test(sourceMessage) ? sourceMessage : '');
      if (failure && (status === 'waiting_for_endpoint' || vision.endpoint_watch_active === true)) {
        message = 'Connection attempt failed; still watching. ' + summarizeVisionFailure(failure);
        state = 'failed';
      } else if (status === 'waiting_for_endpoint' || vision.endpoint_watch_active === true) {
        message = 'Waiting for the notebook URL. Run “Start the direct Colab vision server”; this line will change when the app tests it.';
        state = 'in_progress';
      } else if (vision.connection_registered === true) {
        message = 'The endpoint was detected, but Colab is not responding: ' + summarizeVisionFailure(sourceMessage || 'No live HTTPS response.');
        state = 'failed';
      } else if (watchError || status === 'error' || status === 'disconnected') {
        message = watchError
          ? 'Connection failed. ' + summarizeVisionFailure(watchError)
          : status === 'error'
            ? 'Connection failed. ' + summarizeVisionFailure(sourceMessage || 'The app returned an error.')
            : 'Not connected. Click Connect Colab, then run the notebook server cell.';
        state = watchError || status === 'error' ? 'failed' : 'not_verified';
      } else {
        message = 'Not connected. Click Connect Colab, then run the notebook server cell.';
        state = 'not_verified';
      }
    }
    visionMessage.textContent = message;
    visionMessage.title = [sourceMessage, watchError].filter(Boolean).join('\n') || message;
    visionMessage.dataset.state = state;
  }

  function renderVisionStatus(state) {
    const vision = state || {};
    const status = String(vision.status || 'unavailable');
    renderVisionMessage(vision);
    const labels = {
      ready: 'Vision: ready',
      inactive: vision.runtime_fresh === true ? 'Colab connected · vision off' : 'Vision: inactive',
      starting: 'Vision: starting',
      waiting_for_runtime: 'Colab: waiting for connection',
      waiting_for_endpoint: 'Colab: waiting for URL',
      checking_endpoint: 'Colab: testing HTTPS…',
      inference_in_progress: 'Vision: analyzing',
      report_available: 'Vision: report available',
      disconnected: 'Vision: disconnected',
      needs_authentication: 'Vision: Colab sign-in needed',
      gpu_unavailable: 'Vision: GPU unavailable',
      error: 'Vision: error',
      unavailable: 'Vision: unavailable'
    };
    visionLabel.textContent = labels[status] || 'Vision: ' + status.replace(/_/g, ' ');
    visionLabel.title = String(vision.message || vision.error || 'Live vision status');
    const danger = ['disconnected', 'needs_authentication', 'gpu_unavailable', 'error', 'unavailable'].includes(status);
    setDot(visionDot,
      (status === 'ready' && vision.model_loaded === true) ||
      (status === 'inactive' && vision.runtime_fresh === true)
        ? 'online'
        : danger ? 'error' : 'waiting');

    if (vision.runtime_fresh === true) {
      const stageName = String(vision.stage || '').replace(/_/g, ' ');
      const elapsedSeconds = Number.isFinite(vision.stage_elapsed_seconds)
        ? Math.max(0, Math.floor(vision.stage_elapsed_seconds)) : null;
      const elapsedLabel = elapsedSeconds === null ? ''
        : elapsedSeconds >= 60
          ? Math.floor(elapsedSeconds / 60) + 'm ' + (elapsedSeconds % 60) + 's'
          : elapsedSeconds + 's';
      const runtimeLabel = status === 'inactive'
        ? 'Direct tunnel live; vision disabled'
        : status === 'starting' && stageName
          ? 'Vision setup: ' + stageName + (elapsedLabel ? ' · ' + elapsedLabel : '')
          : status === 'needs_authentication' ? 'Google/Drive authentication required'
            : status === 'gpu_unavailable' ? 'GPU unavailable'
              : 'Direct tunnel live (' + String(vision.runtime_status || status).replace(/_/g, ' ') + ')';
      visionColabDetail.textContent = runtimeLabel;
      visionColabDetail.title = String(vision.message || '');
      visionColabDetail.dataset.state = ['needs_authentication', 'gpu_unavailable', 'error'].includes(status) ? 'action_required' : 'passed';
    } else {
      const endpointFailure = /Last detection attempt:|HTTP \d{3}|malformed JSON|fetch failed|timed out|failed/i.test(String(vision.message || '')) ||
        Boolean(vision.endpoint_watch_error);
      if (status === 'checking_endpoint' || vision.endpoint_test_in_progress === true) {
        visionColabDetail.textContent = 'Testing HTTPS + registration…';
        visionColabDetail.title = String(vision.message || 'The app is testing the copied endpoint now.');
        visionColabDetail.dataset.state = 'in_progress';
      } else if (status === 'waiting_for_endpoint' || vision.endpoint_watch_active === true) {
        visionColabDetail.textContent = endpointFailure ? 'Endpoint failed; retrying' : 'Waiting for notebook URL';
        visionColabDetail.title = String(vision.message || vision.endpoint_watch_error || 'Run the server cell to create a fresh endpoint.');
        visionColabDetail.dataset.state = endpointFailure ? 'failed' : 'in_progress';
      } else if (vision.connection_registered === true) {
        visionColabDetail.textContent = 'Tunnel not responding';
        visionColabDetail.title = String(vision.message || 'The endpoint was detected earlier but does not answer now.');
        visionColabDetail.dataset.state = 'failed';
      } else if (vision.endpoint_watch_error || status === 'error') {
        visionColabDetail.textContent = 'Connection failed';
        visionColabDetail.title = String(vision.endpoint_watch_error || vision.message || vision.error || 'The app could not connect to Colab.');
        visionColabDetail.dataset.state = 'failed';
      } else {
        visionColabDetail.textContent = 'Not connected';
        visionColabDetail.title = String(vision.message || 'Click Connect Colab, then run the notebook server cell.');
        visionColabDetail.dataset.state = 'not_verified';
      }
    }

    if (vision.model_loaded === true && vision.runtime_fresh === true) {
      visionModelDetail.textContent = 'Loaded';
      visionModelDetail.title = String(vision.model || '') + (vision.gpu ? ' on ' + vision.gpu : '');
      visionModelDetail.dataset.state = 'passed';
    } else {
      visionModelDetail.textContent = 'Not verified / not loaded';
      visionModelDetail.title = String(vision.model || 'Vision model') + ' is not confirmed loaded in a live Colab runtime.';
      visionModelDetail.dataset.state = 'not_verified';
    }

    if (!visionSetupSnapshot && visionSetupDetail.textContent === 'Not checked') {
      visionSetupDetail.title = 'Click Setup check to test GitHub sign-in, mailbox reads, the direct Colab tunnel, and model readiness.';
      visionSetupDetail.dataset.state = 'not_verified';
      visionMailboxDetail.title = 'Mailbox read access is checked by Setup check.';
      visionMailboxDetail.dataset.state = 'not_verified';
    }
  }

  function renderVisionSetup(snapshot) {
    visionSetupSnapshot = snapshot || {};
    const value = visionSetupSnapshot;
    const summaryStatus = value.status === 'ready' ? 'passed' : value.status === 'failed' ? 'failed' : 'action_required';
    setCheckDetail(visionSetupDetail, {
      status: summaryStatus,
      message: (value.status || 'unknown') + (value.next_steps && value.next_steps.length ? '\n' + value.next_steps.join('\n') : '')
    });
    const checks = value.checks || {};
    setCheckDetail(visionMailboxDetail, checks.mailbox);
    if (checks.colab) setCheckDetail(visionColabDetail, checks.colab);
    if (checks.model) setCheckDetail(visionModelDetail, checks.model);
    visionSetupButton.title = value.note || 'Setup check checks readiness without enabling vision.';
  }

  async function refreshVisionStatus() {
    try {
      renderVisionStatus(await window.windowsBridge.getVisionStatus());
    } catch (error) {
      renderVisionStatus({ status: 'error', message: String(error && error.message || error) });
    }
  }

  function stopVisionConnectionWatch() {
    if (visionConnectWatchTimer !== null) window.clearTimeout(visionConnectWatchTimer);
    visionConnectWatchTimer = null;
    visionConnectWatchDeadline = 0;
  }

  function scheduleVisionConnectionCheck() {
    if (!visionConnectWatchDeadline) return;
    if (Date.now() >= visionConnectWatchDeadline) {
      stopVisionConnectionWatch();
      void runVisionSetupCheck();
      return;
    }
    if (visionConnectWatchTimer !== null) window.clearTimeout(visionConnectWatchTimer);
    visionConnectWatchTimer = window.setTimeout(async () => {
      visionConnectWatchTimer = null;
      try {
        const snapshot = await window.windowsBridge.getVisionStatus();
        renderVisionStatus(snapshot);
        if (snapshot && snapshot.runtime_fresh === true) {
          stopVisionConnectionWatch();
          visionSetupDetail.textContent = 'Colab connected';
          visionSetupDetail.title = 'The app received a response from Colab over the authenticated direct HTTPS tunnel. Vision activation and model loading are controlled separately.';
          visionSetupDetail.dataset.state = 'passed';
          void runVisionSetupCheck();
          return;
        }
        if (snapshot && snapshot.endpoint_watch_active !== true && snapshot.status !== 'checking_endpoint') {
          stopVisionConnectionWatch();
          return;
        }
      } catch (error) {
        const message = String(error && error.message || error);
        visionColabDetail.textContent = 'Status check failed';
        visionColabDetail.title = message;
        visionColabDetail.dataset.state = 'failed';
        if (visionMessage) {
          visionMessage.textContent = 'Could not refresh the Colab status: ' + summarizeVisionFailure(message);
          visionMessage.title = message;
          visionMessage.dataset.state = 'failed';
        }
      }
      scheduleVisionConnectionCheck();
    }, 5000);
  }

  function startVisionConnectionWatch() {
    stopVisionConnectionWatch();
    visionConnectWatchDeadline = Date.now() + 120000;
    scheduleVisionConnectionCheck();
  }

  async function connectColab() {
    if (visionBusy) return;
    visionBusy = true;
    visionSignInButton.disabled = true;
    visionSignInButton.textContent = 'Connecting…';
    try {
      const result = await window.windowsBridge.connectColab();
      if (result && result.connected === true) {
        renderVisionStatus(result);
        visionSetupDetail.textContent = 'Colab connected';
        visionSetupDetail.title = result.message || 'Colab responded through the direct HTTPS tunnel.';
        visionSetupDetail.dataset.state = 'passed';
        visionColabDetail.textContent = 'Direct tunnel live';
        visionColabDetail.title = result.message || 'The app is connected to Colab through the authenticated HTTPS tunnel.';
        visionColabDetail.dataset.state = 'passed';
        void window.windowsBridge.checkVisionSetup().then(renderVisionSetup).catch(() => {});
      } else if (result && result.status === 'waiting_for_runtime') {
        visionLabel.textContent = 'Colab: waiting for connection';
        visionLabel.title = result.message || 'Waiting for a direct Colab connection.';
        setDot(visionDot, 'waiting');
        visionSetupDetail.textContent = 'Waiting for Colab';
        visionSetupDetail.title = result.message || 'Open the notebook, connect a runtime if needed, and run the server cell. Then click Connect Windows Bridge and approve opening the Windows app.';
        visionSetupDetail.dataset.state = 'in_progress';
        renderVisionStatus(result);
        visionColabDetail.textContent = 'Waiting for notebook URL';
        visionColabDetail.title = result.message || 'The app is watching for the public endpoint copied by the notebook.';
        visionColabDetail.dataset.state = 'action_required';
        visionModelDetail.textContent = 'Not started';
        visionModelDetail.title = 'Connecting to Colab does not activate vision or download the model.';
        visionModelDetail.dataset.state = 'not_verified';
        startVisionConnectionWatch();
      } else {
        const message = result && (result.message || result.error) || 'Colab connection could not be started.';
        visionSetupDetail.textContent = result && result.status === 'action_required' ? 'GitHub sign-in needed' : 'Connection failed';
        visionSetupDetail.title = message;
        visionSetupDetail.dataset.state = result && result.status === 'action_required' ? 'action_required' : 'failed';
        visionColabDetail.textContent = result && result.status === 'action_required' ? 'Sign in to GitHub first' : 'Not connected';
        visionColabDetail.title = message;
        visionColabDetail.dataset.state = result && result.status === 'action_required' ? 'action_required' : 'failed';
      }
    } catch (error) {
      const message = String(error && error.message || error);
      visionSetupDetail.textContent = 'Connection failed';
      visionSetupDetail.title = message;
      visionSetupDetail.dataset.state = 'failed';
      visionColabDetail.textContent = 'Not connected';
      visionColabDetail.title = message;
      visionColabDetail.dataset.state = 'failed';
    } finally {
      visionBusy = false;
      visionSignInButton.disabled = false;
      visionSignInButton.textContent = 'Connect Colab';
    }
  }


  async function runVisionSetupCheck() {
    if (visionBusy) return;
    visionBusy = true;
    visionSetupButton.disabled = true;
    visionSetupButton.textContent = 'Checking…';
    try {
      const result = await window.windowsBridge.checkVisionSetup();
      renderVisionSetup(result);
      await refreshVisionStatus();
    } catch (error) {
      renderVisionSetup({
        status: 'failed',
        checks: {
          mailbox: { status: 'failed', message: String(error && error.message || error) },
          colab: { status: 'not_verified', message: 'Setup check failed before Colab could be verified.' },
          model: { status: 'not_verified', message: 'Setup check failed before model readiness could be verified.' }
        },
        next_steps: ['Check that the app is connected to GitHub, then run Setup check again.']
      });
    } finally {
      visionBusy = false;
      visionSetupButton.disabled = false;
      visionSetupButton.textContent = 'Setup check';
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
    await refreshVisionStatus();
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
  visionSignInButton.addEventListener('click', () => { void connectColab(); });
  visionSetupButton.addEventListener('click', () => { void runVisionSetupCheck(); });
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
  window.addEventListener('beforeunload', () => {
    stopAuthPolling();
    stopVisionConnectionWatch();
  });

  refreshState();
  window.setInterval(refreshState, 15000);
})();
