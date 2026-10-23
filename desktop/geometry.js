function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampRectToWorkArea(bounds, workArea, minWidth = 360, minHeight = 480) {
  const workX = numberOr(workArea.x, 0);
  const workY = numberOr(workArea.y, 0);
  const workWidth = Math.max(1, numberOr(workArea.width, 1));
  const workHeight = Math.max(1, numberOr(workArea.height, 1));
  const requestedWidth = numberOr(bounds.width, 460);
  const requestedHeight = numberOr(bounds.height, 720);
  const wantedWidth = Math.max(minWidth, requestedWidth > 0 ? requestedWidth : 460);
  const wantedHeight = Math.max(minHeight, requestedHeight > 0 ? requestedHeight : 720);
  const width = Math.min(wantedWidth, workWidth);
  const height = Math.min(wantedHeight, workHeight);
  const x = clamp(numberOr(bounds.x, workX), workX, workX + workWidth - width);
  const y = clamp(numberOr(bounds.y, workY), workY, workY + workHeight - height);
  return { x, y, width, height };
}

function clampBubbleToWorkArea(bounds, workArea, size = 76) {
  const workX = numberOr(workArea.x, 0);
  const workY = numberOr(workArea.y, 0);
  const workWidth = Math.max(1, numberOr(workArea.width, 1));
  const workHeight = Math.max(1, numberOr(workArea.height, 1));
  const x = clamp(numberOr(bounds.x, workX), workX, Math.max(workX, workX + workWidth - size));
  const y = clamp(numberOr(bounds.y, workY), workY, Math.max(workY, workY + workHeight - size));
  return { x, y };
}

module.exports = { clampRectToWorkArea, clampBubbleToWorkArea };
