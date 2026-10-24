(() => {
  const root = document.body;
  const collapseButton = document.getElementById('collapse');
  const reloadButton = document.getElementById('reload-chat');
  const workspaceButton = document.getElementById('select-workspace');
  const workspaceLabel = document.getElementById('conversation-title');
  const accountsButton = document.getElementById('accounts');
  const browserButton = document.getElementById('open-browser');
  const quitButton = document.getElementById('quit');
  const bubbleButton = document.getElementById('assistant-ball');
  const bubbleLabel = document.getElementById('bubble-label');
  const threadButton = document.getElementById('threads');
  const newConversationButton = document.getElementById('new-conversation');
  const picker = document.getElementById('conversation-picker');
  const closePickerButton = document.getElementById('close-picker');
  const conversationList = document.getElementById('conversation-list');
  const pickerEmpty = document.getElementById('picker-empty');
  const chooseConversationEmpty = document.getElementById('choose-conversation-empty');
  const newConversationEmpty = document.getElementById('new-conversation-empty');
  const messageList = document.getElementById('message-list');
  const emptyState = document.getElementById('empty-state');
  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const sendButton = document.getElementById('send-message');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('connection-dot');
  const messageRange = document.getElementById('message-range');
  const loadEarlierButton = document.getElementById('load-earlier');
  const loadNewerButton = document.getElementById('load-newer');
  const mirrorError = document.getElementById('mirror-error');
  const snapshotNote = document.getElementById('snapshot-note');
  let currentSnapshot = null;
  let lastRenderedKey = '';
  let sending = false;
  let scrollingConversation = false;

  function setCollapsed(isCollapsed) {
    root.classList.toggle('is-collapsed', isCollapsed);
    root.setAttribute('aria-label', isCollapsed ? 'Collapsed ChatGPT Mirror' : 'ChatGPT Mirror');
    bubbleButton.setAttribute('aria-expanded', String(!isCollapsed));
    if (bubbleLabel) bubbleLabel.textContent = isCollapsed ? 'Open ChatGPT Mirror' : 'ChatGPT Mirror';
  }

  function showError(message) {
    if (!mirrorError) return;
    mirrorError.textContent = String(message || '');
    mirrorError.hidden = !message;
  }

  function setStatus(snapshot) {
    const signedIn = snapshot && snapshot.signedIn;
    const busy = snapshot && snapshot.generating;
    statusDot.classList.toggle('is-connected', Boolean(signedIn && !snapshot.error));
    statusDot.classList.toggle('is-busy', Boolean(busy));
    statusDot.classList.toggle('is-error', Boolean(snapshot && (snapshot.error || snapshot.loginPage)));
    if (snapshot && snapshot.error) statusText.textContent = 'ChatGPT session is not ready';
    else if (snapshot && snapshot.loginPage) statusText.textContent = 'Sign in to ChatGPT to continue';
    else if (busy) statusText.textContent = 'ChatGPT is responding…';
    else if (snapshot && !snapshot.signedIn) statusText.textContent = 'Waiting for the signed-in ChatGPT session…';
    else if (snapshot && snapshot.conversationId) statusText.textContent = 'Connected · same ChatGPT conversation';
    else statusText.textContent = 'Connected · start a new chat or choose an existing conversation';

    const title = snapshot && snapshot.title ? snapshot.title : 'Connecting to your conversation…';
    workspaceLabel.textContent = title.length > 64 ? title.slice(0, 61) + '…' : title;
    workspaceLabel.title = title;
    if (snapshot && snapshot.totalRenderedMessages != null && snapshot.messages) {
      messageRange.textContent = snapshot.messages.length
        ? (snapshot.startIndex + 1) + '–' + snapshot.endIndex + ' of ' + snapshot.totalRenderedMessages
        : '';
    } else messageRange.textContent = '';
    loadEarlierButton.hidden = !(snapshot && snapshot.hasEarlier);
    loadNewerButton.hidden = !(snapshot && snapshot.hasLater);
    if (snapshot && snapshot.hasEarlier) loadEarlierButton.textContent = '↑ Load earlier messages';
    if (snapshot && snapshot.hasLater) loadNewerButton.textContent = 'Load newer messages ↓';
    messageInput.disabled = Boolean(sending || busy || (snapshot && (snapshot.signedIn === false || snapshot.loginPage || snapshot.composerHasDraft)));
    sendButton.disabled = messageInput.disabled || !messageInput.value.trim();
    if (snapshot && snapshot.composerHasDraft) {
      snapshotNote.textContent = 'The hidden ChatGPT composer has an unsent draft. Clear it in the full ChatGPT window before sending from the mirror.';
    } else if (snapshot && snapshot.totalRenderedMessages > (snapshot.messages || []).length) {
      snapshotNote.textContent = 'Viewport-sized mirror · ' + snapshot.messages.length + ' nearby messages loaded; full context stays on ChatGPT.';
    } else {
      snapshotNote.textContent = 'Viewport-sized mirror · full conversation context stays on ChatGPT.';
    }
  }

  function appendPlainBlock(parent, text) {
    const block = document.createElement('div');
    block.className = 'message-copy';
    block.textContent = String(text || '');
    parent.appendChild(block);
  }

  function appendMessageText(parent, rawText) {
    const text = String(rawText || '');
    const fence = /```([^\n`]*)(?:\n)?([\s\S]*?)```/g;
    let cursor = 0;
    let match;
    while ((match = fence.exec(text))) {
      const before = text.slice(cursor, match.index).trim();
      if (before) appendPlainBlock(parent, before);
      const pre = document.createElement('pre');
      pre.className = 'message-code';
      const code = document.createElement('code');
      const language = String(match[1] || '').trim();
      if (language) code.dataset.language = language;
      code.textContent = String(match[2] || '').replace(/^\n/, '').replace(/\n$/, '');
      pre.appendChild(code);
      parent.appendChild(pre);
      cursor = fence.lastIndex;
    }
    const after = text.slice(cursor).trim();
    if (after) appendPlainBlock(parent, after);
    if (!text.trim()) appendPlainBlock(parent, '(No text content in this message)');
  }

  function createMessage(message) {
    const article = document.createElement('article');
    article.className = 'message-card message-' + (message.role === 'user' ? 'user' : 'assistant');
    article.dataset.messageId = String(message.id || '');
    const header = document.createElement('div');
    header.className = 'message-meta';
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.role === 'user' ? 'You' : 'ChatGPT';
    header.appendChild(author);
    if (message.hasImages) {
      const attachment = document.createElement('span');
      attachment.className = 'message-tag';
      attachment.textContent = 'Image / attachment';
      header.appendChild(attachment);
    }
    if (message.truncated) {
      const clipped = document.createElement('span');
      clipped.className = 'message-tag';
      clipped.textContent = 'Preview shortened';
      header.appendChild(clipped);
    }
    article.appendChild(header);
    const content = document.createElement('div');
    content.className = 'message-content';
    appendMessageText(content, message.text);
    article.appendChild(content);
    return article;
  }

  function renderSnapshot(snapshot) {
    currentSnapshot = snapshot || {};
    setStatus(currentSnapshot);
    const messages = Array.isArray(currentSnapshot.messages) ? currentSnapshot.messages : [];
    const renderKey = JSON.stringify({
      url: currentSnapshot.url,
      messages: messages.map(message => [message.id, message.text, message.truncated]),
      generating: currentSnapshot.generating,
      loginPage: currentSnapshot.loginPage,
      error: currentSnapshot.error
    });
    if (renderKey === lastRenderedKey) return;
    const previousScrollTop = messageList.scrollTop;
    const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 100;
    const shouldStickToBottom = nearBottom || !lastRenderedKey;
    lastRenderedKey = renderKey;
    messageList.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-orb" aria-hidden="true"><span></span><span></span><span></span></div><h1></h1><p></p><button id="choose-conversation-empty" class="secondary-button" type="button">Choose an existing conversation</button><button id="new-conversation-empty" class="text-button" type="button">Start a new conversation</button>';
      empty.querySelector('h1').textContent = currentSnapshot.loginPage
        ? 'Sign in to ChatGPT'
        : currentSnapshot.conversationId ? 'This conversation is empty' : 'Choose a conversation';
      empty.querySelector('p').textContent = currentSnapshot.loginPage
        ? 'Open the ChatGPT sign-in window from Accounts. Once signed in, return here to continue in the same session.'
        : currentSnapshot.conversationId
          ? 'The selected thread has no messages in the current viewport yet. Send a message below to continue.'
          : 'Choose an existing thread or start a new chat. Only the active conversation is shown here; the full ChatGPT website stays out of the mirror.';
      empty.querySelector('#choose-conversation-empty').addEventListener('click', openConversationPicker);
      empty.querySelector('#new-conversation-empty').addEventListener('click', startNewConversation);
      messageList.appendChild(empty);
    } else {
      const fragment = document.createDocumentFragment();
      messages.forEach(message => fragment.appendChild(createMessage(message)));
      messageList.appendChild(fragment);
      if (shouldStickToBottom) messageList.scrollTop = messageList.scrollHeight;
      else messageList.scrollTop = Math.min(previousScrollTop, Math.max(0, messageList.scrollHeight - messageList.clientHeight));
    }
    if (!messages.length) messageList.scrollTop = 0;
    if (currentSnapshot.error) showError(currentSnapshot.error);
    else showError('');
  }

  async function refreshMirror() {
    reloadButton.classList.add('is-spinning');
    try {
      const snapshot = await window.assistantOverlay.getMirrorSnapshot();
      if (snapshot) renderSnapshot(snapshot);
    } catch (error) { showError(error.message || error); }
    finally { window.setTimeout(() => reloadButton.classList.remove('is-spinning'), 450); }
  }

  async function openConversationPicker() {
    showError('');
    picker.hidden = false;
    conversationList.replaceChildren();
    pickerEmpty.hidden = true;
    const loading = document.createElement('div');
    loading.className = 'picker-loading';
    loading.textContent = 'Loading recent conversations…';
    conversationList.appendChild(loading);
    try {
      const result = await window.assistantOverlay.listMirrorConversations();
      const conversations = result && Array.isArray(result.conversations) ? result.conversations : [];
      conversationList.replaceChildren();
      if (!conversations.length) {
        pickerEmpty.hidden = false;
        return;
      }
      conversations.forEach(conversation => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation-option' + (conversation.current ? ' is-current' : '');
        const title = document.createElement('span');
        title.className = 'conversation-option-title';
        title.textContent = conversation.title || 'Untitled conversation';
        const status = document.createElement('span');
        status.className = 'conversation-option-status';
        status.textContent = conversation.current ? 'Current conversation' : 'Open this thread';
        button.append(title, status);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const outcome = await window.assistantOverlay.openMirrorConversation(conversation.id);
            if (outcome && outcome.ok) picker.hidden = true;
            else showError('Could not open the selected conversation.');
          } catch (error) { showError(error.message || error); }
          finally { button.disabled = false; }
        });
        conversationList.appendChild(button);
      });
    } catch (error) {
      conversationList.replaceChildren();
      pickerEmpty.hidden = false;
      showError(error.message || error);
    }
  }

  async function startNewConversation() {
    showError('');
    picker.hidden = true;
    try {
      await window.assistantOverlay.newMirrorConversation();
      messageInput.value = '';
      messageInput.focus();
    } catch (error) { showError(error.message || error); }
  }

  async function scrollConversation(direction) {
    if (scrollingConversation) return;
    scrollingConversation = true;
    loadEarlierButton.disabled = true;
    loadNewerButton.disabled = true;
    try {
      const result = await window.assistantOverlay.scrollMirrorConversation(direction);
      if (result && result.ok === false && result.reason) showError('Could not change the mirrored message window: ' + result.reason);
    } catch (error) { showError(error.message || error); }
    finally {
      loadEarlierButton.disabled = false;
      loadNewerButton.disabled = false;
      scrollingConversation = false;
    }
  }

  function setWorkspaceLabel(workspaceRoot) {
    const title = currentSnapshot && currentSnapshot.title ? currentSnapshot.title : 'ChatGPT Mirror';
    if (workspaceLabel) workspaceLabel.title = title + '\nWorkspace: ' + String(workspaceRoot || '');
  }

  collapseButton.addEventListener('click', () => window.assistantOverlay.collapse());
  reloadButton.addEventListener('click', refreshMirror);
  workspaceButton.addEventListener('click', async () => {
    workspaceButton.disabled = true;
    try {
      const result = await window.assistantOverlay.selectWorkspace();
      if (result && result.workspaceRoot) setWorkspaceLabel(result.workspaceRoot);
    } catch (error) { showError('Workspace error: ' + String(error.message || error)); }
    finally { workspaceButton.disabled = false; }
  });
  accountsButton.addEventListener('click', () => window.assistantOverlay.openAccounts());
  browserButton.addEventListener('click', () => window.assistantOverlay.openInBrowser());
  quitButton.addEventListener('click', () => window.assistantOverlay.quit());
  bubbleButton.addEventListener('click', () => window.assistantOverlay.expand());
  threadButton.addEventListener('click', openConversationPicker);
  closePickerButton.addEventListener('click', () => { picker.hidden = true; });
  newConversationButton.addEventListener('click', startNewConversation);
  chooseConversationEmpty.addEventListener('click', openConversationPicker);
  newConversationEmpty.addEventListener('click', startNewConversation);
  loadEarlierButton.addEventListener('click', () => scrollConversation(-1));
  loadNewerButton.addEventListener('click', () => scrollConversation(1));

  messageForm.addEventListener('submit', async event => {
    event.preventDefault();
    const text = String(messageInput.value || '').trim();
    if (!text || sending) return;
    sending = true;
    sendButton.disabled = true;
    showError('');
    statusText.textContent = 'Sending message to the same ChatGPT conversation…';
    try {
      const result = await window.assistantOverlay.sendMirrorMessage(text);
      if (!result || !result.ok) {
        const reason = result && result.reason === 'composer_has_draft'
          ? 'The ChatGPT page already has a draft. It was not overwritten.'
          : result && result.reason === 'assistant_busy'
            ? 'ChatGPT is still responding. Please wait for that response to finish.'
            : result && result.message || 'The message was not sent.';
        showError(reason);
        return;
      }
      messageInput.value = '';
      messageInput.style.height = 'auto';
      renderSnapshot({ ...(currentSnapshot || {}), generating: true, signedIn: true });
    } catch (error) { showError(error.message || error); }
    finally {
      sending = false;
      setStatus(currentSnapshot || {});
      sendButton.disabled = messageInput.disabled || !messageInput.value.trim();
      messageInput.focus();
    }
  });

  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(160, messageInput.scrollHeight) + 'px';
    sendButton.disabled = messageInput.disabled || !messageInput.value.trim();
  });
  messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!sendButton.disabled) messageForm.requestSubmit();
    }
  });

  window.assistantOverlay.onMirrorSnapshot(renderSnapshot);
  window.assistantOverlay.onWorkspaceChanged(setWorkspaceLabel);
  window.assistantOverlay.getWorkspace().then(info => setWorkspaceLabel(info.workspaceRoot)).catch(() => {});
  window.assistantOverlay.onCollapsedChanged(setCollapsed);
  setCollapsed(false);
  refreshMirror();
})();
