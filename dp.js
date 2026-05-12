/*
 * Stager - DP Module
 * DP ranking fetch, parsing, caching, and refresh behavior.
 */

function getDpCacheKey() {
    return `DP_${state.dp.env}_${state.dp.offi}`;
}

async function loadDpData() {
    const key = getDpCacheKey();
    const cached = await getCachedEntryFromIdb(key);

    if (cached?.entry) {
        state.dpCacheFileSha = cached.sha || null;
        applyDpCacheEntry(cached.entry);

        if (state.dp.levels.length > 0) {
            console.log(`DP ☆${state.dp.offi}: Loaded ${state.totalSongsInDB} songs from IndexedDB cache across ${state.dp.levels.length} rank levels`);
            return true;
        }
    }

    const response = await workerFetch('/api/dp-rank-cache?key=' + encodeURIComponent(key));

    if (!response.ok) {
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
    await saveCachedEntryToIdb(key, { entry: data.entry, sha: data.sha || null });

    if (state.dp.levels.length === 0) {
        throw new Error('No levels found in cached DP data');
    }

    console.log(`DP ☆${state.dp.offi}: Loaded ${state.totalSongsInDB} songs from cache across ${state.dp.levels.length} rank levels`);
    return true;
}

function parseDpHtml(html) {
    state.songDB = {};
    state.versions = [];
    state.dp.levels = [];
    state.totalSongsInDB = 0;

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

    const headerCells = rows[0].querySelectorAll('th');
    const versionMap = [];

    for (let i = 0; i < headerCells.length; i++) {
        const th = headerCells[i];
        if (th.classList.contains('rank')) {
            versionMap.push(null);
        } else {
            const vName = th.textContent.trim();
            versionMap.push(vName);
            if (vName && !state.versions.includes(vName)) {
                state.versions.push(vName);
            }
        }
    }

    const levelsSet = new Set();

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const cells = row.querySelectorAll('td');
        if (cells.length === 0) continue;

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

        let versionIdx = 0;
        for (let c = 0; c < cells.length; c++) {
            if (cells[c].classList.contains('rank')) continue;

            while (versionIdx < versionMap.length && versionMap[versionIdx] === null) {
                versionIdx++;
            }
            const version = versionMap[versionIdx] || null;
            versionIdx++;

            if (!version) continue;

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

    state.dp.levels = Array.from(levelsSet).sort((a, b) => parseFloat(a) - parseFloat(b));
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
    await saveCachedEntryToIdb(getDpCacheKey(), {
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
