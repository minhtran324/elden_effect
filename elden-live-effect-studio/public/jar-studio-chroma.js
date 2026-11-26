const chromaDialog = document.getElementById('studioChromaDialog');
const chromaBefore = document.getElementById('studioChromaBefore');
const chromaAfter = document.getElementById('studioChromaAfter');
const chromaColor = document.getElementById('studioChromaColor');
const chromaTolerance = document.getElementById('studioChromaTolerance');
const chromaSoftness = document.getElementById('studioChromaSoftness');
const chromaApply = document.getElementById('studioChromaApply');
const chromaCancel = document.getElementById('studioChromaCancel');
const chromaControls = document.getElementById('studioChromaControls');
const chromaStatus = document.getElementById('studioChromaStatus');
let stickerChroma;
let chromaRequest = 0;
let chromaPreviewFrame = 0;

chromaDialog.addEventListener('cancel', event => {
  if (chromaApply.disabled) event.preventDefault();
});

chromaDialog.addEventListener('close', () => {
  cancelAnimationFrame(chromaPreviewFrame);
  chromaPreviewFrame = 0;
  stickerChroma = undefined;
  chromaBefore.width = chromaAfter.width = 1;
  chromaBefore.height = chromaAfter.height = 1;
});

async function openStickerChromaFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    await openStickerChroma(url, file.name.replace(/\.[^./]+$/, ''));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openSelectedStickerChroma() {
  const sticker = state.stickers[state.selectedStickerIdx];
  if (sticker) return openStickerChroma(sticker.src, sticker.name, sticker);
}

async function openStickerChroma(url, name, sticker = null) {
  const request = ++chromaRequest;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;

  try {
    await image.decode();
    if (request !== chromaRequest) return;
    const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
    chromaBefore.width = chromaAfter.width = Math.max(1, Math.round(image.naturalWidth * scale));
    chromaBefore.height = chromaAfter.height = Math.max(1, Math.round(image.naturalHeight * scale));

    const context = chromaBefore.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, chromaBefore.width, chromaBefore.height);
    const preview = context.getImageData(0, 0, chromaBefore.width, chromaBefore.height);
    stickerChroma = { image, preview, name, sticker };

    chromaColor.value = '#00ff00';
    chromaTolerance.value = '18';
    chromaSoftness.value = '8';
    chromaStatus.textContent = '';
    chromaApply.textContent = sticker ? 'Cập nhật sticker' : 'Dán sticker';
    chromaDialog.showModal();
    queueStickerChromaPreview();
  } catch {
    if (request === chromaRequest) showToast('', 'Không mở được ảnh để xóa phông.');
  }
}

function readStickerChromaSettings() {
  const hex = Number.parseInt(chromaColor.value.slice(1), 16);
  const maxDistance = Math.hypot(255, 255, 255);
  return {
    key: [hex >> 16, (hex >> 8) & 255, hex & 255],
    threshold: chromaTolerance.valueAsNumber / 100 * maxDistance,
    feather: chromaSoftness.valueAsNumber / 100 * maxDistance
  };
}

function keyStickerPixels(pixels, { key, threshold, feather }) {
  const data = pixels.data;
  const thresholdSquared = threshold ** 2;
  const featherEdgeSquared = (threshold + feather) ** 2;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const distanceSquared = (data[i] - key[0]) ** 2 + (data[i + 1] - key[1]) ** 2 + (data[i + 2] - key[2]) ** 2;
    if (distanceSquared <= thresholdSquared) {
      data[i + 3] = 0;
    } else if (distanceSquared < featherEdgeSquared) {
      const t = (Math.sqrt(distanceSquared) - threshold) / feather;
      const coverage = t * t * (3 - 2 * t);
      data[i + 3] *= coverage;
      if (!data[i + 3]) continue;
      // Remove the key color from partially transparent pixels to clean the edge.
      for (let channel = 0; channel < 3; channel++) {
        data[i + channel] = (data[i + channel] - key[channel] * (1 - coverage)) / coverage;
      }
    }
  }
}

function queueStickerChromaPreview() {
  document.getElementById('studioChromaToleranceValue').value = chromaTolerance.value + '%';
  document.getElementById('studioChromaSoftnessValue').value = chromaSoftness.value + '%';
  if (!stickerChroma || chromaPreviewFrame) return;

  chromaPreviewFrame = requestAnimationFrame(() => {
    chromaPreviewFrame = 0;
    if (!stickerChroma) return;
    const { data, width, height } = stickerChroma.preview;
    const pixels = new ImageData(new Uint8ClampedArray(data), width, height);
    keyStickerPixels(pixels, readStickerChromaSettings());
    chromaAfter.getContext('2d').putImageData(pixels, 0, 0);
  });
}

function sampleStickerChroma(event) {
  if (!stickerChroma || chromaApply.disabled) return;
  const { left, top, width, height } = chromaBefore.getBoundingClientRect();
  const x = Math.floor((event.clientX - left) / width * chromaBefore.width);
  const y = Math.floor((event.clientY - top) / height * chromaBefore.height);
  const at = (y * chromaBefore.width + x) * 4;
  const { data } = stickerChroma.preview;
  if (!data[at + 3]) {
    chromaStatus.textContent = 'Chọn một điểm có màu trên ảnh gốc.';
    return;
  }
  chromaColor.value = '#' + Array.from(data.subarray(at, at + 3), value => value.toString(16).padStart(2, '0')).join('');
  chromaStatus.textContent = '';
  queueStickerChromaPreview();
}

async function applyStickerChroma(event) {
  event.preventDefault();
  if (!stickerChroma || chromaApply.disabled) return;
  const { image, name, sticker } = stickerChroma;
  chromaApply.disabled = chromaCancel.disabled = chromaControls.disabled = true;
  chromaStatus.textContent = 'Đang xử lý ảnh…';

  try {
    const output = document.createElement('canvas');
    output.width = image.naturalWidth;
    output.height = image.naturalHeight;
    const context = output.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, output.width, output.height);
    keyStickerPixels(pixels, readStickerChromaSettings());
    context.putImageData(pixels, 0, 0);

    const blob = await canvasPng(output);
    output.width = output.height = 1;
    const file = new File([blob], (name || 'sticker') + '-chroma.png', { type: 'image/png' });
    const src = await uploadStudioSticker(file);
    await addStickerToCanvas(src, name, sticker);
    chromaDialog.close();
    showToast('', 'Đã dán sticker đã xóa phông.');
  } catch (error) {
    chromaStatus.textContent = error instanceof DOMException ? 'Không xử lý được ảnh sticker.' : error.message;
  } finally {
    chromaApply.disabled = chromaCancel.disabled = chromaControls.disabled = false;
  }
}
