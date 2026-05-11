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
const DEFAULT_SERVICE = 'iidx';
const HISTORY_FILE_PREFIX = 'play_history_';
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
                    const historyFile = getHistoryFile(url);
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
                        return corsResponse(env, await handleGetHistory(request, env, historyFile));
                    } else {
                        return corsResponse(env, await handlePutHistory(request, env, historyFile));
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
 * Proxies to GitHub API to fetch service-specific play history file
 */
async function handleGetHistory(request, env, historyFile) {
    if (!(await authenticate(request, env))) {
        return json({ error: 'Unauthorized' }, 401);
    }

    const repo = env.REPO || 'skygarlics/stager';
    const branch = env.DATA_BRANCH || 'data';

    const url = `${GITHUB_API}/repos/${repo}/contents/${historyFile}?ref=${branch}`;

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
 * Proxies to GitHub API to update service-specific play history file
 * Body: { content: {...}, sha: "..." }
 */
async function handlePutHistory(request, env, historyFile) {
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
    const encoded = btoa(unescape(encodeURIComponent(jsonStr)));

    const url = `${GITHUB_API}/repos/${repo}/contents/${historyFile}`;

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

function getHistoryFile(url) {
    const rawService = (url.searchParams.get('service') || DEFAULT_SERVICE).toLowerCase();
    const safeService = /^[a-z0-9_-]{1,32}$/.test(rawService) ? rawService : DEFAULT_SERVICE;
    return `${HISTORY_FILE_PREFIX}${safeService}.json`;
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
