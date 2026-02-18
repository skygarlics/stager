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
    WORKER_URL: '',  // e.g., 'https://stager-proxy.<your-subdomain>.workers.dev'
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
};

// ==================== Application State ====================
const state = {
    password: null,              // Login password (used as Bearer token for Worker)
    currentLevelIndex: 0,       // Index into CONFIG.LEVELS
    songDB: {},                  // { version: { level: [song1, song2, ...] } }
    versions: [],                // Ordered from oldest to newest
    playedSongs: new Set(),      // "version|song" strings for session dedup
    history: [],                 // Full play history array
    currentSong: null,           // Currently displayed song
    currentVersion: null,        // Version of current song
    fileSha: null,               // GitHub file SHA for updates
    mode: 'ノマゲ',              // Current gauge mode
    isProcessing: false,         // Prevent double-clicks
    totalSongsInDB: 0,           // Total songs loaded
};

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', () => {
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

    // Focus password input
    document.getElementById('password-input').focus();
});

// ==================== Login / Authentication ====================
async function handleLogin() {
    const passwordInput = document.getElementById('password-input');
    const password = passwordInput.value.trim();
    const errorEl = document.getElementById('login-error');

    errorEl.classList.add('hidden');

    if (!password) {
        showError(errorEl, 'パスワードを入力してください。');
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

    // Transition to loading
    document.getElementById('login-modal').classList.add('hidden');
    document.getElementById('loading-overlay').classList.remove('hidden');

    try {
        // Load spreadsheet data and play history in parallel
        await Promise.all([
            loadSpreadsheetData(),
            loadPlayHistory(),
        ]);

        // Transition to app
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');

        // Update UI with restored state
        updateLevelDisplay();
        updateCountDisplay();
        renderFullHistory();

        // Select first song
        selectNextSong();

        // Enable buttons
        enableActionButtons(true);
    } catch (e) {
        console.error('Initialization failed:', e);
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('login-modal').classList.remove('hidden');
        showError(errorEl, `初期化に失敗しました: ${e.message}`);
    }
}

// ==================== Spreadsheet Data Loading ====================
async function loadSpreadsheetData() {
    const gid = CONFIG.SHEET_GIDS[state.mode];
    if (!gid) {
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

    console.log(`Loaded ${state.totalSongsInDB} songs across ${state.versions.length} versions`);
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

// ==================== Song Selection Algorithm ====================
function selectNextSong() {
    const level = CONFIG.LEVELS[state.currentLevelIndex];

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

    // All songs at this level have been played in session - reset and retry
    clearPlayedSongsForLevel(level);

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

function clearPlayedSongsForLevel(level) {
    const toRemove = [];
    for (const key of state.playedSongs) {
        // Check if any version has this song at the current level
        for (const version of state.versions) {
            const songs = state.songDB[version]?.[level] || [];
            for (const song of songs) {
                if (key === songKey(version, song)) {
                    toRemove.push(key);
                }
            }
        }
    }
    toRemove.forEach(key => state.playedSongs.delete(key));
}

function displaySong(song, version, level) {
    state.currentSong = song;
    state.currentVersion = version;

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

    const level = CONFIG.LEVELS[state.currentLevelIndex];

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
    };

    state.history.push(entry);
    state.playedSongs.add(songKey(state.currentVersion, state.currentSong));

    // Update level
    if (result === 'clear') {
        state.currentLevelIndex = Math.min(state.currentLevelIndex + 1, CONFIG.LEVELS.length - 1);
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
        const response = await workerFetch('/api/history');

        if (!response.ok) {
            throw new Error(`Worker API error: ${response.status}`);
        }

        const data = await response.json();

        if (!data.exists) {
            console.log('No existing play history found - starting fresh');
            return;
        }

        state.fileSha = data.sha;

        // Restore state
        state.history = data.history || [];
        state.currentLevelIndex = data.currentLevelIndex ?? 0;

        // Clamp level index to valid range
        state.currentLevelIndex = Math.max(0, Math.min(state.currentLevelIndex, CONFIG.LEVELS.length - 1));

        // Rebuild played songs set from recent history (last 50 entries)
        const recentHistory = state.history.slice(-50);
        for (const entry of recentHistory) {
            state.playedSongs.add(songKey(entry.version, entry.song));
        }

        console.log(`Restored ${state.history.length} history entries, level: ${CONFIG.LEVELS[state.currentLevelIndex]}`);
    } catch (e) {
        console.error('Failed to load play history:', e);
        // Non-fatal: we can still play without saved history
    }
}

async function savePlayHistory() {
    const payload = {
        history: state.history,
        currentLevelIndex: state.currentLevelIndex,
        mode: state.mode,
        lastUpdated: new Date().toISOString(),
    };

    const body = {
        content: payload,
        message: `Update play history - ${CONFIG.LEVELS[state.currentLevelIndex]} - ${new Date().toISOString()}`,
    };

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
}

// ==================== Mode Toggle ====================
async function handleModeToggle() {
    if (state.isProcessing) return;

    const modes = Object.keys(CONFIG.SHEET_GIDS);
    const currentIndex = modes.indexOf(state.mode);
    const nextMode = modes[(currentIndex + 1) % modes.length];

    state.isProcessing = true;
    enableActionButtons(false);

    // Show loading
    document.getElementById('song-name').textContent = 'データ読み込み中...';
    document.getElementById('song-version').textContent = '';
    document.getElementById('song-level').textContent = '';

    // Save current state before switching
    await savePlayHistory().catch(err => console.error('Save before mode switch failed:', err));

    // Switch mode
    state.mode = nextMode;
    document.getElementById('mode-toggle').textContent = nextMode;

    // Reset song-related state but keep level
    state.songDB = {};
    state.versions = [];
    state.playedSongs.clear();
    state.totalSongsInDB = 0;

    try {
        await loadSpreadsheetData();
        updateCountDisplay();
        selectNextSong();
        enableActionButtons(true);
    } catch (e) {
        console.error('Mode switch failed:', e);
        document.getElementById('song-name').textContent = 'モード切替に失敗しました';
    }

    state.isProcessing = false;
}

// ==================== UI Update Functions ====================
function updateLevelDisplay() {
    const level = CONFIG.LEVELS[state.currentLevelIndex];
    const levelBadge = document.getElementById('current-level');
    levelBadge.textContent = level;

    // Color based on level tier
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

function updateCountDisplay() {
    const clearCount = state.history.filter(e => e.status === 'clear').length;
    const total = state.history.length;
    document.getElementById('song-count').textContent = `${clearCount}✓ / ${total}`;
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
