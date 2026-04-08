const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

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
};

const statusLabels = {
  lobby: 'Lobby',
  choosing: 'Számválasztás',
  playing: 'Játék megy',
  finished: 'Kör vége',
};

init();

async function init() {
  if (!CONFIG_READY) {
    render();
    return;
  }

  renderLoading('Szoba visszatöltése...');

  if (state.roomCode) {
    const restored = await fetchRoomState(state.roomCode, { silent: true, allowMissing: true });
    if (!restored) {
      clearRoomState();
    }
  }

  render();
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
      <div class="kicker"><span class="kicker-dot"></span> Number Duel</div>
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
          <p class="inline-note">A pontos lépések a README-ben benne vannak, plusz ott van a teljes SQL séma is.</p>
        </div>
      </section>

      <section class="section-stack">
        <div class="section-card">
          <h2 class="section-title">Mit tud a játék?</h2>
          <div class="section-stack">
            <div class="stat-pill">
              <div class="stat-label">Játékmód</div>
              <div class="stat-value">2 játékos, szobakóddal</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Host vezérlés</div>
              <div class="stat-value">Host indítja a kört</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Mobil design</div>
              <div class="stat-value">Telefonra optimalizálva</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderLandingView() {
  app.innerHTML = `
    <div class="hero-card fade-in">
      <div class="kicker"><span class="kicker-dot"></span> Number Duel</div>
      <h1 class="hero-title">Találd ki gyorsabban az ellenfél számát.</h1>
      <p class="hero-subtitle">
        Szobás, mobilos, látványos számháború. A host beállítja a tartományt, mindenki elrejti a saját számát,
        aztán indulnak a tippek és szűkül a sáv.
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
          <button id="create-room-btn" class="btn btn-primary">Szoba létrehozása</button>
          <p class="inline-note">A host később is átírhatja a minimumot és maximumot, amíg nem indítja a kört.</p>
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
          <h2 class="section-title">Miért jó mobilon?</h2>
          <div class="section-stack">
            <div class="stat-pill">
              <div class="stat-label">Nagy gombok</div>
              <div class="stat-value">Kényelmes telón is</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Látható tartomány</div>
              <div class="stat-value">Mindig tudod, hol jársz</div>
            </div>
            <div class="stat-pill">
              <div class="stat-label">Körvégi restart</div>
              <div class="stat-value">Host újraindíthatja a meccset</div>
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
            <div class="range-list compact-range-list">
              <div class="stat-pill compact-pill">
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${room.min_value}</div>
              </div>
              <div class="stat-pill compact-pill">
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${room.max_value}</div>
              </div>
            </div>
          </div>
          <div class="room-actions">
            <button id="copy-room-code" class="btn btn-secondary copy-btn">Kód másolása</button>
            <button id="manual-refresh" class="btn btn-ghost copy-btn">Frissítés</button>
          </div>
        </div>

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

        ${renderHistorySection(guesses, you, room)}
      </section>
    </div>
  `;
}

function renderStatusSection(roomState) {
  const room = roomState.room;
  const you = roomState.you;
  const opponent = roomState.opponent;
  const isHost = !!you?.is_host;

  if (room.status === 'lobby') {
    return `
      <div class="section-card section-stack">
        <div class="card-head">
          <h2 class="section-title">Lobby</h2>
          <span class="status-chip waiting">${roomState.players.length}/2 játékos</span>
        </div>
        <p class="hero-subtitle">
          ${isHost
            ? 'Állítsd be a számok tartományát, aztán ha ketten vagytok, indítsd a számválasztást.'
            : 'Várd meg, míg a host elindítja a számválasztást.'}
        </p>

        <div class="range-list">
          <div class="stat-pill">
            <div class="stat-label">Minimum</div>
            <div class="stat-value">${room.min_value}</div>
          </div>
          <div class="stat-pill">
            <div class="stat-label">Maximum</div>
            <div class="stat-value">${room.max_value}</div>
          </div>
        </div>

        ${isHost ? renderHostLobbyControls(roomState) : ''}
        ${!isHost ? '<p class="inline-note">A host bármikor átírhatja a minimumot és maximumot, amíg nem indul el a kör.</p>' : ''}
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
          Amint mindkét játékos leadta, automatikusan indul a kör.
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

        ${submitted
          ? `
            <div class="turn-banner waiting">
              <div class="banner-title">A szám rögzítve van.</div>
              <div class="banner-subtitle">Most már csak várni kell a másik játékosra.</div>
            </div>
          `
          : `
            <div class="guess-grid">
              <div>
                <label class="label" for="secret-number">Titkos számod</label>
                <input id="secret-number" class="input" type="number" placeholder="Pl. 37" />
              </div>
              <button id="submit-secret-btn" class="btn btn-primary">Leadás</button>
            </div>
          `}

        <p class="inline-note">A másik játékos nem látja a választott számodat, csak a rendszer hasonlítja össze a tippekkel.</p>
      </div>
    `;
  }

  if (room.status === 'playing') {
    const yourTurn = room.current_turn_slot === you.slot;
    const range = getVisibleRange(roomState);
    const rangeBar = getRangeBarStyle(range.low, range.high, room.min_value, room.max_value);

    return `
      <div class="section-stack">
        <div class="turn-banner ${yourTurn ? 'active' : 'waiting'}">
          <div class="banner-title">${yourTurn ? 'Te jössz!' : `${escapeHtml(getCurrentPlayerName(roomState))} tippel`}</div>
          <div class="banner-subtitle">
            ${yourTurn
              ? `Próbáld eltalálni ${escapeHtml(opponent?.nickname || 'az ellenfél')} számát.`
              : 'A saját tartományod lent megmarad, közben figyelheted a kört.'}
          </div>
        </div>

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

        <div class="section-card action-card">
          <div class="card-head">
            <h2 class="section-title">Tippelés</h2>
            <span class="turn-chip ${yourTurn ? 'active' : ''}">${yourTurn ? 'Most te' : 'Várakozás'}</span>
          </div>
          ${yourTurn
            ? `
              <div class="guess-grid section-stack">
                <div>
                  <label class="label" for="guess-number">Tipped</label>
                  <input id="guess-number" class="input" type="number" min="${range.low}" max="${range.high}" placeholder="${range.low} - ${range.high}" />
                </div>
                <button id="submit-guess-btn" class="btn btn-primary">Tipp küldése</button>
              </div>
            `
            : `
              <div class="empty-card section-stack">Most a másik játékos lép. A rendszer automatikusan frissít, amint jön az új tipp.</div>
            `}
        </div>
      </div>
    `;
  }

  if (room.status === 'finished') {
    const youWon = room.winner_slot === you.slot;
    const hostAction = isHost
      ? '<button id="start-round-btn" class="btn btn-primary">Új kör indítása</button>'
      : '<button class="btn btn-secondary" disabled>A host indíthat új kört</button>';

    return `
      <div class="section-stack">
        <div class="result-banner">
          <div class="banner-subtitle">A kör lezárult</div>
          <div class="result-title">${youWon ? 'Te nyertél!' : `${escapeHtml(getWinnerName(roomState))} nyert!`}</div>
          <div class="banner-subtitle">A saját számod: <strong>${roomState.you.secret_number ?? '—'}</strong> · Az ellenfél száma: <strong>${roomState.opponent?.revealed_secret_number ?? '—'}</strong></div>
        </div>

        <div class="range-list">
          <div class="stat-pill">
            <div class="stat-label">Nyertes</div>
            <div class="stat-value">${escapeHtml(getWinnerName(roomState))}</div>
          </div>
          <div class="stat-pill">
            <div class="stat-label">Tippek száma</div>
            <div class="stat-value">${(roomState.guesses || []).length}</div>
          </div>
        </div>

        <div class="section-card">
          <div class="card-head">
            <h2 class="section-title">Következő kör</h2>
            <span class="status-chip finished">Újra játszható</span>
          </div>
          <p class="hero-subtitle">Az új kör lenullázza a tippeket és mindenki új titkos számot választhat ugyanabban vagy új tartományban.</p>
          <div class="finish-actions section-stack">
            ${hostAction}
            <button id="manual-refresh" class="btn btn-ghost">Frissítés</button>
          </div>
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
      <div class="double-grid section-stack">
        <div>
          <label class="label" for="host-min">Minimum</label>
          <input id="host-min" class="input" type="number" value="${room.min_value}" />
        </div>
        <div>
          <label class="label" for="host-max">Maximum</label>
          <input id="host-max" class="input" type="number" value="${room.max_value}" />
        </div>
      </div>
      <div class="finish-actions section-stack">
        <button id="save-range-btn" class="btn btn-secondary">Tartomány mentése</button>
        <button id="start-round-btn" class="btn btn-primary" ${canStart ? '' : 'disabled'}>Számválasztás indítása</button>
      </div>
      <p class="inline-note">A kör indításához két játékos kell a szobába.</p>
    </div>
  `;
}

function renderPlayerCard(player, room, you) {
  const turnClass = room.current_turn_slot === player.slot && room.status === 'playing' ? 'current-turn' : '';
  const youClass = player.is_you ? 'you' : '';
  const submittedLabel = room.status === 'choosing' || room.status === 'playing' || room.status === 'finished'
    ? (player.has_submitted_secret ? 'Szám leadva' : 'Még nincs meg')
    : 'Lobby';

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
        <span class="range-chip">${room.status === 'playing' && room.current_turn_slot === player.slot ? 'Most ő jön' : 'Figyel'}</span>
        <span class="tag-chip">${player.is_you ? 'Saját nézet' : 'Ellenfél'}</span>
      </div>
    </div>
  `;
}

function renderHistorySection(guesses, you, room) {
  if (!guesses.length) {
    return `
      <div class="section-card">
        <h2 class="section-title">Tippelőnapló</h2>
        <div class="empty-card section-stack">Még nincs tipp. Ahogy jönnek a próbálkozások, itt szépen felcsúsznak.</div>
      </div>
    `;
  }

  return `
    <div class="section-card">
      <div class="card-head">
        <h2 class="section-title">Tippelőnapló</h2>
        <span class="tag-chip">${guesses.length} bejegyzés</span>
      </div>
      <div class="history-list">
        ${[...guesses].reverse().map((guess) => renderHistoryCard(guess, you, room)).join('')}
      </div>
    </div>
  `;
}

function renderHistoryCard(guess, you, room) {
  const resultLabel = guess.result === 'higher'
    ? 'A szám nagyobb'
    : guess.result === 'lower'
      ? 'A szám kisebb'
      : 'Eltalálta';

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

  document.getElementById('save-range-btn')?.addEventListener('click', onSaveRange);
  document.getElementById('start-round-btn')?.addEventListener('click', onStartRound);
  document.getElementById('submit-secret-btn')?.addEventListener('click', onSubmitSecret);
  document.getElementById('submit-guess-btn')?.addEventListener('click', onSubmitGuess);
}

async function onCreateRoom() {
  const nickname = readNicknameFromForm('create-nickname');
  const minValue = Number(document.getElementById('create-min')?.value);
  const maxValue = Number(document.getElementById('create-max')?.value);

  if (!nickname) {
    showToast('Adj meg egy nevet.');
    return;
  }

  if (!Number.isInteger(minValue) || !Number.isInteger(maxValue) || minValue >= maxValue) {
    showToast('A minimum legyen kisebb, mint a maximum.');
    return;
  }

  persistNickname(nickname);

  await withBusy(async () => {
    const { data, error } = await supabase.rpc('create_room', {
      _session_id: state.sessionId,
      _nickname: nickname,
      _min_value: minValue,
      _max_value: maxValue,
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

async function onSaveRange() {
  const roomCode = state.roomData?.room?.code;
  const minValue = Number(document.getElementById('host-min')?.value);
  const maxValue = Number(document.getElementById('host-max')?.value);

  if (!Number.isInteger(minValue) || !Number.isInteger(maxValue) || minValue >= maxValue) {
    showToast('A minimum legyen kisebb, mint a maximum.');
    return;
  }

  await withBusy(async () => {
    const { error } = await supabase.rpc('update_room_range', {
      _code: roomCode,
      _session_id: state.sessionId,
      _min_value: minValue,
      _max_value: maxValue,
    });

    if (error) {
      throw error;
    }

    showToast('Tartomány mentve.');
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
    const { data, error } = await supabase.rpc('make_guess', {
      _code: roomCode,
      _session_id: state.sessionId,
      _guess_value: guessNumber,
    });

    if (error) {
      throw error;
    }

    const result = data?.result;
    if (result === 'correct') {
      showToast('Telitalálat!');
    } else if (result === 'higher') {
      showToast('Nagyobb az ellenfél száma.');
    } else if (result === 'lower') {
      showToast('Kisebb az ellenfél száma.');
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

function getWinnerName(roomData) {
  return roomData.players.find((player) => player.slot === roomData.room.winner_slot)?.nickname || 'Ismeretlen';
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
  if (/private_player_states_session_id_key/i.test(message) || /duplicate key value/i.test(message)) return 'Ez a böngésző már bent ragadt egy másik szobában. Futtasd le a javító SQL-t, vagy lépj ki a régi szobából.';

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
    },
    you: {
      slot: roomData.you?.slot,
      is_host: roomData.you?.is_host,
      has_submitted_secret: roomData.you?.has_submitted_secret,
      range_low: roomData.you?.range_low,
      range_high: roomData.you?.range_high,
      secret_number: roomData.you?.secret_number,
      revealed_secret_number: roomData.you?.revealed_secret_number,
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
      guess_value: guess.guess_value,
      result: guess.result,
      visible_low: guess.visible_low,
      visible_high: guess.visible_high,
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
