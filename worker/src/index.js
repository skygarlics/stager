/**
 * Stager - Cloudflare Worker Proxy
 * 
 * GitHub PAT를 서버 측 환경변수에 저장하고,
 * 클라이언트는 비밀번호 인증만으로 GitHub API에 접근합니다.
 * 
 * Environment Variables (Secrets):
 *   GITHUB_PAT   - GitHub Personal Access Token
 *   AUTH_HASH     - SHA-256 hex hash of the login password
 * 
 * Environment Variables (Config):
 *   REPO          - GitHub repo (e.g., "skygarlics/stager")
 *   DATA_BRANCH   - Branch for data storage (e.g., "data")
 *   ALLOWED_ORIGIN - CORS origin (e.g., "https://skygarlics.github.io")
 */

// ==================== Constants ====================
const HISTORY_FILE = 'play_history.json';
const DRUM_HISTORY_FILE = 'play_history_drum.json';
const DP_CACHE_FILE = 'dp_rank_cache.json';
const GITHUB_API = 'https://api.github.com';
const MAX_REQUEST_BODY = 512 * 1024; // 512 KB max request body

// ==================== Rate Limiting ====================
// In-memory sliding window rate limiter (per-Worker-instance)
// Note: Workers may run on multiple isolates, so this is approximate, not exact.
// For stricter limits, use Cloudflare Rate Limiting rules (dashboard) or Durable Objects.
const rateLimiter = {
    // { ip: { count, windowStart } }
    auth: new Map(),
    api: new Map(),

    /**
     * Check if request is within rate limit
     * @param {string} bucket - 'auth' or 'api'
     * @param {string} key - IP address
     * @param {number} maxRequests - max requests per window
     * @param {number} windowMs - window size in ms
     * @returns {{ allowed: boolean, remaining: number, retryAfter: number }}
     */
    check(bucket, key, maxRequests, windowMs) {
        const map = this[bucket];
        const now = Date.now();
        const entry = map.get(key);

        if (!entry || now - entry.windowStart > windowMs) {
            map.set(key, { count: 1, windowStart: now });
            return { allowed: true, remaining: maxRequests - 1, retryAfter: 0 };
        }

        entry.count++;
        if (entry.count > maxRequests) {
            const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
            return { allowed: false, remaining: 0, retryAfter };
        }

        return { allowed: true, remaining: maxRequests - entry.count, retryAfter: 0 };
    },

    /** Periodic cleanup of expired entries */
    cleanup(bucket, windowMs) {
        const map = this[bucket];
        const now = Date.now();
        for (const [key, entry] of map) {
            if (now - entry.windowStart > windowMs) {
                map.delete(key);
            }
        }
    }
};

// Cleanup stale entries every 60 seconds (runs lazily on next request)
let lastCleanup = Date.now();
function maybeCleanup() {
    const now = Date.now();
    if (now - lastCleanup > 60_000) {
        rateLimiter.cleanup('auth', 60_000);
        rateLimiter.cleanup('api', 60_000);
        lastCleanup = now;
    }
}

/** Get client IP from Cloudflare header */
function getClientIP(request) {
    return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ==================== Main Handler ====================
export default {
    async fetch(request, env) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return corsResponse(env, new Response(null, { status: 204 }));
        }

        maybeCleanup();

        try {
            const url = new URL(request.url);
            const path = url.pathname;
            const clientIP = getClientIP(request);

            // Route requests
            switch (true) {
                case path === '/api/auth' && request.method === 'POST': {
                    // Strict rate limit: 5 attempts per 60 seconds per IP
                    const rl = rateLimiter.check('auth', clientIP, 5, 60_000);
                    if (!rl.allowed) {
                        return corsResponse(env, json(
                            { error: 'Too many login attempts. Try again later.' },
                            429,
                            { 'Retry-After': String(rl.retryAfter) }
                        ));
                    }
                    return corsResponse(env, await handleAuth(request, env));
                }

                case path === '/api/history' && request.method === 'GET':
                case path === '/api/history' && request.method === 'PUT': {
                    // API rate limit: 30 requests per 60 seconds per IP
                    const rl = rateLimiter.check('api', clientIP, 30, 60_000);
                    if (!rl.allowed) {
                        return corsResponse(env, json(
                            { error: 'Rate limit exceeded. Try again later.' },
                            429,
                            { 'Retry-After': String(rl.retryAfter) }
                        ));
                    }
                    if (request.method === 'GET') {
                        return corsResponse(env, await handleGetHistory(request, env));
                    } else {
                        return corsResponse(env, await handlePutHistory(request, env));
                    }
                }

                case path === '/api/drum-history' && request.method === 'GET':
                case path === '/api/drum-history' && request.method === 'PUT': {
                    const rl = rateLimiter.check('api', clientIP, 30, 60_000);
                    if (!rl.allowed) {
                        return corsResponse(env, json(
                            { error: 'Rate limit exceeded. Try again later.' },
                            429,
                            { 'Retry-After': String(rl.retryAfter) }
                        ));
                    }
                    if (request.method === 'GET') {
                        return corsResponse(env, await handleGetDrumHistory(request, env));
                    } else {
                        return corsResponse(env, await handlePutDrumHistory(request, env));
                    }
                }

                case path === '/api/dp-rank' && request.method === 'POST': {
                    // Rate limit same as API
                    const rl = rateLimiter.check('api', clientIP, 30, 60_000);
                    if (!rl.allowed) {
                        return corsResponse(env, json(
                            { error: 'Rate limit exceeded. Try again later.' },
                            429,
                            { 'Retry-After': String(rl.retryAfter) }
                        ));
                    }
                    return corsResponse(env, await handleDpRank(request, env));
                }

                case path === '/api/dp-rank-cache' && request.method === 'GET':
                case path === '/api/dp-rank-cache' && request.method === 'PUT': {
                    const rl = rateLimiter.check('api', clientIP, 30, 60_000);
                    if (!rl.allowed) {
                        return corsResponse(env, json(
                            { error: 'Rate limit exceeded. Try again later.' },
                            429,
                            { 'Retry-After': String(rl.retryAfter) }
                        ));
                    }
                    if (request.method === 'GET') {
                        return corsResponse(env, await handleGetDpRankCache(request, env));
                    } else {
                        return corsResponse(env, await handlePutDpRankCache(request, env));
                    }
                }

                case path === '/api/health':
                    return corsResponse(env, json({ status: 'ok' }));

                default:
                    return corsResponse(env, json({ error: 'Not Found' }, 404));
            }
        } catch (err) {
            console.error('Worker error:', err);
            return corsResponse(env, json({ error: 'Internal Server Error' }, 500));
        }
    }
};

// ==================== Auth ====================

/**
 * POST /api/auth
 * Body: { "password": "..." }
 * Returns: { "ok": true } or 401
 */
async function handleAuth(request, env) {
    const body = await readBody(request);
    if (!body) return json({ error: 'Request body too large' }, 413);

    const { password } = JSON.parse(body);

    if (!password || typeof password !== 'string' || password.length > 128) {
        return json({ error: 'Password required' }, 400);
    }

    const valid = await verifyPassword(password, env.AUTH_HASH);
    if (!valid) {
        // Constant-time delay to prevent timing-based enumeration
        await sleep(200 + Math.random() * 300);
        return json({ error: 'Invalid password' }, 401);
    }

    return json({ ok: true });
}

/**
 * GET /api/drum-history
 * Proxies to GitHub API to fetch play_history_drum.json
 */
async function handleGetDrumHistory(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';

    const url = `${GITHUB_API}/repos/${repo}/contents/${DRUM_HISTORY_FILE}?ref=${branch}`;

    const ghResponse = await fetch(url, {
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Stager-Worker',
        },
    });

    if (ghResponse.status === 404) {
        return json({ exists: false, schemaVersion: 1, route: 'drum', rankStore: {}, floorStatuses: {}, selectedFloorIndex: 0 });
    }

    if (!ghResponse.ok) {
        const errorText = await ghResponse.text();
        return json({ error: 'GitHub API error', status: ghResponse.status, detail: errorText }, 502);
    }

    const data = await ghResponse.json();
    const base64Clean = data.content.replace(/\n/g, '');
    const content = atob(base64Clean);
    const decoded = new TextDecoder().decode(
        Uint8Array.from(content, c => c.charCodeAt(0))
    );
    const parsed = JSON.parse(decoded);
    const normalized = normalizeDrumHistoryPayload(parsed);

    return json({
        ...normalized,
        exists: true,
        sha: data.sha,
    });
}

/**
 * PUT /api/drum-history
 * Proxies to GitHub API to update play_history_drum.json
 */
async function handlePutDrumHistory(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';
    const rawBody = await readBody(request);
    if (!rawBody) return json({ error: 'Request body too large (max 512KB)' }, 413);
    const body = JSON.parse(rawBody);

    const normalizedContent = normalizeDrumHistoryPayload(body.content || {});
    const jsonStr = JSON.stringify(normalizedContent, null, 2);
    const encoded = toBase64Utf8(jsonStr);

    const url = `${GITHUB_API}/repos/${repo}/contents/${DRUM_HISTORY_FILE}`;

    const ghBody = {
        message: body.message || `Update drum history - ${new Date().toISOString()}`,
        content: encoded,
        branch: branch,
    };

    if (body.sha) {
        ghBody.sha = body.sha;
    }

    const ghResponse = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Stager-Worker',
        },
        body: JSON.stringify(ghBody),
    });

    if (!ghResponse.ok) {
        const errorData = await ghResponse.json().catch(() => ({}));
        return json({
            error: 'GitHub PUT failed',
            status: ghResponse.status,
            detail: errorData.message || '',
        }, 502);
    }

    const data = await ghResponse.json();
    return json({ ok: true, sha: data.content.sha });
}

function normalizeDrumHistoryPayload(payload) {
    return {
        schemaVersion: 1,
        route: 'drum',
        selectedFloorIndex: payload.selectedFloorIndex ?? payload.drumSelectedFloorIndex ?? payload.currentFloorIndex ?? 0,
        rankStore: payload.rankStore || payload.drumRankStore || payload.ranks || {},
        floorStatuses: payload.floorStatuses || payload.drumFloorStatuses || payload.floors || {},
        lastUpdated: payload.lastUpdated || new Date().toISOString(),
    };
}

/**
 * Verify password by comparing SHA-256 hash
 */
async function verifyPassword(password, storedHash) {
    const hash = await sha256(password);
    return hash === storedHash;
}

/**
 * SHA-256 hash using Web Crypto API
 */
async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== Middleware ====================

/**
 * Extract and verify password from Authorization header
 * Header format: "Bearer <password>"
 */
async function authenticate(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const password = authHeader.slice(7);
    return verifyPassword(password, env.AUTH_HASH);
}

// ==================== History Endpoints ====================

/**
 * GET /api/history
 * Proxies to GitHub API to fetch play_history.json
 */
async function handleGetHistory(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';

    const url = `${GITHUB_API}/repos/${repo}/contents/${HISTORY_FILE}?ref=${branch}`;

    const ghResponse = await fetch(url, {
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Stager-Worker',
        },
    });

    if (ghResponse.status === 404) {
        // File doesn't exist yet - return empty state
        return json({ history: [], currentLevelIndex: 0, exists: false });
    }

    if (!ghResponse.ok) {
        const errorText = await ghResponse.text();
        return json({ error: 'GitHub API error', status: ghResponse.status, detail: errorText }, 502);
    }

    const data = await ghResponse.json();

    // Decode base64 content
    const base64Clean = data.content.replace(/\n/g, '');
    const content = atob(base64Clean);
    // Handle UTF-8 decoding
    const decoded = new TextDecoder().decode(
        Uint8Array.from(content, c => c.charCodeAt(0))
    );
    const parsed = JSON.parse(decoded);

    return json({
        ...parsed,
        exists: true,
        sha: data.sha,
    });
}

/**
 * PUT /api/history
 * Proxies to GitHub API to update play_history.json
 * Body: { content: {...}, sha: "..." }
 */
async function handlePutHistory(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';
    const rawBody = await readBody(request);
    if (!rawBody) return json({ error: 'Request body too large (max 512KB)' }, 413);
    const body = JSON.parse(rawBody);

    // Encode content to base64
    const jsonStr = JSON.stringify(body.content, null, 2);
    const encoded = toBase64Utf8(jsonStr);

    const url = `${GITHUB_API}/repos/${repo}/contents/${HISTORY_FILE}`;

    const ghBody = {
        message: body.message || `Update play history - ${new Date().toISOString()}`,
        content: encoded,
        branch: branch,
    };

    if (body.sha) {
        ghBody.sha = body.sha;
    }

    const ghResponse = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Stager-Worker',
        },
        body: JSON.stringify(ghBody),
    });

    if (!ghResponse.ok) {
        const errorData = await ghResponse.json().catch(() => ({}));
        return json({
            error: 'GitHub PUT failed',
            status: ghResponse.status,
            detail: errorData.message || '',
        }, 502);
    }

    const data = await ghResponse.json();
    return json({ ok: true, sha: data.content.sha });
}

// ==================== DP Rank Proxy ====================

/**
 * POST /api/dp-rank
 * Proxies POST request to zasa.sakura.ne.jp/dp/rank.php
 * Body: { offi: 11, env: "a330", cat: 0, mode: "p1" }
 * Returns: { html: "..." } - the raw HTML response
 */
async function handleDpRank(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const rawBody = await readBody(request);
    if (!rawBody) return json({ error: 'Request body too large' }, 413);
    const body = JSON.parse(rawBody);

    const offi = body.offi ?? 11;
    const envParam = body.env ?? 'a330';
    const cat = body.cat ?? 0;
    const mode = body.mode ?? 'p1';

    const formData = `env=${encodeURIComponent(envParam)}&submit=%E8%A1%A8%E7%A4%BA&cat=${cat}&mode=${encodeURIComponent(mode)}&offi=${offi}`;

    const dpResponse = await fetch('https://zasa.sakura.ne.jp/dp/rank.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
    });

    if (!dpResponse.ok) {
        return json({ error: 'DP rank fetch failed', status: dpResponse.status }, 502);
    }

    const html = await dpResponse.text();
    return json({ html });
}

/**
 * GET /api/dp-rank-cache
 * Query: ?key=DP_a330_11
 */
async function handleGetDpRankCache(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';
    const requestUrl = new URL(request.url);
    const key = requestUrl.searchParams.get('key');
    const url = `${GITHUB_API}/repos/${repo}/contents/${DP_CACHE_FILE}?ref=${branch}`;

    const ghResponse = await fetch(url, {
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Stager-Worker',
        },
    });

    if (ghResponse.status === 404) {
        return json({ exists: false, schemaVersion: 1, key: key || null, entry: null, entries: {} });
    }

    if (!ghResponse.ok) {
        const errorText = await ghResponse.text();
        return json({ error: 'GitHub API error', status: ghResponse.status, detail: errorText }, 502);
    }

    const data = await ghResponse.json();
    const base64Clean = data.content.replace(/\n/g, '');
    const content = atob(base64Clean);
    const decoded = new TextDecoder().decode(
        Uint8Array.from(content, c => c.charCodeAt(0))
    );
    const parsed = JSON.parse(decoded);
    const normalized = normalizeDpRankCachePayload(parsed);

    if (key) {
        return json({
            exists: true,
            schemaVersion: normalized.schemaVersion,
            key,
            entry: normalized.entries[key] || null,
            lastUpdated: normalized.lastUpdated,
            sha: data.sha,
        });
    }

    return json({
        ...normalized,
        exists: true,
        sha: data.sha,
    });
}

/**
 * PUT /api/dp-rank-cache
 * Body: { key: "...", entry: {...}, sha?: "..." }
 */
async function handlePutDpRankCache(request, env) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';
    const rawBody = await readBody(request);
    if (!rawBody) return json({ error: 'Request body too large (max 512KB)' }, 413);
    const body = JSON.parse(rawBody);

    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) {
        return json({ error: 'Cache key is required' }, 400);
    }
    if (!body.entry || typeof body.entry !== 'object') {
        return json({ error: 'Cache entry is required' }, 400);
    }

    const getUrl = `${GITHUB_API}/repos/${repo}/contents/${DP_CACHE_FILE}?ref=${branch}`;
    const getResponse = await fetch(getUrl, {
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Stager-Worker',
        },
    });

    let currentPayload = normalizeDpRankCachePayload({});
    let fileSha = body.sha || null;

    if (getResponse.ok) {
        const existing = await getResponse.json();
        const base64Clean = existing.content.replace(/\n/g, '');
        const content = atob(base64Clean);
        const decoded = new TextDecoder().decode(
            Uint8Array.from(content, c => c.charCodeAt(0))
        );
        currentPayload = normalizeDpRankCachePayload(JSON.parse(decoded));
        if (!fileSha) fileSha = existing.sha;
    } else if (getResponse.status !== 404) {
        const errorText = await getResponse.text();
        return json({ error: 'GitHub API error', status: getResponse.status, detail: errorText }, 502);
    }

    currentPayload.entries[key] = body.entry;
    currentPayload.lastUpdated = new Date().toISOString();
    const jsonStr = JSON.stringify(currentPayload, null, 2);
    const encoded = toBase64Utf8(jsonStr);

    const putUrl = `${GITHUB_API}/repos/${repo}/contents/${DP_CACHE_FILE}`;
    const ghBody = {
        message: body.message || `Update DP cache ${key} - ${new Date().toISOString()}`,
        content: encoded,
        branch,
    };
    if (fileSha) ghBody.sha = fileSha;

    const putResponse = await fetch(putUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Stager-Worker',
        },
        body: JSON.stringify(ghBody),
    });

    if (!putResponse.ok) {
        const errorData = await putResponse.json().catch(() => ({}));
        return json({
            error: 'GitHub PUT failed',
            status: putResponse.status,
            detail: errorData.message || '',
        }, 502);
    }

    const data = await putResponse.json();
    return json({ ok: true, key, sha: data.content.sha });
}

function normalizeDpRankCachePayload(payload) {
    const entries = payload && typeof payload.entries === 'object' && payload.entries !== null
        ? payload.entries
        : {};
    return {
        schemaVersion: 1,
        entries,
        lastUpdated: payload?.lastUpdated || new Date().toISOString(),
    };
}

// ==================== Helpers ====================

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
}

/**
 * Read request body with size limit protection
 * @returns {string|null} - body text or null if too large
 */
async function readBody(request) {
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY) {
        return null;
    }

    // Stream and check actual size (Content-Length can be spoofed)
    const reader = request.body?.getReader();
    if (!reader) return '{}';

    const chunks = [];
    let totalSize = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > MAX_REQUEST_BODY) {
            reader.cancel();
            return null;
        }
        chunks.push(value);
    }

    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(merged);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function corsResponse(env, response) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Max-Age', '86400');

    return new Response(response.body, {
        status: response.status,
        headers,
    });
}
