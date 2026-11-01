(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const oneDriveRow = byId('onedrive-row');
  const oneDriveButton = byId('onedrive-choose');
  const oneDriveDot = byId('onedrive-dot');
  const oneDriveLabel = byId('onedrive-status');
  const workerDot = byId('worker-dot');
  const workerLabel = byId('worker-status');
  const workspaceRow = byId('workspace-row');
  const workspaceDot = byId('workspace-dot');
  const workspaceLabel = byId('workspace-status');
  const autoAcceptRow = byId('auto-accept-row');
  const observeRow = byId('observe-row');
  const observeDot = byId('observe-dot');
  const observeLabel = byId('observe-status');
  const observeFpsSelect = byId('observe-fps');
  const autoAcceptDot = byId('auto-accept-dot');
  const autoAcceptLabel = byId('auto-accept-status');
  const visionDot = byId('vision-dot');
  const visionLabel = byId('vision-status');
  const visionSignInButton = byId('vision-signin');
  const visionSetupButton = byId('vision-setup-check');
  const visionPasteButton = byId('vision-paste-url');
  const visionManualPanel = byId('vision-manual-panel');
  const visionEndpointInput = byId('vision-endpoint-url');
  const visionEndpointConnectButton = byId('vision-endpoint-connect');
  const visionEndpointCancelButton = byId('vision-endpoint-cancel');
  const visionSetupDetail = byId('vision-setup-detail');
  const visionMailboxDetail = byId('vision-mailbox-detail');
  const visionColabDetail = byId('vision-colab-detail');
  const visionModelDetail = byId('vision-model-detail');
  const visionMessage = byId('vision-message');
  const minimizeButton = byId('minimize');
  const quitButton = byId('quit');
  const openDashboardButton = byId('open-dashboard');

  let currentBridgeState = null;
  let autoAcceptAll = false;
  let observeBusy = false;
  let observeEnabled = false;
  let workspaceBusy = false;
  let visionBusy = false;
  let visionSetupSnapshot = null;
  let visionConnectWatchTimer = null;
  let visionConnectWatchDeadline = 0;

  function setDot(dot, status) {
    dot.className = 'status-dot ' + status;
  }

  function renderWorker(state) {
    currentBridgeState = state || {};
    const status = String(currentBridgeState.workerStatus || (currentBridgeState.running ? 'online' : 'connecting'));
    const active = Number.isFinite(currentBridgeState.activeCount) ? Math.max(0, currentBridgeState.activeCount) : 0;
    const pending = Number.isFinite(currentBridgeState.pendingCount) ? Math.max(0, currentBridgeState.pendingCount) : 0;
    const labels = {
      online: active > 0 ? 'Worker online · ' + active + ' active'
        : pending > 0 ? 'Worker online · ' + pending + ' queued'
          : 'Worker online · idle',
      connecting: 'Worker connecting…',
      reconnecting: 'Worker reconnecting · waiting for OneDrive sync',
      offline: 'Worker cannot reach the OneDrive mailbox',
      github: 'Worker waiting for OneDrive configuration',
      setup: 'Worker needs configuration',
      attention: 'Worker needs attention'
    };
    workerLabel.textContent = labels[status] || 'Worker ' + status;
    const polling = currentBridgeState.requestPolling || {};
    const details = [
      currentBridgeState.connectionError || '',
      'Worker process: ' + (currentBridgeState.running ? 'running' : 'stopped'),
      'Mailbox work: ' + active + ' active, ' + pending + ' queued',
      currentBridgeState.lastPollAt ? 'Last successful request scan: ' + currentBridgeState.lastPollAt : 'No successful request scan recorded yet',
      Number.isFinite(polling.lastRequestTreeScanDurationMs)
        ? 'Last request scan took ' + polling.lastRequestTreeScanDurationMs + ' ms across ' + Number(polling.lastRequestTreeEntryCount || 0) + ' entries'
        : '',
      Number.isFinite(polling.requestCommitProbeIntervalMs)
        ? 'Fast request-commit probe interval: ' + polling.requestCommitProbeIntervalMs + ' ms'
        : '',
      polling.lastRequestCommitProbeAt ? 'Last fast request probe: ' + polling.lastRequestCommitProbeAt : '',
      Number.isFinite(polling.lastRequestCommitProbeDurationMs)
        ? 'Last fast request probe took ' + polling.lastRequestCommitProbeDurationMs + ' ms'
        : '',
      polling.lastRequestCommitProbeError ? 'Fast request probe error (tree reconciliation remains active): ' + polling.lastRequestCommitProbeError : '',
      Number.isFinite(polling.lastPollDurationMs) ? 'Last poll duration: ' + polling.lastPollDurationMs + ' ms' : '',
      currentBridgeState.lastPollError ? 'Mailbox transport error: ' + currentBridgeState.lastPollError : '',
      currentBridgeState.lastError && status === 'online' ? 'Recent tool/result issue (worker still reachable): ' + currentBridgeState.lastError : ''
    ].filter(Boolean);
    workerLabel.title = details.join('\n') || workerLabel.textContent;
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

  function renderObserveStatus(state) {
    const value = state || {};
    observeEnabled = value.enabled === true;
    if (observeFpsSelect) observeFpsSelect.value = String(value.fps || 2);
    observeRow.setAttribute('aria-pressed', String(observeEnabled));
    const retainedFrames = Number(value.frame_count || 0);
    observeLabel.textContent = observeEnabled
      ? 'Observe: ON · ' + retainedFrames + ' recent frame' + (retainedFrames === 1 ? '' : 's')
      : 'Observe: OFF';
    const details = [
      'Target sampling rate: ' + Number(value.fps || 2) + ' fps (' + Number(value.sample_interval_ms || 500) + ' ms per tick).',
      'Retained changed frames: ' + retainedFrames + '/10 maximum; this is buffer size, not FPS. Unchanged fingerprints are omitted.',
      'Successful captures this session: ' + Number(value.capture_count || 0) + '; timer ticks skipped while a capture was busy: ' + Number(value.skipped_samples || 0) + '.',
      'Live context is published to the OneDrive mailbox at most once per second.',
      observeEnabled ? 'Status: ' + String(value.status || 'watching') : 'Live context is cleared when Observe is turned off.',
      value.last_capture_at ? 'Last capture: ' + value.last_capture_at : '',
      value.last_publish_at ? 'Last publish: ' + value.last_publish_at : '',
      value.error ? 'Error: ' + value.error : ''
    ].filter(Boolean);
    observeRow.title = details.join('\n');
    setDot(observeDot, observeEnabled ? (value.error ? 'error' : 'online') : 'waiting');
  }

  async function refreshObserveStatus() {
    try {
      renderObserveStatus(await window.windowsBridge.getObserveStatus());
    } catch (error) {
      observeRow.title = 'Observe status unavailable: ' + String(error && error.message || error);
      setDot(observeDot, 'error');
    }
  }

  async function toggleObserve() {
    if (observeBusy) return;
    observeBusy = true;
    observeRow.disabled = true;
    observeLabel.textContent = observeEnabled ? 'Observe: turning off…' : 'Observe: starting…';
    try {
      const state = await window.windowsBridge.setObserveEnabled(!observeEnabled);
      renderObserveStatus(state);
    } catch (error) {
      observeRow.title = 'Could not change Observe mode: ' + String(error && error.message || error);
      await refreshObserveStatus();
    } finally {
      observeBusy = false;
      observeRow.disabled = false;
    }
  }

  async function changeObserveFps() {
    if (!observeFpsSelect || observeFpsSelect.disabled) return;
    const requestedFps = Number(observeFpsSelect.value);
    observeFpsSelect.disabled = true;
    try {
      renderObserveStatus(await window.windowsBridge.setObserveFps(requestedFps));
    } catch (error) {
      observeFpsSelect.title = 'Could not change Observe FPS: ' + String(error && error.message || error);
      await refreshObserveStatus();
    } finally {
      observeFpsSelect.disabled = false;
    }
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
      message = 'Colab endpoint received. Testing the direct HTTPS health response and registration acknowledgement…';
      state = 'in_progress';
    } else if (vision.runtime_fresh === true && status === 'incompatible_runtime') {
      message = 'Colab is reachable, but its running notebook is out of date: ' +
        (sourceMessage || 'interrupt the old server cell and run the latest notebook cell.');
      state = 'failed';
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
      message = vision.model_loaded === true
        ? 'Connected to Colab. Vision is OFF; screenshot analysis is disabled, but the model remains loaded.'
        : 'Connected to Colab. Vision is OFF; the model has not been activated or downloaded.';
      state = 'passed';
    } else {
      const lastAttempt = sourceMessage.match(/Last detection attempt:\s*([\s\S]*)$/i);
      const failure = lastAttempt ? lastAttempt[1] : watchError || (/failed|HTTP \d{3}|malformed JSON|timed out|fetch failed/i.test(sourceMessage) ? sourceMessage : '');
      if (failure && (status === 'waiting_for_endpoint' || vision.endpoint_watch_active === true)) {
        message = 'Connection attempt failed; still watching. ' + summarizeVisionFailure(failure);
        state = 'failed';
      } else if (status === 'waiting_for_endpoint' || vision.endpoint_watch_active === true) {
        message = vision.automatic_handoff_ready === true && vision.automatic_handoff_armed === true
          ? 'Connect Colab is armed. Run the notebook server cell and allow loopback access once; its endpoint will be sent automatically.'
          : vision.automatic_handoff_ready === true
            ? 'Receiver ready but not armed. Click Connect Colab in this app first, then run the notebook server cell; no copying or pasting is needed.'
            : 'The local handoff receiver is unavailable. Click Connect Colab to retry; the notebook also has a one-click app fallback.';
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
      incompatible_runtime: 'Colab: update notebook',
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
    const danger = ['disconnected', 'needs_authentication', 'gpu_unavailable', 'error', 'unavailable', 'incompatible_runtime'].includes(status);
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
        : status === 'incompatible_runtime'
          ? 'Notebook update required'
          : status === 'starting' && stageName
            ? 'Vision setup: ' + stageName + (elapsedLabel ? ' · ' + elapsedLabel : '')
            : status === 'needs_authentication' ? 'Google/Drive authentication required'
              : status === 'gpu_unavailable' ? 'GPU unavailable'
                : 'Direct tunnel live (' + String(vision.runtime_status || status).replace(/_/g, ' ') + ')';
      visionColabDetail.textContent = runtimeLabel;
      visionColabDetail.title = String(vision.message || '');
      visionColabDetail.dataset.state = ['needs_authentication', 'gpu_unavailable', 'error', 'incompatible_runtime'].includes(status) ? 'action_required' : 'passed';
    } else {
      const endpointFailure = /Last detection attempt:|HTTP \d{3}|malformed JSON|fetch failed|timed out|failed/i.test(String(vision.message || '')) ||
        Boolean(vision.endpoint_watch_error);
      if (status === 'checking_endpoint' || vision.endpoint_test_in_progress === true) {
        visionColabDetail.textContent = 'Testing HTTPS + registration…';
        visionColabDetail.title = String(vision.message || 'The app is testing the copied endpoint now.');
        visionColabDetail.dataset.state = 'in_progress';
      } else if (status === 'waiting_for_endpoint' || vision.endpoint_watch_active === true) {
        visionColabDetail.textContent = endpointFailure ? 'Endpoint failed; retrying' :
          (vision.automatic_handoff_ready === true && vision.automatic_handoff_armed === true ? 'Waiting for direct handoff' :
            vision.automatic_handoff_ready === true ? 'Click Connect Colab to arm' : 'Handoff receiver unavailable');
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
    } else if (vision.runtime_fresh === true && vision.enabled === true) {
      visionModelDetail.textContent = 'Loading…';
      visionModelDetail.title = String(vision.model || 'Vision model') + ' is active and loading in the connected Colab runtime.';
      visionModelDetail.dataset.state = 'in_progress';
    } else {
      visionModelDetail.textContent = 'Not loaded';
      visionModelDetail.title = String(vision.model || 'Vision model') + ' is not confirmed loaded in a live Colab runtime.';
      visionModelDetail.dataset.state = 'not_verified';
    }

    if (!visionSetupSnapshot && visionSetupDetail.textContent === 'Not checked') {
      visionSetupDetail.title = 'Setup check tests GitHub sign-in, mailbox reads, the direct Colab tunnel, and model readiness. Successful tunnel connection activates vision and begins model loading automatically.';
      visionSetupDetail.dataset.state = 'not_verified';
      visionMailboxDetail.title = 'Mailbox read access is checked by Setup check.';
      visionMailboxDetail.dataset.state = 'not_verified';
    }
  }

  function renderVisionSetup(snapshot) {
    visionSetupSnapshot = snapshot || {};
    const value = visionSetupSnapshot;
    const summaryStatus = value.status === 'ready' ? 'passed' : value.status === 'failed' ? 'failed' : value.status === 'loading' ? 'in_progress' : 'action_required';
    setCheckDetail(visionSetupDetail, {
      status: summaryStatus,
      message: (value.status || 'unknown') + (value.next_steps && value.next_steps.length ? '\n' + value.next_steps.join('\n') : '')
    });
    const checks = value.checks || {};
    setCheckDetail(visionMailboxDetail, checks.mailbox);
    if (checks.colab) setCheckDetail(visionColabDetail, checks.colab);
    if (checks.model) setCheckDetail(visionModelDetail, checks.model);
    visionSetupButton.title = value.note || 'Setup check verifies the authenticated tunnel and model readiness; successful connection automatically activates vision.';
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
      const message = 'The Colab connection check timed out. The app stopped waiting for this attempt; click Connect Colab to try again.';
      visionLabel.textContent = 'Colab: connection timed out';
      visionLabel.title = message;
      setDot(visionDot, 'error');
      visionSetupDetail.textContent = 'Connection timed out';
      visionSetupDetail.title = message;
      visionSetupDetail.dataset.state = 'failed';
      visionColabDetail.textContent = 'Connection timed out';
      visionColabDetail.title = message;
      visionColabDetail.dataset.state = 'failed';
      if (visionMessage) {
        visionMessage.textContent = message;
        visionMessage.title = message;
        visionMessage.dataset.state = 'failed';
      }
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
          visionSetupDetail.title = 'The app received a response from Colab over the authenticated direct HTTPS tunnel. Vision is activated automatically and model loading continues in the background.';
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
    visionConnectWatchDeadline = Date.now() + 21 * 60 * 1000;
    scheduleVisionConnectionCheck();
  }

  function setVisionManualPanelVisible(visible) {
    const expanded = visible === true;
    visionManualPanel.hidden = !expanded;
    visionPasteButton.setAttribute('aria-expanded', String(expanded));
    visionPasteButton.textContent = expanded ? 'Hide URL' : 'Paste URL';
    void window.windowsBridge.setVisionManualPanel(expanded).catch(() => {});
    if (expanded) {
      window.setTimeout(() => {
        if (!visionManualPanel.hidden) visionEndpointInput.focus();
      }, 0);
    }
  }

  async function connectColab(endpointUrl) {
    const isManual = typeof endpointUrl === 'string' && endpointUrl.trim().length > 0;
    if (visionBusy) return;
    visionBusy = true;
    visionSignInButton.disabled = true;
    visionSignInButton.textContent = isManual ? 'Checking URL…' : 'Connecting…';
    if (isManual) {
      visionEndpointConnectButton.disabled = true;
      visionEndpointConnectButton.textContent = 'Verifying…';
    }
    let result = null;
    try {
      result = await window.windowsBridge.connectColab(isManual ? endpointUrl.trim() : undefined);
      if (result && result.connected === true) {
        stopVisionConnectionWatch();
        renderVisionStatus(result);
        const incompatibleRuntime = result.status === 'incompatible_runtime' || result.runtime_compatible === false;
        visionSetupDetail.textContent = incompatibleRuntime ? 'Notebook update required' : 'Colab connected';
        visionSetupDetail.title = result.message || 'Colab responded through the direct authenticated HTTPS endpoint.';
        visionSetupDetail.dataset.state = incompatibleRuntime ? 'failed' : 'passed';
        visionColabDetail.textContent = incompatibleRuntime ? 'Tunnel live · API outdated' : 'Direct tunnel live';
        visionColabDetail.title = result.message || 'The app verified the authenticated HTTPS connection.';
        visionColabDetail.dataset.state = incompatibleRuntime ? 'action_required' : 'passed';
        visionModelDetail.textContent = incompatibleRuntime ? 'Update notebook' : result.model_loaded === true ? 'Loaded' : result.enabled === true ? 'Loading…' : 'Not loaded';
        visionModelDetail.title = incompatibleRuntime
          ? result.message || 'Interrupt the old server cell and run the latest notebook cell.'
          : result.model_loaded === true
            ? 'The Colab model is loaded.'
            : result.enabled === true ? 'Vision is active; the model is loading in the background.' : 'Waiting for the authenticated connection to activate vision.';
        visionModelDetail.dataset.state = incompatibleRuntime ? 'action_required' : result.model_loaded === true ? 'passed' : result.enabled === true ? 'in_progress' : 'not_verified';
        if (isManual) {
          visionEndpointInput.value = '';
          setVisionManualPanelVisible(false);
        }
        void window.windowsBridge.checkVisionSetup().then(renderVisionSetup).catch(() => {});
      } else if (result && result.status === 'waiting_for_runtime') {
        visionLabel.textContent = 'Colab: waiting for connection';
        visionLabel.title = result.message || 'Waiting for a direct Colab connection.';
        setDot(visionDot, 'waiting');
        visionSetupDetail.textContent = 'Waiting for Colab';
        visionSetupDetail.title = result.message || 'Open the notebook, connect a runtime if needed, and run the server cell.';
        visionSetupDetail.dataset.state = 'in_progress';
        renderVisionStatus(result);
        visionColabDetail.textContent = 'Waiting for notebook URL';
        visionColabDetail.title = result.message || 'The app is watching for the endpoint. You can paste it manually too.';
        visionColabDetail.dataset.state = 'action_required';
        visionModelDetail.textContent = 'Not started';
        visionModelDetail.title = 'After the authenticated HTTPS connection succeeds, the app activates vision automatically and model setup runs in the background.';
        visionModelDetail.dataset.state = 'not_verified';
        startVisionConnectionWatch();
      } else {
        const message = result && (result.message || result.error) || 'Colab connection could not be started.';
        visionSetupDetail.textContent = result && result.status === 'action_required' ? 'OneDrive folder needed' : 'Connection failed';
        visionSetupDetail.title = message;
        visionSetupDetail.dataset.state = result && result.status === 'action_required' ? 'action_required' : 'failed';
        visionColabDetail.textContent = result && result.status === 'action_required' ? 'Choose the OneDrive mailbox folder first' : 'Not connected';
        visionColabDetail.title = message;
        visionColabDetail.dataset.state = result && result.status === 'action_required' ? 'action_required' : 'failed';
        if (result) renderVisionStatus(result);
        if (isManual && visionMessage) {
          visionMessage.textContent = 'Could not connect using that URL. ' + String(message);
          visionMessage.title = String(message);
          visionMessage.dataset.state = 'failed';
        }
      }
    } catch (error) {
      const message = String(error && error.message || error);
      visionSetupDetail.textContent = 'Connection failed';
      visionSetupDetail.title = message;
      visionSetupDetail.dataset.state = 'failed';
      visionColabDetail.textContent = 'Not connected';
      visionColabDetail.title = message;
      visionColabDetail.dataset.state = 'failed';
      if (visionMessage) {
        visionMessage.textContent = 'Connection failed. ' + message;
        visionMessage.title = message;
        visionMessage.dataset.state = 'failed';
      }
    } finally {
      visionBusy = false;
      visionSignInButton.disabled = false;
      visionSignInButton.textContent = 'Connect Colab';
      visionEndpointConnectButton.disabled = false;
      visionEndpointConnectButton.textContent = 'Connect using URL';
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
    await refreshObserveStatus();
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
      renderOneDrive(await window.windowsBridge.getOneDriveState());
    } catch (error) {
      renderOneDrive({ configured: false, error: String(error && error.message || error) });
    }
    await refreshVisionStatus();
  }

  workspaceRow.addEventListener('click', chooseWorkspace);
  autoAcceptRow.addEventListener('click', toggleAutoAcceptAll);
  observeRow.addEventListener('click', () => { void toggleObserve(); });
  observeFpsSelect.addEventListener('change', () => { void changeObserveFps(); });
  visionSignInButton.addEventListener('click', () => { void connectColab(); });
  visionPasteButton.addEventListener('click', () => {
    setVisionManualPanelVisible(visionManualPanel.hidden);
  });
  visionEndpointCancelButton.addEventListener('click', () => {
    visionEndpointInput.value = '';
    setVisionManualPanelVisible(false);
  });
  visionManualPanel.addEventListener('submit', event => {
    event.preventDefault();
    const endpointUrl = visionEndpointInput.value.trim();
    if (!endpointUrl) {
      visionMessage.textContent = 'Paste the complete Colab endpoint URL from the running notebook cell.';
      visionMessage.dataset.state = 'action_required';
      visionEndpointInput.focus();
      return;
    }
    void connectColab(endpointUrl);
  });
  visionSetupButton.addEventListener('click', () => { void runVisionSetupCheck(); });
  minimizeButton.addEventListener('click', () => window.windowsBridge.minimizeToTray().catch(() => {}));
  quitButton.addEventListener('click', () => window.windowsBridge.quit().catch(() => {}));
  openDashboardButton.addEventListener('click', () => window.windowsBridge.openDashboard().catch(error => {
    openDashboardButton.title = String(error && error.message || error);
  }));
  window.windowsBridge.onBridgeState(renderWorker);
  window.windowsBridge.onOneDriveState(state => renderOneDrive(state));
  window.windowsBridge.onColabHandoffResult(result => {
    void refreshVisionStatus().finally(() => {
      const message = String(result && result.message || '');
      if (message && visionMessage) {
        visionMessage.textContent = message;
        visionMessage.title = message;
        visionMessage.dataset.state = result.connected === true ? 'passed' : 'failed';
      }
    });
  });
  window.addEventListener('online', () => {
    window.windowsBridge.retryConnection().catch(() => {});
    void refreshState();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      window.windowsBridge.retryConnection().catch(() => {});
      void refreshState();
    }
  });
  window.addEventListener('beforeunload', () => {
    stopVisionConnectionWatch();
  });

  refreshState();
  window.setInterval(refreshState, 15000);
  window.setInterval(refreshObserveStatus, 1000);
})();
