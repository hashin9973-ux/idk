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
    $('caption-agent-label').textContent = String(value.agentLabel || 'Windows Bridge');
    $('caption-previous').disabled = Number(value.chunkIndex || 0) <= 0;
    $('caption-next').disabled = Number(value.chunkIndex || 0) >= Math.max(0, Number(value.chunkCount || 1) - 1);
    $('caption-pause').textContent = value.paused === true ? '▶' : 'Ⅱ';
    $('caption-pause').hidden = value.hasPlayback !== true;
    $('caption-pause').setAttribute('aria-label', value.paused === true ? 'Resume speech' : 'Pause speech');
    $('caption-controls').hidden = Number(value.chunkCount || 1) < 2 && value.mode !== 'autoplay';
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
  $('caption-previous').addEventListener('click', () => void bridge.navigate('previous').catch(() => {}));
  $('caption-next').addEventListener('click', () => void bridge.navigate('next').catch(() => {}));
  $('caption-pause').addEventListener('click', async () => {try{const r=await bridge.togglePause();$('caption-pause').textContent=r.paused?'▶':'Ⅱ'}catch(error){$('caption-status').textContent=String(error&&error.message||error)}});
  $('caption-dismiss').addEventListener('click', () => void bridge.dismiss().catch(() => {}));
  bridge.onUpdate(render);
})();
