// tinySAmomo — main application glue
// Wires up UI, drives the scan loop, manages markers, logging, export.

(() => {
  const $ = (id) => document.getElementById(id);

  const tinysa = new TinySA();
  let spectrum, waterfall;
  let running = false;
  let sweepCount = 0;
  let rateWindow = []; // timestamps of recent sweeps
  let logBuffer = [];  // continuous log rows
  let scanLoopActive = false;

  const ui = {
    connDot: $('connDot'),
    connText: $('connText'),
    devInfo: $('devInfo'),
    sweepRate: $('sweepRate'),
    sweepCount: $('sweepCount'),

    btnConnect: $('btnConnect'),
    btnDisconnect: $('btnDisconnect'),
    btnRecover: $('btnRecover'),
    btnLowRange: $('btnLowRange'),
    btnHighRange: $('btnHighRange'),
    sendModeCmd: $('sendModeCmd'),

    btnTvAomori: $('btnTvAomori'),
    btnTvMit: $('btnTvMit'),
    btnTvMctv: $('btnTvMctv'),
    btnTvAll: $('btnTvAll'),
    btnTvEmi: $('btnTvEmi'),
    tvInfo: $('tvInfo'),

    unit: $('unit'),

    startFreq: $('startFreq'),
    stopFreq: $('stopFreq'),
    points: $('points'),
    rbw: $('rbw'),
    btnBenchmark: $('btnBenchmark'),
    benchResult: $('benchResult'),

    btnStart: $('btnStart'),
    btnStop: $('btnStop'),
    maxHold: $('maxHold'),
    avgEnable: $('avgEnable'),
    avgCount: $('avgCount'),

    maxDbm: $('maxDbm'),
    minDbm: $('minDbm'),
    calOffset: $('calOffset'),
    extGain: $('extGain'),
    btnAutoScale: $('btnAutoScale'),
    btnClearWF: $('btnClearWF'),
    wfEnable: $('wfEnable'),

    btnPeakMarker: $('btnPeakMarker'),
    btnClearMarkers: $('btnClearMarkers'),
    markerList: $('markerList'),
    markerDesc: $('markerDesc'),
    bandsDesc: $('bandsDesc'),
    bandsDescBody: $('bandsDescBody'),

    btnExportCSV: $('btnExportCSV'),
    btnExportPNG: $('btnExportPNG'),
    logEnable: $('logEnable'),
    btnExportLog: $('btnExportLog'),
    logInfo: $('logInfo'),
    btnLoadCSV: $('btnLoadCSV'),
    fileCSV: $('fileCSV'),
    btnClearRef: $('btnClearRef'),
    refInfo: $('refInfo'),
  };

  // 表示設定の永続化
  const DISPLAY_SETTINGS_KEY = 'tinySA_displaySettings';

  function saveDisplaySettings() {
    try {
      const s = {
        unit: ui.unit.value,
        maxDbm: ui.maxDbm.value,
        minDbm: ui.minDbm.value,
        calOffset: ui.calOffset.value,
        extGain: ui.extGain.value,
        wfEnable: ui.wfEnable.checked,
        points: ui.points.value,
        maxHold: ui.maxHold.checked,
      };
      localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  }

  function restoreDisplaySettings() {
    try {
      const s = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || 'null');
      if (!s) return false;
      if (s.unit && window.UNIT_DEFS[s.unit]) ui.unit.value = s.unit;
      if (s.maxDbm != null && s.maxDbm !== '') ui.maxDbm.value = s.maxDbm;
      if (s.minDbm != null && s.minDbm !== '') ui.minDbm.value = s.minDbm;
      if (s.calOffset != null && s.calOffset !== '') ui.calOffset.value = s.calOffset;
      if (s.extGain != null && s.extGain !== '') ui.extGain.value = s.extGain;
      if (typeof s.wfEnable === 'boolean') ui.wfEnable.checked = s.wfEnable;
      if (s.points != null && s.points !== '') {
        const optExists = Array.from(ui.points.options).some(o => o.value === String(s.points));
        if (optExists) ui.points.value = String(s.points);
      }
      if (typeof s.maxHold === 'boolean') ui.maxHold.checked = s.maxHold;
      console.log('[init] 表示設定を localStorage から復元');
      return true;
    } catch {
      return false;
    }
  }

  // 保存済み設定に points が存在するか判定
  function hasSavedPoints() {
    try {
      const s = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || 'null');
      return !!(s && s.points != null && s.points !== '');
    } catch {
      return false;
    }
  }

  function init() {
    spectrum = new Spectrum($('spectrumCanvas'));
    waterfall = new Waterfall($('waterfallCanvas'));
    // 先に localStorage から表示設定を復元 (UIに反映)
    restoreDisplaySettings();
    // 復元した maxHold チェック状態を spectrum 内部状態にも反映
    // (onchange は programmatic な checked 書き換えでは発火しないため明示的に同期)
    spectrum.peakHoldEnabled = ui.maxHold.checked;
    // 単位とラベルを設定
    spectrum.setUnit(ui.unit.value);
    waterfall.setUnit(ui.unit.value);
    document.querySelectorAll('.unit-lbl').forEach(el => {
      el.textContent = window.UNIT_DEFS[ui.unit.value].label;
    });
    applyScale();
    applyRange();

    ui.btnConnect.onclick = onConnect;
    ui.btnDisconnect.onclick = onDisconnect;
    ui.btnRecover.onclick = onRecover;
    ui.btnLowRange.onclick = () => applyPreset('low');
    ui.btnHighRange.onclick = () => applyPreset('high');

    ui.btnStart.onclick = onStart;
    ui.btnStop.onclick = onStop;
    ui.maxHold.onchange = () => {
      spectrum.peakHoldEnabled = ui.maxHold.checked;
      if (!ui.maxHold.checked) spectrum.clearPeakHold();
      saveDisplaySettings();
    };
    ui.points.addEventListener('change', saveDisplaySettings);
    ui.avgEnable.onchange = () => {
      spectrum.avgEnabled = ui.avgEnable.checked;
      if (!ui.avgEnable.checked) spectrum.clearAvg();
    };
    ui.avgCount.onchange = () => {
      spectrum.avgCount = Math.max(2, parseInt(ui.avgCount.value) || 4);
    };

    [ui.startFreq, ui.stopFreq].forEach(el => {
      el.addEventListener('change', applyRange);
    });
    [ui.maxDbm, ui.minDbm].forEach(el => {
      el.addEventListener('change', () => { applyScale(); saveDisplaySettings(); });
    });
    ui.calOffset.addEventListener('change', saveDisplaySettings);
    ui.extGain.addEventListener('change', saveDisplaySettings);

    ui.unit.onchange = () => { onUnitChange(); saveDisplaySettings(); };

    ui.btnTvAomori.onclick = () => applyTvPreset('aomori');
    ui.btnTvMit.onclick    = () => applyTvPreset('mit');
    ui.btnTvMctv.onclick   = () => applyTvPreset('mctv');
    ui.btnTvAll.onclick    = () => applyTvPreset('all');
    ui.btnTvEmi.onclick    = () => applyTvPreset('emi');

    ui.btnAutoScale.onclick = () => { autoScale(); saveDisplaySettings(); };
    ui.btnClearWF.onclick = () => waterfall.clear();
    ui.wfEnable.onchange = () => { applyWaterfallToggle(); saveDisplaySettings(); };
    ui.btnBenchmark.onclick = runBenchmark;

    ui.btnPeakMarker.onclick = () => {
      const id = spectrum.addPeakMarker();
      if (id !== null) {
        updateMarkerList();
        spectrum.draw();
      }
    };
    ui.btnClearMarkers.onclick = () => {
      spectrum.clearMarkers();
      updateMarkerList();
      spectrum.draw();
    };

    ui.btnExportCSV.onclick = exportCurrentCSV;
    ui.btnExportPNG.onclick = exportSpectrumPNG;
    ui.logEnable.onchange = () => {
      if (ui.logEnable.checked) {
        logBuffer = [];
        ui.btnExportLog.disabled = false;
      }
      updateLogInfo();
    };
    ui.btnExportLog.onclick = exportLogCSV;

    ui.btnLoadCSV.onclick = () => ui.fileCSV.click();
    ui.fileCSV.addEventListener('change', onLoadCSV);
    ui.btnClearRef.onclick = () => {
      spectrum.clearReferenceTrace();
      ui.btnClearRef.disabled = true;
      ui.refInfo.textContent = '';
      spectrum.draw();
    };

    // カーソル位置の周波数ツールチップ (マウスホバー時)
    const cursorFreq = $('cursorFreq');
    const canvas = $('spectrumCanvas');
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      // プロット領域外なら非表示
      if (x < spectrum.padL || x > rect.width - spectrum.padR) {
        cursorFreq.classList.remove('show');
        return;
      }
      const freq = spectrum.xToFreq(x, rect.width);
      const dbm = spectrum.valueAt(freq);
      const u = window.UNIT_DEFS[spectrum.unit] || { offset: 0, label: 'dBm' };
      const fStr = (freq / 1e6).toFixed(3) + ' MHz';
      let html = fStr;
      if (dbm !== null && Number.isFinite(dbm)) {
        const lvl = (dbm + u.offset).toFixed(1) + ' ' + u.label;
        html += `<span class="lvl">${lvl}</span>`;
      }
      cursorFreq.innerHTML = html;
      cursorFreq.classList.add('show');
      // カーソル右上に配置、画面端で反転
      const ofsX = 14, ofsY = 22;
      let px = e.clientX + ofsX;
      let py = e.clientY - ofsY;
      const tw = cursorFreq.offsetWidth;
      const th = cursorFreq.offsetHeight;
      if (px + tw > window.innerWidth - 4) px = e.clientX - tw - ofsX;
      if (py < 4) py = e.clientY + ofsY;
      cursorFreq.style.left = px + 'px';
      cursorFreq.style.top = py + 'px';
    });
    canvas.addEventListener('mouseleave', () => {
      cursorFreq.classList.remove('show');
    });

    // クリック (マウス用): マーカー追加
    canvas.addEventListener('click', (e) => {
      // touch由来のクリックは抑止 (touchend で別途処理する)
      if (e.detail === 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const freq = spectrum.xToFreq(x, rect.width);
      if (freq >= spectrum.startFreq && freq <= spectrum.stopFreq) {
        spectrum.addMarker(freq);
        updateMarkerList();
        spectrum.draw();
      }
    });

    // タッチジェスチャ: ピンチ→ズーム、ロングタップ→マーカー追加
    setupTouchGestures(canvas);

    // ハンバーガー & ドロワー (モバイル)
    const menuToggle = $('menuToggle');
    const drawer = $('controls');
    const backdrop = $('drawerBackdrop');
    const closeDrawer = () => {
      drawer.classList.remove('open');
      menuToggle.classList.remove('open');
      backdrop.classList.remove('show');
    };
    menuToggle.addEventListener('click', () => {
      const open = !drawer.classList.contains('open');
      drawer.classList.toggle('open', open);
      menuToggle.classList.toggle('open', open);
      backdrop.classList.toggle('show', open);
    });
    backdrop.addEventListener('click', closeDrawer);
    // メディアクエリ復帰時にドロワーを自動で閉じる
    window.matchMedia('(min-width: 901px)').addEventListener('change', (ev) => {
      if (ev.matches) closeDrawer();
    });

    // Resize observer
    const ro = new ResizeObserver(() => {
      spectrum._needsResize = true;
      waterfall._needsResize = true;
      spectrum.draw();
      waterfall.draw();
    });
    ro.observe($('spectrumCanvas'));
    ro.observe($('waterfallCanvas'));

    if (!tinysa.isSupported()) {
      ui.connText.textContent = 'WebSerial / WebUSB 非対応ブラウザ';
      ui.btnConnect.disabled = true;
      ui.devInfo.textContent = 'Chrome / Edge / Opera (デスクトップ) または Android Chrome で開いてください。';
    } else {
      const hasSerial = 'serial' in navigator;
      const hasUSB = 'usb' in navigator;
      const apis = [hasSerial ? 'WebSerial' : null, hasUSB ? 'WebUSB' : null].filter(Boolean).join(' / ');
      ui.devInfo.textContent = `利用可能 API: ${apis}\n「tinySA 接続」ボタンを押してください。`;
    }

    // 起動時デフォルト: 三沢オールセット適用 + ウォーターフォール OFF
    applyWaterfallToggle();
    applyTvPreset('all');

    // 前回ベンチマーク結果からポイント数を復元 (帯域に近いものを選択)
    // ただしユーザーが明示的に保存した points がある場合はそれを優先 (上書きしない)
    if (!hasSavedPoints()) {
      try {
        const cache = JSON.parse(localStorage.getItem('tinySA_bestPoints') || '{}');
        // 現在の帯域に最も近いキーを探す
        const curStart = parseFreq(ui.startFreq.value);
        const curStop = parseFreq(ui.stopFreq.value);
        const curSpan = Math.round((curStop - curStart) / 1e6);
        const key = curSpan + 'MHz';
        let restored = null;
        if (cache[key] != null) {
          restored = cache[key];
        } else if (cache._latest != null) {
          restored = cache._latest;
        }
        if (restored != null) {
          const optExists = Array.from(ui.points.options).some(o => o.value === String(restored));
          if (optExists) {
            ui.points.value = String(restored);
            console.log('[init] 前回ベンチマークから最速ポイント数', restored, 'を復元');
          }
        }
      } catch {}
    }

    spectrum.draw();
    waterfall.draw();
  }

  function applyRange() {
    const start = parseFreq(ui.startFreq.value);
    const stop = parseFreq(ui.stopFreq.value);
    if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) {
      spectrum.setRange(start, stop);
      spectrum.draw();
    }
  }

  function applyScale() {
    // 入力値は現在の表示単位。内部は常に dBm。
    const off = (window.UNIT_DEFS && window.UNIT_DEFS[ui.unit.value])
      ? window.UNIT_DEFS[ui.unit.value].offset : 0;
    const mnDisp = parseFloat(ui.minDbm.value);
    const mxDisp = parseFloat(ui.maxDbm.value);
    if (Number.isFinite(mnDisp) && Number.isFinite(mxDisp) && mxDisp > mnDisp) {
      const mn = mnDisp - off;
      const mx = mxDisp - off;
      spectrum.setScale(mn, mx);
      waterfall.setScale(mn, mx);
      spectrum.draw();
      waterfall.draw();
    }
  }

  function onUnitChange() {
    const newUnit = ui.unit.value;
    const u = window.UNIT_DEFS[newUnit];
    if (!u) return;
    // 内部 dBm の値そのものは保持し、入力値を新単位に再変換する。
    const newMinDisp = spectrum.minDbm + u.offset;
    const newMaxDisp = spectrum.maxDbm + u.offset;
    ui.minDbm.value = newMinDisp;
    ui.maxDbm.value = newMaxDisp;
    spectrum.setUnit(newUnit);
    waterfall.setUnit(newUnit);
    // ラベル更新
    document.querySelectorAll('.unit-lbl').forEach(el => {
      el.textContent = u.label;
    });
    updateMarkerList();
    spectrum.draw();
    waterfall.draw();
  }

  async function applyTvPreset(name) {
    const preset = (window.TVCH && window.TVCH.PRESETS) ? window.TVCH.PRESETS[name] : null;
    if (!preset) return;
    ui.startFreq.value = hzToMHzStr(preset.start);
    ui.stopFreq.value  = hzToMHzStr(preset.stop);
    applyRange();
    // ハイレンジ帯域 (>240MHz) なら mode 切替
    if (tinysa.connected && ui.sendModeCmd.checked && preset.start >= 240e6) {
      try { await tinysa.setInputMode('high'); }
      catch (e) { console.warn('mode コマンド失敗:', e); }
    }
    // 帯域表示
    spectrum.setStations(preset.stations);
    // 既存マーカーを消し、各局中心にマーカー追加
    spectrum.clearMarkers();
    for (const s of preset.stations) {
      if (s.noMarker) continue;  // 広域バックグラウンド帯はラベルのみ
      const label = (s.short ? s.short : s.name) + (s.ch ? ` ${s.ch}ch` : '');
      spectrum.addMarker(s.center, label, s.color, s.desc || '');
    }
    // 帯域(noMarker)の解説も使えるよう別途保管
    spectrum.stationDescs = preset.stations.filter(s => s.noMarker && s.desc)
      .map(s => ({ name: s.name, short: s.short, color: s.color, desc: s.desc,
                   freq: s.center, range: `${(s.start/1e6).toFixed(2)}〜${(s.stop/1e6).toFixed(2)} MHz` }));
    updateMarkerList();
    spectrum.draw();
    // 情報表示
    const summary = preset.stations.length
      ? preset.stations.map(s => (s.ch ? `${s.ch}ch ` : '') + `${(s.center/1e6).toFixed(3)}MHz`).join(' / ')
      : `範囲: ${(preset.start/1e6).toFixed(1)} 〜 ${(preset.stop/1e6).toFixed(1)} MHz`;
    ui.tvInfo.textContent = preset.title + ' — ' + summary;
    // ボタンのアクティブ表示
    ['Aomori', 'Mit', 'Mctv', 'All', 'Emi'].forEach(k => {
      const b = ui['btnTv' + k];
      if (b) b.classList.remove('active');
    });
    const map = { aomori: 'Aomori', mit: 'Mit', mctv: 'Mctv', all: 'All', emi: 'Emi' };
    const btn = ui['btnTv' + map[name]];
    if (btn) btn.classList.add('active');
  }

  // 入力欄は MHz が既定単位。"100k"=100kHz、"1.5G"=1.5GHz、"470"=470MHz。
  function parseFreq(s) {
    s = String(s).trim().toLowerCase().replace(/,/g, '');
    const m = s.match(/^([0-9.]+)\s*([kmg]?)(hz)?$/);
    if (!m) {
      const v = parseFloat(s);
      return Number.isFinite(v) ? v * 1e6 : NaN;  // 単位なし → MHz
    }
    const num = parseFloat(m[1]);
    const unit = m[2];
    if (unit === 'k') return num * 1e3;
    if (unit === 'm') return num * 1e6;
    if (unit === 'g') return num * 1e9;
    return num * 1e6;  // 単位なし → MHz
  }

  // Hz → MHz 表示用文字列 (末尾ゼロ削除)
  function hzToMHzStr(hz) {
    const mhz = hz / 1e6;
    // 整数なら整数表示、小数なら最大6桁
    if (Math.abs(mhz - Math.round(mhz)) < 1e-9) return String(Math.round(mhz));
    return mhz.toFixed(6).replace(/\.?0+$/, '');
  }

  async function applyPreset(mode) {
    if (mode === 'low') {
      ui.startFreq.value = '0.1';
      ui.stopFreq.value = '350';
    } else {
      ui.startFreq.value = '240';
      ui.stopFreq.value = '960';
    }
    applyRange();
    // TV プリセット帯域を解除
    spectrum.clearStations();
    ui.tvInfo.textContent = '';
    ['Aomori', 'Mit', 'Mctv', 'All'].forEach(k => {
      const b = ui['btnTv' + k];
      if (b) b.classList.remove('active');
    });
    spectrum.draw();
    if (tinysa.connected && ui.sendModeCmd.checked) {
      try {
        await tinysa.setInputMode(mode);
      } catch (e) {
        console.warn('mode コマンド失敗:', e);
      }
    }
  }

  async function onConnect() {
    ui.btnConnect.disabled = true;
    ui.connText.textContent = '接続中...';
    console.log('[connect] start. UA=', navigator.userAgent);
    console.log('[connect] navigator.serial =', 'serial' in navigator,
                ', navigator.usb =', 'usb' in navigator);
    try {
      await tinysa.connect();
      console.log('[connect] succeeded via', tinysa.transportLabel);
      ui.connDot.classList.remove('disconnected');
      ui.connDot.classList.add('connected');
      ui.connText.textContent = '接続済 (' + tinysa.transportLabel + ')';
      ui.btnDisconnect.disabled = false;
      ui.btnStart.disabled = false;
      ui.btnRecover.disabled = false;

      try {
        const ver = await tinysa.getVersion();
        ui.devInfo.textContent = ver.split('\n').slice(0, 4).join('\n');
      } catch (e) {
        ui.devInfo.textContent = '(version 取得失敗)';
      }

      // Apply RBW if not auto
      try {
        await tinysa.setRbw(ui.rbw.value);
      } catch {}
    } catch (e) {
      console.error('[connect] FAILED:', e);
      console.error('[connect] error.name =', e.name, ', message =', e.message);
      if (e.stack) console.error('[connect] stack:', e.stack);
      ui.connText.textContent = '接続失敗: ' + e.message;
      ui.connDot.classList.remove('connected');
      ui.connDot.classList.add('disconnected');
      ui.btnConnect.disabled = false;
      ui.devInfo.textContent = '接続失敗:\n' + e.message;
      alert('接続失敗:\n' + e.message);
    }
  }

  async function onRecover() {
    if (!tinysa.connected) return;
    // 走行中の scan ループを止める
    running = false;
    ui.connText.textContent = 'リカバリ中 (再接続)...';
    // 走行中の sendCommand に終わってもらう時間
    await sleep(300);
    // 切断して再接続 (pending Promise も全部クリア)
    try {
      await tinysa.disconnect();
    } catch {}
    await sleep(500);
    try {
      await tinysa.connect();
      ui.connDot.classList.remove('disconnected');
      ui.connDot.classList.add('connected');
      ui.connText.textContent = '接続済 (リカバリ完了)';
      try {
        const ver = await tinysa.getVersion();
        ui.devInfo.textContent = ver.split('\n').slice(0, 4).join('\n');
      } catch {}
    } catch (e) {
      ui.connText.textContent = 'リカバリ失敗: ' + e.message;
      ui.connDot.classList.remove('connected');
      ui.connDot.classList.add('disconnected');
      ui.btnConnect.disabled = false;
      ui.btnDisconnect.disabled = true;
      ui.btnRecover.disabled = true;
      ui.btnStart.disabled = true;
      return;
    }
    ui.btnStart.disabled = false;
    ui.btnStop.disabled = true;
  }

  async function onDisconnect() {
    if (running) await onStop();
    try {
      await tinysa.disconnect();
    } catch (e) {
      console.warn(e);
    }
    ui.connDot.classList.remove('connected');
    ui.connDot.classList.add('disconnected');
    ui.connText.textContent = '未接続';
    ui.btnConnect.disabled = false;
    ui.btnDisconnect.disabled = true;
    ui.btnStart.disabled = true;
    ui.btnStop.disabled = true;
    ui.btnRecover.disabled = true;
    ui.devInfo.textContent = '';
  }

  let autoScaleOnce = false;

  async function onStart() {
    if (running || !tinysa.connected) return;
    try {
      await tinysa.setRbw(ui.rbw.value);
    } catch (e) {
      console.warn('rbw 設定失敗:', e);
    }
    running = true;
    autoScaleOnce = true;  // 最初の有効データでオートスケール発火
    ui.btnStart.disabled = true;
    ui.btnStop.disabled = false;
    rateWindow = [];
    if (!scanLoopActive) scanLoop();
  }

  async function onStop() {
    running = false;
    ui.btnStart.disabled = !tinysa.connected;
    ui.btnStop.disabled = true;
  }

  async function scanLoop() {
    scanLoopActive = true;
    while (running) {
      const start = parseFreq(ui.startFreq.value);
      const stop = parseFreq(ui.stopFreq.value);
      const pts = parseInt(ui.points.value);
      if (!(start < stop) || !(pts >= 2)) {
        await sleep(200);
        continue;
      }

      let data;
      try {
        data = await tinysa.scan(start, stop, pts);
      } catch (e) {
        console.error('scan error:', e);
        ui.connText.textContent = 'エラー: ' + e.message;
        running = false;
        ui.btnStart.disabled = !tinysa.connected;
        ui.btnStop.disabled = true;
        break;
      }

      if (data.length) {
        // 校正オフセット + 外部利得補正をまとめて適用
        //  - calOff: tinySA v1.3 firmware の生値を実dBμVへ補正 (加算)
        //  - extGain: 外部 LNA / ATT 補正。正 = アンプ (差し引いて実信号源レベルへ戻す)
        const calOff = parseFloat(ui.calOffset.value);
        const extGain = parseFloat(ui.extGain.value);
        const totalOff = (Number.isFinite(calOff) ? calOff : 0)
                       - (Number.isFinite(extGain) ? extGain : 0);
        if (totalOff !== 0) {
          for (const p of data) p.dbm += totalOff;
        }
        spectrum.setRange(data[0].freq, data[data.length - 1].freq);
        spectrum.setData(data);
        if (autoScaleOnce) {
          autoScale();
          autoScaleOnce = false;
        }
        spectrum.draw();
        if (ui.wfEnable.checked) waterfall.addLine(data);

        sweepCount++;
        ui.sweepCount.textContent = sweepCount;

        const now = performance.now();
        rateWindow.push(now);
        while (rateWindow.length && rateWindow[0] < now - 2000) rateWindow.shift();
        const rate = rateWindow.length / Math.min(2, (now - rateWindow[0]) / 1000 || 1);
        ui.sweepRate.textContent = rate.toFixed(1);

        updateMarkerList();

        if (ui.logEnable.checked) {
          const ts = new Date().toISOString();
          for (const p of data) {
            logBuffer.push([ts, p.freq, p.dbm]);
          }
          updateLogInfo();
        }
      }

      // Yield so UI stays responsive
      await sleep(0);
    }
    scanLoopActive = false;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // タッチジェスチャ処理
  // - 1本指 + 静止 500ms → ロングタップでマーカー追加 (バイブ)
  // - 1本指 + ドラッグ → 周波数範囲を左右パン
  // - 2本指 + ピンチ → ピンチ位置を中心に周波数ズーム
  function setupTouchGestures(canvas) {
    let mode = null;            // 'long' | 'pan' | 'pinch'
    let longTimer = null;
    let lpStart = null;         // {x, y}
    let panStart = null;         // {x, startFreq, stopFreq}
    let pinchStart = null;       // {dist, centerX, startFreq, stopFreq}

    const getRect = () => canvas.getBoundingClientRect();

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const rect = getRect();
        lpStart = { x: t.clientX - rect.left, y: t.clientY - rect.top };
        panStart = { x: lpStart.x, startFreq: spectrum.startFreq, stopFreq: spectrum.stopFreq };
        mode = 'long';  // 暫定、move で 'pan' に昇格
        clearTimeout(longTimer);
        longTimer = setTimeout(() => {
          if (mode !== 'long' || !lpStart) return;
          // ロングタップ → マーカー追加
          const freq = spectrum.xToFreq(lpStart.x, rect.width);
          if (freq >= spectrum.startFreq && freq <= spectrum.stopFreq) {
            spectrum.addMarker(freq);
            updateMarkerList();
            spectrum.draw();
            if (navigator.vibrate) navigator.vibrate(40);
          }
          mode = null;
        }, 500);
        e.preventDefault();
      } else if (e.touches.length === 2) {
        clearTimeout(longTimer);
        const t1 = e.touches[0], t2 = e.touches[1];
        const rect = getRect();
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        pinchStart = {
          dist,
          centerX: (t1.clientX + t2.clientX) / 2 - rect.left,
          startFreq: spectrum.startFreq,
          stopFreq: spectrum.stopFreq,
          rectW: rect.width
        };
        mode = 'pinch';
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (mode === 'pinch' && e.touches.length === 2 && pinchStart) {
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const scale = Math.max(0.1, Math.min(10, pinchStart.dist / dist));
        const focusT = pinchStart.centerX / pinchStart.rectW;  // 0〜1
        const focusFreq = pinchStart.startFreq + focusT * (pinchStart.stopFreq - pinchStart.startFreq);
        const newSpan = (pinchStart.stopFreq - pinchStart.startFreq) * scale;
        let newStart = focusFreq - focusT * newSpan;
        let newStop = newStart + newSpan;
        // 帯域チェック (50kHz 以上、~3GHz 以下)
        if (newSpan < 50e3) return;
        if (newStart < 0) { newStart = 0; newStop = newStart + newSpan; }
        if (newStop > 3e9) { newStop = 3e9; newStart = newStop - newSpan; }
        ui.startFreq.value = hzToMHzStr(newStart);
        ui.stopFreq.value = hzToMHzStr(newStop);
        applyRange();
        e.preventDefault();
      } else if (mode === 'long' && e.touches.length === 1 && lpStart) {
        const t = e.touches[0];
        const rect = getRect();
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;
        const dx = x - lpStart.x;
        const dy = y - lpStart.y;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          // ロング判定キャンセル → パンモードへ
          clearTimeout(longTimer);
          mode = 'pan';
        }
      }
      if (mode === 'pan' && e.touches.length === 1 && panStart) {
        const t = e.touches[0];
        const rect = getRect();
        const x = t.clientX - rect.left;
        const dx = x - panStart.x;
        const span = panStart.stopFreq - panStart.startFreq;
        const freqShift = -dx / rect.width * span;
        let newStart = panStart.startFreq + freqShift;
        let newStop = panStart.stopFreq + freqShift;
        if (newStart < 0) { newStart = 0; newStop = newStart + span; }
        if (newStop > 3e9) { newStop = 3e9; newStart = newStop - span; }
        ui.startFreq.value = hzToMHzStr(newStart);
        ui.stopFreq.value = hzToMHzStr(newStop);
        applyRange();
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      clearTimeout(longTimer);
      if (e.touches.length === 0) {
        mode = null;
        lpStart = null;
        panStart = null;
        pinchStart = null;
      } else if (e.touches.length === 1 && mode === 'pinch') {
        // 1本に減ったら pan に切替
        mode = 'pan';
        const t = e.touches[0];
        const rect = getRect();
        panStart = { x: t.clientX - rect.left, startFreq: spectrum.startFreq, stopFreq: spectrum.stopFreq };
      }
    });

    canvas.addEventListener('touchcancel', () => {
      clearTimeout(longTimer);
      mode = null;
      lpStart = panStart = pinchStart = null;
    });
  }

  function applyWaterfallToggle() {
    const main = document.querySelector('main');
    const wf = document.querySelector('.waterfall-wrap');
    if (!main || !wf) return;
    if (ui.wfEnable.checked) {
      main.style.gridTemplateRows = '1fr 1fr';
      wf.style.display = '';
      waterfall._needsResize = true;
      spectrum._needsResize = true;
      waterfall.draw();
      spectrum.draw();
    } else {
      main.style.gridTemplateRows = '1fr 0';
      wf.style.display = 'none';
      spectrum._needsResize = true;
      spectrum.draw();
    }
  }

  async function runBenchmark() {
    if (!tinysa.connected) {
      alert('tinySA に接続してから実行してください。');
      return;
    }
    if (running) {
      alert('掃引中はベンチマークを実行できません。\n「停止」を押してから再度実行してください。');
      return;
    }
    const start = parseFreq(ui.startFreq.value);
    const stop = parseFreq(ui.stopFreq.value);
    if (!(start < stop)) {
      alert('開始/停止周波数が無効です。');
      return;
    }
    const samples = 5;
    const ptsList = [51, 101, 145, 290, 450, 900];
    ui.btnBenchmark.disabled = true;
    ui.btnBenchmark.textContent = '計測中...';
    ui.benchResult.textContent = '計測中... 各 ' + samples + ' 回ずつ';
    const lines = [];
    const results = [];
    for (const pts of ptsList) {
      const times = [];
      for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        try {
          await tinysa.scan(start, stop, pts);
          times.push(performance.now() - t0);
        } catch (e) {
          console.warn('[bench] scan failed at', pts, 'pts:', e.message);
        }
      }
      if (times.length === 0) {
        lines.push(`${String(pts).padStart(3)}pt: 失敗`);
        ui.benchResult.textContent = lines.join('\n');
        continue;
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const rate = 1000 / avg;
      results.push({ pts, avg, min, rate });
      lines.push(`${String(pts).padStart(3)}pt: ${avg.toFixed(0)}ms 平均 / ${min.toFixed(0)}ms 最速 / ${rate.toFixed(2)} 回/秒`);
      ui.benchResult.textContent = lines.join('\n');
      console.log(`[bench] ${pts}pt: avg=${avg.toFixed(0)}ms min=${min.toFixed(0)}ms (${rate.toFixed(2)} sweeps/sec)`);
    }
    // 最速ポイント数を判定 → 自動設定 + 記憶
    if (results.length > 0) {
      results.sort((a, b) => a.avg - b.avg);
      const best = results[0];
      // ドロップダウンに反映 (change イベントも発火させて副作用を起動)
      const prev = ui.points.value;
      const optExists = Array.from(ui.points.options).some(o => o.value === String(best.pts));
      if (optExists) {
        ui.points.value = String(best.pts);
        ui.points.dispatchEvent(new Event('change'));
      }
      // localStorage に保存 (帯域幅キーで使い分け)
      const span = Math.round((stop - start) / 1e6);
      try {
        const cache = JSON.parse(localStorage.getItem('tinySA_bestPoints') || '{}');
        cache[span + 'MHz'] = best.pts;
        cache._latest = best.pts;
        localStorage.setItem('tinySA_bestPoints', JSON.stringify(cache));
      } catch {}
      lines.push('');
      lines.push(`★ 最速: ${best.pts} 点 (${best.rate.toFixed(2)} 回/秒)`);
      lines.push(`→ ポイント数を ${best.pts} に自動設定しました (前: ${prev})`);
      lines.push(`帯域 ${span}MHz 用に記憶 (次回も自動復元)`);
      ui.benchResult.textContent = lines.join('\n');
    }
    ui.btnBenchmark.disabled = false;
    ui.btnBenchmark.textContent = 'スイープ速度ベンチマーク';
  }

  function autoScale() {
    if (!spectrum.data.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const p of spectrum.data) {
      if (p.dbm < lo) lo = p.dbm;
      if (p.dbm > hi) hi = p.dbm;
    }
    const margin = Math.max(5, (hi - lo) * 0.1);
    const mn = Math.floor((lo - margin) / 5) * 5;
    const mx = Math.ceil((hi + margin) / 5) * 5;
    // 入力欄は表示単位
    const off = window.UNIT_DEFS[ui.unit.value].offset;
    ui.minDbm.value = mn + off;
    ui.maxDbm.value = mx + off;
    applyScale();
  }

  let selectedMarkerId = null;

  function updateMarkerList() {
    const list = ui.markerList;
    list.innerHTML = '';
    const u = window.UNIT_DEFS[spectrum.unit] || { offset: 0, label: 'dBm' };
    for (const m of spectrum.markers) {
      const dbm = spectrum.valueAt(m.freq);
      const avgDbm = spectrum.avgValueAt(m.freq);
      const li = document.createElement('li');
      if (m.id === selectedMarkerId) li.classList.add('selected');
      const dot = document.createElement('span');
      dot.className = 'marker-color';
      dot.style.background = m.color;
      const info = document.createElement('span');
      info.className = 'marker-info';
      const lvl = (dbm !== null) ? (dbm + u.offset).toFixed(1) + ' ' + u.label : '-';
      const avgLvl = (avgDbm !== null)
        ? `  avg ${(avgDbm + u.offset).toFixed(1)}` : '';
      const prefix = m.label ? `M${m.id} [${m.label}]` : `M${m.id}`;
      info.textContent = `${prefix}: ${formatFreq(m.freq)}  ${lvl}${avgLvl}`;
      info.title = m.desc ? 'クリックで解説を表示' : '';
      info.onclick = () => {
        if (selectedMarkerId === m.id) {
          // 同じマーカーを再クリック → 閉じる
          selectedMarkerId = null;
          ui.markerDesc.classList.remove('show');
          ui.markerDesc.innerHTML = '';
        } else {
          selectedMarkerId = m.id;
          const text = m.desc || '(解説なし)';
          ui.markerDesc.innerHTML =
            `<div class="freq">M${m.id} ${m.label || ''} — ${formatFreq(m.freq)}</div>` +
            `<div>${text.replace(/</g, '&lt;')}</div>`;
          ui.markerDesc.classList.add('show');
        }
        updateMarkerList();  // re-render to update .selected
      };
      const del = document.createElement('button');
      del.className = 'marker-del';
      del.textContent = '×';
      del.title = '削除';
      del.onclick = (e) => {
        e.stopPropagation();
        spectrum.removeMarker(m.id);
        if (selectedMarkerId === m.id) {
          selectedMarkerId = null;
          ui.markerDesc.classList.remove('show');
          ui.markerDesc.innerHTML = '';
        }
        updateMarkerList();
        spectrum.draw();
      };
      li.appendChild(dot);
      li.appendChild(info);
      li.appendChild(del);
      list.appendChild(li);
    }
    // 帯域(背景バンド)の解説を別アコーディオンに表示
    updateBandsDesc();
  }

  function updateBandsDesc() {
    const bands = spectrum.stationDescs || [];
    if (!bands.length) {
      ui.bandsDesc.style.display = 'none';
      ui.bandsDescBody.innerHTML = '';
      return;
    }
    ui.bandsDesc.style.display = '';
    ui.bandsDescBody.innerHTML = bands.map(b =>
      `<div class="band-item" style="border-left-color:${b.color}">
        <div class="band-head" style="color:${b.color}">${b.short} — ${b.range}</div>
        <div>${b.desc.replace(/</g, '&lt;')}</div>
      </div>`
    ).join('');
  }

  function formatFreq(hz) {
    if (hz >= 1e9) return (hz / 1e9).toFixed(6) + ' GHz';
    if (hz >= 1e6) return (hz / 1e6).toFixed(4) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
    return hz.toFixed(0) + ' Hz';
  }

  function exportSpectrumPNG() {
    const src = document.getElementById('spectrumCanvas');
    if (!src || !src.width || !src.height) {
      alert('スペクトラムが描画されていません');
      return;
    }
    // タイムスタンプと設定情報を追記したオフスクリーン canvas を作成
    const off = document.createElement('canvas');
    off.width = src.width;
    off.height = src.height;
    const octx = off.getContext('2d');
    octx.drawImage(src, 0, 0);

    // 右上に補足情報をオーバーレイ (CSS px 換算)
    const dpr = src.width / src.getBoundingClientRect().width;
    octx.scale(dpr, dpr);
    const u = window.UNIT_DEFS[spectrum.unit] || { label: 'dBm' };
    const extGainVal = parseFloat(ui.extGain.value);
    const extGainStr = (Number.isFinite(extGainVal) && extGainVal !== 0)
      ? ` / 外部 ${extGainVal > 0 ? '+' : ''}${extGainVal} dB` : '';
    const lines = [
      `tinySA — ${new Date().toLocaleString('ja-JP')}`,
      `${(spectrum.startFreq/1e6).toFixed(3)} 〜 ${(spectrum.stopFreq/1e6).toFixed(3)} MHz`,
      `${u.label} スケール: ${ui.minDbm.value} 〜 ${ui.maxDbm.value}`,
      `掃引 #${sweepCount} / 校正 ${ui.calOffset.value} dB${extGainStr} / RBW ${ui.rbw.value}`
    ];
    octx.font = 'bold 11px "Yu Gothic UI", Consolas, monospace';
    const padX = 8;
    const padY = 4;
    const lineH = 15;
    const tw = Math.max(...lines.map(l => octx.measureText(l).width)) + padX * 2;
    const th = lines.length * lineH + padY * 2;
    const x0 = (src.getBoundingClientRect().width) - tw - 4;
    // バンド情報(最上段)を避けて配置: padT(18) + 4 + 3行 × rowHeight(32) + 余白
    const y0 = 130;
    octx.fillStyle = 'rgba(0,0,0,0.78)';
    octx.fillRect(x0, y0, tw, th);
    octx.strokeStyle = '#4ade80';
    octx.lineWidth = 1;
    octx.strokeRect(x0 + 0.5, y0 + 0.5, tw - 1, th - 1);
    octx.fillStyle = '#e0e7ef';
    octx.textBaseline = 'top';
    lines.forEach((l, i) => octx.fillText(l, x0 + padX, y0 + padY + i * lineH));

    off.toBlob((blob) => {
      if (!blob) {
        alert('PNG 生成に失敗しました');
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'spectrum_' + tsStamp() + '.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 100);
    }, 'image/png');
  }

  function exportCurrentCSV() {
    if (!spectrum.data.length) {
      alert('データがありません');
      return;
    }
    const u = window.UNIT_DEFS[spectrum.unit] || { offset: 0, label: 'dBm' };
    const lines = [`freq_Hz,dBm,${u.label}`];
    for (const p of spectrum.data) {
      lines.push(`${p.freq},${p.dbm},${(p.dbm + u.offset).toFixed(2)}`);
    }
    downloadCSV('spectrum_' + tsStamp() + '.csv', lines.join('\n'));
  }

  function exportLogCSV() {
    if (!logBuffer.length) {
      alert('ログが空です');
      return;
    }
    const u = window.UNIT_DEFS[spectrum.unit] || { offset: 0, label: 'dBm' };
    const lines = [`time_iso,freq_Hz,dBm,${u.label}`];
    for (const row of logBuffer) {
      const [ts, freq, dbm] = row;
      lines.push(`${ts},${freq},${dbm},${(dbm + u.offset).toFixed(2)}`);
    }
    downloadCSV('log_' + tsStamp() + '.csv', lines.join('\n'));
  }

  function onLoadCSV(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target.result;
        const data = parseCSV(text);
        if (!data.length) {
          alert('CSV から有効なデータが読み取れませんでした。\n期待形式: freq_Hz, dBm (先頭2列)');
          return;
        }
        spectrum.setReferenceTrace(data, file.name);
        ui.btnClearRef.disabled = false;
        const f0 = data[0].freq, f1 = data[data.length - 1].freq;
        ui.refInfo.textContent = `${file.name} (${data.length}点 / ${formatFreqShort(f0)}〜${formatFreqShort(f1)})`;
        spectrum.draw();
      } catch (err) {
        console.error(err);
        alert('CSV 読み込み失敗: ' + err.message);
      }
    };
    reader.onerror = () => alert('ファイル読み込みエラー');
    reader.readAsText(file);
    // 同じファイルの再選択を可能にする
    e.target.value = '';
  }

  function parseCSV(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(/[,\t;]+/);
      if (parts.length < 2) continue;
      const f = parseFloat(parts[0]);
      const d = parseFloat(parts[1]);
      // ヘッダ行(数値でない行)はスキップ
      if (!Number.isFinite(f) || !Number.isFinite(d)) continue;
      // 周波数があまりに小さいと "1.0e3 → 1000Hz" 程度しか無いはずなので桁スケールはチェックしない
      out.push({ freq: f, dbm: d });
    }
    return out;
  }

  function formatFreqShort(hz) {
    if (hz >= 1e9) return (hz / 1e9).toFixed(3) + 'GHz';
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + 'MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(1) + 'kHz';
    return hz.toFixed(0) + 'Hz';
  }

  function downloadCSV(name, content) {
    const blob = new Blob([content], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 100);
  }

  function tsStamp() {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function updateLogInfo() {
    if (ui.logEnable.checked) {
      ui.logInfo.textContent = `ログ中: ${logBuffer.length} 行`;
    } else {
      ui.logInfo.textContent = logBuffer.length ? `${logBuffer.length} 行保持中` : '';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
