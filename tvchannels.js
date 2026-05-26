// 日本の地上デジタルテレビ放送 物理チャンネル/周波数テーブル
// 物理ch → 中心周波数 (Hz)
// 計算式: 473.142857 MHz + (ch - 13) × 6 MHz、帯域幅 ±3 MHz

(function () {
  function chToCenterHz(ch) {
    return 473.142857e6 + (ch - 13) * 6e6;
  }

  function chBand(ch) {
    const c = chToCenterHz(ch);
    return { center: c, start: c - 3e6, stop: c + 3e6, ch };
  }

  // 青森県三沢市が受信する八戸テレビ中継局 (階上岳) — 5局
  // ※ 三沢市は八戸局のサービスエリア内
  const AOMORI_HACHINOHE = [
    { name: 'NHK Eテレ・青森',  short: 'NHK E',  ch: 14, color: '#60a5fa',
      desc: 'NHK 教育チャンネル。八戸中継局(階上岳)から送信。三沢市内では強信号で受信可能。OFDM 変調のため帯域全体に平坦な「台形」のスペクトラムとして観測されます。' },
    { name: 'ATV 青森テレビ',   short: 'ATV',    ch: 18, color: '#a78bfa',
      desc: 'TBS 系列 青森テレビ (JOAI-DTV)。八戸中継局 18ch (503.143 MHz)。' },
    { name: 'NHK 総合・青森',   short: 'NHK G',  ch: 20, color: '#34d399',
      desc: 'NHK 総合チャンネル。八戸中継局 20ch (515.143 MHz)。岩手めんこいテレビ盛岡局 (ch50) と異なる方向から到来。' },
    { name: 'RAB 青森放送',     short: 'RAB',    ch: 22, color: '#facc15',
      desc: '日本テレビ系列 青森放送 (JOGR-DTV)。八戸中継局 22ch (527.143 MHz)。' },
    { name: 'ABA 青森朝日放送', short: 'ABA',    ch: 24, color: '#fb923c',
      desc: 'テレビ朝日系列 青森朝日放送 (JOAH-DTV)。八戸中継局 24ch (539.143 MHz)。' },
  ].map(s => ({ ...s, ...chBand(s.ch) }));

  // 岩手めんこいテレビ (mit) 盛岡親局 — 50ch
  const IWATE_MIT = [
    { name: '岩手めんこいテレビ (mit) 盛岡', short: 'mit', ch: 50, color: '#f472b6',
      desc: 'フジテレビ系列 岩手めんこいテレビ盛岡親局 (JOYH-DTV)。物理 ch50 = 695.143 MHz。三沢市は本来サービスエリア外ですが、指向性アンテナで盛岡方向へ向ければ受信可能なことがあります。' }
  ].map(s => ({ ...s, ...chBand(s.ch) }));

  // 三沢市ケーブルテレビ MCTV 自主放送 — 物理ch46
  const MCTV = [
    { name: 'mctv 自主放送 (三沢市ケーブルテレビ・OTA対応)', short: 'mctv', ch: 46, color: '#ef4444',
      desc: '三沢市ケーブルテレビが運営する自主放送(コミュニティチャンネル)。物理 ch46 = 671.143 MHz。最近アンテナ直接受信(OTA)にも対応開始し、ケーブル契約なしでも視聴可能になりました。' }
  ].map(s => ({ ...s, ...chBand(s.ch) }));

  // プリセット定義
  // start/stop は表示する周波数レンジ、stations は配置するマーカー
  const PRESETS = {
    aomori: {
      title: '青森県内波 (八戸中継局・5局)',
      start: 476e6,  // ch14 下端 + 少し
      stop:  542e6,  // ch24 上端 + 少し
      // 余白付けて画面に収める
      stations: AOMORI_HACHINOHE,
    },
    mit: {
      title: '岩手めんこいテレビ (盛岡 ch50)',
      // ch50 中心 = 473.142857 + 37×6 = 695.142857 MHz、帯域 692.143〜698.143 MHz
      start: 690e6,
      stop:  700e6,
      stations: IWATE_MIT,
    },
    mctv: {
      title: 'mctv 自主放送 (46ch)',
      start: 666e6,
      stop:  676e6,
      stations: MCTV,
    },
    all: {
      title: '三沢オールセット (青森+岩手+mctv)',
      // 14ch(479MHz) 〜 50ch(695MHz) を全てカバー
      start: 470e6,
      stop:  702e6,
      stations: [...AOMORI_HACHINOHE, ...MCTV, ...IWATE_MIT],
    },
    emi: {
      title: '電波障害監視 (240〜479MHz)',
      // テレビUHF直下、業務/アマチュア/MCA/救命/天文など混在する帯域。
      // 既知の用途で「ここに信号があるはず」「ここは静かなはず」を可視化し、
      // 想定外のピークやスプリアスを検出するための広域モニタ。
      // noMarker:true は帯ラベルのみ (広域帯域用、マーカーは付けない)
      start: 240e6,
      stop:  479e6,
      stations: (() => {
        const raw = [
          { name: '航空・防衛 (240-322)', short: '航空/防衛', color: '#94a3b8',
            start: 250e6, stop: 322e6, noMarker: true,
            desc: '防衛省・米軍機の航空無線、衛星通信、軍用レーダーが混在する帯域。常設の連続信号は少なく、訓練や作戦活動中に短時間の強信号として現れます。' },
          { name: '電波天文 (静穏保護帯)', short: '電波天文', color: '#14b8a6',
            start: 322e6, stop: 328.6e6, noMarker: true,
            desc: '国際的に保護された「静穏帯」。電波天文台の観測を妨害しないよう、放送・通信が禁止されています。ここに信号が見える場合は違法電波・スプリアス・EMI 源の可能性が高く、要警戒。' },
          { name: 'ILS グライドパス (空港)', short: 'ILS GS', color: '#22d3ee',
            start: 328.6e6, stop: 335.4e6, noMarker: false,
            desc: '空港の計器着陸装置(ILS)用 精密進入信号。三沢飛行場周辺では常時放射されており、強い狭帯域 FM 信号として観測されます。' },
          { name: '航空・業務 (335-380)', short: '航空業務', color: '#94a3b8',
            start: 335.4e6, stop: 380e6, noMarker: true,
            desc: '民間航空連絡や業務無線が混在する帯域。連続信号は少なく、運用時のみ短時間出現。' },
          { name: '業務移動 (380-400)', short: '業務380M', color: '#fbbf24',
            start: 380e6, stop: 400e6, noMarker: true,
            desc: '業務用デジタル無線、TETRA 互換システムが配備される帯域。デジタル変調のため平坦な台形ピークとして観測。' },
          { name: '業務移動 (400-406)', short: '業務400M', color: '#fbbf24',
            start: 400e6, stop: 406e6, noMarker: true,
            desc: '低出力業務無線、テレメトリ系統が混在。' },
          { name: '救命無線 (EPIRB/PLB 406.025)', short: 'PLB', color: '#ef4444',
            start: 406.0e6, stop: 406.1e6, noMarker: false,
            desc: '国際救難周波数 406.025 MHz。船舶・航空機の遭難ビーコン用。通常は無信号で、発信されたら本当の緊急事態を意味します(誤発信を含む)。' },
          { name: '宇宙運用 (406.1-410)', short: '宇宙運用', color: '#0ea5e9',
            start: 406.1e6, stop: 410e6, noMarker: false,
            desc: '人工衛星地上局・宇宙研究用。常設信号は限定的。' },
          { name: '業務移動 (410-430)', short: '業務410M', color: '#fbbf24',
            start: 410e6, stop: 430e6, noMarker: true,
            desc: '業務無線、ページャー、特定小電力テレメトリなど多用途帯域。' },
          { name: 'アマチュア無線 70cm', short: 'AM 70cm', color: '#a78bfa',
            start: 430e6, stop: 440e6, noMarker: false,
            desc: 'アマチュア無線 70cm 帯 (430-440 MHz)。レピーター中継局、SSB、CW、D-STAR、C4FM、DMR などのデジタルモードが混在。夕方〜夜の時間帯に局多数。' },
          { name: '業務移動 (440-451)', short: '業務440M', color: '#fbbf24',
            start: 440e6, stop: 451e6, noMarker: true,
            desc: '業務用無線、各種低出力業務局が運用される帯域。' },
          { name: 'MCA 陸上移動', short: 'MCA', color: '#fb923c',
            start: 451e6, stop: 454e6, noMarker: false,
            desc: 'MCA(Multi-Channel Access)による民間業務用集中型無線システム。タクシー、宅配、建設業界などで広く利用。' },
          { name: '簡易無線・特小トランシーバ', short: '簡易/特小', color: '#fde047',
            start: 460e6, stop: 469.4e6, noMarker: false,
            desc: '特定小電力トランシーバー(免許不要、10mW 以下)、簡易無線(簡易免許制)が運用される帯域。生活圏で頻繁に観測される短時間ピーク。' },
          { name: '気象援助 (テレメトリ)', short: '気象援助', color: '#34d399',
            start: 469.4e6, stop: 470e6, noMarker: false,
            desc: '気象観測用テレメトリ(ラジオゾンデなど)。間欠的な信号として観測される。' },
          // --- 米軍三沢基地 UHF航空無線 ---
          { name: '軍用航空 GUARD (緊急共通)', short: '軍 GUARD', color: '#84cc16',
            start: 242.99e6, stop: 243.01e6, noMarker: false,
            desc: 'NATO/米軍 軍用航空緊急共通周波数 243.000 MHz。全軍用機がワッチ義務を負う。緊急時のみ通信があり、平時は搬送波検出のみ。' },
          { name: '米軍三沢 Approach', short: '三沢 APP', color: '#84cc16',
            start: 264.79e6, stop: 264.81e6, noMarker: false,
            desc: '三沢基地進入管制 (Approach Control) 264.8 MHz。航空機を空港へ誘導する管制官と機長の交信。AM 変調のため中心が高く左右に裾を持つピークとして観測。' },
          { name: '米軍三沢 Tower (270.8)', short: '三沢 TWR1', color: '#84cc16',
            start: 270.79e6, stop: 270.81e6, noMarker: false,
            desc: '三沢基地飛行場管制 (Tower) 270.8 MHz。離発着許可、滑走路指示など。F-16/F-35 の離発着時に頻繁に交信あり。' },
          { name: '米軍三沢 Ground', short: '三沢 GND', color: '#84cc16',
            start: 275.79e6, stop: 275.81e6, noMarker: false,
            desc: '三沢基地地上管制 (Ground Control) 275.8 MHz。誘導路・駐機場での移動指示。' },
          { name: '米軍三沢 ATIS', short: '三沢 ATIS', color: '#84cc16',
            start: 305.59e6, stop: 305.61e6, noMarker: false,
            desc: '自動定時飛行場情報放送 305.6 MHz。気象・滑走路情報を音声合成で連続放送するため、三沢関連で唯一の常時受信可能信号。' },
          { name: '米軍三沢 Command Post', short: '三沢 CP', color: '#84cc16',
            start: 310.99e6, stop: 311.01e6, noMarker: false,
            desc: '三沢基地司令部との指揮通信 311.0 MHz。運用状況の報告など。' },
          { name: '米軍三沢 Tower (343.0)', short: '三沢 TWR2', color: '#84cc16',
            start: 342.99e6, stop: 343.01e6, noMarker: false,
            desc: '三沢タワー代替周波数 343.0 MHz。風向・天候に応じて切替えあり。' },
          { name: '米軍三沢 Metro (気象)', short: '三沢 MET', color: '#84cc16',
            start: 344.59e6, stop: 344.61e6, noMarker: false,
            desc: '三沢飛行場気象観測専用 344.6 MHz。' },
          { name: '米軍三沢 Tower (372.2)', short: '三沢 TWR3', color: '#84cc16',
            start: 372.19e6, stop: 372.21e6, noMarker: false,
            desc: '三沢タワー代替周波数 372.2 MHz。' },
        ];
        return raw.map(r => ({
          name: r.name, short: r.short, color: r.color, ch: null,
          start: r.start, stop: r.stop,
          center: (r.start + r.stop) / 2,
          noMarker: !!r.noMarker,
          desc: r.desc || '',
        }));
      })(),
    },
  };

  window.TVCH = {
    chToCenterHz,
    chBand,
    AOMORI_HACHINOHE,
    IWATE_MIT,
    MCTV,
    PRESETS,
  };
})();
