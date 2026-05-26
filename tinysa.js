// tinySA — WebSerial protocol handler
// Communicates with tinySA over USB CDC virtual COM port at 115200 bps.
// Uses ASCII `scan` command for compatibility and human-readable output.

class TinySA {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readableClosed = null;
    this.writableClosed = null;
    this.connected = false;
    this.buffer = '';
    // コマンド送信の直列化用ミューテックス
    this._cmdQueue = Promise.resolve();
  }

  isSupported() {
    return 'serial' in navigator;
  }

  async connect() {
    if (!this.isSupported()) {
      throw new Error('WebSerial がサポートされていません。Chrome / Edge を使用してください。');
    }

    // フィルタを使わず、PCに接続されている任意のシリアル/USB-CDC を選択可能にする。
    // (tinySA 本体が PC や他端末に接続されていれば、ブラウザのダイアログで選択する。)
    let port = null;
    const granted = await navigator.serial.getPorts();
    if (granted.length > 0) {
      // 前回承認済みポートがあれば先頭を使う (再接続)
      port = granted[0];
    } else {
      // 初回接続時は全シリアルポートを表示
      port = await navigator.serial.requestPort({});
    }

    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });

    this.port = port;

    const decoder = new TextDecoderStream();
    this.readableClosed = port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();

    const encoder = new TextEncoderStream();
    this.writableClosed = encoder.readable.pipeTo(port.writable).catch(() => {});
    this.writer = encoder.writable.getWriter();

    this.connected = true;
    this.buffer = '';
    this._cmdQueue = Promise.resolve();

    // 接続直後の初期化シーケンス:
    // 1. 本体が自動スイープしてデータをストリーミングしている可能性があるため、
    //    まず生の \r\r を投入して buffer をプロンプトに戻す。
    // 2. 続けて pause を送って本体側スイープを停止させる。これにより以降の
    //    scan コマンドはこちら主導で正確に応答が得られる。
    // 3. 残った出力を捨てる。
    try {
      await this.writer.write('\r\r');
      // 最大 2 秒、何か出力があれば吸収する
      await this._drainAny(2000);
      this.buffer = '';
      if (TinySA.debug) console.log('[tinySA init] sending pause to stop auto sweep');
      await this.writer.write('pause\r');
      await this._drainAny(1500);
      this.buffer = '';
      if (TinySA.debug) console.log('[tinySA init] init complete');
    } catch (e) {
      console.warn('[tinySA init] flush warning:', e);
    }
  }

  // タイムアウトまで読み続けて buffer に積む (prompt を待たない版)
  async _drainAny(timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (this.connected && performance.now() < deadline) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let res;
      try {
        const readPromise = this.reader.read();
        const timer = new Promise((resolve) =>
          setTimeout(() => resolve({ done: false, value: null, _timeout: true }), remaining)
        );
        res = await Promise.race([readPromise, timer]);
      } catch {
        break;
      }
      if (!res || res._timeout) break;
      if (res.done) break;
      if (res.value) this.buffer += res.value;
      // プロンプトが見えたら早期終了 (それ以上のデータは次の sendCommand で)
      if (this.buffer.endsWith('ch> ')) break;
    }
  }

  async disconnect() {
    // 切断前に本体スイープを再開させる (接続時に pause しているため)
    if (this.connected) {
      try {
        // ミューテックスを経由せず直接書き込み (詰まっていても良いように)
        await this.writer.write('resume\r');
        // 軽くドレイン
        await this._drainAny(500);
      } catch {}
    }
    this.connected = false;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch {}
    try {
      if (this.writer) {
        await this.writer.close().catch(() => {});
      }
    } catch {}
    try { await this.readableClosed; } catch {}
    try { await this.writableClosed; } catch {}
    try {
      if (this.port) await this.port.close();
    } catch {}
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = '';
  }

  // Read characters into the internal buffer until "ch> " prompt seen,
  // or timeoutMs elapses. Returns accumulated text.
  async _drainToPrompt(timeoutMs = 8000) {
    const deadline = performance.now() + timeoutMs;
    while (this.connected) {
      if (this.buffer.includes('ch> ')) return this.buffer;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error('タイムアウト: tinySA からの応答がありません');
      }
      const readPromise = this.reader.read();
      const timer = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('read-timeout')), remaining)
      );
      let res;
      try {
        res = await Promise.race([readPromise, timer]);
      } catch (e) {
        if (e.message === 'read-timeout') {
          throw new Error('タイムアウト: tinySA からの応答がありません');
        }
        throw e;
      }
      if (res.done) break;
      this.buffer += res.value;
    }
    return this.buffer;
  }

  // ミューテックス付き sendCommand: 並行呼び出しを直列化
  async sendCommand(cmd, timeoutMs = 8000) {
    const prev = this._cmdQueue;
    let done;
    this._cmdQueue = new Promise(r => { done = r; });
    try {
      await prev;
      return await this._sendCommandImpl(cmd, timeoutMs);
    } finally {
      done();
    }
  }

  async _sendCommandImpl(cmd, timeoutMs = 8000) {
    if (!this.connected) throw new Error('未接続');
    this.buffer = '';
    if (TinySA.debug) console.log('[tinySA TX]', JSON.stringify(cmd));
    await this.writer.write(cmd + '\r');
    let raw;
    try {
      raw = await this._drainToPrompt(timeoutMs);
    } catch (e) {
      if (TinySA.debug) console.warn('[tinySA RX timeout] partial buffer:',
        JSON.stringify(this.buffer.slice(0, 200)) + '... (total ' + this.buffer.length + ' chars)');
      throw e;
    }
    if (TinySA.debug) {
      const preview = raw.length > 300 ? raw.slice(0, 150) + ' ... ' + raw.slice(-100) : raw;
      console.log('[tinySA RX raw ' + raw.length + 'chars]', JSON.stringify(preview));
    }

    // Strip command echo at start and prompt at end.
    const promptIdx = raw.indexOf('ch> ');
    let body = promptIdx >= 0 ? raw.slice(0, promptIdx) : raw;

    // Remove echoed command line (first line that matches cmd).
    const lines = body.split(/\r?\n/);
    if (lines.length && lines[0].trim() === cmd.trim()) {
      lines.shift();
    }
    // Clean any trailing empty lines.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

    // Reset buffer for next call.
    this.buffer = '';
    const result = lines.join('\n');
    if (TinySA.debug) console.log('[tinySA RX body ' + result.length + 'chars / ' + lines.length + 'lines]',
      JSON.stringify(result.length > 200 ? result.slice(0, 200) + '...' : result));
    return result;
  }

  async getVersion() {
    return await this.sendCommand('version', 3000);
  }

  async getInfo() {
    return await this.sendCommand('info', 3000);
  }

  // Set resolution bandwidth. value is kHz number or 'auto'.
  async setRbw(value) {
    const v = (value === 'auto' || value === 0) ? 'auto' : String(value);
    return await this.sendCommand(`rbw ${v}`);
  }

  // Set input mode. mode: 'low' | 'high'.
  async setInputMode(mode) {
    if (mode !== 'low' && mode !== 'high') throw new Error('mode must be low/high');
    return await this.sendCommand(`mode input ${mode}`);
  }

  // Run a single scan and return array of {freq, dbm}.
  // 1) `scan <s> <e> <p> 3` を試す (新ファーム: 応答に "freq dbm" が含まれる)
  // 2) 応答に何もなかった場合 `data 0` で値だけ取得し、周波数は線形補間
  //    (旧ファーム v1.3 系: scan は実行のみで応答にはデータがない)
  async scan(startHz, stopHz, points) {
    const startI = Math.round(startHz);
    const stopI = Math.round(stopHz);
    const ptsI = Math.max(2, Math.floor(points));
    const timeoutMs = Math.max(3000, 50 * ptsI);

    // Step 1: outmask=3 付きで scan を試す
    const scanCmd = `scan ${startI} ${stopI} ${ptsI} 3`;
    const scanBody = await this.sendCommand(scanCmd, timeoutMs);
    const out = this._parseFreqDbmLines(scanBody);
    if (out.length >= 2) {
      if (TinySA.debug) console.log('[tinySA scan path A]', out.length, 'points (outmask 3)');
      return out;
    }

    // Step 2: data 0 で値だけ取得 (旧ファーム互換)
    const dataBody = await this.sendCommand('data 0', timeoutMs);
    const vals = [];
    for (const line of dataBody.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 1 行に複数値が混ざる場合もある (タブ/空白区切り)
      for (const tok of trimmed.split(/\s+/)) {
        const v = parseFloat(tok);
        if (Number.isFinite(v)) vals.push(v);
      }
    }
    if (vals.length < 2) {
      if (TinySA.debug) console.warn('[tinySA scan FAIL] both paths empty. data 0 body=',
        JSON.stringify(dataBody.slice(0, 200)));
      return [];
    }
    const out2 = [];
    const n = vals.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out2.push({ freq: startHz + t * (stopHz - startHz), dbm: vals[i] });
    }
    if (TinySA.debug) console.log('[tinySA scan path B]', n, 'points (data 0 fallback)');
    return out2;
  }

  _parseFreqDbmLines(body) {
    const out = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const f = parseFloat(parts[0]);
      const d = parseFloat(parts[1]);
      // freq は 1kHz 以上であること (誤判定回避)
      if (!Number.isFinite(f) || !Number.isFinite(d)) continue;
      if (f < 1000) continue;
      out.push({ freq: f, dbm: d });
    }
    return out;
  }

  async pause() { return this.sendCommand('pause'); }
  async resume() { return this.sendCommand('resume'); }

  // 緊急リカバリ: ミューテックスを使わず直接 \r や abort を投入してプロンプトに戻す。
  async recover() {
    if (!this.connected) return;
    try {
      this.buffer = '';
      // ミューテックスをスキップして直接書き込み (詰まったコマンドを抜く)
      await this.writer.write('\r\r');
      // 短時間 prompt を待つ (最大 1.5 秒)
      try { await this._drainToPrompt(1500); } catch {}
      this.buffer = '';
      // ミューテックスチェーンもリセット
      this._cmdQueue = Promise.resolve();
      if (TinySA.debug) console.log('[tinySA recover] done');
    } catch (e) {
      console.warn('[tinySA recover] error:', e);
    }
  }
}

// デフォルトでデバッグログ ON (診断用)。コンソールで `TinySA.debug = false` で抑制可能。
TinySA.debug = true;

window.TinySA = TinySA;
