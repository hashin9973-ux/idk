(() => {
  const root = document.body;
  const collapseButton = document.getElementById('collapse');
  const reloadButton = document.getElementById('reload-chat');
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
  browserButton.addEventListener('click', () => window.assistantOverlay.openInBrowser());
  quitButton.addEventListener('click', () => window.assistantOverlay.quit());
  bubbleButton.addEventListener('click', () => window.assistantOverlay.expand());

  window.assistantOverlay.onCollapsedChanged(setCollapsed);
  setCollapsed(false);
})();
