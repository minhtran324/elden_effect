function getCavityPoints(geom, hitboxCfg = {}) {
  const shape = hitboxCfg.shape || (geom.isFishbowl ? 'sphere' : 'cylinder');
  const { cx, imgY, w, h } = geom;

  const defaultRx = shape === 'sphere' ? 0.315 : (shape === 'bottle' ? 0.28 : 0.32);
  const defaultRy = shape === 'sphere' ? 0.24 : (shape === 'bottle' ? 0.26 : 0.30);
  const defaultCy = shape === 'sphere' ? 0.58 : (shape === 'bottle' ? 0.62 : 0.56);
  const defaultMouthY = 0.12;
  const defaultNeckW = shape === 'bottle' ? 0.26 : 0.38;
  const defaultNeckH = shape === 'bottle' ? 0.26 : 0.20;

  const rx = w * (hitboxCfg.radiusX ?? defaultRx) * (hitboxCfg.scaleX ?? 1);
  const ry = h * (hitboxCfg.radiusY ?? defaultRy) * (hitboxCfg.scaleY ?? 1);
  const cavityCy = imgY + h * (hitboxCfg.centerY !== undefined ? hitboxCfg.centerY : defaultCy) + (hitboxCfg.offsetY || 0);
  const cavityCx = cx + (hitboxCfg.offsetX || 0);
  const mouthY = imgY + h * (hitboxCfg.mouthY !== undefined ? hitboxCfg.mouthY : defaultMouthY);
  const mouthHalfW = (w * (hitboxCfg.neckWidth !== undefined ? hitboxCfg.neckWidth : defaultNeckW)) / 2;
  const neckH = h * (hitboxCfg.neckHeight !== undefined ? hitboxCfg.neckHeight : defaultNeckH);
  const neckBottomY = mouthY + neckH;

  const points = [];

  if (shape === 'sphere') {
    // 🔮 BỂ CẦU TRÒN (Sphere / Fishbowl)
    points.push({ x: cavityCx + mouthHalfW, y: mouthY });
    const neckHalfW = mouthHalfW * 1.05;
    points.push({ x: cavityCx + neckHalfW, y: neckBottomY });

    const shoulderSteps = 8;
    for (let i = 1; i <= shoulderSteps; i++) {
      const f = i / shoulderSteps;
      const ease = f * f * (3 - 2 * f);
      const px = cavityCx + neckHalfW + (rx - neckHalfW) * Math.sin(f * Math.PI * 0.5);
      const py = neckBottomY + (cavityCy - neckBottomY) * ease;
      points.push({ x: px, y: py });
    }

    const arcSteps = 24;
    for (let i = 1; i <= arcSteps; i++) {
      const angle = (Math.PI * i) / arcSteps;
      const px = cavityCx + rx * Math.cos(angle);
      const py = cavityCy + ry * Math.sin(angle);
      points.push({ x: px, y: py });
    }

    for (let i = shoulderSteps - 1; i >= 0; i--) {
      const f = i / shoulderSteps;
      const ease = f * f * (3 - 2 * f);
      const px = cavityCx - (neckHalfW + (rx - neckHalfW) * Math.sin(f * Math.PI * 0.5));
      const py = neckBottomY + (cavityCy - neckBottomY) * ease;
      points.push({ x: px, y: py });
    }

    points.push({ x: cavityCx - mouthHalfW, y: mouthY });

  } else if (shape === 'bottle') {
    // 🏺 HŨ CỔ LỌ / BÌNH HOA (Bottle / Vase)
    points.push({ x: cavityCx + mouthHalfW, y: mouthY });
    points.push({ x: cavityCx + mouthHalfW, y: neckBottomY });

    const thetaJoin = -0.22 * Math.PI;
    const joinX = rx * Math.cos(thetaJoin);
    const joinY = ry * Math.sin(thetaJoin);

    const shoulderSteps = 10;
    for (let i = 1; i <= shoulderSteps; i++) {
      const f = i / shoulderSteps;
      const ease = f * f * (3 - 2 * f);
      const px = cavityCx + mouthHalfW + (joinX - mouthHalfW) * ease;
      const py = neckBottomY + (cavityCy + joinY - neckBottomY) * f;
      points.push({ x: px, y: py });
    }

    const arcSteps = 28;
    const thetaEnd = Math.PI - thetaJoin;
    for (let i = 1; i <= arcSteps; i++) {
      const angle = thetaJoin + ((thetaEnd - thetaJoin) * i) / arcSteps;
      const px = cavityCx + rx * Math.cos(angle);
      const py = cavityCy + ry * Math.sin(angle);
      points.push({ x: px, y: py });
    }

    for (let i = shoulderSteps; i >= 1; i--) {
      const f = (i - 1) / shoulderSteps;
      const ease = f * f * (3 - 2 * f);
      const px = cavityCx - (mouthHalfW + (joinX - mouthHalfW) * ease);
      const py = neckBottomY + (cavityCy + joinY - neckBottomY) * f;
      points.push({ x: px, y: py });
    }

    points.push({ x: cavityCx - mouthHalfW, y: mouthY });

  } else {
    // 🥛 HŨ TRỤ ĐỨNG / MASON JAR (Cylinder)
    const bottomY = cavityCy + ry;
    const cornerR = Math.min(rx * 0.35, 36);

    points.push({ x: cavityCx + mouthHalfW, y: mouthY });
    points.push({ x: cavityCx + mouthHalfW, y: neckBottomY });
    points.push({ x: cavityCx + rx, y: neckBottomY + h * 0.04 });
    points.push({ x: cavityCx + rx, y: bottomY - cornerR });

    for (let i = 1; i <= 6; i++) {
      const a = (Math.PI * 0.5) * (i / 6);
      points.push({
        x: cavityCx + rx - cornerR + cornerR * Math.cos(a),
        y: bottomY - cornerR + cornerR * Math.sin(a)
      });
    }

    for (let i = 1; i <= 6; i++) {
      const a = (Math.PI * 0.5) + (Math.PI * 0.5) * (i / 6);
      points.push({
        x: cavityCx - rx + cornerR + cornerR * Math.cos(a),
        y: bottomY - cornerR + cornerR * Math.sin(a)
      });
    }

    points.push({ x: cavityCx - rx, y: neckBottomY + h * 0.04 });
    points.push({ x: cavityCx - mouthHalfW, y: neckBottomY });
    points.push({ x: cavityCx - mouthHalfW, y: mouthY });
  }

  return points;
}

function makeCavityWalls(points, thickness, restitution) {
  const walls = [];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const overlap = Math.min(thickness * 0.7, length * 0.55);
    walls.push(Matter.Bodies.rectangle((start.x + end.x) / 2, (start.y + end.y) / 2, length + overlap, thickness, {
      isStatic: true,
      angle: Math.atan2(dy, dx),
      friction: 0.3,
      restitution,
      label: 'jar_wall'
    }));
  }
  return walls;
}

function isInsideCavity({ x, y }, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function drawJarSilhouette(ctx, geom, style, scale) {
  const { cx, cy, w, h, neckW, neckH, aspect } = geom;
  const halfW = w / 2;
  const halfH = h / 2;
  const halfNeckW = neckW / 2;
  const cornerR = (aspect === 'horizontal' ? 44 : 36) * scale;
  const baseThick = (aspect === 'horizontal' ? 26 : 32) * scale;

  const grad = ctx.createLinearGradient(cx - halfW, cy, cx + halfW, cy);
  if (style === 'diamond') {
    grad.addColorStop(0, 'rgba(168, 85, 247, 0.28)');
    grad.addColorStop(0.15, 'rgba(216, 180, 254, 0.08)');
    grad.addColorStop(0.85, 'rgba(216, 180, 254, 0.08)');
    grad.addColorStop(1, 'rgba(168, 85, 247, 0.32)');
  } else {
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.26)');
    grad.addColorStop(0.15, 'rgba(224, 242, 254, 0.06)');
    grad.addColorStop(0.85, 'rgba(224, 242, 254, 0.06)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.30)');
  }

  ctx.fillStyle = grad;

  // Đường viền bo tròn đáy hũ & uốn lượn vai hũ
  ctx.beginPath();
  ctx.moveTo(cx - halfW + cornerR, cy + halfH);
  ctx.lineTo(cx + halfW - cornerR, cy + halfH);
  ctx.quadraticCurveTo(cx + halfW, cy + halfH, cx + halfW, cy + halfH - cornerR);
  ctx.lineTo(cx + halfW, cy - halfH + neckH + 24);
  ctx.quadraticCurveTo(cx + halfW, cy - halfH + neckH, cx + halfNeckW, cy - halfH + neckH);
  ctx.lineTo(cx + halfNeckW, cy - halfH);
  ctx.lineTo(cx - halfNeckW, cy - halfH);
  ctx.lineTo(cx - halfNeckW, cy - halfH + neckH);
  ctx.quadraticCurveTo(cx - halfW, cy - halfH + neckH, cx - halfW, cy - halfH + neckH + 24);
  ctx.lineTo(cx - halfW, cy + halfH - cornerR);
  ctx.quadraticCurveTo(cx - halfW, cy + halfH, cx - halfW + cornerR, cy + halfH);
  ctx.closePath();
  ctx.fill();

  // Đáy kính đúc nguyên khối dày dặn
  ctx.fillStyle = 'rgba(14, 165, 233, 0.24)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + halfH - baseThick * 0.45, halfW - cornerR * 0.4, baseThick * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();

}
