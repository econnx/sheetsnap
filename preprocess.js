// Image cleanup before OCR: grayscale, upscale small images, erase table grid lines.
// Pure functions on {data: RGBA Uint8ClampedArray, width, height}, so they run in the browser and in Node.
(function (root) {
  function toGray({ data, width, height }) {
    const g = new Uint8ClampedArray(width * height);
    for (let i = 0; i < g.length; i++) {
      g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    // light text on a dark background -> invert, OCR prefers dark on light
    let sum = 0;
    for (let i = 0; i < g.length; i++) sum += g[i];
    if (sum / g.length < 110) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
    return { gray: g, width, height };
  }

  function upscale({ gray, width, height }, k) {
    if (k <= 1) return { gray, width, height };
    const W = Math.round(width * k), H = Math.round(height * k);
    const out = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(height - 1, y / k), y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < W; x++) {
        const sx = Math.min(width - 1, x / k), x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
        const a = gray[y0 * width + x0], b = gray[y0 * width + x1], c = gray[y1 * width + x0], d = gray[y1 * width + x1];
        out[y * W + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
    return { gray: out, width: W, height: H };
  }

  // Long straight runs of dark pixels are grid lines, not letters.
  function removeLines({ gray, width, height }) {
    const dark = (v) => v < 170;
    const minH = Math.max(120, width * 0.25);
    const minV = Math.max(90, height * 0.3);
    const erase = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      let start = -1;
      for (let x = 0; x <= width; x++) {
        const d = x < width && dark(gray[y * width + x]);
        if (d && start < 0) start = x;
        if (!d && start >= 0) {
          if (x - start >= minH) for (let i = start; i < x; i++) erase[y * width + i] = 1;
          start = -1;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      let start = -1;
      for (let y = 0; y <= height; y++) {
        const d = y < height && dark(gray[y * width + x]);
        if (d && start < 0) start = y;
        if (!d && start >= 0) {
          if (y - start >= minV) for (let i = start; i < y; i++) erase[i * width + x] = 1;
          start = -1;
        }
      }
    }
    const out = new Uint8ClampedArray(gray);
    for (let i = 0; i < out.length; i++) if (erase[i]) out[i] = 255;
    return { gray: out, width, height };
  }

  function prepare(img) {
    let g = toGray(img);
    const k = img.width < 1200 ? Math.min(2, 1600 / img.width) : 1;
    g = upscale(g, k);
    g = removeLines(g);
    const rgba = new Uint8ClampedArray(g.width * g.height * 4);
    for (let i = 0; i < g.gray.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g.gray[i];
      rgba[i * 4 + 3] = 255;
    }
    return { data: rgba, width: g.width, height: g.height, scale: k };
  }

  const api = { prepare };
  if (typeof module !== "undefined") module.exports = api;
  else root.SheetPrep = api;
})(this);
