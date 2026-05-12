/*
 * Stager - Drum Module
 * DrumTower data loading, rendering, and persistence.
 */

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
