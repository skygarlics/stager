# Stager 배포 가이드

## 프로젝트 구조

```
stager/
├── index.html          ─┐
├── app.js               ├─ 프론트엔드 → GitHub Pages
├── styles.css          ─┘
└── worker/             ─┐
    ├── wrangler.toml    ├─ 백엔드 → Cloudflare Workers
    └── src/             │
        └── index.js    ─┘
```

**프론트엔드**는 GitHub Pages에서 정적 호스팅되고, **백엔드(Worker)**는 Cloudflare Workers에서 실행됩니다.
Worker가 GitHub API 호출을 대신 처리하므로 PAT(Personal Access Token)이 클라이언트에 노출되지 않습니다.

현재 백엔드는 두 개의 기록 파일을 다룹니다.
- `play_history.json` : IIDX 플레이 기록
- `play_history_drum.json` : DrumTower 층별 S 토글 / clear 상태 / 선택 floor

---

## Phase 1: 사전 준비

### 1-1. GitHub PAT 생성

1. [GitHub Settings → Developer settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) 접속
2. 설정:
   - **Token name**: `stager-worker`
   - **Expiration**: 원하는 기간
   - **Repository access**: Only select repositories → `skygarlics/stager`
   - **Permissions → Repository permissions → Contents**: Read and write
3. **Generate token** 클릭 → 토큰 복사 후 안전한 곳에 보관

### 1-2. `data` 브랜치 생성

플레이 기록 저장용 별도 브랜치를 만듭니다:

```bash
git checkout --orphan data
git rm -rf .
git commit --allow-empty -m "Init data branch"
git push origin data
git checkout main
```

### 1-3. 로그인 비밀번호 해시 생성

앱 로그인에 사용할 비밀번호를 정하고 SHA-256 해시를 생성합니다:

```bash
# Git Bash / Linux / macOS
echo -n "여기에비밀번호" | sha256sum
```

출력 예시:
```
5e884898da280471...  -
```
앞의 64자리 hex 문자열을 복사해 둡니다.

> **PowerShell인 경우:**
> ```powershell
> [System.BitConverter]::ToString(
>   [System.Security.Cryptography.SHA256]::Create().ComputeHash(
>     [System.Text.Encoding]::UTF8.GetBytes("여기에비밀번호")
>   )
> ).Replace("-","").ToLower()
> ```

---

## Phase 2: Cloudflare Worker 배포

### 2-1. Cloudflare 계정

[dash.cloudflare.com](https://dash.cloudflare.com)에서 무료 계정 생성.
Workers 무료 플랜: **일 10만 요청** (개인 사용에 충분).

### 2-2. Wrangler 로그인

```bash
cd worker
npx wrangler login
```

브라우저가 열리면 Cloudflare 계정 로그인 → 권한 허용.

### 2-3. Secrets 등록

> Secrets는 암호화되어 Cloudflare에 저장됩니다. 소스코드에 포함되지 않습니다.

```bash
cd worker

# GitHub PAT 등록 (프롬프트에 토큰 붙여넣기)
npx wrangler secret put GITHUB_PAT

# 비밀번호 해시 등록 (Phase 1-3의 해시)
npx wrangler secret put AUTH_HASH
```

### 2-4. wrangler.toml 확인

`worker/wrangler.toml`의 `[vars]`를 본인 환경에 맞게 확인/수정:

```toml
[vars]
REPO = "skygarlics/stager"                     # GitHub 리포
DATA_BRANCH = "data"                            # 데이터 브랜치
ALLOWED_ORIGIN = "https://skygarlics.github.io" # GitHub Pages URL
```

### 2-5. 배포

```bash
cd worker
npx wrangler deploy
```

성공 시 출력:
```
Published stager-proxy
  https://stager-proxy.<subdomain>.workers.dev
```

이 URL을 복사합니다.

### 2-6. 동작 확인

```bash
# Health check
curl https://stager-proxy.<subdomain>.workers.dev/api/health
# → {"status":"ok"}

# 인증 테스트
curl -X POST https://stager-proxy.<subdomain>.workers.dev/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"여기에비밀번호"}'
# → {"ok":true}

# 실패 테스트
curl -X POST https://stager-proxy.<subdomain>.workers.dev/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"wrongpass"}'
# → {"error":"Invalid password"}
```

---

## Phase 3: 프론트엔드 배포

### 3-1. Worker URL 설정

`app.js`의 `CONFIG.WORKER_URL`에 Worker URL 입력:

```js
WORKER_URL: 'https://stager-proxy.<subdomain>.workers.dev',
```

### 3-2. GitHub Pages 활성화

```bash
git add .
git commit -m "Configure Worker URL for deployment"
git push origin main
```

GitHub → Repository → **Settings** → **Pages**:
- Source: **Deploy from a branch**
- Branch: `main` / `/ (root)`
- **Save**

약 1~2분 후 접속 가능: `https://skygarlics.github.io/stager/`

---

## Phase 4: 검증 체크리스트

| # | 항목 | 확인 방법 |
|---|------|-----------|
| 1 | 페이지 로딩 | `https://skygarlics.github.io/stager/` 접속 → 로그인 화면 |
| 2 | 로그인 | 비밀번호 입력 → 로딩 → 곡 카드 표시 |
| 3 | 잘못된 비밀번호 | 틀린 비밀번호 → 에러 메시지 |
| 4 | Rate limiting | 6회 연속 틀린 비밀번호 → `429 Too many login attempts` |
| 5 | CLEAR/FAIL | 버튼 클릭 → 레벨 변동 & 다음 곡 |
| 6 | 데이터 영속성 | 브라우저 새로고침 → 기록 & 레벨 복원 |
| 7 | 모드 전환 | ノマゲ ↔ ハード 전환 동작 |
| 8 | DrumTower 저장 | Drum 페이지에서 층 변경 / S 토글 후 `play_history_drum.json` 갱신 |

---

## 보안 구성 요약

| 항목 | 내용 |
|------|------|
| **PAT 위치** | Cloudflare Secret (서버 측, 암호화 저장) |
| **클라이언트 노출 정보** | Worker URL, 스프레드시트 URL만 |
| **인증 방식** | 비밀번호 → Worker에서 SHA-256 해시 비교 |
| **Rate Limiting** | `/api/auth`: IP당 5회/분, `/api/history`: IP당 30회/분, `/api/drum-history`: IP당 30회/분 |
| **요청 크기 제한** | 512KB |
| **CORS** | `ALLOWED_ORIGIN`에 지정된 도메인만 허용 |
| **브루트포스 방지** | Rate limit + 실패 시 200~500ms 랜덤 딜레이 |

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `認証サーバーに接続できません` | `WORKER_URL`이 비어있거나 잘못됨 | `app.js`의 `WORKER_URL` 확인 |
| `パスワードが正しくありません` | `AUTH_HASH`와 비밀번호 불일치 | 해시 재생성 → `wrangler secret put AUTH_HASH` |
| CORS 에러 | `ALLOWED_ORIGIN` 불일치 | `wrangler.toml`의 origin → 실제 Pages URL과 일치시킴 |
| `Worker PUT failed: 502` | PAT 만료 또는 권한 부족 | 새 PAT 발급 → `wrangler secret put GITHUB_PAT` |
| 스프레드시트 로드 실패 | Sheets가 비공개 | Google Sheets → File → Share → Publish to web |
| `429 Too many login attempts` | Rate limit 초과 | 1분 후 재시도 |

---

## 비용

| 서비스 | 무료 한도 | 비고 |
|--------|-----------|------|
| Cloudflare Workers | 일 10만 요청 | 개인 사용에 충분 |
| GitHub Pages | 월 100GB 대역폭 | 정적 파일만 |
| GitHub API | 시간당 5,000 요청 (인증) | Worker가 관리 |

---

## 부록: Secrets 갱신

PAT 만료 또는 비밀번호 변경 시:

```bash
cd worker

# PAT 갱신
npx wrangler secret put GITHUB_PAT
# 새 토큰 입력

# 비밀번호 변경
echo -n "새비밀번호" | sha256sum
npx wrangler secret put AUTH_HASH
# 새 해시 입력
```

Worker 재배포 불필요 — Secrets 변경 즉시 반영됩니다.
