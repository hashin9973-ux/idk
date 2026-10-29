'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const bridge = window.speechCaption;
    let busy = false;

  function render(value) {
    const card = $('caption-card');
    card.dataset.theme = String(value.theme || 'midnight');
    card.dataset.mode = value.mode === 'notification' ? 'notification' : 'autoplay';
    card.classList.toggle('transparent', value.transparent === true);
    $('caption-text').textContent = String(value.text || '');
    $('caption-status').textContent = String(value.status || '');
    $('caption-error').textContent = String(value.error || '');
    $('caption-error').hidden = !value.error;
    const button = $('caption-play');
    button.hidden = value.showPlayButton !== true;
    button.disabled = busy;
    $('caption-dismiss').hidden = value.mode !== 'notification' && !value.error;
  }

  $('caption-play').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('caption-play').disabled = true;
    try {
      await bridge.play();
    } catch (error) {
      $('caption-status').textContent = 'Playback failed';
      $('caption-error').textContent = String(error && error.message || error);
      $('caption-error').hidden = false;
      $('caption-play').hidden = false;
    } finally {
      busy = false;
      $('caption-play').disabled = false;
    }
  });
  $('caption-dismiss').addEventListener('click', () => void bridge.dismiss().catch(() => {}));
  bridge.onUpdate(render);
})();
