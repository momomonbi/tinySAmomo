// Waterfall display — scrolling pseudocolor time/frequency map.

class Waterfall {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = window.devicePixelRatio || 1;

    // Offscreen canvas that holds the full waterfall image.
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d', { alpha: false });

    this.minDbm = -110;
    this.maxDbm = 0;
    this.unit = 'dBm';
    this.padL = 50;
    this.padR = 16;
    this.padT = 18;
    this.padB = 16;

    this._needsResize = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.floor(rect.width * this.dpr));
    const ch = Math.max(1, Math.floor(rect.height * this.dpr));

    // Preserve existing image when possible
    const prev = (this.off.width > 0 && this.off.height > 0)
      ? this._snapshotOff() : null;

    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Off canvas in CSS-pixel space for simpler math
    this.off.width = Math.max(1, Math.floor(rect.width));
    this.off.height = Math.max(1, Math.floor(rect.height));
    this.offCtx.fillStyle = '#050709';
    this.offCtx.fillRect(0, 0, this.off.width, this.off.height);

    if (prev) {
      // best-effort restore (stretches)
      this.offCtx.drawImage(prev, 0, 0, this.off.width, this.off.height);
    }
    this._needsResize = false;
  }

  _snapshotOff() {
    const s = document.createElement('canvas');
    s.width = this.off.width;
    s.height = this.off.height;
    s.getContext('2d').drawImage(this.off, 0, 0);
    return s;
  }

  setScale(minDbm, maxDbm) {
    this.minDbm = minDbm;
    this.maxDbm = maxDbm;
  }

  setUnit(unit) {
    if (window.UNIT_DEFS && window.UNIT_DEFS[unit]) this.unit = unit;
  }

  clear() {
    if (!this.off.width) return;
    this.offCtx.fillStyle = '#050709';
    this.offCtx.fillRect(0, 0, this.off.width, this.off.height);
    this.draw();
  }

  addLine(data) {
    if (this._needsResize) this.resize();
    if (!data.length) return;

    const w = this.off.width;
    const h = this.off.height;
    const plotL = this.padL;
    const plotR = w - this.padR;
    const plotT = this.padT;
    const plotB = h - this.padB;
    const plotW = plotR - plotL;
    const plotH = plotB - plotT;
    if (plotW < 2 || plotH < 2) return;

    // Scroll existing image down by 1 px (within plot area)
    const img = this.offCtx.getImageData(plotL, plotT, plotW, plotH - 1);
    this.offCtx.putImageData(img, plotL, plotT + 1);

    // Render new line at top of plot area
    const line = this.offCtx.createImageData(plotW, 1);
    const buf = line.data;
    const span = this.maxDbm - this.minDbm;

    for (let x = 0; x < plotW; x++) {
      const t = x / (plotW - 1);
      const idxF = t * (data.length - 1);
      const i0 = Math.floor(idxF);
      const i1 = Math.min(data.length - 1, i0 + 1);
      const a = idxF - i0;
      const dbm = data[i0].dbm * (1 - a) + data[i1].dbm * a;
      const nt = Math.max(0, Math.min(1, (dbm - this.minDbm) / span));
      const [r, g, b] = jet(nt);
      const p = x * 4;
      buf[p]   = r;
      buf[p+1] = g;
      buf[p+2] = b;
      buf[p+3] = 255;
    }
    this.offCtx.putImageData(line, plotL, plotT);

    this.draw();
  }

  draw() {
    if (this._needsResize) this.resize();
    const rect = this.canvas.getBoundingClientRect();
    const ctx = this.ctx;
    ctx.fillStyle = '#050709';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.drawImage(this.off, 0, 0, rect.width, rect.height);

    this._drawAxes(ctx, rect.width, rect.height);
    this._drawColorBar(ctx, rect.width, rect.height);
  }

  _drawAxes(ctx, w, h) {
    const x0 = this.padL;
    const x1 = w - this.padR;
    const y0 = this.padT;
    const y1 = h - this.padB;
    ctx.strokeStyle = '#2a3548';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

    ctx.fillStyle = '#5a6878';
    ctx.font = '10px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('t↓', x0 - 6, y0 + 10);
  }

  _drawColorBar(ctx, w, h) {
    // Tiny color bar near top-right corner
    const bw = 100, bh = 8;
    const x = w - this.padR - bw;
    const y = 4;
    const g = ctx.createLinearGradient(x, 0, x + bw, 0);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const [r, gg, b] = jet(t);
      g.addColorStop(t, `rgb(${r},${gg},${b})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = '#2a3548';
    ctx.strokeRect(x, y, bw, bh);
    ctx.fillStyle = '#7a8694';
    ctx.font = '9px Consolas, monospace';
    const u = (window.UNIT_DEFS && window.UNIT_DEFS[this.unit]) || { offset: 0, label: 'dBm' };
    ctx.textAlign = 'right';
    ctx.fillText((this.minDbm + u.offset).toFixed(0) + u.label, x, y + bh + 8);
    ctx.textAlign = 'left';
    ctx.fillText((this.maxDbm + u.offset).toFixed(0) + u.label, x + bw, y + bh + 8);
  }
}

// "Jet" colormap, t in [0,1] → [r,g,b]
function jet(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.125) {
    r = 0; g = 0; b = 0.5 + t * 4;
  } else if (t < 0.375) {
    r = 0; g = (t - 0.125) * 4; b = 1;
  } else if (t < 0.625) {
    r = (t - 0.375) * 4; g = 1; b = 1 - (t - 0.375) * 4;
  } else if (t < 0.875) {
    r = 1; g = 1 - (t - 0.625) * 4; b = 0;
  } else {
    r = 1 - (t - 0.875) * 4 * 0.5; g = 0; b = 0;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

window.Waterfall = Waterfall;
