// スペクトラム表示 — Canvas2D リアルタイム描画 (グリッド、トレース、マーカー)

const UNIT_DEFS = {
  dBm:    { label: 'dBm',  offset: 0 },
  dBuV50: { label: 'dBμV', offset: 107 },     // 50Ω, V = sqrt(P*R)
  dBuV75: { label: 'dBμV', offset: 108.75 },  // 75Ω, テレビ向け推奨
  dBmV75: { label: 'dBmV', offset: 48.75 },   // 75Ω CATV系
};

class Spectrum {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = window.devicePixelRatio || 1;

    this.data = [];          // [{freq, dbm}]
    this.peakHold = null;    // dbm[] aligned with data
    this.peakHoldEnabled = false;
    this.avgEnabled = false;
    this.avgCount = 4;
    this.avgBuf = [];        // recent traces for averaging

    this.startFreq = 100000;
    this.stopFreq = 350000000;

    // 内部スケールは常に dBm で保持。表示時に単位変換する。
    this.minDbm = -110;
    this.maxDbm = 0;
    this.unit = 'dBm';

    this.markers = [];       // [{id, freq, color, label?}]
    this.markerColors = ['#ef4444', '#fbbf24', '#a78bfa', '#34d399', '#f472b6', '#60a5fa'];
    this.nextMarkerId = 1;
    this.stations = [];      // 表示する放送局帯域 (テレビプリセット用)
    this.referenceTrace = null;  // 読み込んだ参照トレース [{freq, dbm}]
    this.referenceLabel = '';    // 参照トレース由来情報 (ファイル名等)

    // スイープ間アニメーション
    this.animEnabled = true;
    this.animDuration = 300;       // ms (実測スイープ間隔に応じて動的更新)
    this._prevData = null;
    this._targetData = null;
    this._animStart = 0;
    this._rafId = null;
    this._lastSetTime = 0;

    this.padL = 50;
    this.padR = 16;
    this.padT = 18;
    this.padB = 26;

    this._needsResize = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._needsResize = false;
  }

  setRange(startFreq, stopFreq) {
    this.startFreq = startFreq;
    this.stopFreq = stopFreq;
  }

  setScale(minDbm, maxDbm) {
    this.minDbm = minDbm;
    this.maxDbm = maxDbm;
  }

  setUnit(unit) {
    if (!UNIT_DEFS[unit]) return;
    this.unit = unit;
  }

  get unitLabel() { return UNIT_DEFS[this.unit].label; }
  get unitOffset() { return UNIT_DEFS[this.unit].offset; }

  // dBm を現在の表示単位に変換
  toDisplay(dbm) { return dbm + this.unitOffset; }
  // 表示単位値を dBm に逆変換
  fromDisplay(v) { return v - this.unitOffset; }

  setStations(stations) {
    this.stations = stations || [];
  }
  clearStations() { this.stations = []; }

  setReferenceTrace(data, label) {
    this.referenceTrace = (data && data.length) ? data : null;
    this.referenceLabel = label || '';
  }
  clearReferenceTrace() {
    this.referenceTrace = null;
    this.referenceLabel = '';
  }

  setData(data) {
    // ピークホールド/平均化は最新の target データから計算 (アニメ前データ)
    if (this.peakHoldEnabled) {
      if (!this.peakHold || this.peakHold.length !== data.length) {
        this.peakHold = data.map(p => p.dbm);
      } else {
        for (let i = 0; i < data.length; i++) {
          if (data[i].dbm > this.peakHold[i]) this.peakHold[i] = data[i].dbm;
        }
      }
    } else {
      this.peakHold = null;
    }

    if (this.avgEnabled) {
      this.avgBuf.push(data.map(p => p.dbm));
      while (this.avgBuf.length > this.avgCount) this.avgBuf.shift();
    } else {
      this.avgBuf = [];
    }

    // アニメーション処理
    const now = performance.now();
    if (this._lastSetTime > 0) {
      // 直前スイープからの実経過時間に合わせ、95% を補間時間に
      const dt = now - this._lastSetTime;
      this.animDuration = Math.max(80, Math.min(900, dt * 0.95));
    }
    this._lastSetTime = now;

    if (this.animEnabled && this._canAnimate(data)) {
      // 現在表示中の値を起点に、新データへ補間
      this._prevData = this.data.map(p => ({ freq: p.freq, dbm: p.dbm }));
      this._targetData = data;
      this._animStart = now;
      if (this._rafId === null) {
        this._rafId = requestAnimationFrame(() => this._animTick());
      }
    } else {
      // 即時更新 (初回 / 範囲変更 / 点数変更時)
      this.data = data;
      this._cancelAnim();
    }
  }

  _canAnimate(newData) {
    if (!this.data || this.data.length === 0) return false;
    if (newData.length !== this.data.length) return false;
    // 周波数範囲が同一であること
    const eps = 1; // Hz
    if (Math.abs(newData[0].freq - this.data[0].freq) > eps) return false;
    if (Math.abs(newData[newData.length - 1].freq - this.data[this.data.length - 1].freq) > eps) return false;
    return true;
  }

  _animTick() {
    this._rafId = null;
    if (!this._targetData) return;
    const now = performance.now();
    const t = Math.min(1, (now - this._animStart) / this.animDuration);
    if (t >= 1) {
      this.data = this._targetData;
      this._targetData = null;
      this._prevData = null;
      this.draw();
      return;
    }
    // ease-out cubic
    const k = 1 - Math.pow(1 - t, 3);
    const interp = new Array(this._targetData.length);
    for (let i = 0; i < this._targetData.length; i++) {
      const p = this._prevData[i];
      const q = this._targetData[i];
      interp[i] = { freq: q.freq, dbm: p.dbm + (q.dbm - p.dbm) * k };
    }
    this.data = interp;
    this.draw();
    this._rafId = requestAnimationFrame(() => this._animTick());
  }

  _cancelAnim() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._prevData = null;
    this._targetData = null;
  }

  setAnimEnabled(enabled) {
    this.animEnabled = !!enabled;
    if (!enabled) this._cancelAnim();
  }

  clearPeakHold() { this.peakHold = null; }
  clearAvg() { this.avgBuf = []; }

  addMarker(freq, label, color, desc) {
    const id = this.nextMarkerId++;
    const c = color || this.markerColors[(id - 1) % this.markerColors.length];
    this.markers.push({ id, freq, color: c, label: label || null, desc: desc || '' });
    return id;
  }
  removeMarker(id) {
    this.markers = this.markers.filter(m => m.id !== id);
  }
  clearMarkers() {
    this.markers = [];
    this.nextMarkerId = 1;
  }
  addPeakMarker() {
    if (!this.data.length) return null;
    let maxIdx = 0;
    for (let i = 1; i < this.data.length; i++) {
      if (this.data[i].dbm > this.data[maxIdx].dbm) maxIdx = i;
    }
    return this.addMarker(this.data[maxIdx].freq);
  }

  freqToX(freq, w) {
    const t = (freq - this.startFreq) / (this.stopFreq - this.startFreq);
    return this.padL + t * (w - this.padL - this.padR);
  }
  dbmToY(dbm, h) {
    const t = (dbm - this.minDbm) / (this.maxDbm - this.minDbm);
    return h - this.padB - t * (h - this.padT - this.padB);
  }
  xToFreq(x, w) {
    const t = (x - this.padL) / (w - this.padL - this.padR);
    return this.startFreq + t * (this.stopFreq - this.startFreq);
  }

  // Return interpolated dBm at given freq from current data.
  valueAt(freq) {
    const d = this.data;
    if (!d.length) return null;
    if (freq <= d[0].freq) return d[0].dbm;
    if (freq >= d[d.length - 1].freq) return d[d.length - 1].dbm;
    let lo = 0, hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid].freq <= freq) lo = mid; else hi = mid;
    }
    const t = (freq - d[lo].freq) / (d[hi].freq - d[lo].freq);
    return d[lo].dbm + t * (d[hi].dbm - d[lo].dbm);
  }

  // 平均トレースを指定周波数で補間取得 (移動平均無効時 / バッファ空時は null)
  avgValueAt(freq) {
    const avg = this._avgTrace();
    const d = this.data;
    if (!avg || !d.length || avg.length !== d.length) return null;
    if (freq <= d[0].freq) return avg[0];
    if (freq >= d[d.length - 1].freq) return avg[avg.length - 1];
    let lo = 0, hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid].freq <= freq) lo = mid; else hi = mid;
    }
    const t = (freq - d[lo].freq) / (d[hi].freq - d[lo].freq);
    return avg[lo] + t * (avg[hi] - avg[lo]);
  }

  // 現在のライブトレース (アニメーション反映後の this.data)
  _liveTrace() {
    return this.data.map(p => p.dbm);
  }

  // 平均トレース (有効時のみ。avgBuf は target データから蓄積)
  _avgTrace() {
    if (!this.avgEnabled || !this.avgBuf.length) return null;
    const n = this.avgBuf.length;
    const len = this.avgBuf[0].length;
    if (len !== this.data.length) return null;  // サイズ不一致時はスキップ
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += this.avgBuf[j][i] || 0;
      out[i] = s / n;
    }
    return out;
  }

  draw() {
    if (this._needsResize) this.resize();

    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Background
    ctx.fillStyle = '#050709';
    ctx.fillRect(0, 0, w, h);

    this._drawGrid(ctx, w, h);
    this._drawStations(ctx, w, h);

    if (!this.data.length) {
      ctx.fillStyle = '#556';
      ctx.font = '12px "Yu Gothic UI", "Meiryo", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('データなし — 接続して掃引開始ボタンを押してください', w / 2, h / 2);
      return;
    }

    // 参照トレース (青緑、破線で背面に描画)
    if (this.referenceTrace && this.referenceTrace.length) {
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      for (let i = 0; i < this.referenceTrace.length; i++) {
        const p = this.referenceTrace[i];
        const x = this.freqToX(p.freq, w);
        const y = this.dbmToY(p.dbm, h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 凡例ラベル
      ctx.font = '10px "Yu Gothic UI", "Meiryo", Consolas, monospace';
      ctx.textAlign = 'left';
      const lbl = '参照: ' + (this.referenceLabel || 'CSV');
      ctx.fillStyle = '#22d3ee';
      ctx.fillText(lbl, this.padL + 6, this.padT + 12);
    }

    // Peak hold (yellow, behind main trace)
    if (this.peakHold) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (let i = 0; i < this.data.length; i++) {
        const x = this.freqToX(this.data[i].freq, w);
        const y = this.dbmToY(this.peakHold[i], h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 平均トレース (アンバー、ライブの背面、有効時のみ)
    const avgTrace = this._avgTrace();
    if (avgTrace) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let i = 0; i < avgTrace.length; i++) {
        const x = this.freqToX(this.data[i].freq, w);
        const y = this.dbmToY(avgTrace[i], h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ライブトレース (緑、最前面、塗りつぶしなし)
    const liveTrace = this._liveTrace();
    ctx.beginPath();
    for (let i = 0; i < this.data.length; i++) {
      const x = this.freqToX(this.data[i].freq, w);
      const y = this.dbmToY(liveTrace[i], h);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 凡例 (多重トレース時のみ右上端に表示)
    this._drawLegend(ctx, w, h, !!avgTrace, !!this.peakHold);

    this._drawMarkers(ctx, w, h);
  }

  _drawGrid(ctx, w, h) {
    const x0 = this.padL;
    const x1 = w - this.padR;
    const y0 = this.padT;
    const y1 = h - this.padB;

    ctx.strokeStyle = '#1a2230';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8090a0';
    ctx.font = 'bold 11px "Yu Gothic UI", Consolas, monospace';

    // 振幅軸: 水平グリッド線 (10 単位刻み)
    // 単位変換のためラベルは表示単位に。dBm 値で計算しラベルだけ変換。
    const off = this.unitOffset;
    const dbStep = 10;
    const dbStart = Math.ceil(this.minDbm / dbStep) * dbStep;
    for (let db = dbStart; db <= this.maxDbm; db += dbStep) {
      const y = this.dbmToY(db, h);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText((db + off).toFixed(0), x0 - 4, y + 3);
    }

    // Frequency vertical lines (10 divs)
    const ndiv = 10;
    for (let i = 0; i <= ndiv; i++) {
      const t = i / ndiv;
      const freq = this.startFreq + t * (this.stopFreq - this.startFreq);
      const x = x0 + t * (x1 - x0);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      if (i === 0 || i === ndiv || i % 2 === 0) {
        if (i === 0) ctx.textAlign = 'left';
        else if (i === ndiv) ctx.textAlign = 'right';
        else ctx.textAlign = 'center';
        ctx.fillText(this._formatFreq(freq), x, y1 + 14);
      }
    }

    // Border
    ctx.strokeStyle = '#2a3548';
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

    // 軸ラベル
    ctx.textAlign = 'left';
    ctx.fillStyle = '#5a6878';
    ctx.fillText(this.unitLabel, 6, y0 + 10);
    ctx.textAlign = 'right';
    ctx.fillText('Hz', x1, y1 + 14);
  }

  // テレビ局帯域 (中心±3MHz) を背景に色付き矩形+ラベルで描画
  _drawStations(ctx, w, h) {
    if (!this.stations || !this.stations.length) return;
    const y0 = this.padT;
    const y1 = h - this.padB;

    // 帯域とライン (背景レイヤー)
    for (const s of this.stations) {
      const xs = this.freqToX(s.start, w);
      const xe = this.freqToX(s.stop, w);
      if (xe < this.padL || xs > w - this.padR) continue;
      const cx = this.freqToX(s.center, w);
      // 帯域ハッチ
      ctx.fillStyle = (s.color || '#7dd3fc') + '22';
      ctx.fillRect(Math.max(xs, this.padL), y0,
                   Math.min(xe, w - this.padR) - Math.max(xs, this.padL),
                   y1 - y0);
      // 帯域端の縦線
      ctx.strokeStyle = (s.color || '#7dd3fc') + '66';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(xs, y0); ctx.lineTo(xs, y1);
      ctx.moveTo(xe, y0); ctx.lineTo(xe, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      // 中心線
      ctx.strokeStyle = (s.color || '#7dd3fc');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, y0); ctx.lineTo(cx, y1);
      ctx.stroke();
    }

    // ラベル (前景レイヤー、X座標でソート + 重なり回避で Y を段差化)
    const visibleStations = this.stations
      .map(s => ({ s, cx: this.freqToX(s.center, w) }))
      .filter(o => o.cx >= this.padL - 50 && o.cx <= w - this.padR + 50)
      .sort((a, b) => a.cx - b.cx);

    // 重なり回避: 直前のラベル右端を覚え、必要なら段差をつける
    const fontCh = 'bold 14px "Yu Gothic UI", "Meiryo", Consolas, monospace';
    const fontName = 'bold 12px "Yu Gothic UI", "Meiryo", Consolas, monospace';
    const rowHeight = 32;  // 1段 32px
    const rowsRight = [];  // 各段の最終ラベル右端 X

    for (const { s, cx } of visibleStations) {
      const label = s.short || s.name;
      const hasCh = s.ch != null;
      ctx.font = fontName;
      const nameW = ctx.measureText(label).width;
      ctx.font = fontCh;
      const chW = hasCh ? ctx.measureText(`${s.ch}ch`).width : 0;
      const lblWidth = Math.max(nameW, chW) + 10;
      const boxHeight = hasCh ? 28 : 16;
      const lx0 = cx - lblWidth / 2;
      const lx1 = cx + lblWidth / 2;
      // どの段が空いているか
      let row = 0;
      while (row < rowsRight.length && rowsRight[row] > lx0) row++;
      if (row === rowsRight.length) rowsRight.push(0);
      rowsRight[row] = lx1 + 4;
      const yBase = y0 + 4 + row * rowHeight;

      // 半透明黒背景
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(lx0, yBase, lblWidth, boxHeight);
      ctx.strokeStyle = (s.color || '#7dd3fc');
      ctx.lineWidth = 1;
      ctx.strokeRect(lx0 + 0.5, yBase + 0.5, lblWidth - 1, boxHeight - 1);

      ctx.fillStyle = s.color || '#7dd3fc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (hasCh) {
        // ch番号 (太字、大きめ) + 短縮局名
        ctx.font = fontCh;
        ctx.fillText(`${s.ch}ch`, cx, yBase + 1);
        ctx.font = fontName;
        ctx.fillText(label, cx, yBase + 15);
      } else {
        // 短縮局名のみ (バンド表示用)
        ctx.font = fontName;
        ctx.fillText(label, cx, yBase + 2);
      }
      ctx.textBaseline = 'alphabetic';  // reset
    }
  }

  _formatFreq(hz) {
    if (hz >= 1e9) return (hz / 1e9).toFixed(3) + 'G';
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + 'M';
    if (hz >= 1e3) return (hz / 1e3).toFixed(1) + 'k';
    return hz.toFixed(0);
  }

  _drawLegend(ctx, w, h, hasAvg, hasPeak) {
    if (!hasAvg && !hasPeak) return;
    const items = [{ color: '#4ade80', label: '現在' }];
    if (hasAvg) items.push({ color: '#f59e0b', label: `平均 ×${this.avgBuf.length}` });
    if (hasPeak) items.push({ color: '#facc15', label: '最大値保持' });

    ctx.font = 'bold 11px "Yu Gothic UI", "Meiryo", Consolas, monospace';
    const padX = 8;
    const lineH = 16;
    // 各ラベル幅を計測して最大幅を求める
    let maxW = 0;
    for (const it of items) {
      const tw = ctx.measureText(it.label).width;
      if (tw > maxW) maxW = tw;
    }
    const boxW = maxW + 26;
    const boxH = items.length * lineH + 6;
    const x0 = w - this.padR - boxW - 4;
    const y0 = h - this.padB - boxH - 4;

    // 背景
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x0, y0, boxW, boxH);
    ctx.strokeStyle = '#2a3548';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, boxW - 1, boxH - 1);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    items.forEach((it, i) => {
      const cy = y0 + 3 + i * lineH + lineH / 2;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0 + padX, cy);
      ctx.lineTo(x0 + padX + 14, cy);
      ctx.stroke();
      ctx.fillStyle = '#e0e7ef';
      ctx.fillText(it.label, x0 + padX + 18, cy);
    });
    ctx.textBaseline = 'alphabetic';
  }

  _drawMarkers(ctx, w, h) {
    // 縦線と頂点ドットを先に描く (奥側)
    const drawnMarkers = [];
    for (const m of this.markers) {
      const x = this.freqToX(m.freq, w);
      if (x < this.padL || x > w - this.padR) continue;
      const dbm = this.valueAt(m.freq);
      if (dbm === null) continue;
      const y = this.dbmToY(dbm, h);

      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(x, this.padT);
      ctx.lineTo(x, h - this.padB);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      drawnMarkers.push({ m, x, y, dbm });
    }

    // マーカーラベル (コンパクト、X座標でソート + 縦スタッガー)
    const fontMk = 'bold 12px "Yu Gothic UI", "Meiryo", Consolas, monospace';
    ctx.font = fontMk;
    ctx.textBaseline = 'middle';
    drawnMarkers.sort((a, b) => a.x - b.x);
    const rowsRight = [];  // Y段ごとの右端 X
    const labelHeight = 18;
    const labelGap = 2;
    // マーカーは画面下半分(値が高い)側からスタッガー
    const baseY = h - this.padB - 10;

    for (const item of drawnMarkers) {
      const { m, x, dbm } = item;
      const disp = (dbm + this.unitOffset).toFixed(1);
      const label = m.label
        ? `M${m.id} ${disp}${this.unitLabel}`   // 局情報は帯ラベルが既に表示
        : `M${m.id} ${this._formatFreq(m.freq)}Hz  ${disp}${this.unitLabel}`;
      const tw = ctx.measureText(label).width + 10;
      const lx0 = Math.max(this.padL + 2, Math.min(w - this.padR - tw - 2, x - tw / 2));
      // 段選択
      let row = 0;
      while (row < rowsRight.length && rowsRight[row] > lx0) row++;
      if (row === rowsRight.length) rowsRight.push(0);
      rowsRight[row] = lx0 + tw + 4;
      const ly = baseY - row * (labelHeight + labelGap);

      // ドットからラベルへの引き出し線
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, item.y);
      ctx.lineTo(lx0 + tw / 2, ly);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 背景 + 枠 + 文字
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      ctx.fillRect(lx0, ly - labelHeight / 2, tw, labelHeight);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(lx0 + 0.5, ly - labelHeight / 2 + 0.5, tw - 1, labelHeight - 1);
      ctx.fillStyle = m.color;
      ctx.textAlign = 'left';
      ctx.fillText(label, lx0 + 5, ly);
    }
    ctx.textBaseline = 'alphabetic';
  }
}

window.Spectrum = Spectrum;
window.UNIT_DEFS = UNIT_DEFS;
