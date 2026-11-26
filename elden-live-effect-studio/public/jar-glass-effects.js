const JarGlass = (() => {
  const impact = [0.17, 0.58];
  const fractures = [
    [
      [impact, [.24, .564], [.285, .598], [.37, .573], [.418, .592], [.51, .548], [.56, .558], [.635, .505]],
      [impact, [.193, .526], [.235, .484], [.217, .432], [.265, .369], [.29, .302]],
      [[.285, .598], [.313, .649], [.365, .674], [.388, .759], [.455, .815]],
      [[.235, .484], [.281, .466], [.313, .427]],
      [[.51, .548], [.546, .489], [.615, .451]]
    ],
    [
      [impact, [.137, .641], [.184, .694], [.158, .745], [.238, .787], [.278, .861], [.337, .917]],
      [[.418, .592], [.457, .647], [.534, .669], [.569, .728], [.682, .747], [.75, .809], [.833, .816]],
      [[.635, .505], [.702, .52], [.725, .47], [.802, .442], [.891, .476], [.965, .44]],
      [[.313, .649], [.261, .675], [.26, .728], [.238, .787]],
      [[.546, .489], [.517, .418], [.568, .369], [.581, .283], [.641, .242]],
      [[.569, .728], [.547, .788], [.602, .844], [.595, .911]]
    ],
    [
      [[.29, .302], [.358, .315], [.392, .26], [.445, .278], [.496, .22], [.553, .238], [.581, .283]],
      [[.37, .573], [.411, .517], [.4, .472], [.459, .438], [.517, .418]],
      [[.534, .669], [.604, .626], [.651, .658], [.711, .618], [.795, .656], [.846, .618], [.947, .65]],
      [[.682, .747], [.717, .712], [.714, .676], [.795, .656]],
      [[.802, .442], [.788, .373], [.839, .335], [.823, .279], [.882, .233]],
      [[.455, .815], [.507, .835], [.509, .891], [.573, .934], [.575, .981]],
      [[.184, .694], [.115, .724], [.095, .789]],
      [[.75, .809], [.709, .864], [.761, .913]]
    ]
  ];

  function surface(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    return canvas;
  }

  function trace(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
  }

  function capture(geometry, cavity, drawArtwork) {
    const { w, h, imgX, imgY } = geometry;
    const scale = Math.min(1.5, 640 / Math.max(w, h));
    const art = surface(w * scale, h * scale);
    const ink = art.getContext('2d');
    ink.setTransform(art.width / w, 0, 0, art.height / h, -imgX * art.width / w, -imgY * art.height / h);
    drawArtwork(ink);

    const mask = surface(art.width, art.height);
    const stencil = mask.getContext('2d');
    stencil.drawImage(art, 0, 0);
    // The transparent pane is enclosed by the same outline used by the jar's collision walls.
    if (cavity.length > 2) {
      trace(stencil, cavity.map(({ x, y }) => [(x - imgX) * art.width / w, (y - imgY) * art.height / h]));
      stencil.fillStyle = 'rgba(255,255,255,.76)';
      stencil.fill();
    }
    return { art, mask, cracks: surface(art.width, art.height) };
  }

  function paintCracks(texture, progress, pulse = 0) {
    const { cracks, mask } = texture;
    const { width, height } = cracks;
    const ctx = cracks.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    const edge = Math.max(.8, Math.min(width, height) * .0037);

    fractures.forEach((lines, level) => {
      const revealed = (progress[level] || 0) * 1.28;
      if (!revealed) return;
      lines.forEach((line, index) => {
        const extension = Math.max(0, revealed - index * .039) * (line.length - 1);
        for (let i = 1; i < line.length && i - 1 < extension; i++) {
          const [x1, y1] = line[i - 1];
          const [x2, y2] = line[i];
          const reach = Math.min(1, extension - i + 1);
          const weight = edge * (1 - .48 * (i - 1) / line.length) * (index > 2 ? .68 : 1);
          ctx.beginPath();
          ctx.moveTo(x1 * width, y1 * height);
          ctx.lineTo((x1 + (x2 - x1) * reach) * width, (y1 + (y2 - y1) * reach) * height);
          ctx.strokeStyle = 'rgba(14,30,48,.7)';
          ctx.lineWidth = weight * 1.85;
          ctx.stroke();
          ctx.strokeStyle = index > 2 ? 'rgba(196,232,250,.79)' : 'rgba(245,252,255,.96)';
          ctx.lineWidth = weight;
          ctx.stroke();
        }
      });
    });

    if (pulse > 0) {
      const [x, y] = [impact[0] * width, impact[1] * height];
      const radius = Math.max(3, Math.min(width, height) * .045);
      const glint = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glint.addColorStop(0, 'rgba(228,248,255,' + (.64 * pulse) + ')');
      glint.addColorStop(1, 'rgba(228,248,255,0)');
      ctx.fillStyle = glint;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  function cutShards(texture, reduced) {
    const { art, cracks } = texture;
    const source = surface(art.width, art.height);
    const sourceCtx = source.getContext('2d');
    sourceCtx.drawImage(art, 0, 0);
    // Clear sections of the pane show fracture highlights without filling its transparency.
    sourceCtx.drawImage(cracks, 0, 0);
    const { width, height } = source;
    const cuts = reduced ? 3 : 5;
    const grid = Array.from({ length: cuts + 1 }, (_, row) => Array.from({ length: cuts + 1 }, (_, col) => [
      (col + (col && col !== cuts ? (Math.random() - .5) * .64 : 0)) * width / cuts,
      (row + (row && row !== cuts ? (Math.random() - .5) * .64 : 0)) * height / cuts
    ]));
    const pieces = [];
    for (let row = 0; row < cuts; row++) {
      for (let col = 0; col < cuts; col++) {
        const a = grid[row][col];
        const b = grid[row][col + 1];
        const c = grid[row + 1][col + 1];
        const d = grid[row + 1][col];
        const triangles = (row + col) % 2 ? [[a, b, d], [b, c, d]] : [[a, b, c], [a, c, d]];
        for (const triangle of triangles) {
          const x = Math.floor(Math.min(...triangle.map(point => point[0])));
          const y = Math.floor(Math.min(...triangle.map(point => point[1])));
          const w = Math.ceil(Math.max(...triangle.map(point => point[0]))) - x;
          const h = Math.ceil(Math.max(...triangle.map(point => point[1]))) - y;
          const image = surface(w, h);
          const ctx = image.getContext('2d');
          trace(ctx, triangle.map(([px, py]) => [px - x, py - y]));
          ctx.clip();
          ctx.drawImage(source, -x, -y);
          const pixels = ctx.getImageData(0, 0, w, h).data;
          let visible = false;
          for (let i = 3; i < pixels.length; i += 16) {
            if (pixels[i] > 46) { visible = true; break; }
          }
          if (visible) pieces.push({ image, u: (x + w / 2) / width, v: (y + h / 2) / height, w: w / width, h: h / height });
        }
      }
    }
    return pieces;
  }

  return { capture, paintCracks, cutShards };
})();
