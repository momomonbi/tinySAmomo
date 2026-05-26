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

    // 接続方式: 'serial' (WebSerial、デスクトップ Chrome) または 'usb' (WebUSB、Android Chrome)
    this.transport = null;

    // WebUSB 用の状態
    this._usbDevice = null;
    this._usbInterfaceNum = -1;
    this._usbEpIn = -1;
    this._usbEpOut = -1;
    this._usbEpInPacketSize = 64;
    this._usbReadBuffer = '';
    this._usbReadWaiters = [];
    this._usbReadLoopActive = false;
    this._usbReadLoopPromise = null;
    this._textEncoder = new TextEncoder();
    this._textDecoder = new TextDecoder('utf-8', { fatal: false });
  }

  // どちらかの API が使えれば true
  isSupported() {
    return ('serial' in navigator) || ('usb' in navigator);
  }

  // 接続方式の文字列表記 (UI 表示用)
  get transportLabel() {
    if (this.transport === 'serial') return 'WebSerial';
    if (this.transport === 'usb') return 'WebUSB';
    return '未接続';
  }

  async connect() {
    if (!this.isSupported()) {
      throw new Error('WebSerial も WebUSB もサポートされていません。Chrome / Edge を使用してください。');
    }
    // WebSerial を優先 (デスクトップ Chrome/Edge ではこちらが基本)
    // 利用不可なら WebUSB にフォールバック (Android Chrome ではこちら)
    if ('serial' in navigator) {
      try {
        await this._connectSerial();
      } catch (e) {
        // WebSerial が API としてはあるがアクセスダイアログでキャンセル等
        // → そのままエラーを上に投げる (ユーザの意図と思われるため)
        throw e;
      }
    } else if ('usb' in navigator) {
      await this._connectUSB();
    } else {
      throw new Error('WebSerial も WebUSB もサポートされていません。');
    }

    this.connected = true;
    this.buffer = '';
    this._cmdQueue = Promise.resolve();

    // 接続直後の初期化シーケンス (両トランスポート共通):
    // 1. 本体が自動スイープしてデータをストリーミングしている可能性があるため、
    //    まず生の \r\r を投入して buffer をプロンプトに戻す。
    // 2. 続けて pause を送って本体側スイープを停止させる。これにより以降の
    //    scan コマンドはこちら主導で正確に応答が得られる。
    // 3. 残った出力を捨てる。
    try {
      await this._writeText('\r\r');
      await this._drainAny(2000);
      this.buffer = '';
      if (TinySA.debug) console.log('[tinySA init] sending pause to stop auto sweep');
      await this._writeText('pause\r');
      await this._drainAny(1500);
      this.buffer = '';
      if (TinySA.debug) console.log('[tinySA init] init complete (transport=' + this.transport + ')');
    } catch (e) {
      console.warn('[tinySA init] flush warning:', e);
    }
  }

  async _connectSerial() {
    let port = null;
    const granted = await navigator.serial.getPorts();
    if (granted.length > 0) {
      port = granted[0];
    } else {
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
    this.transport = 'serial';
  }

  async _connectUSB() {
    // 既に承認済みデバイスがあれば優先利用 (再接続)
    let device = null;
    const granted = await navigator.usb.getDevices();
    const isTinySA = (d) => d.vendorId === 0x0483 && d.productId === 0x5740;
    const known = granted.find(isTinySA);
    if (known) {
      device = known;
    } else {
      device = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x0483, productId: 0x5740 }],
      });
    }
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    // CDC: Data Interface (class 0x0A) を見つけ、Bulk IN/OUT エンドポイントを取得
    let dataIface = null;
    let controlIfaceNum = -1;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 0x0A && dataIface == null) {
          dataIface = { ifaceNum: iface.interfaceNumber, alt };
        }
        if (alt.interfaceClass === 0x02 && controlIfaceNum < 0) {
          controlIfaceNum = iface.interfaceNumber;
        }
      }
    }
    if (!dataIface) {
      await device.close();
      throw new Error('USB: CDC Data インタフェースが見つかりません');
    }
    let epIn = -1, epOut = -1, epInSize = 64;
    for (const ep of dataIface.alt.endpoints) {
      if (ep.type === 'bulk' && ep.direction === 'in') {
        epIn = ep.endpointNumber;
        epInSize = ep.packetSize || 64;
      }
      if (ep.type === 'bulk' && ep.direction === 'out') {
        epOut = ep.endpointNumber;
      }
    }
    if (epIn < 0 || epOut < 0) {
      await device.close();
      throw new Error('USB: Bulk エンドポイントが見つかりません');
    }

    // Data インタフェースを claim
    try {
      await device.claimInterface(dataIface.ifaceNum);
    } catch (e) {
      await device.close();
      throw new Error('USB: インタフェースを取得できませんでした。OS の CDC ドライバが占有している可能性: ' + e.message);
    }
    // Control インタフェースもあれば claim (一部 OS で必要)
    if (controlIfaceNum >= 0 && controlIfaceNum !== dataIface.ifaceNum) {
      try { await device.claimInterface(controlIfaceNum); } catch {}
    }

    // CDC SET_LINE_CODING: 115200 8N1
    //   dwDTERate(4 LE) | bCharFormat(1=stop) | bParityType(1=parity) | bDataBits(1=data)
    //   115200 = 0x0001C200 → 00 C2 01 00 / stop=0 / parity=0 / data=8
    const lineCoding = new Uint8Array([0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08]);
    try {
      await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x20, // SET_LINE_CODING
        value: 0,
        index: controlIfaceNum >= 0 ? controlIfaceNum : dataIface.ifaceNum,
      }, lineCoding);
    } catch (e) {
      console.warn('[USB] SET_LINE_CODING failed (継続):', e.message);
    }
    // CDC SET_CONTROL_LINE_STATE: DTR=1, RTS=1
    try {
      await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22, // SET_CONTROL_LINE_STATE
        value: 0x03,   // DTR | RTS
        index: controlIfaceNum >= 0 ? controlIfaceNum : dataIface.ifaceNum,
      });
    } catch (e) {
      console.warn('[USB] SET_CONTROL_LINE_STATE failed (継続):', e.message);
    }

    this._usbDevice = device;
    this.port = device;  // 共通フィールドにも入れて互換性のため
    this._usbInterfaceNum = dataIface.ifaceNum;
    this._usbEpIn = epIn;
    this._usbEpOut = epOut;
    this._usbEpInPacketSize = epInSize;
    this._usbReadBuffer = '';
    this._usbReadWaiters = [];
    this.transport = 'usb';
    this._startUSBReadLoop();
  }

  // WebUSB のバックグラウンド読み込みループ
  // transferIn は基本的に「データが来るまで」もしくは「endpoint stall まで」ブロックする。
  // ここで連続的に読み続け、_usbReadBuffer に蓄積する。読み手 (_readRaw) はバッファから取り出す。
  _startUSBReadLoop() {
    this._usbReadLoopActive = true;
    this._usbReadLoopPromise = (async () => {
      while (this._usbReadLoopActive) {
        let result;
        try {
          result = await this._usbDevice.transferIn(this._usbEpIn, this._usbEpInPacketSize);
        } catch (e) {
          // 切断時は transferIn が reject する → ループ抜け
          if (this._usbReadLoopActive && TinySA.debug) {
            console.warn('[USB read loop] transferIn error:', e.message);
          }
          break;
        }
        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
          const bytes = new Uint8Array(
            result.data.buffer,
            result.data.byteOffset,
            result.data.byteLength
          );
          const text = this._textDecoder.decode(bytes, { stream: true });
          this._usbReadBuffer += text;
          // 待機中の読み手を全員起こす
          const waiters = this._usbReadWaiters;
          this._usbReadWaiters = [];
          for (const w of waiters) w();
        } else if (result.status === 'stall') {
          try { await this._usbDevice.clearHalt('in', this._usbEpIn); } catch {}
        }
      }
      // 読み手にループ終了を通知
      const waiters = this._usbReadWaiters;
      this._usbReadWaiters = [];
      for (const w of waiters) w();
    })();
  }

  // 共通 I/O ラッパー: 1 チャンクのテキストを返す。
  // 返り値: { value: string|null, done: boolean }
  // 利用側で Promise.race により外部タイムアウトが可能。
  async _readRaw() {
    if (this.transport === 'serial') {
      return await this.reader.read();
    }
    // WebUSB
    while (this.connected || this._usbReadBuffer.length > 0) {
      if (this._usbReadBuffer.length > 0) {
        const text = this._usbReadBuffer;
        this._usbReadBuffer = '';
        return { value: text, done: false };
      }
      // 新着待ち
      await new Promise((resolve) => {
        this._usbReadWaiters.push(resolve);
      });
    }
    return { value: null, done: true };
  }

  async _writeText(text) {
    if (this.transport === 'serial') {
      return await this.writer.write(text);
    }
    // WebUSB
    const bytes = this._textEncoder.encode(text);
    await this._usbDevice.transferOut(this._usbEpOut, bytes);
  }

  // タイムアウトまで読み続けて buffer に積む (prompt を待たない版)
  async _drainAny(timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (this.connected && performance.now() < deadline) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let res;
      try {
        const readPromise = this._readRaw();
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
        await this._writeText('resume\r');
        await this._drainAny(500);
      } catch {}
    }
    this.connected = false;

    if (this.transport === 'serial') {
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
    } else if (this.transport === 'usb') {
      // 読み込みループを止める
      this._usbReadLoopActive = false;
      // ループ中の transferIn を abort するために interface を release → close
      try {
        if (this._usbDevice && this._usbInterfaceNum >= 0) {
          await this._usbDevice.releaseInterface(this._usbInterfaceNum).catch(() => {});
        }
      } catch {}
      try {
        if (this._usbDevice) await this._usbDevice.close();
      } catch {}
      // ループ終了を待つ (最大 1 秒)
      try {
        await Promise.race([
          this._usbReadLoopPromise || Promise.resolve(),
          new Promise(r => setTimeout(r, 1000)),
        ]);
      } catch {}
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = '';
    this.transport = null;
    this._usbDevice = null;
    this._usbReadBuffer = '';
    this._usbReadWaiters = [];
    this._usbReadLoopPromise = null;
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
      const readPromise = this._readRaw();
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
      if (res.value) this.buffer += res.value;
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
    await this._writeText(cmd + '\r');
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
      await this._writeText('\r\r');
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
