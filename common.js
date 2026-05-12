/*
 * Stager - Common Shared Logic
 * Shared state, cache helpers, generic UI utilities, and history helpers.
 */

// ==================== Configuration ====================
const CONFIG = {
    WORKER_URL: 'https://stager-proxy.stager-skygarlics.workers.dev',
    SPREADSHEET_BASE: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSUdp6iuEzE8Z5AL1hkoxzLexp89nJnLQMmICm6_MC0_UjCp1ImZFzabcZkvCpK7mcWvm_2t6iYoJRg/pub',
    SHEET_GIDS: {
        'ノマゲ': 1873149697,
        'ハード': 0,
    },
    LEVELS: ['F', 'E', 'D', 'C', 'B', 'B+', 'A', 'A+', 'S', 'S+'],
    VERSION_MARKERS: ['5th', '6th', '7th', '8th', '9th', '10th', 'IIDXRED', 'HAPPY SKY'],
    MAX_HISTORY_DISPLAY: 30,
    MAX_HISTORY_ENTRIES: 500,
    SESSION_DAYS: 30,
    DP: {
        OFFI_LEVELS: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        DEFAULT_OFFI: 11,
        DEFAULT_ENV: 'a330',
    },
    DEV_ALLOW_OFFLINE: true,
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
    password: null,
    currentLevelIndex: 0,
    songDB: {},
    versions: [],
    playedSongs: new Set(),
    songStatus: new Map(),
    history: [],
    currentSong: null,
    currentVersion: null,
    currentLevel: null,
    fileSha: null,
    drumFileSha: null,
    dpCacheFileSha: null,
    mode: 'ノマゲ',
    gameMode: 'SP',
    playEnv: 'home',
    isProcessing: false,
    totalSongsInDB: 0,
    clearCount: 0,
    totalCount: 0,
    modeStates: {},
    drumFloors: [],
    drumRankStore: {},
    drumFloorStatuses: {},
    drumSelectedFloorIndex: 0,
    dp: {
        offi: 11,
        levels: [],
        env: 'a330',
    },
};

// ==================== IndexedDB Cache ====================
function openCacheDb() {
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

async function getCachedEntryFromIdb(key) {
    try {
        const db = await openCacheDb();
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
        console.warn('Failed to read cache from IndexedDB:', e);
        return null;
    }
}

async function saveCachedEntryToIdb(key, payload) {
    try {
        const db = await openCacheDb();
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
        console.warn('Failed to save cache to IndexedDB:', e);
    }
}

async function readCachedEntry(key, ttlMs = null) {
    const cached = await getCachedEntryFromIdb(key);
    if (!cached || !cached.entry) return null;

    if (ttlMs == null) return cached;
    if (!cached.savedAt) return null;

    const savedAt = Date.parse(cached.savedAt);
    if (!Number.isFinite(savedAt)) return null;

    if (Date.now() - savedAt > ttlMs) return null;
    return cached;
}

async function writeCachedEntry(key, entry, sha = null) {
    await saveCachedEntryToIdb(key, { entry, sha });
}

async function getCachedHistoryState() {
    return readCachedEntry(CONFIG.HISTORY_CACHE_KEY, CONFIG.HISTORY_CACHE_TTL_MS);
}

async function saveCachedHistoryState(entry, sha) {
    await writeCachedEntry(CONFIG.HISTORY_CACHE_KEY, entry, sha || null);
}

async function getCachedDrumHistoryState() {
    return readCachedEntry(CONFIG.DRUM_HISTORY_CACHE_KEY, CONFIG.DRUM_HISTORY_CACHE_TTL_MS);
}

async function saveCachedDrumHistoryState(entry, sha) {
    await writeCachedEntry(CONFIG.DRUM_HISTORY_CACHE_KEY, entry, sha || null);
}

// ==================== Generic Helpers ====================
function songKey(version, song) {
    return `${version}|${song}`;
}

function getModeKey() {
    const suffix = state.gameMode === 'DP' ? state.dp.offi : state.mode;
    return `${state.gameMode}_${state.playEnv}_${suffix}`;
}

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

function restoreModeState(modeKey) {
    const saved = state.modeStates[modeKey];
    state.history = saved ? [...(saved.history || [])] : [];
    state.currentLevelIndex = saved?.currentLevelIndex ?? 0;
    state.clearCount = saved?.clearCount ?? 0;
    state.totalCount = saved?.totalCount ?? 0;

    state.playedSongs.clear();
    if (saved?.playedSongs) {
        for (const k of saved.playedSongs) {
            state.playedSongs.add(k);
        }
    }

    state.songStatus.clear();
    if (saved?.songStatus) {
        for (const [k, v] of saved.songStatus) {
            state.songStatus.set(k, v);
        }
    }

    if (!saved?.playedSongs && state.history.length > 0) {
        for (const entry of state.history) {
            const k = songKey(entry.version, entry.song);
            state.playedSongs.add(k);
            state.songStatus.set(k, { status: entry.status, level: entry.level });
        }
    }
}

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

function adjustColor(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amount));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
    const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
    return `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
}

// ==================== UI Update Functions ====================
function updateLevelDisplay() {
    const levels = getCurrentLevels();
    const level = levels[state.currentLevelIndex] || levels[0] || '?';
    const levelBadge = document.getElementById('current-level');
    if (!levelBadge) return;
    levelBadge.textContent = level;

    if (state.gameMode === 'DP') {
        const numLevel = parseFloat(level);
        const hue = Math.max(0, Math.min(120, (1 - (numLevel - 1) / 12) * 120));
        const color = `hsl(${hue}, 80%, 55%)`;
        levelBadge.style.background = `linear-gradient(135deg, ${color}, hsl(${hue}, 80%, 40%))`;
    } else {
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
    const el = document.getElementById('song-count');
    if (el) {
        el.textContent = `${state.clearCount}✓ / ${state.totalCount}`;
    }
}

function addHistoryEntry(entry) {
    const list = document.getElementById('history-list');
    if (!list) return;
    const li = createHistoryLI(entry);
    list.insertBefore(li, list.firstChild);
    while (list.children.length > CONFIG.MAX_HISTORY_DISPLAY) {
        list.removeChild(list.lastChild);
    }
}

function renderFullHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
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
    const clearBtn = document.getElementById('clear-btn');
    const failBtn = document.getElementById('fail-btn');
    if (clearBtn) clearBtn.disabled = !enabled;
    if (failBtn) failBtn.disabled = !enabled;
}

function toggleHistory() {
    const list = document.getElementById('history-list');
    const btn = document.getElementById('history-toggle');
    if (!list || !btn) return;

    if (list.style.display === 'none') {
        list.style.display = '';
        btn.textContent = '▼';
    } else {
        list.style.display = 'none';
        btn.textContent = '▶';
    }
}

function showError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
}
