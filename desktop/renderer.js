(() => {
  const root = document.body;
  const collapseButton = document.getElementById('collapse');
  const reloadButton = document.getElementById('reload-chat');
  const workspaceButton = document.getElementById('select-workspace');
  const workspaceLabel = document.getElementById('workspace-label');
  const browserButton = document.getElementById('open-browser');
  const quitButton = document.getElementById('quit');
  const bubbleButton = document.getElementById('assistant-ball');
  const bubbleLabel = document.getElementById('bubble-label');

  function setCollapsed(isCollapsed) {
    root.classList.toggle('is-collapsed', isCollapsed);
    root.setAttribute('aria-label', isCollapsed ? 'Collapsed ChatGPT Assistant' : 'ChatGPT Assistant');
    bubbleButton.setAttribute('aria-expanded', String(!isCollapsed));
    if (bubbleLabel) bubbleLabel.textContent = isCollapsed ? 'Open ChatGPT' : 'ChatGPT Assistant';
  }

  collapseButton.addEventListener('click', () => {
    window.assistantOverlay.collapse();
  });
  reloadButton.addEventListener('click', () => {
    reloadButton.classList.add('is-spinning');
    window.assistantOverlay.reloadChat().finally(() => {
      window.setTimeout(() => reloadButton.classList.remove('is-spinning'), 650);
    });
  });
  workspaceButton.addEventListener('click', async () => {
    workspaceButton.disabled = true;
    try {
      const result = await window.assistantOverlay.selectWorkspace();
      if (result && result.workspaceRoot) setWorkspaceLabel(result.workspaceRoot);
    } catch (error) {
      if (workspaceLabel) workspaceLabel.textContent = 'Workspace error · ' + String(error.message || error);
    } finally { workspaceButton.disabled = false; }
  });
  browserButton.addEventListener('click', () => window.assistantOverlay.openInBrowser());
  quitButton.addEventListener('click', () => window.assistantOverlay.quit());
  bubbleButton.addEventListener('click', () => window.assistantOverlay.expand());

  function setWorkspaceLabel(rootPath) {
    if (!workspaceLabel) return;
    const pieces = String(rootPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const shortName = pieces.length > 1 ? pieces.slice(-2).join('/') : (pieces[0] || 'No workspace');
    workspaceLabel.textContent = 'Workspace · ' + shortName + ' · Ctrl+Shift+Space';
    workspaceLabel.title = String(rootPath || '');
  }
  window.assistantOverlay.onWorkspaceChanged(setWorkspaceLabel);
  window.assistantOverlay.getWorkspace().then(info => setWorkspaceLabel(info.workspaceRoot)).catch(() => {});
  window.assistantOverlay.onCollapsedChanged(setCollapsed);
  setCollapsed(false);
})();
