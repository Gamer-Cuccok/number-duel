const SUPABASE_URL = 'https://tlaeajmgycycihqdeqpo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_yT1s8xGeAFrbMcYI772MgA_tLWUOK9M';

const BUILD_VERSION = 'v5-verified-2026-04-08';

const CONFIG_READY =
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.includes('YOUR-PROJECT') &&
  !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE_ANON_KEY');

const supabase = CONFIG_READY
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const eventToastEl = document.getElementById('event-toast');

const state = {
  sessionId: getOrCreateSessionId(),
  nickname: localStorage.getItem('numberDuel:nickname') || '',
  roomCode: localStorage.getItem('numberDuel:lastRoomCode') || '',
  roomData: null,
  loading: false,
  busy: false,
  silentSync: false,
  poller: null,
  pollInFlight: false,
  lastRenderedSignature: '',
  audioContext: null,
  audioUnlocked: false,
};

const statusLabels = {
  lobby: 'Lobby',
  choosing: 'Számválasztás',
  playing: 'Kör folyamatban',
  finished: 'Kör vége',
};

init();

async function init() {
  installAudioUnlock();
  installVisibilitySync();

  if (!CONFIG_READY) {
    render(true);
    return;
  }

  renderLoading('Szoba visszatöltése...');

  if (state.roomCode) {
    const restored = await fetchRoomState(state.roomCode, { silent: true, allowMissing: true });
    if (!restored) {
      clearRoomState();
    }
  }

  render(true);
}

function installVisibilitySync() {
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && state.roomData?.room?.code) {
      await fetchRoomState(state.roomData.room.code, { silent: true, allowMissing: true });
    }
  });
}

function installAudioUnlock() {
  const unlock = async () => {
    try {
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      state.audioUnlocked = true;
    } catch (error) {
      console.error(error);
    }
  };

  ['pointerdown', 'touchstart', 'keydown'].forEach((eventName) => {
    document.addEventListener(eventName, unlock, { passive: true });
  });
}

function getAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }
    state.audioContext = new AudioContextClass();
  }
  return state.audioContext;
}

function playSound(kind) {
  const ctx = getAudioContext();
  if (!ctx || !state.audioUnlocked) {
    return;
  }

  const now = ctx.currentTime + 0.01;
  const schedule = (freq, offset, duration, type = 'sine', gain = 0.05) => {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, now + offset);
    gainNode.gain.setValueAtTime(0.0001, now + offset);
    gainNode.gain.exponentialRampToValueAtTime(gain, now + offset + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + duration + 0.03);
  };

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    if (kind === 'guess') {
      schedule(480, 0, 0.09, 'triangle', 0.035);
      schedule(620, 0.11, 0.07, 'triangle', 0.03);
      return;
    }

    if (kind === 'correct') {
      schedule(520, 0, 0.08, 'triangle', 0.04);
      schedule(660, 0.09, 0.09, 'triangle', 0.05);
      schedule(840, 0.21, 0.14, 'triangle', 0.055);
      return;
    }

    if (kind === 'turn') {
      schedule(360, 0, 0.1, 'sine', 0.04);
      schedule(520, 0.13, 0.12, 'sine', 0.045);
      return;
    }

    if (kind === 'victory') {
      schedule(420, 0, 0.1, 'triangle', 0.04);
      schedule(560, 0.12, 0.1, 'triangle', 0.05);
      schedule(760, 0.24, 0.16, 'triangle', 0.06);
      schedule(1040, 0.4, 0.2, 'triangle', 0.06);
      return;
    }

    if (kind === 'rematch') {
      schedule(440, 0, 0.08, 'sine', 0.03);
      schedule(880, 0.1, 0.08, 'sine', 0.03);
    }
  } catch (error) {
    console.error(error);
  }
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch (error) {
    console.error(error);
  }
}

function getOrCreateSessionId() {
  const key = 'numberDuel:sessionId';
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
}

function persistNickname(value) {
  state.nickname = value.trim();
  localStorage.setItem('numberDuel:nickname', state.nickname);
}

function persistRoomCode(value) {
  state.roomCode = value;
  if (value) {
    localStorage.setItem('numberDuel:lastRoomCode', value);
  } else {
    localStorage.removeItem('numberDuel:lastRoomCode');
  }
}

function clearRoomState() {
  state.roomData = null;
  persistRoomCode('');
  stopPolling();
}

function showToast(message, type = 'info') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 2400);
}

function showEventToast(message, type = 'info', duration = 2500) {
  if (!eventToastEl) {
    showToast(message, type);
    return;
  }

  eventToastEl.textContent = message;
  eventToastEl.className = `event-toast show ${type}`;
  clearTimeout(showEventToast.timer);
  showEventToast.timer = setTimeout(() => {
    eventToastEl.className = 'event-toast';
  }, duration);
}

function renderLoading(text) {
  app.innerHTML = `
    <div class="loading-card fade-in">
      <div class="loading-spinner"></div>
      <div class="panel-title">${escapeHtml(text)}</div>
      <p class="hero-subtitle">Pillanat, felépül a játéktér.</p>
    </div>
  `;
}

function render(force = false) {
  let nextSignature = 'landing';

  if (!CONFIG_READY) {
    nextSignature = 'setup';
  } else if (state.loading && !state.silentSync && !state.roomData) {
    nextSignature = 'loading';
  } else if (state.roomData) {
    nextSignature = `room:${getRoomSignature(state.roomData)}`;
  }

  if (!force && nextSignature === state.lastRenderedSignature) {
    return;
  }

  state.lastRenderedSignature = nextSignature;

  if (!CONFIG_READY) {
    renderSetupView();
    return;
  }

  if (state.loading && !state.silentSync && !state.roomData) {
    renderLoading('Betöltés...');
    return;
  }

  if (!state.roomData) {
    stopPolling();
    renderLandingView();
    bindLandingEvents();
    return;
  }

  startPolling();
  renderRoomView();
  bindRoomEvents();
}

function renderSetupView() {
  app.innerHTML = `
    <div class="hero-card fade-in">
      <div class="kicker"><span class="kicker-dot"></span> Number Duel <span class="tag-chip version-chip">${BUILD_VERSION}</span></div>
      <h1 class="hero-title">Előbb kösd össze a Supabase-szel.</h1>
      <p class="hero-subtitle">
        Ez a projekt GitHub Pages-re készült, de a szobákhoz és a kétjátékos realtime logikához kell egy Supabase backend.
        Az <strong>assets/app.js</strong> tetején írd be a project URL-t és az anon kulcsot, majd kész.
      </p>
    </div>

    <div class="layout-stack fade-in">
      <section class="panel">
        <h2 class="panel-title">Mit kell kitölteni?</h2>
        <div class="section-stack">
          <div>
            <label class="label">SUPABASE_URL</label>
            <input class="input" value="${escapeHtml(SUPABASE_URL)}" disabled />
          </div>
          <div>
            <label class="label">SUPABASE_ANON_KEY</label>
            <input class="input" value="${escapeHtml(SUPABASE_ANON_KEY)}" disabled />
          </div>
          <p class="inline-note">A README-ben bent van a teljes setup, a Supabase SQL és a friss v4 funkciólista is.</p>
        </div>
      </section>
    </div>
  `;
}

function renderLandingView() {
  app.innerHTML = `
    <div class="hero-card fade-in">
      <div class="kicker"><span class="kicker-dot"></span> Number Duel <span class="tag-chip version-chip">${BUILD_VERSION}</span></div>
      <h1 class="hero-title">Találd ki gyorsabban az ellenfél számát.</h1>
      <p class="hero-subtitle">
        Best of 3 / 5, pontozás, revans, hangok, rezgés és körstatisztika. Mobilon lett összerakva, nem csak úgy mellékesen.
      </p>
    </div>

    <div class="layout-stack fade-in">
      <section class="panel">
        <h2 class="panel-title">Szoba létrehozása</h2>
        <div class="section-stack">
          <div>
            <label class="label" for="create-nickname">Neved</label>
            <input id="create-nickname" class="input" maxlength="18" placeholder="Pl. Shadow" value="${escapeHtml(state.nickname)}" />
          </div>
          <div class="double-grid">
            <div>
              <label class="label" for="create-min">Kezdő minimum</label>
              <input id="create-min" class="input" type="number" value="1" />
            </div>
            <div>
              <label class="label" for="create-max">Kezdő maximum</label>
              <input id="create-max" class="input" type="number" value="100" />
            </div>
          </div>
          <div>
            <label class="label" for="create-match-mode">Meccs hossza</label>
            <select id="create-match-mode" class="select">
              <option value="3">Best of 3</option>
              <option value="5">Best of 5</option>
            </select>
          </div>
          <button id="create-room-btn" class="btn btn-primary">Szoba létrehozása</button>
          <p class="inline-note">A host a lobbyban még átírhatja a tartományt és a best of beállítást, amíg nem indul el a kör.</p>
          <p class="inline-note strong-note">Build: ${BUILD_VERSION}</p>
        </div>
      </section>

      <section class="section-stack">
        <div class="section-card">
          <h2 class="section-title">Csatlakozás kóddal</h2>
          <div class="section-stack">
            <div>
              <label class="label" for="join-nickname">Neved</label>
              <input id="join-nickname" class="input" maxlength="18" placeholder="Pl. Tesó" value="${escapeHtml(state.nickname)}" />
            </div>
            <div>
              <label class="label" for="join-code">Szobakód</label>
              <input id="join-code" class="input" maxlength="6" placeholder="Pl. A7K9Q2" value="${escapeHtml(state.roomCode)}" />
            </div>
            <button id="join-room-btn" class="btn btn-secondary">Belépés a szobába</button>
          </div>
        </div>

        <div class="section-card">
          <h2 class="section-title">Újdonságok</h2>
          <div class="section-stack">
            <div class="stat-pill">
              <div class="stat-label">Meccsrendszer</div>
              <div class="stat-value">Best of 3 vagy 5</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Pontozás</div>
              <div class="stat-value">Körönként gyűlnek a pontok</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Revans</div>
              <div class="stat-value">Két katt és indul újra</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Statisztika</div>
              <div class="stat-value">Ki hány tippből talált</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderRoomView() {
  const roomState = state.roomData;
  const room = roomState.room;
  const you = roomState.you;
  const players = roomState.players || [];
  const guesses = roomState.guesses || [];
  const isHost = !!you?.is_host;

  const statusChipClass = room.status === 'finished'
    ? 'finished'
    : room.status === 'playing'
      ? 'active'
      : 'waiting';

  app.innerHTML = `
    <div class="topbar fade-in">
      <button id="back-to-home" class="btn btn-ghost back-btn">Kilépés a szobából</button>
      <div class="status-chip ${statusChipClass}">${escapeHtml(statusLabels[room.status] || 'Játék')}</div>
    </div>

    <div class="layout-stack fade-in">
      <section class="section-stack">
        <div class="room-code-card compact-room-card">
          <div class="room-summary-grid">
            <div>
              <div class="room-meta">Szobakód</div>
              <div class="room-code-pill">${escapeHtml(room.code)}</div>
            </div>
            <div class="room-mini-actions">
              <button id="copy-room-code" class="btn btn-secondary copy-btn">Kód másolása</button>
              <button id="manual-refresh" class="btn btn-ghost copy-btn">Frissítés</button>
            </div>
          </div>
        </div>

        ${renderMatchOverview(roomState)}
        ${renderStatusSection(roomState)}
      </section>

      <section class="section-stack">
        <div class="section-card">
          <div class="card-head">
            <h2 class="section-title">Játékosok</h2>
            ${isHost ? '<span class="role-chip">Host</span>' : '<span class="tag-chip">Vendég</span>'}
          </div>
          <div class="players-grid section-stack">
            ${players.map((player) => renderPlayerCard(player, room, you)).join('')}
          </div>
        </div>

        ${renderRoundHistorySection(roomState)}
        ${renderHistorySection(guesses, you, room)}
      </section>
    </div>
  `;
}

function renderMatchOverview(roomState) {
  const room = roomState.room;
  const players = roomState.players || [];
  const target = getWinsNeeded(room.match_mode);

  return `
    <div class="section-card match-overview-card">
      <div class="card-head">
        <h2 class="section-title">Meccs állása</h2>
        <span class="tag-chip">Best of ${room.match_mode}</span>
      </div>
      <div class="triple-grid score-meta-grid compact-score-meta">
        <div class="stat-pill compact-pill">
          <div class="stat-label">Round</div>
          <div class="stat-value">${room.round_no}</div>
        </div>
        <div class="stat-pill compact-pill">
          <div class="stat-label">Győzelemhez kell</div>
          <div class="stat-value">${target}</div>
        </div>
        <div class="stat-pill compact-pill">
          <div class="stat-label">Tartomány</div>
          <div class="stat-value">${room.min_value} – ${room.max_value}</div>
        </div>
      </div>
      <div class="scoreboard-grid">
        ${players.map((player) => renderScoreTile(player, room)).join('')}
      </div>
      ${room.match_winner_slot
        ? `<div class="inline-note strong-note">A meccset ${escapeHtml(getWinnerName(roomState, room.match_winner_slot))} húzta be.</div>`
        : `<div class="inline-note">Aki előbb eléri a <strong>${target}</strong> körgyőzelmet, az viszi a teljes meccset.</div>`}
    </div>
  `;
}

function renderScoreTile(player, room) {
  const score = getScoreForSlot(room, player.slot);
  return `
    <div class="score-tile ${player.is_you ? 'you' : ''} ${room.match_winner_slot === player.slot ? 'winner' : ''}">
      <div class="score-top">
        <div>
          <div class="player-name">${escapeHtml(player.nickname)} ${player.is_you ? '<span class="tag-chip">Te</span>' : ''}</div>
          <div class="player-meta">${player.is_host ? 'Host' : 'Vendég'} · Hely: ${player.slot}</div>
        </div>
        <div class="score-value">${score}</div>
      </div>
      <div class="score-track"><div class="score-fill" style="width:${Math.min(100, (score / getWinsNeeded(room.match_mode)) * 100)}%"></div></div>
    </div>
  `;
}

function renderStatusSection(roomState) {
  const room = roomState.room;
  const you = roomState.you;
  const opponent = roomState.opponent;
  const isHost = !!you?.is_host;
  const matchFinished = !!room.match_winner_slot;

  if (room.status === 'lobby') {
    return `
      <div class="section-card section-stack">
        <div class="card-head">
          <h2 class="section-title">Lobby</h2>
          <span class="status-chip waiting">${roomState.players.length}/2 játékos</span>
        </div>
        <p class="hero-subtitle">
          ${isHost
            ? 'Állítsd be a tartományt és a meccshosszt, aztán ha ketten vagytok, indítsd a számválasztást.'
            : 'Várd meg, míg a host elindítja a számválasztást.'}
        </p>

        ${isHost ? renderHostLobbyControls(roomState) : '<p class="inline-note">A host kezeli a minimumot, maximumot és a best of módot.</p>'}
      </div>
    `;
  }

  if (room.status === 'choosing') {
    const submitted = !!you?.has_submitted_secret;
    return `
      <div class="section-card section-stack">
        <div class="card-head">
          <h2 class="section-title">Titkos szám választása</h2>
          <span class="status-chip ${submitted ? 'active' : 'waiting'}">${submitted ? 'Leadva' : 'Vár rád'}</span>
        </div>
        <p class="hero-subtitle">
          Írj be egy egész számot a <strong>${room.min_value}</strong> és <strong>${room.max_value}</strong> közötti tartományból.
          Amint mindketten leadtátok, automatikusan indul a kör.
        </p>
        <div class="range-list">
          <div class="stat-pill">
            <div class="stat-label">Alsó határ</div>
            <div class="stat-value">${room.min_value}</div>
          </div>
          <div class="stat-pill">
            <div class="stat-label">Felső határ</div>
            <div class="stat-value">${room.max_value}</div>
          </div>
        </div>

        ${renderOwnSecretCard(roomState, { compact: true })}

        ${submitted
          ? `
            <div class="turn-banner waiting">
              <div class="banner-title">A szám rögzítve van.</div>
              <div class="banner-subtitle">Most már csak várni kell a másik játékosra.</div>
            </div>
          `
          : `
            <div class="guess-grid section-stack mobile-single-grid">
              <div>
                <label class="label" for="secret-number">Titkos számod</label>
                <input id="secret-number" class="input" type="number" placeholder="Pl. 37" />
              </div>
              <button id="submit-secret-btn" class="btn btn-primary">Leadás</button>
            </div>
          `}

        <p class="inline-note">A másik játékos nem látja a számodat, csak a rendszer hasonlítja össze a tippekkel.</p>
      </div>
    `;
  }

  if (room.status === 'playing') {
    const yourTurn = room.current_turn_slot === you.slot;
    const range = getVisibleRange(roomState);
    const rangeBar = getRangeBarStyle(range.low, range.high, room.min_value, room.max_value);
    const yourRoundGuesses = countGuessesBySlot(roomState.guesses, you.slot);
    const opponentRoundGuesses = countGuessesBySlot(roomState.guesses, opponent?.slot);

    return `
      <div class="section-stack">
        <div class="turn-banner ${yourTurn ? 'active' : 'waiting'} sticky-turn-banner">
          <div class="banner-title">${yourTurn ? 'Te jössz!' : `${escapeHtml(getCurrentPlayerName(roomState))} tippel`}</div>
          <div class="banner-subtitle">
            ${yourTurn
              ? `Próbáld eltalálni ${escapeHtml(opponent?.nickname || 'az ellenfél')} számát.`
              : 'Most a másik játékos van soron, de a saját sávodat lent ugyanúgy látod.'}
          </div>
        </div>

        <div class="double-grid room-play-grid room-play-grid-single">
          <div class="range-card">
            <div class="range-title">A te látható tartományod</div>
            <div class="range-value">${formatRangeHeadline(range.low, range.high)}</div>
            <div class="range-bar">
              <div class="range-fill" style="left:${rangeBar.left}%; width:${rangeBar.width}%;"></div>
            </div>
            <div class="range-row">
              <span class="range-chip">Minimum: ${range.low}</span>
              <span class="range-chip">Maximum: ${range.high}</span>
            </div>
            <div class="hint-text">${formatRangeHint(range.low, range.high)}</div>
          </div>

          <div class="section-card side-stat-card">
            <div class="card-head">
              <h2 class="section-title">Kör infó</h2>
              <span class="turn-chip ${yourTurn ? 'active' : ''}">${yourTurn ? 'Most te' : 'Várakozás'}</span>
            </div>
            ${renderOwnSecretCard(roomState, { compact: true })}
            <div class="double-grid compact-stat-grid">
              <div class="stat-pill compact-pill">
                <div class="stat-label">Te eddig</div>
                <div class="stat-value">${yourRoundGuesses} tipp</div>
              </div>
              <div class="stat-pill compact-pill">
                <div class="stat-label">Ellenfél</div>
                <div class="stat-value">${opponentRoundGuesses} tipp</div>
              </div>
            </div>
          </div>
        </div>

        <div class="section-card action-card sticky-action-card">
          <div class="card-head">
            <h2 class="section-title">Tippelés</h2>
            <span class="turn-chip ${yourTurn ? 'active' : ''}">${yourTurn ? 'Most te' : 'Várakozás'}</span>
          </div>
          ${yourTurn
            ? `
              <div class="guess-grid section-stack mobile-single-grid">
                <div>
                  <label class="label" for="guess-number">Tipped</label>
                  <input id="guess-number" class="input" type="number" min="${range.low}" max="${range.high}" placeholder="${range.low} - ${range.high}" />
                </div>
                <button id="submit-guess-btn" class="btn btn-primary">Tipp küldése</button>
              </div>
            `
            : `
              <div class="empty-card section-stack">Most a másik játékos lép. Amint jön új tipp vagy rád kerül a sor, felugró jelzést kapsz.</div>
            `}
        </div>
      </div>
    `;
  }

  if (room.status === 'finished') {
    const youWonRound = room.winner_slot === you.slot;
    const matchWinnerName = room.match_winner_slot ? getWinnerName(roomState, room.match_winner_slot) : null;
    const lastRound = getLatestRoundResult(roomState);
    const nextRoundButton = !matchFinished
      ? (isHost
          ? '<button id="start-round-btn" class="btn btn-primary">Következő kör</button>'
          : '<button class="btn btn-secondary" disabled>A host indítja a következő kört</button>')
      : '';

    return `
      <div class="section-stack">
        <div class="result-banner ${matchFinished ? 'match-finished' : ''}">
          <div class="banner-subtitle">${matchFinished ? 'Meccs vége' : 'A kör lezárult'}</div>
          <div class="result-title">${matchFinished
            ? (room.match_winner_slot === you.slot ? 'Megnyerted a meccset!' : `${escapeHtml(matchWinnerName)} vitte a meccset!`)
            : (youWonRound ? 'Behúztad ezt a kört!' : `${escapeHtml(getWinnerName(roomState))} vitte ezt a kört!`)}</div>
          <div class="banner-subtitle">A saját számod: <strong>${roomState.you.secret_number ?? '—'}</strong> · Az ellenfél száma: <strong>${roomState.opponent?.revealed_secret_number ?? '—'}</strong></div>
        </div>

        <div class="double-grid compact-stat-grid">
          <div class="stat-pill">
            <div class="stat-label">Kör nyertese</div>
            <div class="stat-value">${escapeHtml(getWinnerName(roomState))}</div>
          </div>
          <div class="stat-pill">
            <div class="stat-label">Meccs állása</div>
            <div class="stat-value">${renderScoreText(roomState)}</div>
          </div>
        </div>

        ${lastRound ? `
          <div class="section-card">
            <div class="card-head">
              <h2 class="section-title">Utolsó kör stat</h2>
              <span class="tag-chip">Round ${lastRound.round_no}</span>
            </div>
            <div class="triple-grid compact-stat-grid">
              <div class="stat-pill compact-pill">
                <div class="stat-label">Összes tipp</div>
                <div class="stat-value">${lastRound.total_guesses}</div>
              </div>
              <div class="stat-pill compact-pill">
                <div class="stat-label">1. hely</div>
                <div class="stat-value">${lastRound.slot1_guess_count}</div>
              </div>
              <div class="stat-pill compact-pill">
                <div class="stat-label">2. hely</div>
                <div class="stat-value">${lastRound.slot2_guess_count}</div>
              </div>
            </div>
          </div>
        ` : ''}

        <div class="section-card">
          <div class="card-head">
            <h2 class="section-title">Mi legyen tovább?</h2>
            <span class="status-chip finished">${matchFinished ? 'Revans jöhet' : 'Folytatható'}</span>
          </div>
          <p class="hero-subtitle">${matchFinished
            ? 'A revans lenullázza a pontokat és új meccset indít ugyanebben a szobában.'
            : 'A host indíthatja a következő kört, vagy kérhettek teljes revansot is nullázott pontokkal.'}</p>
          <div class="finish-actions section-stack">
            ${nextRoundButton}
            <button id="rematch-btn" class="btn btn-secondary">${isYouRematchReady(roomState) ? 'Revans kérve' : 'Revans kérése'}</button>
            <button id="manual-refresh" class="btn btn-ghost">Frissítés</button>
          </div>
          ${renderRematchStatus(roomState)}
        </div>
      </div>
    `;
  }

  return '';
}

function renderHostLobbyControls(roomState) {
  const room = roomState.room;
  const canStart = roomState.players.length === 2;

  return `
    <div class="section-card">
      <div class="card-head">
        <h3 class="section-title">Host beállítások</h3>
        <span class="role-chip">Csak nálad</span>
      </div>
      <div class="double-grid section-stack mobile-single-grid">
        <div>
          <label class="label" for="host-min">Minimum</label>
          <input id="host-min" class="input" type="number" value="${room.min_value}" />
        </div>
        <div>
          <label class="label" for="host-max">Maximum</label>
          <input id="host-max" class="input" type="number" value="${room.max_value}" />
        </div>
      </div>
      <div class="section-stack">
        <div>
          <label class="label" for="host-match-mode">Meccs hossza</label>
          <select id="host-match-mode" class="select">
            <option value="3" ${String(room.match_mode) === '3' ? 'selected' : ''}>Best of 3</option>
            <option value="5" ${String(room.match_mode) === '5' ? 'selected' : ''}>Best of 5</option>
          </select>
        </div>
      </div>
      <div class="finish-actions section-stack">
        <button id="save-settings-btn" class="btn btn-secondary">Beállítások mentése</button>
        <button id="start-round-btn" class="btn btn-primary" ${canStart ? '' : 'disabled'}>Számválasztás indítása</button>
      </div>
      <p class="inline-note">A kör indításához két játékos kell a szobába.</p>
    </div>
  `;
}

function renderOwnSecretCard(roomState, options = {}) {
  const { compact = false } = options;
  const room = roomState.room;
  const you = roomState.you || {};
  const hasSecret = Number.isInteger(you.secret_number);
  const statusText = hasSecret
    ? 'Ezt csak te látod.'
    : room.status === 'choosing'
      ? 'Még nem adtad le a számod.'
      : 'A következő körben itt jelenik meg.';

  return `
    <div class="secret-card ${compact ? 'compact-secret-card' : ''}">
      <div class="secret-label">A saját számod</div>
      <div class="secret-value">${hasSecret ? you.secret_number : '—'}</div>
      <div class="secret-note">${escapeHtml(statusText)}</div>
    </div>
  `;
}

function renderPlayerCard(player, room, you) {
  const turnClass = room.current_turn_slot === player.slot && room.status === 'playing' ? 'current-turn' : '';
  const youClass = player.is_you ? 'you' : '';
  const submittedLabel = room.status === 'choosing' || room.status === 'playing' || room.status === 'finished'
    ? (player.has_submitted_secret ? 'Szám leadva' : 'Még nincs meg')
    : 'Lobby';
  const score = getScoreForSlot(room, player.slot);

  return `
    <div class="player-card ${turnClass} ${youClass}">
      <div class="player-row">
        <div>
          <div class="player-name">${escapeHtml(player.nickname)} ${player.is_you ? '<span class="tag-chip">Te</span>' : ''}</div>
          <div class="player-meta">${player.is_host ? 'Host' : 'Csatlakozott játékos'} · Hely: ${player.slot}</div>
        </div>
        <div class="status-chip ${player.has_submitted_secret ? 'active' : 'waiting'}">${submittedLabel}</div>
      </div>
      <div class="divider"></div>
      <div class="card-foot">
        <span class="range-chip">Pont: ${score}</span>
        <span class="tag-chip">${room.status === 'playing' && room.current_turn_slot === player.slot ? 'Most ő jön' : (player.is_you ? 'Saját nézet' : 'Ellenfél')}</span>
      </div>
    </div>
  `;
}

function renderRoundHistorySection(roomState) {
  const rounds = roomState.round_history || [];

  if (!rounds.length) {
    return `
      <div class="section-card">
        <div class="card-head">
          <h2 class="section-title">Szobatörténet</h2>
          <span class="tag-chip">0 kör</span>
        </div>
        <div class="empty-card section-stack">Még nem zárult le kör. Ahogy mennek a meccsek, itt látszik majd, ki hány tippből húzta be.</div>
      </div>
    `;
  }

  return `
    <div class="section-card">
      <div class="card-head">
        <h2 class="section-title">Szobatörténet</h2>
        <span class="tag-chip">${rounds.length} kör</span>
      </div>
      <div class="history-list">
        ${rounds.map((round) => renderRoundHistoryCard(round, roomState)).join('')}
      </div>
    </div>
  `;
}

function renderRoundHistoryCard(round, roomState) {
  const winnerIsYou = round.winner_slot === roomState.you?.slot;
  return `
    <div class="history-card round-history-card">
      <div class="history-top">
        <div>
          <div class="player-name">Round ${round.round_no} · ${escapeHtml(round.winner_nickname)} ${winnerIsYou ? '<span class="tag-chip">Te</span>' : ''}</div>
          <div class="history-meta">Győztes · ${round.total_guesses} össztipp</div>
        </div>
        <div class="history-guess">${round.total_guesses}</div>
      </div>
      <div class="history-result correct">1. hely: ${round.slot1_guess_count} tipp · 2. hely: ${round.slot2_guess_count} tipp</div>
    </div>
  `;
}

function renderHistorySection(guesses, you, room) {
  if (!guesses.length) {
    return `
      <div class="section-card">
        <h2 class="section-title">Aktuális kör naplója</h2>
        <div class="empty-card section-stack">Még nincs tipp. Ahogy jönnek a próbálkozások, itt szépen felcsúsznak.</div>
      </div>
    `;
  }

  return `
    <div class="section-card">
      <div class="card-head">
        <h2 class="section-title">Aktuális kör naplója</h2>
        <span class="tag-chip">${guesses.length} tipp</span>
      </div>
      <div class="history-list">
        ${[...guesses].reverse().map((guess) => renderHistoryCard(guess, you, room)).join('')}
      </div>
    </div>
  `;
}

function renderHistoryCard(guess, you) {
  const resultLabel = guess.result === 'higher'
    ? 'A szám nagyobb'
    : guess.result === 'lower'
      ? 'A szám kisebb'
      : 'Telitalálat';

  const myGuess = guess.guesser_slot === you.slot;
  const rangeText = myGuess
    ? `Saját tartomány utána: ${guess.visible_low} – ${guess.visible_high}`
    : 'Ez az ellenfél sávja volt ennél a tippnél.';

  return `
    <div class="history-card">
      <div class="history-top">
        <div>
          <div class="player-name">${escapeHtml(guess.guesser_nickname)} ${myGuess ? '<span class="tag-chip">Te</span>' : ''}</div>
          <div class="history-meta">${escapeHtml(resultLabel)}</div>
        </div>
        <div class="history-guess">${guess.guess_value}</div>
      </div>
      <div class="history-result ${guess.result}">${escapeHtml(rangeText)}</div>
    </div>
  `;
}

function renderRematchStatus(roomState) {
  const room = roomState.room;
  if (room.status !== 'finished') {
    return '';
  }

  const chips = [];
  chips.push(`<span class="tag-chip ${room.rematch_host_ready ? 'ready-chip' : ''}">Host: ${room.rematch_host_ready ? 'kész' : 'vár'}</span>`);
  chips.push(`<span class="tag-chip ${room.rematch_guest_ready ? 'ready-chip' : ''}">Vendég: ${room.rematch_guest_ready ? 'kész' : 'vár'}</span>`);

  const note = room.rematch_host_ready && room.rematch_guest_ready
    ? 'Mindkét fél kész, a revans azonnal indul.'
    : 'Ha mindketten rányomtok, lenullázza a pontokat és indul az új meccs.';

  return `
    <div class="section-stack">
      <div class="button-row rematch-row">${chips.join('')}</div>
      <p class="inline-note">${note}</p>
    </div>
  `;
}

function bindLandingEvents() {
  document.getElementById('create-room-btn')?.addEventListener('click', onCreateRoom);
  document.getElementById('join-room-btn')?.addEventListener('click', onJoinRoom);

  const createNickname = document.getElementById('create-nickname');
  const joinNickname = document.getElementById('join-nickname');

  const syncNickname = (event) => {
    persistNickname(event.target.value);
    if (createNickname && joinNickname) {
      createNickname.value = state.nickname;
      joinNickname.value = state.nickname;
    }
  };

  createNickname?.addEventListener('input', syncNickname);
  joinNickname?.addEventListener('input', syncNickname);

  document.getElementById('join-code')?.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
}

function bindRoomEvents() {
  document.getElementById('back-to-home')?.addEventListener('click', async () => {
    await leaveCurrentRoom();
    stopPolling();
    clearRoomState();
    render(true);
  });

  document.getElementById('copy-room-code')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.roomData.room.code);
      showToast('Szobakód kimásolva.');
    } catch {
      showToast('Nem sikerült másolni.', 'error');
    }
  });

  document.getElementById('manual-refresh')?.addEventListener('click', async () => {
    await fetchRoomState(state.roomData.room.code);
  });

  document.getElementById('save-settings-btn')?.addEventListener('click', onSaveSettings);
  document.getElementById('start-round-btn')?.addEventListener('click', onStartRound);
  document.getElementById('submit-secret-btn')?.addEventListener('click', onSubmitSecret);
  document.getElementById('submit-guess-btn')?.addEventListener('click', onSubmitGuess);
  document.getElementById('rematch-btn')?.addEventListener('click', onRequestRematch);
}

async function onCreateRoom() {
  const nickname = readNicknameFromForm('create-nickname');
  const minValue = Number(document.getElementById('create-min')?.value);
  const maxValue = Number(document.getElementById('create-max')?.value);
  const matchMode = Number(document.getElementById('create-match-mode')?.value || 3);

  if (!nickname) {
    showToast('Adj meg egy nevet.');
    return;
  }

  if (!Number.isInteger(minValue) || !Number.isInteger(maxValue) || minValue >= maxValue) {
    showToast('A minimum legyen kisebb, mint a maximum.');
    return;
  }

  if (![3, 5].includes(matchMode)) {
    showToast('Best of 3 vagy best of 5 lehet.');
    return;
  }

  persistNickname(nickname);

  await withBusy(async () => {
    const { data, error } = await supabase.rpc('create_room', {
      _session_id: state.sessionId,
      _nickname: nickname,
      _min_value: minValue,
      _max_value: maxValue,
      _match_mode: matchMode,
    });

    if (error) {
      throw error;
    }

    const roomCode = data?.code;
    if (!roomCode) {
      throw new Error('A szoba nem jött létre.');
    }

    persistRoomCode(roomCode);
    showToast('Szoba létrehozva.');
    await fetchRoomState(roomCode);
  });
}

async function onJoinRoom() {
  const nickname = readNicknameFromForm('join-nickname');
  const code = (document.getElementById('join-code')?.value || '').trim().toUpperCase();

  if (!nickname) {
    showToast('Adj meg egy nevet.');
    return;
  }

  if (code.length < 4) {
    showToast('Adj meg egy érvényes szobakódot.');
    return;
  }

  persistNickname(nickname);

  await withBusy(async () => {
    const { error } = await supabase.rpc('join_room', {
      _code: code,
      _session_id: state.sessionId,
      _nickname: nickname,
    });

    if (error) {
      throw error;
    }

    persistRoomCode(code);
    showToast('Csatlakoztál a szobához.');
    await fetchRoomState(code);
  });
}

async function onSaveSettings() {
  const roomCode = state.roomData?.room?.code;
  const minValue = Number(document.getElementById('host-min')?.value);
  const maxValue = Number(document.getElementById('host-max')?.value);
  const matchMode = Number(document.getElementById('host-match-mode')?.value || 3);

  if (!Number.isInteger(minValue) || !Number.isInteger(maxValue) || minValue >= maxValue) {
    showToast('A minimum legyen kisebb, mint a maximum.');
    return;
  }

  if (![3, 5].includes(matchMode)) {
    showToast('Best of 3 vagy best of 5 lehet.');
    return;
  }

  await withBusy(async () => {
    const { error } = await supabase.rpc('update_room_settings', {
      _code: roomCode,
      _session_id: state.sessionId,
      _min_value: minValue,
      _max_value: maxValue,
      _match_mode: matchMode,
    });

    if (error) {
      throw error;
    }

    showToast('Beállítások mentve.');
    await fetchRoomState(roomCode);
  });
}

async function onStartRound() {
  const roomCode = state.roomData?.room?.code;

  await withBusy(async () => {
    const { error } = await supabase.rpc('start_round', {
      _code: roomCode,
      _session_id: state.sessionId,
    });

    if (error) {
      throw error;
    }

    showToast('Indul a számválasztás.');
    await fetchRoomState(roomCode);
  });
}

async function onSubmitSecret() {
  const roomCode = state.roomData?.room?.code;
  const room = state.roomData?.room;
  const secretNumber = Number(document.getElementById('secret-number')?.value);

  if (!Number.isInteger(secretNumber)) {
    showToast('Adj meg egy egész számot.');
    return;
  }

  if (secretNumber < room.min_value || secretNumber > room.max_value) {
    showToast(`A szám csak ${room.min_value} és ${room.max_value} között lehet.`);
    return;
  }

  await withBusy(async () => {
    const { error } = await supabase.rpc('submit_secret_number', {
      _code: roomCode,
      _session_id: state.sessionId,
      _secret_number: secretNumber,
    });

    if (error) {
      throw error;
    }

    showToast('Titkos szám leadva.');
    await fetchRoomState(roomCode);
  });
}

async function onSubmitGuess() {
  const roomCode = state.roomData?.room?.code;
  const range = getVisibleRange(state.roomData);
  const guessNumber = Number(document.getElementById('guess-number')?.value);

  if (!Number.isInteger(guessNumber)) {
    showToast('Adj meg egy egész tipped.');
    return;
  }

  if (guessNumber < range.low || guessNumber > range.high) {
    showToast(`A tipped legyen ${range.low} és ${range.high} között.`);
    return;
  }

  await withBusy(async () => {
    const { error } = await supabase.rpc('make_guess', {
      _code: roomCode,
      _session_id: state.sessionId,
      _guess_value: guessNumber,
    });

    if (error) {
      throw error;
    }

    await fetchRoomState(roomCode);
  });
}

async function onRequestRematch() {
  const roomCode = state.roomData?.room?.code;

  await withBusy(async () => {
    const { data, error } = await supabase.rpc('request_rematch', {
      _code: roomCode,
      _session_id: state.sessionId,
    });

    if (error) {
      throw error;
    }

    if (data?.started) {
      showToast('Revans indul.');
      playSound('rematch');
    } else {
      showToast('Revans kérve.');
    }

    await fetchRoomState(roomCode);
  });
}

function readNicknameFromForm(inputId) {
  const value = document.getElementById(inputId)?.value || state.nickname;
  return value.trim().slice(0, 18);
}

async function withBusy(fn) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  state.loading = !state.roomData;
  render();

  try {
    await fn();
  } catch (error) {
    console.error(error);
    showToast(normalizeError(error), 'error');
  } finally {
    state.busy = false;
    state.loading = false;
    render(true);
  }
}

async function fetchRoomState(roomCode, options = {}) {
  if (!CONFIG_READY || !roomCode) {
    return false;
  }

  if (state.pollInFlight) {
    return false;
  }

  const { silent = false, allowMissing = false } = options;

  state.pollInFlight = true;
  state.loading = !silent;
  state.silentSync = silent;

  if (!silent) {
    render();
  }

  try {
    const { data, error } = await supabase.rpc('get_room_state', {
      _code: roomCode,
      _session_id: state.sessionId,
    });

    if (error) {
      throw error;
    }

    if (!data?.room) {
      if (!allowMissing) {
        throw new Error('A szoba nem található vagy nincs hozzáférésed.');
      }
      return false;
    }

    maybeHandleRealtimeEvents(state.roomData, data);
    state.roomData = data;
    persistRoomCode(data.room.code);
    return true;
  } catch (error) {
    console.error(error);
    if (!allowMissing) {
      showToast(normalizeError(error), 'error');
    }
    if (!silent) {
      clearRoomState();
    }
    return false;
  } finally {
    state.loading = false;
    state.silentSync = false;
    state.pollInFlight = false;
    render(!silent);
  }
}

function maybeHandleRealtimeEvents(previousRoomData, nextRoomData) {
  if (!previousRoomData?.room || !nextRoomData?.room) {
    return;
  }

  if (previousRoomData.room.code !== nextRoomData.room.code) {
    return;
  }

  maybeAnnounceLatestGuess(previousRoomData, nextRoomData);
  maybeAnnounceYourTurn(previousRoomData, nextRoomData);
  maybeAnnounceRoundEnd(previousRoomData, nextRoomData);
  maybeAnnounceRematch(previousRoomData, nextRoomData);
}

function maybeAnnounceLatestGuess(previousRoomData, nextRoomData) {
  const previousLatest = getLatestGuess(previousRoomData);
  const nextLatest = getLatestGuess(nextRoomData);

  if (!nextLatest) {
    return;
  }

  const previousTurn = previousLatest?.turn_no || 0;
  const nextTurn = nextLatest?.turn_no || 0;

  if (nextTurn <= previousTurn) {
    return;
  }

  const actorName = nextLatest.guesser_slot === nextRoomData.you?.slot ? 'Te' : (nextLatest.guesser_nickname || 'Valaki');
  const resultLabel = nextLatest.result === 'correct'
    ? 'telitalálatot lőtt'
    : nextLatest.result === 'higher'
      ? 'tippelt, és a szám nagyobb'
      : 'tippelt, és a szám kisebb';

  showEventToast(`${actorName}: ${nextLatest.guess_value} · ${resultLabel}`);
  playSound(nextLatest.result === 'correct' ? 'correct' : 'guess');
}

function maybeAnnounceYourTurn(previousRoomData, nextRoomData) {
  const youSlot = nextRoomData.you?.slot;
  const nowYourTurn = nextRoomData.room?.status === 'playing' && nextRoomData.room?.current_turn_slot === youSlot;
  const wasYourTurn = previousRoomData.room?.status === 'playing' && previousRoomData.room?.current_turn_slot === youSlot;

  if (nowYourTurn && !wasYourTurn) {
    showEventToast('Te jössz!', 'success', 1900);
    playSound('turn');
    vibrate([90, 50, 120]);
  }
}

function maybeAnnounceRoundEnd(previousRoomData, nextRoomData) {
  if (previousRoomData.room?.status === 'finished' || nextRoomData.room?.status !== 'finished') {
    return;
  }

  const winnerName = getWinnerName(nextRoomData);

  if (nextRoomData.room.match_winner_slot) {
    showEventToast(`${winnerName} megnyerte a meccset!`, 'success', 2800);
    playSound('victory');
    vibrate([160, 60, 160, 60, 220]);
  } else {
    showEventToast(`${winnerName} vitte ezt a kört.`, 'success', 2400);
    playSound('correct');
    vibrate([120, 50, 120]);
  }
}

function maybeAnnounceRematch(previousRoomData, nextRoomData) {
  if (previousRoomData.room?.status === 'finished' && nextRoomData.room?.status === 'choosing') {
    showEventToast('Revans indul, válassz új számot!', 'success', 2500);
    playSound('rematch');
    return;
  }

  const previousOpponentReady = getOpponentRematchReady(previousRoomData);
  const nextOpponentReady = getOpponentRematchReady(nextRoomData);

  if (!previousOpponentReady && nextOpponentReady && nextRoomData.room?.status === 'finished') {
    showEventToast('Az ellenfél is nyomott egy revansot.', 'info', 2200);
  }
}

function startPolling() {
  if (state.poller) {
    return;
  }

  state.poller = setInterval(async () => {
    if (!state.roomData?.room?.code || document.hidden) {
      return;
    }
    await fetchRoomState(state.roomData.room.code, { silent: true, allowMissing: true });
  }, 1800);
}

function stopPolling() {
  if (state.poller) {
    clearInterval(state.poller);
    state.poller = null;
  }
}

function getVisibleRange(roomData) {
  const room = roomData.room;
  const you = roomData.you || {};
  return {
    low: Number.isInteger(you.range_low) ? you.range_low : room.min_value,
    high: Number.isInteger(you.range_high) ? you.range_high : room.max_value,
  };
}

function getRangeBarStyle(low, high, min, max) {
  const total = Math.max(1, max - min + 1);
  const left = ((low - min) / total) * 100;
  const width = Math.max(((high - low + 1) / total) * 100, 2);
  return {
    left: clamp(left, 0, 100),
    width: clamp(width, 2, 100),
  };
}

function getCurrentPlayerName(roomData) {
  return roomData.players.find((player) => player.slot === roomData.room.current_turn_slot)?.nickname || 'Valaki';
}

function getWinnerName(roomData, slot = null) {
  const wantedSlot = slot || roomData.room.winner_slot;
  return roomData.players.find((player) => player.slot === wantedSlot)?.nickname || 'Ismeretlen';
}

function getWinsNeeded(matchMode) {
  return Math.ceil(Number(matchMode || 3) / 2);
}

function getScoreForSlot(room, slot) {
  if (slot === 1) return Number(room.score_slot1 || 0);
  if (slot === 2) return Number(room.score_slot2 || 0);
  return 0;
}

function renderScoreText(roomState) {
  const room = roomState.room;
  return `${room.score_slot1} – ${room.score_slot2}`;
}

function countGuessesBySlot(guesses, slot) {
  if (!Array.isArray(guesses) || !slot) return 0;
  return guesses.filter((guess) => guess.guesser_slot === slot).length;
}

function getLatestRoundResult(roomState) {
  const rounds = roomState.round_history || [];
  return rounds[0] || null;
}

function getLatestGuess(roomData) {
  const guesses = roomData?.guesses || [];
  if (!guesses.length) return null;
  return guesses[guesses.length - 1];
}

function getOpponentRematchReady(roomData) {
  if (!roomData?.room || !roomData?.you) return false;
  return roomData.you.is_host ? roomData.room.rematch_guest_ready : roomData.room.rematch_host_ready;
}

function isYouRematchReady(roomData) {
  if (!roomData?.room || !roomData?.you) return false;
  return roomData.you.is_host ? roomData.room.rematch_host_ready : roomData.room.rematch_guest_ready;
}

function formatRangeHeadline(low, high) {
  return low === high ? `${low}` : `${low} – ${high}`;
}

function formatRangeHint(low, high) {
  if (low === high) {
    return `Innentől már fixen ez az egy szám maradt: ${low}.`;
  }

  return `${low - 1} fölött és ${high + 1} alatt van a szám, vagyis most ${low} és ${high} között mozoghatsz.`;
}

function normalizeError(error) {
  const message = error?.message || 'Valami hiba történt.';

  if (/room is full/i.test(message)) return 'Ez a szoba már tele van.';
  if (/host only/i.test(message)) return 'Ezt csak a host csinálhatja.';
  if (/two players/i.test(message)) return 'Ehhez két játékos kell.';
  if (/range/i.test(message)) return 'Érvénytelen tartomány.';
  if (/not in room/i.test(message)) return 'Nem vagy ebben a szobában.';
  if (/your turn/i.test(message)) return 'Most nem te jössz.';
  if (/already in progress/i.test(message)) return 'A kör már fut.';
  if (/lobby only/i.test(message)) return 'Ezt csak lobby állapotban lehet.';
  if (/choosing phase/i.test(message)) return 'Most nincs számválasztási fázis.';
  if (/playing phase/i.test(message)) return 'Most nincs aktív játékfázis.';
  if (/secret number/i.test(message)) return 'A titkos szám hibás vagy hiányzik.';
  if (/guess out of visible range/i.test(message)) return 'Ez a tipp már kívül esik a látható tartományodon.';
  if (/room not found/i.test(message)) return 'A szoba nem található.';
  if (/match mode/i.test(message)) return 'Best of 3 vagy best of 5 lehet.';
  if (/match finished/i.test(message)) return 'A meccs lezárult, innen már csak revans indulhat.';
  if (/private_player_states_session_id_key/i.test(message) || /duplicate key value/i.test(message)) return 'Ez a böngésző bent ragadt egy másik szobában. Lépj ki a régi szobából, vagy futtasd le a friss SQL-t.';
  if (/function .* does not exist/i.test(message) || /column .* does not exist/i.test(message) || /match_mode/i.test(message) && /does not exist/i.test(message)) return 'A Supabase séma még régi. Futtasd le az új supabase-schema.sql fájlt.';

  return message;
}

async function leaveCurrentRoom() {
  if (!CONFIG_READY || !state.roomData?.room?.code) {
    return;
  }

  try {
    await supabase.rpc('leave_current_room', {
      _session_id: state.sessionId,
    });
  } catch (error) {
    console.error(error);
  }
}

function getRoomSignature(roomData) {
  return JSON.stringify({
    room: {
      code: roomData.room?.code,
      status: roomData.room?.status,
      min_value: roomData.room?.min_value,
      max_value: roomData.room?.max_value,
      current_turn_slot: roomData.room?.current_turn_slot,
      winner_slot: roomData.room?.winner_slot,
      round_no: roomData.room?.round_no,
      match_mode: roomData.room?.match_mode,
      score_slot1: roomData.room?.score_slot1,
      score_slot2: roomData.room?.score_slot2,
      match_winner_slot: roomData.room?.match_winner_slot,
      rematch_host_ready: roomData.room?.rematch_host_ready,
      rematch_guest_ready: roomData.room?.rematch_guest_ready,
    },
    you: {
      slot: roomData.you?.slot,
      is_host: roomData.you?.is_host,
      has_submitted_secret: roomData.you?.has_submitted_secret,
      range_low: roomData.you?.range_low,
      range_high: roomData.you?.range_high,
      secret_number: roomData.you?.secret_number,
    },
    opponent: {
      slot: roomData.opponent?.slot,
      has_submitted_secret: roomData.opponent?.has_submitted_secret,
      revealed_secret_number: roomData.opponent?.revealed_secret_number,
    },
    players: (roomData.players || []).map((player) => ({
      slot: player.slot,
      nickname: player.nickname,
      is_host: player.is_host,
      is_you: player.is_you,
      has_submitted_secret: player.has_submitted_secret,
    })),
    guesses: (roomData.guesses || []).map((guess) => ({
      turn_no: guess.turn_no,
      guesser_slot: guess.guesser_slot,
      guesser_nickname: guess.guesser_nickname,
      guess_value: guess.guess_value,
      result: guess.result,
      visible_low: guess.visible_low,
      visible_high: guess.visible_high,
    })),
    round_history: (roomData.round_history || []).map((round) => ({
      round_no: round.round_no,
      winner_slot: round.winner_slot,
      winner_nickname: round.winner_nickname,
      total_guesses: round.total_guesses,
      slot1_guess_count: round.slot1_guess_count,
      slot2_guess_count: round.slot2_guess_count,
    })),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
