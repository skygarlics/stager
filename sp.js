/*
 * Stager - SP Module
 * Spreadsheet loading, parsing, caching, and SP refresh behavior.
 */

function getSpCacheKey() {
    return `SP_${state.mode}`;
}

async function loadSpreadsheetData() {
    return loadSpreadsheetDataWithCache({ forceRefresh: false });
}

async function loadSpreadsheetDataWithCache({ forceRefresh = false } = {}) {
    const key = getSpCacheKey();
    if (!forceRefresh) {
        const cached = await getCachedEntryFromIdb(key);

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

    await saveCachedEntryToIdb(key, {
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

    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const row = rows[i];
        const rowText = row.join(' ');
        if (CONFIG.VERSION_MARKERS.some(marker => rowText.includes(marker))) {
            headerRowIndex = i;
            break;
        }
    }

    if (headerRowIndex === -1) {
        throw new Error('Could not find header row with version names');
    }

    const headerRow = rows[headerRowIndex];
    state.versions = [];
    const versionColMap = {};

    for (let col = 1; col < headerRow.length - 1; col++) {
        const version = headerRow[col].trim();
        if (version) {
            state.versions.push(version);
            versionColMap[version] = col;
        }
    }

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

function normalizeLevel(level) {
    return level
        .replace(/＋/g, '+')
        .replace(/\s+/g, '')
        .trim();
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
