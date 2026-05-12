/**
 * Stager - Core Application Logic
 * 
 * Handles:
 * - Google Spreadsheet CSV fetching & parsing
 * - Adaptive difficulty song selection
 * - Cloudflare Worker proxy for GitHub data persistence
 * - UI state management
 */

// ==================== Configuration ====================
const CONFIG = {
    // Cloudflare Worker proxy URL (handles GitHub API calls server-side)
    WORKER_URL: 'https://stager-proxy.stager-skygarlics.workers.dev',
    SPREADSHEET_BASE: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSUdp6iuEzE8Z5AL1hkoxzLexp89nJnLQMmICm6_MC0_UjCp1ImZFzabcZkvCpK7mcWvm_2t6iYoJRg/pub',
    SHEET_GIDS: {
        'ノマゲ': 1873149697,
        'ハード': 0,
    },
    // Levels ordered from lowest to highest
    LEVELS: ['F', 'E', 'D', 'C', 'B', 'B+', 'A', 'A+', 'S', 'S+'],
    // Known version identifiers to help find the header row
    VERSION_MARKERS: ['5th', '6th', '7th', '8th', '9th', '10th', 'IIDXRED', 'HAPPY SKY'],
    // Max history entries to display
    MAX_HISTORY_DISPLAY: 30,
    // Max history entries to persist (older entries are trimmed on save)
    MAX_HISTORY_ENTRIES: 500,
    // Number of days to keep login session
    SESSION_DAYS: 30,

    // DP Mode Configuration
    DP: {
        // Available official star levels
        OFFI_LEVELS: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        // Default starting star level
        DEFAULT_OFFI: 11,
        // Latest game version env code
        DEFAULT_ENV: 'a330',
    },
    // When true, local development can bypass auth and Worker persistence
    DEV_ALLOW_OFFLINE: true,
    // IndexedDB cache for song data
    DP_CACHE_DB: 'stager_dp_cache',
    DP_CACHE_STORE: 'entries',
    DP_CACHE_VERSION: 1,
    HISTORY_CACHE_KEY: 'PLAY_HISTORY_STATE_V1',
    HISTORY_CACHE_TTL_MS: 60 * 60 * 1000,
    DRUM_HISTORY_CACHE_KEY: 'DRUM_HISTORY_STATE_V1',
    DRUM_HISTORY_CACHE_TTL_MS: 60 * 60 * 1000,
};

const ROUTES = {
    iidx: {
        key: 'iidx',
        title: 'IIDX ☆12 Leveler',
        loginTitle: 'IIDX Leveler',
        loginDesc: 'パスワードを入力してアクセスしてください',
    },
    drum: {
        key: 'drum',
        title: 'Drum Stager',
        loginTitle: 'Drum Stager',
        loginDesc: 'パスワードを入力してアクセスしてください',
    },
};

const DEFAULT_ROUTE = 'iidx';

function isLocalDevEnvironment() {
    return CONFIG.DEV_ALLOW_OFFLINE && (
        window.location.protocol === 'file:' ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname === '::1'
    );
}

// ==================== Application State ====================
const state = {
    route: DEFAULT_ROUTE,
    password: null,              // Login password (used as Bearer token for Worker)
    currentLevelIndex: 0,       // Index into CONFIG.LEVELS or DP levels
    songDB: {},                  // { version: { level: [song1, song2, ...] } }
    versions: [],                // Ordered from oldest to newest
    playedSongs: new Set(),      // "version|song" strings for session dedup
    songStatus: new Map(),       // songKey -> { status: 'clear'|'fail', level } latest result per song
    history: [],                 // Full play history array
    currentSong: null,           // Currently displayed song
    currentVersion: null,        // Version of current song
    currentLevel: null,          // Level of current song (may differ from currentLevelIndex)
    fileSha: null,               // GitHub file SHA for updates
    drumFileSha: null,           // GitHub file SHA for DrumTower updates
    dpCacheFileSha: null,        // GitHub file SHA for DP cache updates
    mode: 'ノマゲ',              // Current gauge mode (SP only)
    gameMode: 'SP',              // 'SP' or 'DP'
    playEnv: 'home',             // 'home' or 'arcade'
    isProcessing: false,         // Prevent double-clicks
    totalSongsInDB: 0,           // Total songs loaded
    clearCount: 0,               // Lifetime clear count
    totalCount: 0,               // Lifetime total play count
    modeStates: {},              // { modeKey: { history, currentLevelIndex, clearCount, totalCount } }
    drumFloors: [],              // Parsed DrumTower floor data
    drumRankStore: {},           // Local S-rank toggles per song
    drumFloorStatuses: {},       // Persisted per-floor clear states
    drumSelectedFloorIndex: 0,   // Last selected floor index in DrumTower

    // DP-specific state
    dp: {
        offi: 11,                // Current official star level (☆11)
        levels: [],              // Rank levels sorted ascending (e.g., ['10.2','10.5',...])
        env: 'a330',             // Game version env code
    },
};

// ==================== IndexedDB Cache ====================
function getDpCacheIdbKey() {
    return getDpCacheKey();
}

function getSpCacheKey() {
    return `SP_${state.mode}`;
}

function openDpCacheDb() {
    if (!('indexedDB' in window)) {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DP_CACHE_DB, CONFIG.DP_CACHE_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(CONFIG.DP_CACHE_STORE)) {
                db.createObjectStore(CONFIG.DP_CACHE_STORE, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getDpCacheFromIdb(key) {
    try {
        const db = await openDpCacheDb();
        if (!db) return null;

        return await new Promise((resolve, reject) => {
            const tx = db.transaction(CONFIG.DP_CACHE_STORE, 'readonly');
            const store = tx.objectStore(CONFIG.DP_CACHE_STORE);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        });
    } catch (e) {
        console.warn('Failed to read DP cache from IndexedDB:', e);
        return null;
    }
}

async function saveDpCacheToIdb(key, payload) {
    try {
        const db = await openDpCacheDb();
        if (!db) return;

        await new Promise((resolve, reject) => {
            const tx = db.transaction(CONFIG.DP_CACHE_STORE, 'readwrite');
            const store = tx.objectStore(CONFIG.DP_CACHE_STORE);
            store.put({
                key,
                entry: payload.entry,
                sha: payload.sha || null,
                savedAt: new Date().toISOString(),
            });
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        });
    } catch (e) {
        console.warn('Failed to save DP cache to IndexedDB:', e);
    }
}

async function getCachedHistoryState() {
    const cached = await getDpCacheFromIdb(CONFIG.HISTORY_CACHE_KEY);
    if (!cached || !cached.entry || !cached.savedAt) return null;

    const savedAt = Date.parse(cached.savedAt);
    if (!Number.isFinite(savedAt)) return null;

    const age = Date.now() - savedAt;
    if (age > CONFIG.HISTORY_CACHE_TTL_MS) return null;

    return cached;
}

async function saveCachedHistoryState(entry, sha) {
    await saveDpCacheToIdb(CONFIG.HISTORY_CACHE_KEY, {
        entry,
        sha: sha || null,
    });
}

function applyPlayHistoryPayload(data) {
    if (!data) return false;

    state.fileSha = data.sha || null;

    if (data.gameMode) {
        state.gameMode = data.gameMode;
    }
    if (data.playEnv) {
        state.playEnv = data.playEnv;
    } else if (data.environment) {
        state.playEnv = data.environment;
    }
    if (data.dp) {
        state.dp.offi = data.dp.offi ?? CONFIG.DP.DEFAULT_OFFI;
        state.dp.env = data.dp.env ?? CONFIG.DP.DEFAULT_ENV;
    }
    if (data.mode) {
        state.mode = data.mode;
    }

    if (data.modeStates) {
        state.modeStates = normalizeModeStates(data.modeStates);
    } else if (data.history) {
        const legacyModeKey = getModeKey();
        const legacyPlayed = [];
        const legacyStatus = [];
        for (const entry of data.history) {
            const k = songKey(entry.version, entry.song);
            if (!legacyPlayed.includes(k)) legacyPlayed.push(k);
            const existingIdx = legacyStatus.findIndex(([key]) => key === k);
            const statusEntry = [k, { status: entry.status, level: entry.level }];
            if (existingIdx !== -1) {
                legacyStatus[existingIdx] = statusEntry;
            } else {
                legacyStatus.push(statusEntry);
            }
        }

        state.modeStates[legacyModeKey] = {
            history: data.history,
            currentLevelIndex: data.currentLevelIndex ?? 0,
            clearCount: data.clearCount ?? data.history.filter(e => e.status === 'clear').length,
            totalCount: data.totalCount ?? data.history.length,
            playedSongs: legacyPlayed,
            songStatus: legacyStatus,
        };
    }

    restoreModeState(getModeKey());

    const maxIndex = state.gameMode === 'DP' ? 999 : CONFIG.LEVELS.length - 1;
    state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, maxIndex));
    return true;
}

function applyDrumHistoryPayload(data) {
    if (!data) return false;

    state.drumFileSha = data.sha || null;
    const payload = normalizeDrumHistoryPayload(data);
    state.drumRankStore = payload.rankStore;
    state.drumFloorStatuses = payload.floorStatuses;
    state.drumSelectedFloorIndex = clampDrumFloorIndex(payload.selectedFloorIndex);

    localStorage.setItem('drum_ranks_v1', JSON.stringify(state.drumRankStore));
    localStorage.setItem('drum_floor_statuses_v1', JSON.stringify(state.drumFloorStatuses));
    saveDrumSelectedFloorIndex(state.drumSelectedFloorIndex);
    return true;
}

async function getCachedDrumHistoryState() {
    const cached = await getDpCacheFromIdb(CONFIG.DRUM_HISTORY_CACHE_KEY);
    if (!cached || !cached.entry || !cached.savedAt) return null;

    const savedAt = Date.parse(cached.savedAt);
    if (!Number.isFinite(savedAt)) return null;

    const age = Date.now() - savedAt;
    if (age > CONFIG.DRUM_HISTORY_CACHE_TTL_MS) return null;

    return cached;
}

async function saveCachedDrumHistoryState(entry, sha) {
    await saveDpCacheToIdb(CONFIG.DRUM_HISTORY_CACHE_KEY, {
        entry,
        sha: sha || null,
    });
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', () => {
    initializeRouting();

    // Login handlers
    document.getElementById('login-btn').addEventListener('click', handleLogin);
    document.getElementById('password-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLogin();
    });

    // Game action handlers
    document.getElementById('clear-btn').addEventListener('click', () => handleResult('clear'));
    document.getElementById('fail-btn').addEventListener('click', () => handleResult('fail'));

    // History toggle
    document.getElementById('history-toggle').addEventListener('click', toggleHistory);

    // Mode toggle
    document.getElementById('mode-toggle').addEventListener('click', handleModeToggle);

    // Game mode toggle (SP / DP)
    document.getElementById('game-mode-toggle').addEventListener('click', handleGameModeToggle);

    // Play environment toggle (home / arcade)
    document.getElementById('env-toggle').addEventListener('click', handleEnvironmentToggle);

    // DP star level selector
    document.getElementById('dp-offi-down')?.addEventListener('click', () => handleDpOffiChange(-1));
    document.getElementById('dp-offi-up')?.addEventListener('click', () => handleDpOffiChange(1));
    document.getElementById('dp-refresh-btn')?.addEventListener('click', handleDpRefresh);
    document.getElementById('sp-refresh-btn')?.addEventListener('click', handleSpreadsheetRefresh);

    // Try auto-login from saved session
    tryAutoLogin();
});

function getRouteFromHash() {
    const raw = window.location.hash.replace(/^#\/?/, '').toLowerCase();
    return ROUTES[raw] ? raw : DEFAULT_ROUTE;
}

function initializeRouting() {
    state.route = getRouteFromHash();
    if (!window.location.hash || !ROUTES[window.location.hash.replace(/^#\/?/, '').toLowerCase()]) {
        window.location.hash = `#${state.route}`;
    }
    applyRouteUI();

    window.addEventListener('hashchange', () => {
        const nextRoute = getRouteFromHash();
        if (nextRoute === state.route) return;
        state.route = nextRoute;
        applyRouteUI();

        if (state.password) {
            initializeApp().catch(err => console.error('Route switch failed:', err));
        }
    });
}

function applyRouteUI() {
    const routeConfig = ROUTES[state.route] || ROUTES[DEFAULT_ROUTE];
    const loginTitle = document.getElementById('login-title');
    const loginDesc = document.querySelector('.login-desc');
    if (loginTitle) loginTitle.textContent = routeConfig.loginTitle;
    if (loginDesc) loginDesc.textContent = routeConfig.loginDesc;
    document.title = routeConfig.title;

    document.getElementById('route-iidx')?.classList.toggle('active', state.route === 'iidx');
    document.getElementById('route-drum')?.classList.toggle('active', state.route === 'drum');

    document.getElementById('iidx-section')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('drum-section')?.classList.toggle('hidden', state.route !== 'drum');

    document.getElementById('history-panel')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('song-card')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('action-buttons')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('game-mode-toggle')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('env-toggle')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('mode-toggle')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('dp-controls')?.classList.toggle('hidden', state.route !== 'iidx');
    document.getElementById('sp-refresh-btn')?.classList.toggle('hidden', state.route !== 'iidx' || state.gameMode !== 'SP');

    const currentLevel = document.getElementById('current-level');
    if (currentLevel && state.route === 'drum') {
        currentLevel.textContent = 'Drum';
    }

    if (state.route === 'drum') {
        updateHeaderCountForDrum();
    } else {
        updateCountDisplay();
    }
}

// ==================== Login / Authentication ====================

/**
 * Save login session to localStorage with expiry.
 */
function saveSession(password) {
    const session = {
        password,
        expires: Date.now() + CONFIG.SESSION_DAYS * 24 * 60 * 60 * 1000,
    };
    try {
        localStorage.setItem('stager_session', JSON.stringify(session));
    } catch (e) {
        console.warn('Failed to save session:', e);
    }
}

/**
 * Load saved session from localStorage. Returns password or null.
 */
function loadSession() {
    try {
        const raw = localStorage.getItem('stager_session');
        if (!raw) return null;
        const session = JSON.parse(raw);
        if (!session.password || !session.expires) return null;
        if (Date.now() > session.expires) {
            localStorage.removeItem('stager_session');
            return null;
        }
        return session.password;
    } catch (e) {
        return null;
    }
}

/**
 * Clear saved session.
 */
function clearSession() {
    localStorage.removeItem('stager_session');
}

/**
 * Try to auto-login using a saved session.
 * Falls back to showing the login modal.
 */
async function tryAutoLogin() {
    const savedPassword = loadSession();
    if (!savedPassword) {
        document.getElementById('password-input').focus();
        return;
    }

    if (isLocalDevEnvironment()) {
        state.password = savedPassword;
        saveSession(savedPassword);
        await initializeApp();
        return;
    }

    // Attempt silent authentication
    try {
        const authRes = await fetch(`${CONFIG.WORKER_URL}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: savedPassword }),
        });

        if (!authRes.ok) {
            // Saved password is no longer valid
            clearSession();
            document.getElementById('password-input').focus();
            return;
        }
    } catch (e) {
        // Network error - show login modal
        document.getElementById('password-input').focus();
        return;
    }

    // Session valid - extend expiry and proceed to app
    state.password = savedPassword;
    saveSession(savedPassword);
    await initializeApp();
}

async function handleLogin() {
    const passwordInput = document.getElementById('password-input');
    const password = passwordInput.value.trim();
    const errorEl = document.getElementById('login-error');

    errorEl.classList.add('hidden');

    if (!password) {
        showError(errorEl, 'パスワードを入力してください。');
        return;
    }

    if (isLocalDevEnvironment()) {
        state.password = password || 'dev';
        saveSession(state.password);
        await initializeApp();
        return;
    }

    if (!CONFIG.WORKER_URL) {
        showError(errorEl, 'Worker URLが未設定です。app.js の WORKER_URL を設定してください。');
        return;
    }

    // Authenticate via Worker proxy
    try {
        const authRes = await fetch(`${CONFIG.WORKER_URL}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });

        if (!authRes.ok) {
            showError(errorEl, 'パスワードが正しくありません。');
            passwordInput.value = '';
            passwordInput.focus();
            return;
        }
    } catch (e) {
        showError(errorEl, `認証サーバーに接続できません: ${e.message}`);
        return;
    }

    state.password = password;
    saveSession(password);
    await initializeApp();
}

/**
 * Common initialization after successful authentication.
 */
async function initializeApp() {
    const errorEl = document.getElementById('login-error');

    // Transition to loading
    document.getElementById('login-modal').classList.add('hidden');
    document.getElementById('loading-overlay').classList.remove('hidden');

    try {
        if (state.route === 'drum') {
            await loadDrumTowerData();
            document.getElementById('loading-overlay').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            applyRouteUI();
            renderDrumTowerSection();
            updateDrumSummary();
            updateHeaderCountForDrum();
            enableActionButtons(false);
            return;
        }

        // Load play history first to restore gameMode state
        await loadPlayHistory();

        // Then load song data based on restored gameMode
        let hasSongData = true;
        if (state.gameMode === 'DP') {
            hasSongData = await loadDpData();
        } else {
            hasSongData = await loadSpreadsheetData();
        }

        // Clamp level index after data is loaded
        const levels = getCurrentLevels();
        if (levels.length > 0) {
            state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, levels.length - 1));
        }

        // Transition to app
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');

        // Update UI with restored state
        applyRouteUI();
        updateGameModeUI();
        updateEnvironmentUI();
        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();

        if (hasSongData) {
            // Select first song
            selectNextSong();
            // Enable buttons
            enableActionButtons(true);
        } else {
            showDpCacheEmptyState();
        }
    } catch (e) {
        console.error('Initialization failed:', e);
        clearSession();
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('login-modal').classList.remove('hidden');
        showError(errorEl, `初期化に失敗しました: ${e.message}`);
    }
}

// ==================== DrumTower Data / Rendering ====================
async function loadDrumTowerData() {
    const response = await fetch('./data/drumtower_floors_app.json');
    if (!response.ok) {
        throw new Error(`Failed to load DrumTower JSON: ${response.status}`);
    }

    const data = await response.json();
    state.drumFloors = Array.isArray(data.floors) ? data.floors : [];
    await loadDrumHistory();
}

function renderDrumTowerSection() {
    const list = document.getElementById('drum-floor-list');
    if (!list) return;

    list.innerHTML = '';

    if (state.drumFloors.length === 0) {
        return;
    }

    state.drumSelectedFloorIndex = clampDrumFloorIndex(state.drumSelectedFloorIndex);
    const floor = state.drumFloors[state.drumSelectedFloorIndex];
    list.appendChild(renderDrumFloorCard(floor, state.drumSelectedFloorIndex));
    renderDrumFloorNavigation();
}

function clampDrumFloorIndex(index) {
    if (state.drumFloors.length === 0) return 0;
    return Math.max(0, Math.min(index, state.drumFloors.length - 1));
}

function renderDrumFloorNavigation() {
    let nav = document.getElementById('drum-floor-nav');
    if (!nav) {
        nav = document.createElement('div');
        nav.id = 'drum-floor-nav';
        nav.className = 'drum-floor-nav';
        const head = document.querySelector('#drum-section .drum-page-head');
        if (head) {
            head.appendChild(nav);
        }
    }

    nav.innerHTML = '';

    const prev = document.createElement('button');
    prev.className = 'drum-floor-nav-btn';
    prev.textContent = '◀';
    prev.title = 'Previous floor';
    prev.disabled = state.drumSelectedFloorIndex <= 0;
    prev.addEventListener('click', () => {
        state.drumSelectedFloorIndex = clampDrumFloorIndex(state.drumSelectedFloorIndex - 1);
        saveDrumSelectedFloorIndex(state.drumSelectedFloorIndex);
        saveDrumHistory().catch(err => console.error('Failed to save drum selected floor:', err));
        renderDrumTowerSection();
        updateDrumSummary();
        updateHeaderCountForDrum();
    });

    const label = document.createElement('span');
    label.className = 'drum-floor-nav-label';
    const current = state.drumFloors[state.drumSelectedFloorIndex];
    label.textContent = `${state.drumSelectedFloorIndex + 1} / ${state.drumFloors.length} ${current?.floor || ''}`;

    const next = document.createElement('button');
    next.className = 'drum-floor-nav-btn';
    next.textContent = '▶';
    next.title = 'Next floor';
    next.disabled = state.drumSelectedFloorIndex >= state.drumFloors.length - 1;
    next.addEventListener('click', () => {
        state.drumSelectedFloorIndex = clampDrumFloorIndex(state.drumSelectedFloorIndex + 1);
        saveDrumSelectedFloorIndex(state.drumSelectedFloorIndex);
        saveDrumHistory().catch(err => console.error('Failed to save drum selected floor:', err));
        renderDrumTowerSection();
        updateDrumSummary();
        updateHeaderCountForDrum();
    });

    nav.appendChild(prev);
    nav.appendChild(label);
    nav.appendChild(next);
}

function renderDrumFloorCard(floor, index) {
    const floorKey = floor.floor || String(index);
    const stats = evaluateDrumFloor(floor, floorKey);

    const card = document.createElement('section');
    card.className = 'drum-floor-card';
    if (stats.bossFail) {
        card.classList.add('boss-fail');
    }

    const head = document.createElement('div');
    head.className = 'drum-floor-head';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'drum-floor-title';

    const title = document.createElement('h3');
    title.textContent = floor.floor || `Floor ${index + 1}`;
    titleWrap.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'drum-floor-meta';
    meta.textContent = `${stats.sCount}/${floor.songCount || floor.songs.length} S+ · ${stats.needed} needed${stats.bossFail ? ' · boss fail' : ''}`;
    titleWrap.appendChild(meta);

    const statusBtn = document.createElement('button');
    statusBtn.className = 'drum-floor-status';
    statusBtn.dataset.cleared = String(Boolean(stats.cleared));
    statusBtn.textContent = stats.cleared ? 'CLEARED' : 'LOCKED';
    statusBtn.title = 'Toggle persisted floor clear state';
    statusBtn.addEventListener('click', () => {
        const statuses = loadDrumFloorStatuses();
        const current = statuses[floorKey] || {};
        current.cleared = !current.cleared;
        current.updatedAt = new Date().toISOString();
        statuses[floorKey] = current;
        state.drumFloorStatuses = statuses;
        saveDrumHistory().catch(err => console.error('Failed to save drum floor state:', err));
        renderDrumTowerSection();
        updateDrumSummary();
        updateHeaderCountForDrum();
    });

    head.appendChild(titleWrap);
    head.appendChild(statusBtn);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'drum-floor-body';

    for (const song of floor.songs || []) {
        body.appendChild(renderDrumSongRow(floorKey, song));
    }

    card.appendChild(body);
    return card;
}

function renderDrumSongRow(floorKey, song) {
    const songKey = `${floorKey}|${song.idx}`;
    const row = document.createElement('div');
    row.className = 'drum-song-row';

    if (song.clearType === 'boss' || normalizeDrumTags(song.tags).includes('보스곡')) {
        row.classList.add('boss');
    }

    const name = document.createElement('span');
    name.className = 'song-name';
    name.textContent = song.displayName || song.songName || '';

    const version = document.createElement('span');
    version.className = 'song-version';
    version.textContent = song.version || '';

    const diff = document.createElement('span');
    diff.className = 'song-diff';
    diff.textContent = song.difficultyLabel || '';

    const level = document.createElement('span');
    level.className = 'song-level';
    level.textContent = song.level ?? '';

    const tags = document.createElement('span');
    tags.className = 'song-tags';
    tags.textContent = normalizeDrumTags(song.tags).join('\n');

    const toggle = document.createElement('button');
    toggle.className = 'song-toggle';
    toggle.dataset.rank = state.drumRankStore[songKey] || '';
    toggle.textContent = state.drumRankStore[songKey] === 'S' ? 'S' : '-';
    toggle.title = 'Toggle S rank';
    toggle.addEventListener('click', () => {
        const next = state.drumRankStore[songKey] === 'S' ? '' : 'S';
        saveDrumRank(floorKey, song.idx, next);
        state.drumRankStore = loadDrumRankStore();
        state.drumSelectedFloorIndex = clampDrumFloorIndex(state.drumSelectedFloorIndex);
        saveDrumHistory().catch(err => console.error('Failed to save drum rank state:', err));
        renderDrumTowerSection();
        updateDrumSummary();
        updateHeaderCountForDrum();
    });

    row.appendChild(name);
    row.appendChild(version);
    row.appendChild(diff);
    row.appendChild(level);
    row.appendChild(tags);
    row.appendChild(toggle);
    return row;
}

function normalizeDrumTags(tags) {
    if (typeof tags === 'string') {
        return tags.split(',').map(tag => tag.trim()).filter(Boolean);
    }
    if (Array.isArray(tags)) {
        return tags.map(tag => String(tag).trim()).filter(Boolean);
    }
    return [];
}

function evaluateDrumFloor(floor, floorKey) {
    const statuses = state.drumFloorStatuses || loadDrumFloorStatuses();
    const saved = statuses[floorKey] || {};
    const needed = Math.ceil((floor.songCount || floor.songs.length) * 3 / 4);

    let sCount = 0;
    let bossFail = false;

    for (const song of floor.songs || []) {
        const songKey = `${floorKey}|${song.idx}`;
        const rank = state.drumRankStore[songKey] || '';
        if (rank === 'S') {
            sCount++;
        }

        const tags = normalizeDrumTags(song.tags);
        const isBoss = song.clearType === 'boss' || tags.includes('보스곡');
        if (isBoss && rank !== 'S') {
            bossFail = true;
        }
    }

    const autoCleared = sCount >= needed && !bossFail;
    const cleared = typeof saved.cleared === 'boolean' ? saved.cleared : autoCleared;

    statuses[floorKey] = {
        cleared,
        autoCleared,
        sCount,
        needed,
        bossFail,
        updatedAt: saved.updatedAt || new Date().toISOString(),
    };
    state.drumFloorStatuses = statuses;

    return statuses[floorKey];
}

function updateDrumSummary() {
    const summary = document.getElementById('drum-summary');
    const stats = document.getElementById('drum-summary-stats');
    if (!summary || !stats) return;

    const floor = state.drumFloors[state.drumSelectedFloorIndex];
    if (!floor) {
        summary.textContent = 'No DrumTower data loaded';
        stats.innerHTML = '';
        return;
    }

    const floorKey = floor.floor || String(state.drumSelectedFloorIndex);
    const floorStats = evaluateDrumFloor(floor, floorKey);

    summary.textContent = `${floor.floor || `Floor ${state.drumSelectedFloorIndex + 1}`} / ${floor.songCount || floor.songs.length} songs`;
    stats.innerHTML = '';

    const pills = [
        {
            text: `${floorStats.sCount}/${floorStats.needed} S`,
            ok: floorStats.sCount >= floorStats.needed,
        },
        {
            text: floorStats.bossFail ? 'boss fail' : 'boss ok',
            ok: !floorStats.bossFail,
        },
    ];

    for (const item of pills) {
        const pill = document.createElement('span');
        pill.className = 'drum-stat-pill';
        pill.textContent = item.text;
        pill.classList.toggle('drum-stat-pill-ok', Boolean(item.ok));
        pill.classList.toggle('drum-stat-pill-bad', !item.ok);
        stats.appendChild(pill);
    }
}

function updateHeaderCountForDrum() {
    const count = document.getElementById('song-count');
    if (!count) return;
    const floors = state.drumFloors.length;
    const songs = state.drumFloors.reduce((total, floor) => total + (floor.songCount || (floor.songs || []).length), 0);
    count.textContent = `${floors}F / ${songs} songs`;
}

function loadDrumSelectedFloorIndex() {
    try {
        const raw = localStorage.getItem('drum_selected_floor_v1');
        if (raw == null) return 0;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch (e) {
        return 0;
    }
}

function saveDrumSelectedFloorIndex(index) {
    try {
        localStorage.setItem('drum_selected_floor_v1', String(index));
    } catch (e) {
        console.warn('Failed to save selected DrumTower floor:', e);
    }
}

function loadDrumFloorStatuses() {
    if (state.drumFloorStatuses && Object.keys(state.drumFloorStatuses).length > 0) {
        return state.drumFloorStatuses;
    }
    try {
        const raw = localStorage.getItem('drum_floor_statuses_v1');
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
}

function loadDrumRankStore() {
    if (state.drumRankStore && Object.keys(state.drumRankStore).length > 0) {
        return state.drumRankStore;
    }
    try {
        const raw = localStorage.getItem('drum_ranks_v1');
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
}

function saveDrumRank(floorName, sIdx, value) {
    const key = `${floorName}|${sIdx}`;
    const store = { ...(state.drumRankStore || loadDrumRankStore()) };
    if (value) store[key] = value; else delete store[key];
    state.drumRankStore = store;
    localStorage.setItem('drum_ranks_v1', JSON.stringify(store));
}

async function loadDrumHistory() {
    try {
        const cached = await getCachedDrumHistoryState();
        if (cached?.entry && applyDrumHistoryPayload({ ...cached.entry, sha: cached.sha || null })) {
            console.log('Restored drum history from IndexedDB cache');
            return;
        }

        const response = await workerFetch('/api/drum-history');
        if (!response.ok) {
            throw new Error(`Worker API error: ${response.status}`);
        }

        const data = await response.json();
        if (!data.exists) {
            state.drumFileSha = null;
            state.drumRankStore = loadDrumRankStore();
            state.drumFloorStatuses = loadDrumFloorStatuses();
            state.drumSelectedFloorIndex = clampDrumFloorIndex(loadDrumSelectedFloorIndex());
            await saveCachedDrumHistoryState({
                schemaVersion: 1,
                route: 'drum',
                selectedFloorIndex: state.drumSelectedFloorIndex,
                rankStore: state.drumRankStore,
                floorStatuses: state.drumFloorStatuses,
                lastUpdated: new Date().toISOString(),
            }, null);
            return;
        }

        applyDrumHistoryPayload({ ...data, sha: data.sha || null });
        await saveCachedDrumHistoryState(data, data.sha || null);
    } catch (e) {
        console.error('Failed to load drum history:', e);
        state.drumRankStore = loadDrumRankStore();
        state.drumFloorStatuses = loadDrumFloorStatuses();
        state.drumSelectedFloorIndex = clampDrumFloorIndex(loadDrumSelectedFloorIndex());
        try {
            const cached = await getCachedDrumHistoryState();
            if (cached?.entry) {
                applyDrumHistoryPayload({ ...cached.entry, sha: cached.sha || null });
                console.warn('Using stale IndexedDB drum history cache after load failure');
            }
        } catch (cacheError) {
            console.warn('Failed to restore stale drum history cache:', cacheError);
        }
    }
}

async function saveDrumHistory() {
    const payload = {
        schemaVersion: 1,
        route: 'drum',
        selectedFloorIndex: clampDrumFloorIndex(state.drumSelectedFloorIndex || 0),
        rankStore: state.drumRankStore || {},
        floorStatuses: state.drumFloorStatuses || {},
        lastUpdated: new Date().toISOString(),
    };

    const body = {
        content: payload,
        message: `Update drum history - ${state.drumSelectedFloorIndex + 1}F - ${new Date().toISOString()}`,
    };

    if (state.drumFileSha) {
        body.sha = state.drumFileSha;
    }

    const response = await workerFetch('/api/drum-history', {
        method: 'PUT',
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Worker PUT failed: ${response.status} - ${errorData.detail || ''}`);
    }

    const data = await response.json();
    state.drumFileSha = data.sha || null;
    saveDrumSelectedFloorIndex(payload.selectedFloorIndex);
    await saveCachedDrumHistoryState(payload, state.drumFileSha);
}

function normalizeDrumHistoryPayload(data) {
    const rankStore = data.rankStore || data.drumRankStore || data.ranks || data.data?.rankStore || {};
    const floorStatuses = data.floorStatuses || data.drumFloorStatuses || data.floors || data.data?.floorStatuses || {};
    const selectedFloorIndex = data.selectedFloorIndex ?? data.drumSelectedFloorIndex ?? data.currentFloorIndex ?? data.data?.selectedFloorIndex ?? 0;

    return {
        rankStore,
        floorStatuses,
        selectedFloorIndex,
    };
}

// ==================== Spreadsheet Data Loading ====================
async function loadSpreadsheetData() {
    return loadSpreadsheetDataWithCache({ forceRefresh: false });
}

async function loadSpreadsheetDataWithCache({ forceRefresh = false } = {}) {
    const key = getSpCacheKey();
    if (!forceRefresh) {
        const cached = await getDpCacheFromIdb(key);

        if (cached?.entry) {
            applySpreadsheetCacheEntry(cached.entry);

            if (state.versions.length > 0) {
                console.log(`Loaded ${state.totalSongsInDB} songs across ${state.versions.length} versions from IndexedDB cache`);
                return true;
            }
        }
    }

    const gid = CONFIG.SHEET_GIDS[state.mode];
    if (gid == null) {
        throw new Error(`Sheet GID not configured for mode: ${state.mode}`);
    }

    const csvUrl = `${CONFIG.SPREADSHEET_BASE}?gid=${gid}&single=true&output=csv`;

    const response = await fetch(csvUrl);
    if (!response.ok) {
        throw new Error(`Spreadsheet fetch failed: ${response.status}`);
    }

    const csvText = await response.text();
    parseSpreadsheetCSV(csvText);

    if (state.versions.length === 0) {
        throw new Error('No versions found in spreadsheet data');
    }

    await saveDpCacheToIdb(key, {
        entry: createSpreadsheetCacheEntry(),
        sha: null,
    });

    console.log(`Loaded ${state.totalSongsInDB} songs across ${state.versions.length} versions`);
    return true;
}

function parseSpreadsheetCSV(csvText) {
    const result = Papa.parse(csvText, {
        header: false,
        skipEmptyLines: false,
    });

    const rows = result.data;

    // Step 1: Find the header row containing version names
    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const row = rows[i];
        const rowText = row.join(' ');
        // Check for known version markers
        if (CONFIG.VERSION_MARKERS.some(marker => rowText.includes(marker))) {
            headerRowIndex = i;
            break;
        }
    }

    if (headerRowIndex === -1) {
        throw new Error('Could not find header row with version names');
    }

    const headerRow = rows[headerRowIndex];

    // Step 2: Extract version names (skip first column = label, last column = label)
    state.versions = [];
    const versionColMap = {}; // version -> column index

    for (let col = 1; col < headerRow.length - 1; col++) {
        const version = headerRow[col].trim();
        if (version) {
            state.versions.push(version);
            versionColMap[version] = col;
        }
    }

    // Step 3: Parse level rows
    state.songDB = {};
    state.totalSongsInDB = 0;

    for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) continue;

        const rawLevel = row[0] ? row[0].trim() : '';
        const level = normalizeLevel(rawLevel);

        if (!CONFIG.LEVELS.includes(level)) continue;

        for (const version of state.versions) {
            const col = versionColMap[version];
            if (col >= row.length) continue;

            const cellContent = row[col] ? row[col].trim() : '';
            if (!cellContent) continue;

            // Songs are separated by newlines within the CSV cell
            const songs = cellContent
                .split('\n')
                .map(s => s.trim())
                .filter(s => s.length > 0);

            if (songs.length === 0) continue;

            if (!state.songDB[version]) {
                state.songDB[version] = {};
            }
            state.songDB[version][level] = songs;
            state.totalSongsInDB += songs.length;
        }
    }
}

function applySpreadsheetCacheEntry(entry) {
    state.songDB = entry?.songDB && typeof entry.songDB === 'object'
        ? JSON.parse(JSON.stringify(entry.songDB))
        : {};
    state.versions = Array.isArray(entry?.versions) ? [...entry.versions] : [];
    state.totalSongsInDB = Number.isFinite(entry?.totalSongsInDB) ? entry.totalSongsInDB : 0;
}

function createSpreadsheetCacheEntry() {
    return {
        mode: state.mode,
        versions: [...state.versions],
        totalSongsInDB: state.totalSongsInDB,
        songDB: state.songDB,
        parsedAt: new Date().toISOString(),
    };
}

/**
 * Normalize level labels from spreadsheet format
 * Converts fullwidth plus signs: B＋ → B+, A＋ → A+, S＋ → S+
 */
function normalizeLevel(level) {
    return level
        .replace(/＋/g, '+')
        .replace(/\s+/g, '')
        .trim();
}

// ==================== DP Data Loading ====================

/**
 * Load DP difficulty table from zasa.sakura.ne.jp via Worker proxy
 */
async function loadDpData() {
    const key = getDpCacheKey();
    const cached = await getDpCacheFromIdb(key);

    if (cached?.entry) {
        state.dpCacheFileSha = cached.sha || null;
        applyDpCacheEntry(cached.entry);

        if (state.dp.levels.length > 0) {
            console.log(`DP ☆${state.dp.offi}: Loaded ${state.totalSongsInDB} songs from IndexedDB cache across ${state.dp.levels.length} rank levels`);
            return true;
        }
    }

    const response = await workerFetch(`/api/dp-rank-cache?key=${encodeURIComponent(key)}`);

    if (!response.ok) {
        // Some Worker deployments may not include dp-rank-cache routes yet.
        // Treat 404 as cache-miss instead of hard failure.
        if (response.status === 404) {
            state.dpCacheFileSha = null;
            state.songDB = {};
            state.versions = [];
            state.dp.levels = [];
            state.totalSongsInDB = 0;
            return false;
        }
        throw new Error(`DP cache fetch failed: ${response.status}`);
    }

    const data = await response.json();
    state.dpCacheFileSha = data.sha || null;

    if (!data.entry) {
        state.songDB = {};
        state.versions = [];
        state.dp.levels = [];
        state.totalSongsInDB = 0;
        return false;
    }

    applyDpCacheEntry(data.entry);
    await saveDpCacheToIdb(key, { entry: data.entry, sha: data.sha || null });

    if (state.dp.levels.length === 0) {
        throw new Error('No levels found in cached DP data');
    }

    console.log(`DP ☆${state.dp.offi}: Loaded ${state.totalSongsInDB} songs from cache across ${state.dp.levels.length} rank levels`);
    return true;
}

/**
 * Parse the HTML table from the DP ranking site into songDB
 * 
 * Structure: <table class="rank_p1">
 *   <tr> header row with <th> version names </tr>
 *   <tr class="tile_*"> <td class="rank">level</td> <td> songs... </td> ... </tr>
 * </table>
 */
function parseDpHtml(html) {
    // Reset
    state.songDB = {};
    state.versions = [];
    state.dp.levels = [];
    state.totalSongsInDB = 0;

    // Create a DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const table = doc.querySelector('table.rank_p1');
    if (!table) {
        throw new Error('Could not find rank_p1 table in DP response');
    }

    const rows = table.querySelectorAll('tr');
    if (rows.length < 2) {
        throw new Error('DP table has insufficient rows');
    }

    // Parse header row to get version names
    const headerCells = rows[0].querySelectorAll('th');
    const versionMap = []; // index -> version name (skip first and last "rank" columns)

    for (let i = 0; i < headerCells.length; i++) {
        const th = headerCells[i];
        if (th.classList.contains('rank')) {
            versionMap.push(null); // skip rank columns
        } else {
            const vName = th.textContent.trim();
            versionMap.push(vName);
            if (vName && !state.versions.includes(vName)) {
                state.versions.push(vName);
            }
        }
    }

    // Parse data rows
    const levelsSet = new Set();

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

        // First cell with class "rank" contains the level
        let level = null;
        let dataStartIdx = 0;

        for (let c = 0; c < cells.length; c++) {
            if (cells[c].classList.contains('rank')) {
                const rankText = cells[c].textContent.trim();
                if (rankText && !level) {
                    level = rankText;
                    dataStartIdx = c + 1;
                }
            }
        }

        if (!level) continue;
        levelsSet.add(level);

        // Parse song cells - each non-rank <td> corresponds to a version
        let versionIdx = 0;
        for (let c = 0; c < cells.length; c++) {
            if (cells[c].classList.contains('rank')) continue;

            // Map this cell to a version
            // We need to find the correct version - skip null entries in versionMap
            while (versionIdx < versionMap.length && versionMap[versionIdx] === null) {
                versionIdx++;
            }
            const version = versionMap[versionIdx] || null;
            versionIdx++;

            if (!version) continue;

            // Extract song names from <a class="music"> links
            const links = cells[c].querySelectorAll('a.music');
            if (links.length === 0) continue;

            const songs = [];
            for (const link of links) {
                const songName = link.textContent.trim();
                if (songName) songs.push(songName);
            }

            if (songs.length === 0) continue;

            if (!state.songDB[version]) {
                state.songDB[version] = {};
            }
            if (!state.songDB[version][level]) {
                state.songDB[version][level] = [];
            }
            state.songDB[version][level].push(...songs);
            state.totalSongsInDB += songs.length;
        }
    }

    // Sort levels numerically ascending
    state.dp.levels = Array.from(levelsSet).sort((a, b) => parseFloat(a) - parseFloat(b));
}

function getDpCacheKey() {
    return `DP_${state.dp.env}_${state.dp.offi}`;
}

function applyDpCacheEntry(entry) {
    state.songDB = entry?.songDB && typeof entry.songDB === 'object'
        ? JSON.parse(JSON.stringify(entry.songDB))
        : {};
    state.versions = Array.isArray(entry?.versions) ? [...entry.versions] : [];
    state.dp.levels = Array.isArray(entry?.levels) ? [...entry.levels] : [];
    state.totalSongsInDB = Number.isFinite(entry?.totalSongsInDB) ? entry.totalSongsInDB : 0;
}

function createDpCacheEntry() {
    return {
        offi: state.dp.offi,
        env: state.dp.env,
        mode: 'p1',
        cat: 0,
        versions: [...state.versions],
        levels: [...state.dp.levels],
        totalSongsInDB: state.totalSongsInDB,
        songDB: state.songDB,
        parsedAt: new Date().toISOString(),
    };
}

async function fetchAndStoreDpData() {
    const response = await workerFetch('/api/dp-rank', {
        method: 'POST',
        body: JSON.stringify({
            offi: state.dp.offi,
            env: state.dp.env,
            cat: 0,
            mode: 'p1',
        }),
    });

    if (!response.ok) {
        throw new Error(`DP rank fetch failed: ${response.status}`);
    }

    const data = await response.json();
    parseDpHtml(data.html);

    if (state.dp.levels.length === 0) {
        throw new Error('No levels found in DP ranking data');
    }

    const saveResponse = await workerFetch('/api/dp-rank-cache', {
        method: 'PUT',
        body: JSON.stringify({
            key: getDpCacheKey(),
            entry: createDpCacheEntry(),
            sha: state.dpCacheFileSha,
            message: `Update DP cache ${getDpCacheKey()} - ${new Date().toISOString()}`,
        }),
    });

    if (!saveResponse.ok) {
        // Allow DP refresh to proceed even when cache API is not deployed yet.
        if (saveResponse.status === 404) {
            console.warn('DP cache endpoint is unavailable (404). Continuing without cache save.');
            state.dpCacheFileSha = null;
            return;
        }
        const errorData = await saveResponse.json().catch(() => ({}));
        throw new Error(`DP cache save failed: ${saveResponse.status} - ${errorData.detail || ''}`);
    }

    const saveData = await saveResponse.json();
    state.dpCacheFileSha = saveData.sha || state.dpCacheFileSha;
    await saveDpCacheToIdb(getDpCacheKey(), {
        entry: createDpCacheEntry(),
        sha: state.dpCacheFileSha,
    });

    console.log(`DP ☆${state.dp.offi}: Parsed and cached ${state.totalSongsInDB} songs across ${state.dp.levels.length} rank levels`);
}

function showDpCacheEmptyState() {
    state.currentSong = null;
    state.currentVersion = null;
    state.currentLevel = null;
    document.getElementById('song-name').textContent = 'DP 難易度表キャッシュがありません';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '更新ボタンで難易度表を取得してください';
    enableActionButtons(false);
}

function setDpRefreshButtonBusy(isBusy) {
    const refreshBtn = document.getElementById('dp-refresh-btn');
    if (!refreshBtn) return;
    refreshBtn.disabled = isBusy;
    refreshBtn.textContent = isBusy ? '更新中' : '更新';
}

async function handleDpRefresh() {
    if (state.isProcessing || state.gameMode !== 'DP') return;

    state.isProcessing = true;
    enableActionButtons(false);
    setDpRefreshButtonBusy(true);

    document.getElementById('song-name').textContent = '難易度表更新中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    try {
        await fetchAndStoreDpData();

        if (state.dp.levels.length > 0) {
            state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, state.dp.levels.length - 1));
        }

        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();
        selectNextSong();
        enableActionButtons(true);
    } catch (e) {
        console.error('DP refresh failed:', e);
        showDpCacheEmptyState();
    }

    setDpRefreshButtonBusy(false);
    state.isProcessing = false;
}

function setSpreadsheetRefreshButtonBusy(isBusy) {
    const refreshBtn = document.getElementById('sp-refresh-btn');
    if (!refreshBtn) return;
    refreshBtn.disabled = isBusy;
    refreshBtn.textContent = isBusy ? '更新中' : '更新';
}

async function handleSpreadsheetRefresh() {
    if (state.isProcessing || state.gameMode !== 'SP') return;

    state.isProcessing = true;
    enableActionButtons(false);
    setSpreadsheetRefreshButtonBusy(true);

    document.getElementById('song-name').textContent = '難易度表更新中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    try {
        await loadSpreadsheetDataWithCache({ forceRefresh: true });

        const levels = getCurrentLevels();
        if (levels.length > 0) {
            state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, levels.length - 1));
        }

        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();
        selectNextSong();
        enableActionButtons(true);
    } catch (e) {
        console.error('SP refresh failed:', e);
        if (state.versions.length > 0) {
            updateLevelDisplay();
            updateCountDisplay();
            renderFullHistory();
            selectNextSong();
            enableActionButtons(true);
        } else {
            document.getElementById('song-name').textContent = '難易度表の更新に失敗しました';
            enableActionButtons(false);
        }
    }

    setSpreadsheetRefreshButtonBusy(false);
    state.isProcessing = false;
}

/**
 * Get current levels array depending on game mode
 */
function getCurrentLevels() {
    return state.gameMode === 'DP' ? state.dp.levels : CONFIG.LEVELS;
}

/**
 * Get current level string
 */
function getCurrentLevel() {
    const levels = getCurrentLevels();
    return levels[state.currentLevelIndex] || levels[0];
}

// ==================== Song Selection Algorithm ====================
function selectNextSong() {
    const levels = getCurrentLevels();
    const level = levels[state.currentLevelIndex];

    // Try from latest version backwards (fallback logic)
    for (let v = state.versions.length - 1; v >= 0; v--) {
        const version = state.versions[v];
        const songs = state.songDB[version]?.[level] || [];

        // Filter out songs played in current session
        const available = songs.filter(s => !state.playedSongs.has(songKey(version, s)));

        if (available.length > 0) {
            const song = pickRandom(available);
            displaySong(song, version, level);
            return;
        }
    }

    // All songs at this level have been played - re-enable only failed songs first
    clearFailedSongsForLevel(level);

    for (let v = state.versions.length - 1; v >= 0; v--) {
        const version = state.versions[v];
        const songs = state.songDB[version]?.[level] || [];
        const available = songs.filter(s => !state.playedSongs.has(songKey(version, s)));

        if (available.length > 0) {
            const song = pickRandom(available);
            displaySong(song, version, level);
            return;
        }
    }

    // No failed songs to retry - try a cleared song from the next higher level
    const higherLevel = levels[Math.min(state.currentLevelIndex + 1, levels.length - 1)];
    if (higherLevel !== level) {
        const clearedHigher = getClearedSongsForLevel(higherLevel);
        if (clearedHigher.length > 0) {
            const pick = pickRandom(clearedHigher);
            displaySong(pick.song, pick.version, higherLevel);
            return;
        }

        // No cleared songs at higher level - pick any song from higher level
        for (let v = state.versions.length - 1; v >= 0; v--) {
            const version = state.versions[v];
            const songs = state.songDB[version]?.[higherLevel] || [];
            if (songs.length > 0) {
                const song = pickRandom(songs);
                displaySong(song, version, higherLevel);
                return;
            }
        }
    }

    // Fallback: reset all at current level and pick
    clearAllPlayedSongsForLevel(level);

    for (let v = state.versions.length - 1; v >= 0; v--) {
        const version = state.versions[v];
        const songs = state.songDB[version]?.[level] || [];

        if (songs.length > 0) {
            const song = pickRandom(songs);
            displaySong(song, version, level);
            return;
        }
    }

    // No songs exist at this level at all
    state.currentSong = null;
    state.currentVersion = null;
    document.getElementById('song-name').textContent = 'このレベルに曲がありません';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = `Level: ${level}`;
    enableActionButtons(false);
}

/**
 * Remove only songs that were failed at this level from playedSongs,
 * so they can be retried while cleared songs stay excluded.
 */
function clearFailedSongsForLevel(level) {
    const failed = getFailedSongsForLevel(level);
    for (const { song, version } of failed) {
        state.playedSongs.delete(songKey(version, song));
    }
}

/**
 * Remove all songs at this level from playedSongs (full reset fallback).
 */
function clearAllPlayedSongsForLevel(level) {
    for (const version of state.versions) {
        const songs = state.songDB[version]?.[level] || [];
        for (const song of songs) {
            state.playedSongs.delete(songKey(version, song));
        }
    }
}

/**
 * Get songs at a given level whose latest result is 'clear'.
 * Returns array of { song, version } objects.
 */
function getClearedSongsForLevel(level) {
    const result = [];
    for (const version of state.versions) {
        const songs = state.songDB[version]?.[level] || [];
        for (const song of songs) {
            const info = state.songStatus.get(songKey(version, song));
            if (info && info.status === 'clear' && info.level === level) {
                result.push({ song, version });
            }
        }
    }
    return result;
}

/**
 * Get songs at a given level whose latest result is 'fail'.
 * Returns array of { song, version } objects.
 */
function getFailedSongsForLevel(level) {
    const result = [];
    for (const version of state.versions) {
        const songs = state.songDB[version]?.[level] || [];
        for (const song of songs) {
            const info = state.songStatus.get(songKey(version, song));
            if (info && info.status === 'fail' && info.level === level) {
                result.push({ song, version });
            }
        }
    }
    return result;
}

/**
 * Get the latest status for a specific song.
 * Returns { status, level } or null.
 */
function getSongStatus(version, song) {
    return state.songStatus.get(songKey(version, song)) || null;
}

function displaySong(song, version, level) {
    state.currentSong = song;
    state.currentVersion = version;
    state.currentLevel = level;

    // Sync currentLevelIndex to match displayed level
    const levels = getCurrentLevels();
    const levelIdx = levels.indexOf(level);
    if (levelIdx !== -1) {
        state.currentLevelIndex = levelIdx;
        updateLevelDisplay();
    }

    const songNameEl = document.getElementById('song-name');
    songNameEl.textContent = song;
    songNameEl.classList.remove('animate');
    // Trigger reflow for animation restart
    void songNameEl.offsetWidth;
    songNameEl.classList.add('animate');

    document.getElementById('song-version').textContent = version;
    document.getElementById('song-level').textContent = `Level: ${level}`;

    enableActionButtons(true);
}

// ==================== Result Handling ====================
async function handleResult(result) {
    if (state.isProcessing || !state.currentSong) return;
    state.isProcessing = true;
    enableActionButtons(false);

    // Use the level of the displayed song (may differ from currentLevelIndex
    // when a higher-level song was selected)
    const levels = getCurrentLevels();
    const level = state.currentLevel || levels[state.currentLevelIndex];

    // Flash effect on song card
    const songCard = document.getElementById('song-card');
    songCard.classList.remove('flash-clear', 'flash-fail');
    void songCard.offsetWidth;
    songCard.classList.add(result === 'clear' ? 'flash-clear' : 'flash-fail');

    // Record result
    const entry = {
        song: state.currentSong,
        version: state.currentVersion,
        level: level,
        status: result,
        timestamp: new Date().toISOString(),
        modeKey: getModeKey(),
    };

    state.history.push(entry);
    const key = songKey(state.currentVersion, state.currentSong);
    state.playedSongs.add(key);
    state.songStatus.set(key, { status: result, level });

    // Update counters
    state.totalCount++;
    if (result === 'clear') state.clearCount++;

    // Update level
    if (result === 'clear') {
        state.currentLevelIndex = Math.min(state.currentLevelIndex + 1, levels.length - 1);
    } else {
        state.currentLevelIndex = Math.max(state.currentLevelIndex - 1, 0);
    }

    // Update UI
    addHistoryEntry(entry);
    updateLevelDisplay();
    updateCountDisplay();

    // Save to GitHub (non-blocking for UX)
    savePlayHistory().catch(err => {
        console.error('Failed to save history:', err);
    });

    // Small delay for visual feedback
    await sleep(300);

    // Select next song
    selectNextSong();

    state.isProcessing = false;
}

// ==================== Worker Proxy API ====================
/**
 * Helper to call Worker API with authentication
 */
async function workerFetch(path, options = {}) {
    if (isLocalDevEnvironment()) {
        const [mockPath, mockQuery = ''] = path.split('?');
        const mockParams = new URLSearchParams(mockQuery);

        if (mockPath === '/api/history') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ exists: false, history: [], currentLevelIndex: 0 }),
                text: async () => JSON.stringify({ exists: false, history: [], currentLevelIndex: 0 }),
            };
        }

        if (mockPath === '/api/drum-history') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ exists: false, schemaVersion: 1, route: 'drum', rankStore: {}, floorStatuses: {}, selectedFloorIndex: 0 }),
                text: async () => JSON.stringify({ exists: false, schemaVersion: 1, route: 'drum', rankStore: {}, floorStatuses: {}, selectedFloorIndex: 0 }),
            };
        }

        if (mockPath === '/api/dp-rank-cache') {
            const key = mockParams.get('key') || getDpCacheKey();
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    exists: true,
                    key,
                    entry: {
                        offi: state.dp.offi,
                        env: state.dp.env,
                        mode: 'p1',
                        cat: 0,
                        versions: ['Dummy'],
                        levels: ['11'],
                        totalSongsInDB: 1,
                        songDB: { Dummy: { '11': ['Dummy Song'] } },
                        parsedAt: new Date().toISOString(),
                    },
                    sha: null,
                }),
                text: async () => JSON.stringify({
                    exists: true,
                    key,
                    entry: {
                        offi: state.dp.offi,
                        env: state.dp.env,
                        mode: 'p1',
                        cat: 0,
                        versions: ['Dummy'],
                        levels: ['11'],
                        totalSongsInDB: 1,
                        songDB: { Dummy: { '11': ['Dummy Song'] } },
                        parsedAt: new Date().toISOString(),
                    },
                    sha: null,
                }),
            };
        }

        if (mockPath === '/api/dp-rank') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ html: '<table class="rank_p1"><tr><th class="rank">rank</th><th>Dummy</th></tr><tr><td class="rank">11</td><td><a class="music">Dummy Song</a></td></tr></table>' }),
                text: async () => '<table class="rank_p1"><tr><th class="rank">rank</th><th>Dummy</th></tr><tr><td class="rank">11</td><td><a class="music">Dummy Song</a></td></tr></table>',
            };
        }

        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, sha: null }),
            text: async () => JSON.stringify({ ok: true, sha: null }),
        };
    }

    const url = `${CONFIG.WORKER_URL}${path}`;
    const headers = {
        'Authorization': `Bearer ${state.password}`,
        'Content-Type': 'application/json',
        ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    return response;
}

async function loadPlayHistory() {
    try {
        const cached = await getCachedHistoryState();
        if (cached?.entry && applyPlayHistoryPayload({ ...cached.entry, sha: cached.sha || null })) {
            console.log('Restored play history from IndexedDB cache');
            return;
        }

        const response = await workerFetch('/api/history');

        if (!response.ok) {
            throw new Error(`Worker API error: ${response.status}`);
        }

        const data = await response.json();

        if (!data.exists) {
            console.log('No existing play history found - starting fresh');
            return;
        }

        applyPlayHistoryPayload({ ...data, sha: data.sha || null });
        await saveCachedHistoryState(data, data.sha || null);

        console.log(`Restored mode ${getModeKey()}: ${state.history.length} history entries, level: ${getCurrentLevel()}, gameMode: ${state.gameMode}`);
    } catch (e) {
        console.error('Failed to load play history:', e);
        // Non-fatal: fall back to stale cached data if available.
        try {
            const cached = await getDpCacheFromIdb(CONFIG.HISTORY_CACHE_KEY);
            if (cached?.entry) {
                applyPlayHistoryPayload({ ...cached.entry, sha: cached.sha || null });
                console.warn('Using stale IndexedDB play history cache after load failure');
            }
        } catch (cacheError) {
            console.warn('Failed to restore stale play history cache:', cacheError);
        }
    }
}

async function savePlayHistory(options = {}) {
    const { sync = true } = options;

    // Trim history to max entries before saving
    if (state.history.length > CONFIG.MAX_HISTORY_ENTRIES) {
        state.history = state.history.slice(-CONFIG.MAX_HISTORY_ENTRIES);
    }

    // Ensure current mode's state is up to date in modeStates
    saveModeState();

    const payload = {
        modeStates: state.modeStates,
        mode: state.mode,
        gameMode: state.gameMode,
        playEnv: state.playEnv,
        dp: {
            offi: state.dp.offi,
            env: state.dp.env,
        },
        lastUpdated: new Date().toISOString(),
    };

    const body = {
        content: payload,
        message: `Update play history - ${state.gameMode} ${state.playEnv} ${getCurrentLevel()} - ${new Date().toISOString()}`,
    };

    await saveCachedHistoryState(payload, state.fileSha);

    if (!sync) {
        return;
    }

    if (state.fileSha) {
        body.sha = state.fileSha;
    }

    const response = await workerFetch('/api/history', {
        method: 'PUT',
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Worker PUT failed: ${response.status} - ${errorData.detail || ''}`);
    }

    const data = await response.json();
    state.fileSha = data.sha;
    await saveCachedHistoryState(payload, state.fileSha);
}

// ==================== Mode Toggle ====================
async function handleModeToggle() {
    if (state.isProcessing) return;

    // In DP mode, mode toggle is not used (no gauge modes)
    if (state.gameMode === 'DP') return;

    const modes = Object.keys(CONFIG.SHEET_GIDS);
    const currentIndex = modes.indexOf(state.mode);
    const nextMode = modes[(currentIndex + 1) % modes.length];

    state.isProcessing = true;
    enableActionButtons(false);

    // Show loading
    document.getElementById('song-name').textContent = 'データ読み込み中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    // Save current mode's state before switching
    saveModeState();
    await savePlayHistory({ sync: false }).catch(err => console.error('Save before mode switch failed:', err));

    // Switch mode
    state.mode = nextMode;
    document.getElementById('mode-toggle').textContent = nextMode;

    // Reset song DB (different songs per gauge mode)
    state.songDB = {};
    state.versions = [];
    state.totalSongsInDB = 0;

    // Restore previous state for the new mode
    restoreModeState(getModeKey());

    try {
        await loadSpreadsheetData();

        // Clamp level index after data is loaded
        const levels = getCurrentLevels();
        if (levels.length > 0) {
            state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, levels.length - 1));
        }

        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();
        updateEnvironmentUI();
        selectNextSong();
        enableActionButtons(true);
    } catch (e) {
        console.error('Mode switch failed:', e);
        document.getElementById('song-name').textContent = 'モード切替に失敗しました';
    }

    state.isProcessing = false;
}

// ==================== Environment Toggle (home / arcade) ====================
async function handleEnvironmentToggle() {
    if (state.isProcessing) return;

    state.isProcessing = true;
    enableActionButtons(false);

    document.getElementById('song-name').textContent = 'データ読み込み中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    saveModeState();
    await savePlayHistory({ sync: false }).catch(err => console.error('Save before environment switch failed:', err));

    state.playEnv = state.playEnv === 'home' ? 'arcade' : 'home';
    updateEnvironmentUI();

    restoreModeState(getModeKey());
    updateLevelDisplay();
    updateCountDisplay();
    renderFullHistory();
    selectNextSong();

    saveModeState();
    await savePlayHistory({ sync: false }).catch(err => console.error('Save after environment switch failed:', err));

    enableActionButtons(true);

    state.isProcessing = false;
}

// ==================== Game Mode Toggle (SP / DP) ====================
async function handleGameModeToggle() {
    if (state.isProcessing) return;

    const nextGameMode = state.gameMode === 'SP' ? 'DP' : 'SP';

    state.isProcessing = true;
    enableActionButtons(false);

    // Show loading
    document.getElementById('song-name').textContent = 'データ読み込み中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    // Save current mode's state before switching
    saveModeState();
    await savePlayHistory({ sync: false }).catch(err => console.error('Save before game mode switch failed:', err));

    // Switch game mode
    state.gameMode = nextGameMode;

    // Reset song DB (different data source per game mode)
    state.songDB = {};
    state.versions = [];
    state.totalSongsInDB = 0;

    // Restore previous state for the new mode
    restoreModeState(getModeKey());

    updateGameModeUI();
    updateEnvironmentUI();

    try {
        let hasSongData = true;
        if (nextGameMode === 'DP') {
            hasSongData = await loadDpData();
        } else {
            await loadSpreadsheetData();
        }

        // Clamp level index after data is loaded
        const levels = getCurrentLevels();
        if (levels.length > 0) {
            state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, levels.length - 1));
        }

        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();
        if (hasSongData) {
            selectNextSong();
            enableActionButtons(true);
        } else {
            showDpCacheEmptyState();
        }
    } catch (e) {
        console.error('Game mode switch failed:', e);
        document.getElementById('song-name').textContent = 'モード切替に失敗しました';
    }

    state.isProcessing = false;
}

/**
 * Update UI elements based on current game mode
 */
function updateGameModeUI() {
    const gameModeBtn = document.getElementById('game-mode-toggle');
    const modeToggle = document.getElementById('mode-toggle');
    const dpControls = document.getElementById('dp-controls');
    const spRefreshBtn = document.getElementById('sp-refresh-btn');

    gameModeBtn.textContent = state.gameMode;

    if (state.gameMode === 'DP') {
        modeToggle.classList.add('hidden');
        dpControls.classList.remove('hidden');
        spRefreshBtn?.classList.add('hidden');
        updateDpOffiDisplay();
    } else {
        modeToggle.classList.remove('hidden');
        modeToggle.textContent = state.mode;
        dpControls.classList.add('hidden');
        spRefreshBtn?.classList.toggle('hidden', state.route !== 'iidx');
    }
}

/**
 * Update the play environment display
 */
function updateEnvironmentUI() {
    const envToggle = document.getElementById('env-toggle');
    if (!envToggle) return;

    envToggle.textContent = state.playEnv === 'home' ? '家用' : 'アーケード';
    envToggle.title = state.playEnv === 'home' ? '家用環境へ切替' : 'アーケード環境へ切替';
}

/**
 * Update the DP star level display
 */
function updateDpOffiDisplay() {
    const offiLabel = document.getElementById('dp-offi-label');
    if (offiLabel) {
        offiLabel.textContent = `☆${state.dp.offi}`;
    }
}

/**
 * Change DP star level
 */
async function handleDpOffiChange(delta) {
    if (state.isProcessing || state.gameMode !== 'DP') return;

    const levels = CONFIG.DP.OFFI_LEVELS;
    const currentIdx = levels.indexOf(state.dp.offi);
    const newIdx = currentIdx + delta;

    if (newIdx < 0 || newIdx >= levels.length) return;

    state.isProcessing = true;
    enableActionButtons(false);

    // Save current DP level's state before switching
    saveModeState();
    await savePlayHistory({ sync: false }).catch(err => console.error('Save before offi change failed:', err));

    state.dp.offi = levels[newIdx];

    // Reset song DB (different data per star level)
    state.songDB = {};
    state.versions = [];
    state.totalSongsInDB = 0;

    // Restore previous state for the new DP level
    restoreModeState(getModeKey());

    updateDpOffiDisplay();
    updateEnvironmentUI();

    // Show loading
    document.getElementById('song-name').textContent = 'データ読み込み中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    try {
        const hasSongData = await loadDpData();

        // Clamp level index after data reload
        if (state.dp.levels.length > 0) {
            state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, state.dp.levels.length - 1));
        }

        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();
        if (hasSongData) {
            selectNextSong();
            enableActionButtons(true);
        } else {
            showDpCacheEmptyState();
        }
    } catch (e) {
        console.error('DP offi change failed:', e);
        document.getElementById('song-name').textContent = 'レベル切替に失敗しました';
    }

    state.isProcessing = false;
}

// ==================== UI Update Functions ====================
function updateLevelDisplay() {
    const levels = getCurrentLevels();
    const level = levels[state.currentLevelIndex] || levels[0] || '?';
    const levelBadge = document.getElementById('current-level');
    levelBadge.textContent = level;

    if (state.gameMode === 'DP') {
        // For DP mode, color by numeric rank value
        const numLevel = parseFloat(level);
        const hue = Math.max(0, Math.min(120, (1 - (numLevel - 1) / 12) * 120));
        const color = `hsl(${hue}, 80%, 55%)`;
        levelBadge.style.background = `linear-gradient(135deg, ${color}, hsl(${hue}, 80%, 40%))`;
    } else {
        // SP mode: Color based on level tier
        const tierColors = {
            'F': '#4ade80', 'E': '#22d3ee',
            'D': '#60a5fa', 'C': '#818cf8',
            'B': '#a78bfa', 'B+': '#c084fc',
            'A': '#f472b6', 'A+': '#fb7185',
            'S': '#f97316', 'S+': '#ef4444',
        };

        const color = tierColors[level] || '#888';
        levelBadge.style.background = `linear-gradient(135deg, ${color}, ${adjustColor(color, -30)})`;
    }
}

function updateCountDisplay() {
    document.getElementById('song-count').textContent = `${state.clearCount}✓ / ${state.totalCount}`;
}

function addHistoryEntry(entry) {
    const list = document.getElementById('history-list');
    const li = createHistoryLI(entry);
    list.insertBefore(li, list.firstChild);

    // Limit displayed items
    while (list.children.length > CONFIG.MAX_HISTORY_DISPLAY) {
        list.removeChild(list.lastChild);
    }
}

function renderFullHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';

    const recent = state.history.slice(-CONFIG.MAX_HISTORY_DISPLAY).reverse();
    for (const entry of recent) {
        list.appendChild(createHistoryLI(entry));
    }
}

function createHistoryLI(entry) {
    const li = document.createElement('li');
    li.className = entry.status;

    const levelSpan = document.createElement('span');
    levelSpan.className = 'history-level';
    levelSpan.textContent = entry.level;

    const songSpan = document.createElement('span');
    songSpan.className = 'history-song';
    songSpan.textContent = entry.song;

    const versionSpan = document.createElement('span');
    versionSpan.className = 'history-version';
    versionSpan.textContent = entry.version;

    li.appendChild(levelSpan);
    li.appendChild(songSpan);
    li.appendChild(versionSpan);

    return li;
}

function enableActionButtons(enabled) {
    document.getElementById('clear-btn').disabled = !enabled;
    document.getElementById('fail-btn').disabled = !enabled;
}

function toggleHistory() {
    const list = document.getElementById('history-list');
    const btn = document.getElementById('history-toggle');

    if (list.style.display === 'none') {
        list.style.display = '';
        btn.textContent = '▼';
    } else {
        list.style.display = 'none';
        btn.textContent = '▶';
    }
}

function showError(el, message) {
    el.textContent = message;
    el.classList.remove('hidden');
}

// ==================== Utility Functions ====================
function songKey(version, song) {
    return `${version}|${song}`;
}

/**
 * Get a unique key representing the current mode combination.
 * SP modes: "SP_home_ノマゲ", "SP_arcade_ノマゲ"
 * DP modes: "DP_home_11", "DP_arcade_11", etc.
 */
function getModeKey() {
    const suffix = state.gameMode === 'DP' ? state.dp.offi : state.mode;
    return `${state.gameMode}_${state.playEnv}_${suffix}`;
}

/**
 * Save current mode's volatile state into modeStates.
 * playedSongs (Set) and songStatus (Map) are serialized to plain arrays/objects
 * so they survive JSON round-tripping and are not limited by history trimming.
 */
function saveModeState() {
    const key = getModeKey();
    state.modeStates[key] = {
        history: [...state.history],
        currentLevelIndex: state.currentLevelIndex,
        clearCount: state.clearCount,
        totalCount: state.totalCount,
        playedSongs: [...state.playedSongs],
        songStatus: [...state.songStatus.entries()],
    };
}

/**
 * Restore a mode's state from modeStates.
 * playedSongs and songStatus are restored directly from saved data,
 * falling back to rebuilding from history for backward compatibility.
 */
function restoreModeState(modeKey) {
    const saved = state.modeStates[modeKey];
    state.history = saved ? [...(saved.history || [])] : [];
    state.currentLevelIndex = saved?.currentLevelIndex ?? 0;
    state.clearCount = saved?.clearCount ?? 0;
    state.totalCount = saved?.totalCount ?? 0;

    // Restore playedSongs
    state.playedSongs.clear();
    if (saved?.playedSongs) {
        for (const k of saved.playedSongs) {
            state.playedSongs.add(k);
        }
    }

    // Restore songStatus
    state.songStatus.clear();
    if (saved?.songStatus) {
        for (const [k, v] of saved.songStatus) {
            state.songStatus.set(k, v);
        }
    }

    // Fallback: if no saved playedSongs/songStatus, rebuild from history
    if (!saved?.playedSongs && state.history.length > 0) {
        for (const entry of state.history) {
            const k = songKey(entry.version, entry.song);
            state.playedSongs.add(k);
            state.songStatus.set(k, { status: entry.status, level: entry.level });
        }
    }
}

/**
 * Normalize stored modeStates so old data is treated as home environment.
 */
function normalizeModeStates(modeStates) {
    const normalized = {};

    for (const [key, value] of Object.entries(modeStates || {})) {
        const envAwareMatch = key.match(/^(SP|DP)_(home|arcade)_(.+)$/);
        if (envAwareMatch) {
            normalized[key] = value;
            continue;
        }

        const legacyMatch = key.match(/^(SP|DP)_(.+)$/);
        if (legacyMatch) {
            const [, gameMode, suffix] = legacyMatch;
            normalized[`${gameMode}_home_${suffix}`] = value;
            continue;
        }

        normalized[key] = value;
    }

    return normalized;
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adjust hex color brightness
 */
function adjustColor(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
    const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
    return `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
}
