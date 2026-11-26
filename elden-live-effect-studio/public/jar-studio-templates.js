const studioJarAspects = { square: 'Vuông 1:1', horizontal: 'Ngang 4:3', vertical: 'Dọc 3:4' };
let studioJarImageRequest = 0;
let studioJarImporting = false;

function discardPendingJarArtwork() {
  studioJarImporting = false;
  if (state.pendingImage) URL.revokeObjectURL(state.baseImgUrl);
  if (state.pendingFrontImage) URL.revokeObjectURL(state.frontOverlayUrl);
  state.pendingImage = null;
  state.pendingFrontImage = null;
}

function clearStudioJarFront() {
  ++studioJarImageRequest;
  studioJarImporting = false;
  if (state.pendingFrontImage) URL.revokeObjectURL(state.frontOverlayUrl);
  state.pendingFrontImage = null;
  state.showFrontOverlay = false;
  loadFrontOverlay('');
}

function validateJarFrontImage(front, rear) {
  if (!rear) throw new Error('Hãy nhập mặt sau trước.');
  if (front.naturalWidth !== rear.naturalWidth || front.naturalHeight !== rear.naturalHeight) {
    throw new Error('Mặt trước cần đúng ' + rear.naturalWidth + ' × ' + rear.naturalHeight + ' px như mặt sau.');
  }
  const sample = document.createElement('canvas');
  const shrink = Math.min(1, 128 / Math.max(front.naturalWidth, front.naturalHeight));
  sample.width = Math.max(1, Math.round(front.naturalWidth * shrink));
  sample.height = Math.max(1, Math.round(front.naturalHeight * shrink));
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(front, 0, 0, sample.width, sample.height);
  const data = context.getImageData(0, 0, sample.width, sample.height).data;
  let clear = false;
  let visible = false;
  for (let i = 3; i < data.length && !(clear && visible); i += 4) {
    if (data[i] === 0) clear = true;
    if (data[i] > 0) visible = true;
  }
  if (!clear || !visible) {
    throw new Error('Mặt trước cần có chi tiết viền hũ và vùng nền trong suốt.');
  }
}

async function handleCustomJarUpload(input, layer) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const request = ++studioJarImageRequest;
  studioJarImporting = true;
  const status = document.getElementById(layer === 'front' ? 'studioFrontLayerStatus' : 'studioRearLayerStatus');
  status.textContent = 'Đang đọc ảnh…';
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    if (!['image/png', 'image/webp'].includes(file.type)) throw new Error('Hãy chọn ảnh PNG hoặc WebP.');
    image.src = url;
    await image.decode();
    if (request !== studioJarImageRequest) {
      URL.revokeObjectURL(url);
      return;
    }

    if (layer === 'front') {
      validateJarFrontImage(image, state.baseImg);
      if (state.pendingFrontImage) URL.revokeObjectURL(state.frontOverlayUrl);
      state.pendingFrontImage = file;
      state.frontOverlayUrl = url;
      state.frontOverlayImg = image;
      state.showFrontOverlay = true;
      showToast('', 'Đã nhập mặt trước. Bấm Thả thử quà để xem hai lớp.');
    } else {
      const ratio = image.naturalWidth / image.naturalHeight;
      const keep = document.getElementById('studioKeepHitbox').checked;
      if (keep && Math.abs(ratio / (state.baseW / state.baseH) - 1) > .02) {
        throw new Error('Ảnh chưa đúng tỷ lệ ' + studioJarAspects[state.aspect] + '. Hãy dùng kích thước trong hướng dẫn.');
      }
      discardPendingJarArtwork();
      state.pendingImage = file;
      state.baseImgUrl = url;
      state.baseImg = image;
      state.sampleName = file.name.replace(/\.[^.]+$/, '');
      state.frontOverlayUrl = '';
      state.frontOverlayImg = null;
      state.showFrontOverlay = false;
      if (!keep) setStudioAspect(ratio > 1.18 ? 'horizontal' : ratio < .85 ? 'vertical' : 'square');
      showToast('', 'Đã nhập mặt sau. Hãy chọn mặt trước cùng kích thước.');
    }
    redraw();
  } catch (error) {
    URL.revokeObjectURL(url);
    if (request === studioJarImageRequest) {
      showToast('', error instanceof DOMException ? 'Không đọc được ảnh hũ.' : error.message);
    }
  } finally {
    if (request === studioJarImageRequest) {
      studioJarImporting = false;
      updateJarSample();
    }
  }
}

function clearStudioStickers() {
  state.stickers = [];
  state.selectedStickerIdx = -1;
  state.legacyDecor = { decorImage: '', decorText: '' };
  updateActiveStickersList();
  updateSelectedStickerUI();
  redraw();
  showToast('', 'Đã xóa sticker trên mẫu đang chỉnh.');
}

function loadStudioJarDesign(design, name = '') {
  ++studioJarImageRequest;
  discardPendingJarArtwork();
  state.sampleName = name;
  state.selectedStickerIdx = -1;

  if (design.hitbox) state.hitbox = { ...design.hitbox };
  state.clipGifts = design.clipGiftsToJar ?? state.clipGifts;
  state.glassRealism = design.glassRealism ?? state.glassRealism;
  state.hideDefaultJar = design.hideDefaultJarOnCustom ?? true;
  state.showSparkles = design.shimmerSparkles ?? state.showSparkles;
  state.shimmerSpeed = Number(design.shimmerRimSpeed ?? state.shimmerSpeed);
  state.showFrontOverlay = !!(design.frontOverlayImage ?? state.frontOverlayUrl);
  toggleShimmerPreview(design.shimmerRimEffect ?? state.showShimmer);

  document.getElementById('chkHideDefault').checked = state.hideDefaultJar;
  document.getElementById('chkShimmerStars').checked = state.showSparkles;
  document.getElementById('shimmerSpeedSlider').value = state.shimmerSpeed;
  document.getElementById('lblShimmerSpeed').textContent = state.shimmerSpeed + 'x';

  const padding = design.jarPadding;
  if (padding) {
    state.padTop = Number(padding.top ?? 20);
    state.padBottom = Number(padding.bottom ?? 20);
    state.padLeft = Number(padding.left ?? 20);
    state.padRight = Number(padding.right ?? 20);
  }
  for (const [part, value] of [['Top', state.padTop], ['Bottom', state.padBottom], ['Sides', state.padLeft]]) {
    document.getElementById('pad' + part + 'Slider').value = value;
    document.getElementById('lblPad' + part).textContent = value + 'px';
  }

  const aspect = Object.hasOwn(studioJarAspects, design.jarAspect) ? design.jarAspect : state.aspect;
  state.stickers = [];
  setStudioAspect(aspect);
  state.legacyDecor = { decorImage: design.decorImage ?? '', decorText: design.decorText ?? '' };
  for (const sticker of Array.isArray(design.stickers) ? design.stickers : []) {
    if (!sticker.url) continue;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const item = {
      id: sticker.id,
      name: sticker.name || 'Sticker',
      src: sticker.url,
      img,
      x: state.padLeft + state.baseW * (sticker.x ?? 50) / 100,
      y: state.padTop + state.baseH * (sticker.y ?? 82) / 100,
      w: 220,
      h: 220,
      scale: sticker.scale ?? .85,
      rotation: (sticker.rotation ?? 0) * Math.PI / 180,
      opacity: sticker.opacity ?? 1,
      layer: sticker.layer || 'front'
    };
    img.onload = () => {
      item.w = Math.min(220, img.naturalWidth || 220);
      item.h = item.w * img.naturalHeight / img.naturalWidth;
      redraw();
    };
    img.src = item.src;
    state.stickers.push(item);
  }

  loadFrontOverlay(design.frontOverlayImage ?? state.frontOverlayUrl);
  loadJarImage(design.customJarImage ?? state.baseImgUrl);
  applyHitboxToStudioUI();
  updateActiveStickersList();
  updateSelectedStickerUI();
}

async function requestStudioTemplate(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('Không kết nối được máy chủ. Hãy mở Jar Studio từ địa chỉ Studio đang chạy.');
  }
  const content = response.headers.get('content-type') || '';
  if (!content.includes('application/json')) {
    const hint = response.status === 404 ? 'Máy chủ chưa có thao tác này.' : 'Máy chủ trả về trang lỗi thay cho dữ liệu.';
    throw new Error(hint + ' Hãy tải lại Jar Studio từ máy chủ đang chạy.');
  }
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || 'Không xử lý được mẫu hũ.');
  return data;
}

async function supportsJarLayerUploads() {
  const data = await requestStudioTemplate('/api/jar/config', { cache: 'no-store' });
  return data.supportsJarLayers === true;
}

function adoptStudioJarLayer(layer, file, url) {
  const rear = layer === 'rear';
  const pending = rear ? 'pendingImage' : 'pendingFrontImage';
  const source = rear ? 'baseImgUrl' : 'frontOverlayUrl';
  if (!file || !url || state[pending] !== file) return;
  URL.revokeObjectURL(state[source]);
  state[pending] = null;
  state[source] = url;
  updateJarSample();
}

async function uploadStudioJarLayer(layer, file) {
  const form = new FormData();
  const stamp = Math.random().toString(36).slice(2, 9);
  const ext = file.type === 'image/webp' ? '.webp' : '.png';
  form.set('jarSkin', file, layer + '-' + stamp + ext);
  form.set('apply', 'false');
  const { fileUrl } = await requestStudioTemplate('/api/jar/upload-jar-skin', { method: 'POST', body: form });
  if (!fileUrl) throw new Error('Studio chưa trả về đường dẫn ảnh hũ.');
  adoptStudioJarLayer(layer, file, fileUrl);
  return fileUrl;
}

function canvasPng(source) {
  return new Promise((resolve, reject) => {
    source.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Không tạo được ảnh PNG.'));
    }, 'image/png');
  });
}

function makeJarArtworkCanvas() {
  const art = document.createElement('canvas');
  art.width = state.baseW;
  art.height = state.baseH;
  return art;
}

async function readJarLayer(url, name) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Không đọc được ảnh ' + name + ' của mẫu đang chỉnh.');
  const blob = await response.blob();
  const ext = blob.type === 'image/webp' ? 'webp' : 'png';
  return new File([blob], name + '.' + ext, { type: blob.type });
}

function getJarTemplateFront(template) {
  return template.frontImageUrl || template.stateData?.design?.frontOverlayImage || '';
}

async function saveStudioJarTemplate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  const nameField = document.getElementById('jarTemplateName');
  const name = nameField.value.trim();
  if (!name || button.disabled) return;
  if (studioJarImporting) {
    showToast('', 'Ảnh hũ đang được đọc. Hãy thử lại sau khi ảnh hiện trong bản xem trước.');
    return;
  }
  button.disabled = true;
  try {
    const design = getStudioJarConfig();
    const width = state.baseW;
    const height = state.baseH;
    const pendingRear = state.pendingImage;
    const pendingFront = state.pendingFrontImage;
    const pairedUpload = Boolean(design.frontOverlayImage) && await supportsJarLayerUploads();
    let [image, front] = await Promise.all([
      pendingRear ?? readJarLayer(design.customJarImage, 'mat-sau'),
      pairedUpload ? pendingFront ?? readJarLayer(design.frontOverlayImage, 'mat-truoc') : null
    ]);
    if (!image) {
      const art = makeJarArtworkCanvas();
      const geom = { cx: width / 2, cy: height / 2, imgX: 0, imgY: 0, w: width, h: height, isFishbowl: state.aspect === 'square' };
      const points = getCavityPoints(geom, design.hitbox);
      drawJarSilhouette(art.getContext('2d'), {
        ...geom, neckW: points[0].x - points.at(-1).x, neckH: height * .14, aspect: state.aspect
      }, 'mason', 1);
      image = new File([await canvasPng(art)], 'hu.png', { type: 'image/png' });
      design.hideDefaultJarOnCustom = true;
    }

    const payload = new FormData();
    payload.set('templateImage', image);
    if (front) payload.set('frontImage', front);
    payload.set('name', name);
    payload.set('aspect', design.jarAspect);
    payload.set('canvasWidth', width);
    payload.set('canvasHeight', height);
    payload.set('padding', JSON.stringify(design.jarPadding));
    const { customJarImage, frontOverlayImage, ...settings } = design;
    if (frontOverlayImage && !pairedUpload) {
      settings.frontOverlayImage = pendingFront ? await uploadStudioJarLayer('front', pendingFront) : frontOverlayImage;
    }
    payload.set('stateData', JSON.stringify({ design: settings }));
    await requestStudioTemplate('/api/jar/save-template', { method: 'POST', body: payload });
    if (nameField.value.trim() === name) nameField.value = '';
    showToast('', 'Đã lưu mẫu "' + name + '".');
    await refreshStudioJarTemplates();
  } catch (error) {
    showToast('', error.message);
  } finally {
    button.disabled = false;
  }
}

function openStudioJarTemplate(template, config) {
  const design = template.stateData?.design;
  loadStudioJarDesign(config ?? {
    ...(design || {}),
    customJarImage: template.imageUrl,
    frontOverlayImage: getJarTemplateFront(template),
    jarAspect: template.aspect,
    jarPadding: template.padding,
    stickers: design?.stickers ?? []
  }, template.name);
  document.getElementById('jarTemplateName').value = '';
}

async function refreshStudioJarTemplates() {
  const list = document.getElementById('jarTemplateList');
  const message = document.createElement('p');
  message.className = 'studio-empty';
  let templates;
  try {
    ({ templates } = await requestStudioTemplate('/api/jar/templates'));
  } catch (error) {
    message.textContent = error.message;
    list.replaceChildren(message);
    return;
  }
  if (!templates.length) {
    message.textContent = 'Chưa có mẫu. Lưu mẫu để mở lại các lớp ảnh và hitbox.';
    list.replaceChildren(message);
    return;
  }

  list.replaceChildren(...templates.map(template => {
    const row = document.createElement('article');
    row.className = 'jar-template-row';
    const preview = document.createElement('div');
    preview.className = 'jar-template-art';
    const front = getJarTemplateFront(template);
    for (const source of [template.previewUrl || template.imageUrl, front]) {
      if (!source) continue;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = source;
      preview.append(img);
    }
    const detail = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = template.name;
    const meta = document.createElement('small');
    meta.textContent = [
      studioJarAspects[template.aspect],
      front ? 'Hai lớp ảnh' : 'Một lớp ảnh',
      template.isActive ? 'Đang dùng trên OBS' : '',
      template.stateData?.design?.hitbox ? '' : 'Dùng hitbox đang áp dụng'
    ].filter(Boolean).join(' · ');
    const actions = document.createElement('div');
    actions.className = 'studio-panel-actions';
    for (const [label, action] of [
      ['Mở để chỉnh', () => openStudioJarTemplate(template)],
      ['Dùng trên OBS', async () => {
        const { config } = await requestStudioTemplate('/api/jar/apply-template/' + encodeURIComponent(template.id), { method: 'POST' });
        openStudioJarTemplate(template, config);
        showToast('', 'Đã áp dụng mẫu "' + template.name + '" lên OBS.');
      }],
      ['Xóa', async () => {
        const extra = template.isActive ? ' OBS sẽ chuyển về mẫu pha lê gốc.' : '';
        if (!confirm('Xóa mẫu "' + template.name + '" khỏi thư viện?' + extra)) return;
        const editingRear = state.baseImgUrl === template.imageUrl;
        const editingFront = front && state.frontOverlayUrl === front;
        const [rearCopy, frontCopy] = await Promise.all([
          editingRear ? readJarLayer(template.imageUrl, 'mat-sau') : null,
          editingFront ? readJarLayer(front, 'mat-truoc') : null
        ]);
        await requestStudioTemplate('/api/jar/template/' + encodeURIComponent(template.id), { method: 'DELETE' });
        if (rearCopy && state.baseImgUrl === template.imageUrl) {
          state.pendingImage = rearCopy;
          state.baseImgUrl = URL.createObjectURL(rearCopy);
        }
        if (frontCopy && state.frontOverlayUrl === front) {
          state.pendingFrontImage = frontCopy;
          state.frontOverlayUrl = URL.createObjectURL(frontCopy);
        }
        updateJarSample();
        showToast('', 'Đã xóa mẫu "' + template.name + '".');
      }]
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = label === 'Xóa' ? 'btn btn-danger btn-sm' : 'btn btn-sm';
      button.textContent = label;
      button.onclick = async () => {
        Array.from(actions.children).forEach(control => { control.disabled = true; });
        try {
          await action();
        } catch (error) {
          showToast('', error.message);
        } finally {
          Array.from(actions.children).forEach(control => { control.disabled = false; });
          if (label !== 'Mở để chỉnh') await refreshStudioJarTemplates();
        }
      };
      actions.append(button);
    }
    detail.append(title, meta, actions);
    row.append(preview, detail);
    return row;
  }));
}

function saveJarDownload(blob, name) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function getJarReferenceSize() {
  const source = state.baseImg;
  const ratio = state.baseW / state.baseH;
  if (source && Math.abs((source.naturalWidth / source.naturalHeight) / ratio - 1) <= .02) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: state.baseW * 2, height: state.baseH * 2 };
}

async function downloadJarReference(layer) {
  const front = layer === 'front';
  const art = makeJarArtworkCanvas();
  const size = getJarReferenceSize();
  art.width = size.width;
  art.height = size.height;
  const drawing = art.getContext('2d');
  const { w, h, isFishbowl } = getStudioJarGeometry();
  const geometry = { w, h, isFishbowl, cx: w / 2, cy: h / 2, imgX: 0, imgY: 0 };
  const points = getCavityPoints(geometry, state.hitbox);
  const right = points[0];
  const left = points.at(-1);
  const mouthHalf = (right.x - left.x) / 2;
  const mouthCenter = (right.x + left.x) / 2;
  const lipHeight = Math.min(h * .035, mouthHalf * .20);

  drawing.scale(art.width / w, art.height / h);
  drawing.fillStyle = '#101a2b';
  drawing.fillRect(0, 0, w, h);
  const source = front && state.frontOverlayImg ? state.frontOverlayImg : state.baseImg;
  if (source) {
    drawing.globalAlpha = front && !state.frontOverlayImg ? .14 : .46;
    drawing.drawImage(source, 0, 0, w, h);
    drawing.globalAlpha = 1;
  }

  drawing.beginPath();
  drawing.moveTo(right.x, right.y);
  points.slice(1).forEach(point => drawing.lineTo(point.x, point.y));
  drawing.strokeStyle = '#81e6ff';
  drawing.lineWidth = 1.5;
  if (front) drawing.setLineDash([4, 4]);
  drawing.stroke();

  drawing.beginPath();
  drawing.moveTo(left.x, left.y);
  drawing.lineTo(right.x, right.y);
  drawing.strokeStyle = '#e4edf9';
  drawing.setLineDash([4, 5]);
  drawing.stroke();
  drawing.setLineDash([]);

  drawing.beginPath();
  drawing.ellipse(mouthCenter, right.y, mouthHalf, lipHeight, 0, front ? 0 : Math.PI, front ? Math.PI : 2 * Math.PI);
  drawing.strokeStyle = front ? '#ff9b7a' : '#ffe092';
  drawing.lineWidth = front ? 6 : 3;
  drawing.lineCap = 'round';
  drawing.stroke();

  drawing.fillStyle = '#edf2fb';
  drawing.font = 'bold 13px system-ui';
  drawing.fillText(front ? 'MẶT TRƯỚC' : 'MẶT SAU', 12, 21);
  drawing.font = '11px system-ui';
  drawing.fillText(size.width + ' × ' + size.height + ' px', 12, 38);
  drawing.fillText(front ? 'Cam / mép miệng gần máy quay' : 'Vàng / mép miệng xa máy quay', 12, h - 26);
  drawing.fillText('Xanh / lòng hũ   ·   Trắng / trục miệng', 12, h - 10);

  try {
    const name = front ? 'mat-truoc' : 'mat-sau';
    saveJarDownload(await canvasPng(art), 'elden-tham-chieu-' + name + '-' + state.aspect + '.png');
  } catch (error) {
    showToast('', error.message);
  }
}

function downloadJarGuide() {
  const { width, height } = getJarReferenceSize();
  const size = width + ' × ' + height;
  const aspect = studioJarAspects[state.aspect];
  const guide = [
    '# Tạo hũ quà hai lớp cho Jar Studio',
    '',
    'Studio vẽ theo thứ tự **mặt sau → quà → mặt trước**. Viền gần máy quay của mặt trước che phần quà đang đi qua miệng hũ.',
    '',
    '## Tạo hai ảnh',
    '',
    '1. Trong **Mẫu hũ**, tải **PNG mẫu mặt sau** và **PNG mẫu mặt trước** của cùng một hitbox.',
    '2. Đính kèm cả hai PNG tham chiếu khi gửi lời nhắc dưới đây cho AI.',
    '3. Xuất hai PNG nền trong suốt cùng kích thước **' + size + ' px** (' + aspect + '). Giữ cùng gốc tọa độ, khoảng trống và tỷ lệ trong cả hai ảnh. Nếu cần đổi kích thước, đổi đồng thời cả hai canvas theo cùng một tỷ lệ.',
    '',
    '| Tệp | Nội dung |',
    '| --- | --- |',
    '| **mat-sau.png** | Thân và đáy phía sau, viền miệng xa máy quay theo cung vàng. |',
    '| **mat-truoc.png** | Viền miệng gần máy quay theo cung cam, viền thân trước và chi tiết trang trí che quà nếu có. Chừa trong suốt phần còn lại của miệng và lòng hũ. |',
    '',
    '## Lời nhắc gửi AI',
    '',
    '> Thiết kế một hũ quà nhìn chính diện với [điền màu, chất liệu và trang trí]. Dựa trên cùng một bản vẽ, tách hũ ra hai tệp PNG có alpha, cùng khung ' + size + ' px. File mat-sau.png chứa thân phía sau và nửa viền miệng xa theo cung vàng. File mat-truoc.png chứa nửa viền miệng gần theo cung cam và các chi tiết kính ở phía trước. Để dải viền trước đủ rõ để che quà đi qua, đồng thời để trống vùng miệng mở và lòng hũ. Canh hai đầu viền theo trục trắng và mép trong theo đường xanh. Giữ nguyên vị trí từng chi tiết khi tách lớp. Xuất hai tệp riêng với nền và vùng trống trong suốt. Bỏ chữ, ảnh nền, đường hướng dẫn và quà minh họa.',
    '',
    '## Nhập vào Jar Studio',
    '',
    '1. Mở mẫu có hitbox tương ứng rồi giữ tùy chọn **Giữ tỷ lệ và hitbox hiện có khi nhập ảnh**.',
    '2. Bấm **Nhập mặt sau** và chọn mat-sau.png.',
    '3. Bấm **Nhập mặt trước** và chọn mat-truoc.png. Tệp phải có cùng kích thước pixel với mặt sau.',
    '4. Bật **Hiện mặt trước khi xem thử** rồi bấm **Thả thử quà**. Kiểm tra quà đi qua sau viền trước và còn thấy qua lòng kính.',
    '5. Đặt tên và bấm **Lưu thành mẫu mới** để lưu cả hai lớp cùng hitbox. Chọn **Dùng trên OBS** để áp dụng mẫu.',
    '',
    'Để bổ sung mặt trước cho mẫu một lớp, mở mẫu đó và dùng ảnh hiện tại làm mặt sau. Tệp mặt trước phải giữ đúng kích thước và vị trí miệng của ảnh đang có.',
    ''
  ].join('\n');
  saveJarDownload(new Blob([guide], { type: 'text/markdown;charset=utf-8' }), 'elden-huong-dan-hu-hai-lop.md');
}
