# AIVM-LM 설계서

> **Agent VM for Lost-Media Hunting**
> Claude(에이전트 두뇌)가 **로스트미디어 탐색**을 잘하도록 설계된, 격리 샌드박스 기반 작업환경.
> 모든 P2P/토렌트(BitTorrent · eD2k/Kad · Perfect Dark · Share) 탐색·취득을 포함한다.
> Stack: **TypeScript / Node**. 작성일 2026-06-15.

---

## 0. 설계 철학

핵심 한 줄: **"VM이 기억하고, 나는 판단만 한다."** VM을 에이전트의 외장 두뇌로 만든다.

로스트미디어 탐색에서 LLM이 겪는 진짜 고통은 격리가 아니라 이것:

1. **기억 소실** — 조사는 며칠~몇 주짜리인데 컨텍스트는 휘발됨. 단서/막다른길/가설을 까먹음.
2. **토큰 폭발** — 웹페이지 원본·검색결과·메타데이터를 컨텍스트에 부으면 즉시 한계.
3. **바이너리 처리 불가** — 영상/음성/이미지는 컨텍스트에 못 넣는데, 식별(지문·역검색·OCR·전사)이 탐색의 핵심.
4. **차단/재작업** — 같은 검색·페치 반복, 레이트리밋, 출처 추적 실종.
5. **느린 비동기 취득** — P2P 다운로드는 느리고 소스 의존적 → 블로킹하면 컨텍스트가 묶임.

→ 그래서 설계 중심축은 **보안이 아니라 "에이전트 인간공학(agent ergonomics) + 탐색 워크플로"**. 격리는 P2P/임의실행 안전을 위한 수단으로 유지하되 강박하지 않는다.

### 책임 고지
이 시스템은 **아카이빙/복원 목적의 dual-use 설계**다. 저작권·관할권 판단과 책임은 운영자 몫이며, 그래서 **모든 취득을 provenance + append-only 감사로그**로 남기는 구조를 기본으로 한다.

---

## 1. 에이전트 인간공학 6원칙 (= "쓰기 편한"의 정의)

| # | 원칙 | 의미 |
|---|---|---|
| 1 | **Reference, not payload** | 큰 건 전부 아티팩트 ID로. 컨텍스트엔 요약만. |
| 2 | **Compact by default, drill-down on demand** | 기본 압축, 필요할 때만 부분 열람. |
| 3 | **Idempotent & cached** | 같은 호출은 캐시 히트 → 며칠짜리 조사에서 재작업 0. |
| 4 | **구조화된 에러 + 다음 행동 제안** | `403 blocked → try archive.get() or vm.exec yt-dlp`. 추측 안 하게. |
| 5 | **Provenance 자동 기록** | 모든 아티팩트에 "언제·어디서·어떻게". 로스트미디어는 출처가 생명. |
| 6 | **VM이 기억** | `case.digest()`로 언제든 조사 상태 복원. 망각이 비용이 안 됨. |

---

## 2. 레이어 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│  Brain (Claude API)              ← 의사결정만             │  HOST
└───────────────┬─────────────────────────────────────────┘
                │ tool calls (skill.use / vm.* / p2p.* / case.*)
┌───────────────▼─────────────────────────────────────────┐
│  Agent Runtime (TS)   세션·툴라우팅·정책게이트            │
│   ├─ Skill Registry (발견/점진로딩)                       │
│   ├─ Policy Engine   (capability/egress/감사)             │
│   ├─ Case File       ⭐ 조사 외장두뇌 (SQLite+FTS)        │
│   └─ Artifact Store  ⭐ content-addressed 캐시+provenance │
└───────────────┬─────────────────────────────────────────┘
                │ VM Protocol (JSON-RPC / WebSocket, 스트리밍)
═══════════════ 격리 경계 (trust boundary) ════════════════════
┌───────────────▼─────────────────────────────────────────┐
│  Sandbox (E2B/Firecracker or Docker)                     │  SANDBOX
│   ├─ Guest Agent (게스트 데몬: fs·proc·net 실행기)        │
│   ├─ Recon 게이트웨이 (SearXNG·Tor/Ahmia·i2pd·Hyphanet·Prowlarr) │
│   ├─ Acquisition (search·fetch·archive·download)          │
│   ├─ Identify     (오디오지문·역이미지·OCR·전사·프레임)   │
│   ├─ Swarm 데몬 풀 (libtorrent/qBittorrent · amuled · …)  │
│   └─ 미디어 툴체인 (yt-dlp · ffmpeg · gallery-dl …)       │
└──────────────────────────────────────────────────────────┘
        + Windows 서브샌드박스 (Perfect Dark / Share GUI 자동화)
```

**두뇌를 밖에 두는 이유**: 샌드박스가 털려도 LLM 자격증명·오케스트레이터·케이스파일은 안전. 샌드박스는 "버려도 되는 무대".

---

## 3. 핵심 3대 구조

### ① Case File — 조사의 외장 두뇌 ⭐
조사 상태 전체를 VM이 구조화 보관. 컨텍스트가 날아가도 여기서 복원.

```
case/
├─ leads/      단서: {id, 가설, status: open|hot|dead|confirmed, 출처, 신뢰도}
├─ evidence/   증거: artifact 참조 + 메모 + provenance
├─ entities/   정규화 개체: 인물/제목/날짜/채널/해시
├─ timeline    "무엇을 언제 시도했고 결과가 뭐였나" (재작업 방지)
└─ deadends/   막다른 길 + 이유 (같은 실수 반복 방지)
```

도구: `case.lead.add/update`, `case.evidence.attach`, `case.deadend`, `case.note`,
`case.digest()`(새 컨텍스트 시작 시 이것만 읽고 재개), `case.report()`(현재 상태 종합).

**저장소**: SQLite + FTS5(전문검색). 단일 파일이라 백업/이식 쉬움. 케이스별 1파일.

### ② Artifact Store — 참조 기반 I/O ⭐
크고 무거운 건 전부 **content-addressed 아티팩트(sha256 ID)**로 저장. 도구는 **항상 ID + 요약만 반환**, 원문은 필요 시에만.

```
fetch("url")  → { artifactId, title, summary(≤500자), links: 42, status: 200 }
download(url) → { artifactId, mime: "audio/mp3", dur: 187s, sha256 }   # 바이너리는 컨텍스트에 안 옴
read(artifactId, range)  # 원문 부분 열람
```

- **한 번 받은 건 캐시 → 재요청 공짜·즉시** (원칙 #3)
- **provenance 자동**: source URL/network, 취득 시각·방법, (P2P면) 해시·시드수
- **P2P 해시 = 아티팩트 ID**: P2P는 콘텐츠를 해시(infohash/ed2k hash/PD hash)로 식별 → content-addressed 스토어와 그대로 맞물려 중복제거·캐시가 공짜

### ③ Skill = 탐색 플레이북 ⭐
`lost-media-hunting` 방법론을 **VM이 실행하는 능력 모듈**로 도구화. 두 종류:

- **Prompt skill** (선언형): 마크다운 절차 지침. 점진 주입. 예: `lostwave-id`, `youtube-recover`.
- **Executable skill** (실행형): 샌드박스 안에서 도는 코드. 타입드 툴 노출. 예: `pd-search`, `image-reverse`.

**매니페스트** (`skill.json` + `SKILL.md`):
```jsonc
{
  "name": "lostwave-id",
  "kind": "prompt",          // 또는 "executable"
  "description": "미상 음원을 식별하는 절차",  // ← LLM 트리거 판단용 한 줄
  "entry": "dist/index.js",  // executable만
  "inputs": { "artifactId": "string" },
  "capabilities": { "net": { "egress": ["*.acoustid.org"] }, "proc": true }
}
```

**점진적 공개(progressive disclosure)** — 컨텍스트 방어 핵심:
1. 항상 로드: 전 스킬의 `name + description`만 (수십 토큰)
2. `skill.use(name)` 호출 시 → `SKILL.md` 본문 로드
3. 본문이 가리키는 참고파일·코드는 필요 시에만 샌드박스에서 읽음

**권한**: 스킬은 capability를 *선언*만, 실제 허용은 **Policy Engine**이 강제. 선언 안 한 능력은 차단.

---

## 4. 도구 표면 (에이전트가 실제 호출)

```
🗂 케이스(Case)
  case.lead.* / case.evidence.* / case.deadend / case.note
  case.digest()            조사 재개용 다이제스트
  case.report()            현재 상태 종합

🌐 정찰(Discovery)          — Surface·Deep·Dark 통합 진입점
  discover(q, scope?)      한 번에 전 표면 fan-out → 통일 후보목록
                           (scope: surface|archive|deep|dark|all)
  source.list()            접근 가능한 소스/게이트웨이 상태 + 자격필요 소스 표시
  coverage()               이 케이스에서 "아직 안 뒤진 표면" 표시

🔍 수집(Acquisition)        — 캐시·예의·차단우회 내장
  search(q, ops?)          검색결과 → 아티팩트 (구글/얀덱스/특수엔진)
  fetch(url)               페이지 → 정제텍스트 요약 + ID
  archive.lookup(url)      Wayback/archive.today 스냅샷 목록
  archive.get(url, ts)     특정 시점 스냅샷 (삭제 페이지 부활)
  download(url)            미디어 → 해시 아티팩트

🆔 식별(Identification)     — 바이너리를 "텍스트 단서"로 변환
  audio.fingerprint(artId) 음악 지문 (lostwave 핵심)
  audio.transcribe(artId)  음성 → 텍스트
  image.reverse(artId)     역이미지검색 (Yandex/Google/Bing/TinEye)
  image.ocr(artId)         이미지 속 글자
  video.frames(artId)      키프레임 추출 → 이미지 아티팩트들
  media.probe(artId)       ffprobe 메타데이터

🌐 P2P / Swarm             — 전부 비동기 잡(job)
  p2p.search(q, nets?)     모든 망 병렬 검색 → 후보 {hash,name,size,ext,net,seeders,health}
  p2p.dht.crawl(opts)      인덱스 없는 콘텐츠 DHT 크롤링 (BT/Kad)
  p2p.resolve(hash|link)   링크/해시 → 메타데이터(파일목록)
  p2p.download(hash|link)  → { jobId }   (블로킹 안 함)
  p2p.jobs() / p2p.job(id) 진행률·속도·소스수·ETA
  p2p.cancel(jobId)
  → 완료되면 자동으로 Artifact 생성 → identify/casefile 파이프라인으로 흐름

🛠 탈출구(Escape hatch)
  vm.exec(cmd)             막히면 셸로 직접 (yt-dlp, ffmpeg, gallery-dl, aria2…)
  vm.read / vm.write
```

**P2P 특화 인간공학**:
- **Judge-before-download**: 검색이 메타데이터(크기·확장자·시드수·파일명) 먼저 제공 → 느린 다운로드 전 후보 판단.
- **비동기 + 폴링**: `download`는 즉시 jobId. 다른 단서 추적하다 `p2p.jobs()`로 확인.
- **health 신호**: 죽은 토렌트/무소스 즉시 표시 → `case.deadend` 빠르게 기록.

---

## 5. 정찰(Reconnaissance) 레이어 — Surface · Deep · Dark 통합 ⭐

> 킬러 인간공학: **하나의 의도, 모든 표면.** `discover(q, scope)` 한 번이면 도달 가능한 모든 표면에 병렬 fan-out → 해시로 중복제거 → 랭킹 → 통일 후보를 Artifact Store + Case File로 흘려보낸다. VM은 케이스별 **커버리지**를 추적해서 "어디를 아직 안 뒤졌는지" 알려준다.

### 5.1 Source 추상 + Federated Query Planner
모든 탐색 가능 표면 = 하나의 `Source` 어댑터 (공통 인터페이스: search / fetch / auth).
Planner가 단일 의도를 활성 소스 전체에 병렬 던지고 → 중복제거(해시/URL) → 관련도+소스신뢰도로 랭킹 → 통일 후보 스트림. 소스마다 다른 쿼리 문법을 내가 신경 쓸 필요 없음.

### 5.2 4-tier 소스 (접근 방식 + OSS)

| Tier | 예시 | 접근 방식 | OSS |
|---|---|---|---|
| **Surface** | 검색엔진·위키·메타DB | 메타검색 API | **SearXNG**(70+ 엔진, JSON API) ⭐, Marginalia/Mojeek, MusicBrainz·Discogs·IMDb API |
| **Archive** | Wayback·archive.today·Common Crawl·도서관·Usenet아카이브 | API / CDX | Wayback **CDX API**, archive.today, **Common Crawl** 인덱스, ArchiveBox(자체), Narkive(구 Usenet) |
| **Deep** | 프라이빗 트래커·회원포럼·Usenet(NZB)·IRC(XDCC)·페이월·도서관카탈로그 | 로그인/폼/전용프로토콜 | **Prowlarr**(torznab+newznab 수십 indexer 통합) ⭐, **NZBHydra2**, SABnzbd/NZBGet, **Crawlee**(로그인·폼·JS, Playwright 내장) ⭐, WorldCat API |
| **Dark** | Tor(.onion)·I2P·Hyphanet(구 Freenet) | 오버레이망 게이트웨이 | **Tor 데몬/Arti** + **Ahmia**(.onion 검색) ⭐, **i2pd**(I2P), **Hyphanet**(freesite), YaCy(분산검색) |

### 5.3 Gateway 데몬 (샌드박스 안 상주)
- **SearXNG 인스턴스** — surface 메타검색을 단일 JSON 엔드포인트로 (70+ 엔진 동시)
- **Tor 데몬 (SOCKS5h)** — .onion DNS·트래픽 전부 Tor 내부. Ahmia로 onion 인덱스 검색
- **i2pd** — I2P eepsite 게이트웨이
- **Hyphanet 노드** — freesite (아카이빙·검열저항 콘텐츠의 역사적 보고)
- **Prowlarr** — 토렌트 + Usenet indexer 수십 개를 단일 API로 (`swarm` 레이어와 직결)

### 5.4 자격증명 금고 + 인증 자동화
- **Credential Vault**: 프라이빗 트래커·회원포럼·Usenet·IRC 로그인을 암호화 저장. capability-gated + 감사로그.
- **Auth automation**: Crawlee(Playwright)로 로그인 플로우·쿠키 영속·JS/폼 사이트 처리.
- **세션 재사용**: 한 번 로그인 → 쿠키를 아티팩트로 보관 → 재방문 즉시 통과.

### 5.5 OPSEC / 신원 격리 (편의이자 안전)
- **소스별 신원**: clearnet은 VPN/프록시, dark는 Tor 회로 — egress를 분리해 절대 섞이지 않게.
- **네트워크 네임스페이스 분리**: 다크웹 트래픽이 clearnet 신원으로 새지 않도록.
- **소스별 레이트리밋·예의(politeness)**로 차단 회피.

### 5.6 안전 가드레일 (다크웹이라 필수 · 양보 없음)
- **하드 차단**: CSAM 등 명백한 불법 콘텐츠 탐지 시 즉시 중단·폐기. 저장/인덱싱 안 함. **비협상 라인.**
- 로스트미디어 아카이빙 ≠ 불법 마켓플레이스 접근. 후자는 하지 않는다.
- 모든 접근·취득 **append-only 감사로그**.
- 받은 파일 **자동실행 금지**, `identify` 도구로만 검사.

### 5.7 에이전트 인간공학 — 정찰 특화
- **One intent, many surfaces**: `discover()` 한 번에 전 표면 fan-out.
- **Unified candidates**: 출처가 SearXNG든 Ahmia든 Prowlarr든 **같은 포맷**.
- **Coverage tracking**: `coverage()`로 "표층 ✓ / 아카이브 ✓ / Usenet 미탐 / Tor 미탐" → 빠짐없이.
- **Credential-aware**: `source.list()`가 "접근 가능 vs 자격 필요"를 구분 → 필요하면 네게 로그인 요청.

---

## 6. 도메인 프로파일 (Japanese · Western TV · Games 전용 설계) ⭐

잃어버린 미디어가 사는 곳·권위 메타DB·진위 검증법이 도메인마다 완전히 다르다. 그래서 **Domain Profile**을 둔다 — 하나의 config가 `recon`(소스 우선순위)·`swarm`(망 우선순위)·`identify`(검증 단계)·`skills`(로드할 도메인 스킬)를 한꺼번에 세팅한다.

```
case.profile = "jp_media" | "western_tv" | "games"   // 자동감지 + 수동지정, 혼합 가능(예: 일본 게임)
```

프로파일은 단서가 들어오면 **"어느 표면부터 파야 효율적인지"**를 자동 결정한다.

---

### 6.1 프로파일 ① 일본 미디어 (애니·특촬·CM·아이돌·드라마·J-POP)

| 항목 | 설계 |
|---|---|
| **언어** | 일본어 쿼리 필수. SearXNG에 **Yahoo! Japan** 엔진 추가, kana/kanji 정규화·읽기 변환 |
| **P2P 우선망** | **Perfect Dark > Share > Winny > eD2k**, + **Nyaa**(애니 토렌트) — 일본은 BT보다 PD/Share 비중 큼 |
| **권위 메타DB** | **AniDB**·AniList·MAL(애니), **VGMdb**(음악), Generasia(아이돌), Discogs/MusicBrainz, ja.wikipedia, ニコニコ大百科 |
| **커뮤니티 허브** | **5ch(5channel)** 해당 판 스레드, したらば, **Niconico**, pixiv, Twitter/X JP, 개인 블로그(죽으면 Wayback) |
| **식별/검증** | 일본어 OCR(**Manga-OCR**/PaddleOCR), OP/ED·CM송 오디오지문 |
| **전용 OSS** | **nndownload**(Niconico), **nyaadownloader/nyaa-cli**(Nyaa), AniDB API |
| **전용 스킬** | `jp-pd-share-hunt` · `niconico-archive` · `5ch-thread-trace` · `nyaa-sweep` |

---

### 6.2 프로파일 ② 서양 TV / 영화 (분실 에피소드·광고·뉴스·키즈쇼·파일럿)

| 항목 | 설계 |
|---|---|
| **권위 허브** | **Lost Media Wiki**(lostmediawiki.com) — 핵심 인덱스+포럼. r/lostmedia, Lost Media Archive |
| **방영 메타DB** | **IMDb·TVmaze·TheTVDB·epguides** — "무엇이 존재했나" 먼저 확정 후 추적 |
| **아카이브** | **Internet Archive**(TV/광고 방대), **fuzzymemories.tv**(Classic Chicago TV), FedFlix, 대학·도서관 미디어 아카이브 |
| **P2P 우선망** | **사설 트래커 — BroadcasTheNet(BTN, TV)·PassThePopcorn(PTP, 영화)** + **Usenet alt.binaries**(Prowlarr/NZBHydra) → 자격증명 금고 필요 |
| **물리 매체** | VHS/Betamax/LaserDisc/16mm 수집가, **eBay·estate sale 모니터링**, 테이프 트레이딩, off-air 홈녹화 |
| **전용 스킬** | `lostmediawiki-index` · `broadcast-metadata-confirm`(존재 확정) · `btn-ptp-search`(자격필요) · `archive-org-tv-sweep` · `physical-media-watch`(경매 모니터링) |

---

### 6.3 프로파일 ③ 게임 (프로토타입·베타·미발매·취소작·지역한정·ROM)

| 항목 | 설계 |
|---|---|
| **진위 검증 DB** ⭐ | **No-Intro · Redump · TOSEC DAT** — 체크섬으로 진본/베타/배드덤프 판정. **해시=진본증명 → content-addressed 스토어와 완벽 일치** |
| **미러/취득** | **Myrient**(No-Intro/Redump 미러), Internet Archive 소프트웨어 라이브러리, archive.org 토렌트 |
| **프로토/취소작 허브** | **Hidden Palace**(프로토타입 보존), **TCRF**(미사용 콘텐츠), **Unseen64**(취소 게임), Lost Levels |
| **메타DB** | MobyGames·IGDB·GameFAQs·Wikipedia |
| **전용 OSS** | **RomVault**(DAT 정리/검증) · **no_intro_dat_matcher**(해시→진본 매칭) · **Myrient-Can-FixDAT**(누락 ROM 자동취득) · **datoso**(DAT 시드·archive.org 플러그인) · MAME |
| **식별/검증** | 카트리지/디스크 덤프 해시를 DAT와 대조. 프로토타입은 빌드 날짜·디버그 심볼 확인 |
| **전용 스킬** | `romset-verify`(No-Intro/Redump 대조) · `myrient-fetch` · `prototype-hunt`(Hidden Palace/TCRF/Unseen64) · `proto-authenticate`(빌드 메타 검증) |

> **공통**: 프로파일은 `packages/profiles/`의 config(소스·망·스킬 우선순위). recon planner·swarm·identify·skill registry가 이걸 읽어 동작을 도메인에 맞춘다. 혼합 케이스(일본 게임 등)는 프로파일 합성.

---

## 7. 오픈소스 적용 매핑 (GitHub 조사 결과)

> 원칙: **바퀴를 재발명하지 않는다.** 검증된 OSS를 샌드박스 안 데몬으로 띄우거나 라이브러리로 임베드하고, 우리는 그 위에 *통일 추상화 + 케이스파일 + 아티팩트 + 에이전트 인간공학*만 얹는다.

### 7.1 격리 샌드박스
| 후보 | 격리 | 비고 | 채택 |
|---|---|---|---|
| **E2B** (`e2b-dev/infra`, Apache-2.0) | Firecracker microVM | ~125–150ms 부팅, 셀프호스팅 가이드+Terraform, AI 에이전트 1순위 | **프로덕션 1순위** |
| **microsandbox** | libkrun microVM | 셀프호스팅 설계, 단순 | 대안 |
| **Daytona** | 컨테이너(옵션 Kata) | 에이전트 특화, 올인원 | 대안 |
| Docker + gVisor | 네임스페이스/syscall | 로컬 개발 빠름 | **Dev 단계** |

→ **전략**: `Sandbox` 추상 인터페이스 뒤에서 시작은 Docker, 목표는 E2B(Firecracker). E2B는 스냅샷으로 "조사 일시정지 후 재개"에 결정적. 참고: `restyler/awesome-sandbox`.

### 7.2 P2P / Swarm
| 네트워크 | OSS | 제어 방식 | 채택 |
|---|---|---|---|
| **BitTorrent** | `qBittorrent`(qbittorrent-nox) / libtorrent-rasterbar / `aria2` | WebUI API v2(REST), 성숙한 클라이언트 라이브러리 | **qbittorrent-nox + WebUI API** |
| **BT 발견/인덱싱** | **`bitmagnet-io/bitmagnet`** | DHT 크롤러+분류기+GraphQL API, 100–1000 토렌트/분 | **DHT 탐색 엔진으로 채택** |
| BT 발견(경량) | `boramalper/magnetico`(magneticod/ow) | 자율 DHT 검색 | 대안 |
| **eD2k + Kad** | **`amule-project/amule`**(amuled) | EC(External Connection) 프로토콜: amulecmd/amuleweb | **amuled + EC** |
| eD2k 통합UI | `got3nks/amutorrent` | aMule/rTorrent/qBit/Deluge/Transmission를 단일 EC 제어 | **참고/재사용** |
| **Perfect Dark** | ❌ 제어 API 없음 (폐쇄·Windows 전용·고암호화) | — | **GUI 자동화만** |
| **Share (EX2)** | ❌ 제어 API 없음 (폐쇄·Windows 전용) | (커뮤니티 "Sharebot" 류 존재하나 불안정) | **GUI 자동화만** |

### 7.3 식별 (Identification)
| 작업 | OSS | 비고 |
|---|---|---|
| 오디오 지문 | **`acoustid/chromaprint`** + AcoustID/MusicBrainz | 핑거프린트 표준. lostwave 1차 |
| 오디오 지문(자체 DB) | `worldveil/dejavu`, **Olaf** | 자체 코퍼스 매칭/경량 임베디드 |
| Shazam 클라이언트 | `marin-m/SongRec` (Rust) | Shazam 식별 직결 |
| 음성 전사 | `openai/whisper` / `whisper.cpp` / faster-whisper | 로컬 ASR |
| 역이미지검색 | `RevEye` 방식(Google/Bing/Yandex/TinEye) | 멀티엔진 라우팅 |
| 이미지 유사검색(자체) | **Milvus** + ResN-50 임베딩 | 자체 이미지 코퍼스 |
| 얼굴/객체 | InsightFace / DeepFace | 인물 식별(주의·동의) |
| OCR | Tesseract / PaddleOCR | 이미지 속 글자 |
| 프레임/probe/변환 | **ffmpeg / ffprobe** | 키프레임·메타데이터 |

### 7.4 수집 / 아카이빙
| 작업 | OSS | 비고 |
|---|---|---|
| 미디어 다운로드 | **`yt-dlp`** (1000+ 사이트) | 영상/음성 만능. `vm.exec`로도 직접 |
| 갤러리/이미지보드 | **`gallery-dl`** | 포럼/보드/SNS 대량 수집 |
| 페이지 전수 아카이빙 | **`ArchiveBox`** | headless Chrome로 HTML/JS/미디어/스샷/PDF 통째 |
| 웹 아카이브 | Wayback Machine / archive.today API | 삭제 페이지 부활 |
| 다중 다운로더 프론트 | `mhogomchungu/media-downloader` | yt-dlp/gallery-dl/aria2 통합 참고 |

### 7.5 런타임 / 기타
| 작업 | OSS | 비고 |
|---|---|---|
| 에이전트 SDK | **Claude Agent SDK (TS)** | 두뇌 연동·툴콜 1급 지원 |
| 케이스 저장소 | **SQLite + FTS5** | 단일 파일, 전문검색 |
| GUI 자동화(PD/Share) | computer-use / UI 자동화 | Windows 서브샌드박스 구동 |

### 7.6 `audio_match` — 후보군 대량 비교 (lostwave 종결자) ⭐ *설계, 미구현*

**문제.** 짧은 음원(흥얼거림·잘린 클립·라디오 녹음)이 손에 있고, `discover`/`p2p_search`로 긁어온 **후보 음원이 수십~수백 개**일 때, 그걸 사람이 하나씩 들어볼 수는 없다. 레퍼런스 1개 ↔ 후보 N개를 **자동으로 비교·랭킹**하는 도구가 필요하다. 기존 `identify_fingerprint`는 "1개를 AcoustID에 조회"하는 것이고, 여기선 "**우리가 가진 코퍼스끼리** 대조"한다 — DB에 없는 진짜 lost media가 타깃이라 AcoustID는 못 맞춘다.

**2단계 매칭 파이프라인** (정밀 → 퍼지, 싼 것부터):

| 단계 | 방식 | OSS | 잡아내는 것 | 출력 |
|---|---|---|---|---|
| **A. 지문 매칭** (정밀) | landmark 해시 + 정렬 | **`worldveil/dejavu`** + **Chromaprint**(`pyacoustid`) | *동일 녹음*이 후보 안에 들어있나 — 압축·노이즈·앞뒤 잘림에 강함, **시간 오프셋**까지 | `{candidateId, offsetSec, confidence=정렬해시수}` |
| **B. 특징 유사도** (퍼지) | 음악 특징 벡터 + DTW | **`librosa`**(MFCC·chroma CENS·spectral contrast·tempo) + **Essentia**(MusicExtractor: key/BPM/descriptor) | *다른 녹음*(커버·리마스터·재생속도·흥얼거림) — 지문이 안 붙는 경우의 graded 유사도 | `{candidateId, similarity 0..1}` |

- **A가 히트하면 B는 생략**(정밀 일치 = 확정). A에서 안 걸린 후보만 B로 넘겨 0..1 유사도로 랭킹. 두 점수는 **방식 라벨을 달아 분리 제시**(fingerprint 히트는 항상 fuzzy 위에 랭크) — 거짓 동일축 비교 금지.
- **Dejavu 흐름**: 후보 N개를 **임시(케이스별) 지문 DB**에 적재 → 레퍼런스 클립으로 `recognize` → "이 클립이 들어있는 후보 + 오프셋 + 신뢰도". 짧은 조각 → 풀 트랙 위치 찾기에 정확히 맞는 모델.
- **Essentia vs librosa**: librosa로 chroma 시퀀스 DTW(키/템포 흔들림 보정), Essentia `MusicExtractor`로 key·BPM·descriptor 벡터 → 코사인. 둘을 합쳐 B 점수 산출.

**아키텍처 적합화 (TS 프로젝트에 Python 얹기).** 위 라이브러리는 전부 Python·중량(numpy/scipy/ffmpeg/essentia). 기존 `identify`의 **주입식 `ToolRunner` 패턴 그대로**, 별도 **Python 사이드카**(`tools/audio-match/`, 자체 venv 또는 컨테이너)로 격리하고 Node는 CLI로 호출한다.

```
audio_match { referenceId, candidateIds[], mode?: 'auto'|'fingerprint'|'features', topK? }
  → AudioMatcher (packages/identify)         # 아티팩트 id → blob 경로 해석
    → python tools/audio-match/match.py        # 사이드카: dejavu+chromaprint / librosa+essentia
      → [{ candidateId, method:'fingerprint'|'features', score, offsetSec?, summary }]  # score 내림차순
```

- **도구 표면**: `audio_match`(비교 프리미티브) 1개를 추가(21→22+). **대량 다운로드 루프는 에이전트/스킬이 운전**: `discover`/`p2p_search` → 상위 N개 `download`/`p2p_download` → `p2p_jobs` 폴링 → `audio_match` → 상위 후보 `case_evidence_attach`. (원하면 이 루프를 `audio_hunt {referenceId, query}` 상위 도구로 캡슐화 가능하나, 결합도↑라 1차는 프리미티브만.)
- **아티팩트·프로비넌스**: 레퍼런스·후보 전부 content-addressed 아티팩트. 결과는 방식·점수·오프셋과 함께 케이스파일 evidence로 적재.
- **Graceful degradation**: 사이드카/deps 부재 시 구조화 에러 — `audio_match unavailable: pip install -r tools/audio-match/requirements.txt (dejavu, pyacoustid, librosa, essentia), 또는 vm.exec`. 단계별 독립: chromaprint만 있고 essentia가 없으면 A만 수행.
- **성능**: A 지문화는 후보당 1회·캐시(아티팩트 sha256 키), B는 A 미스에만. N이 크면 사이드카가 후보 배치를 병렬 처리.

→ `identify_fingerprint`(외부 DB 조회)와 상보적: **AcoustID에 없는** 미등록 음원을 *내 코퍼스끼리* 좁히는 게 `audio_match`의 존재 이유다.

---

## 8. Perfect Dark / Share — 정직한 해법

제어 API가 **존재하지 않는다** (폐쇄 소스·Windows 전용·고암호화). 둘 중 하나:

**(A) Windows 서브샌드박스 + GUI 자동화 (권장·현실적)**
- 별도 Windows 워커에 PD/Share 클라이언트 설치
- **computer-use/UI 자동화**로 검색창 입력 → 결과 클릭 → 다운로드 폴더 감시
- 완료 파일을 공유폴더로 빼서 Artifact Store에 적재
- PD/Share를 `pd-search` / `share-search` **executable skill**로 캡슐화 → 에이전트엔 다른 망과 똑같이 `p2p.search(..., nets:["pd"])`로 보임

**(B) 커뮤니티 리버스엔지니어링 라이브러리** — 존재해도 불안정·유지보수 리스크. 1차로는 (A).

→ **어댑터 패턴**이라 PD/Share가 GUI자동화든 RE든, 상위 레이어(통일 인터페이스·아티팩트·케이스파일)는 안 바뀐다.

---

## 9. 보안 / 정책 (P2P 때문에 다시 중요)

P2P는 (1) 임의 피어 연결 (2) 임의 바이너리 수신 → 이 레이어만큼은 격리를 빡세게:

- **전용 네트워크 네임스페이스** + (옵션) VPN/프록시 경유 egress
- 받은 파일은 **격리 워크스페이스에 격리** — 절대 자동 실행 안 함. identify 도구(probe/transcode)로만 검사
- **Capability 모델**: 세션·스킬 단위 fs경로/net호스트/proc 허용 명시. 기본 deny
- **Egress allowlist**: `net.fetch`는 화이트리스트만 (유출/SSRF 방지). P2P egress는 별도 정책
- **모든 취득 = append-only 감사로그** (책임 추적성)
- **리소스 한도**: CPU/메모리/디스크 cgroup, 동시 잡 수, 업로드 비율, 실행 timeout, 출력 크기 cap

---

## 10. 수명주기 — "이어서 조사하기"

조사는 본질적으로 장기·재개형 → **세션 = 영속 케이스**가 기본.
- 케이스별 영속 워크스페이스(아티팩트 + 케이스파일) → 며칠 뒤 재개
- (선택) Firecracker/E2B 스냅샷으로 환경 상태까지 동결/복원
- Ephemeral은 일회성 정찰용 옵션

---

## 11. 모노레포 구조 (TS)

```
aivm-lm/
├─ packages/
│  ├─ protocol/        VM Protocol 타입·JSON-RPC 스키마 (host↔guest 공유)
│  ├─ runtime/         세션·툴라우팅·Claude(Agent SDK) 연동
│  ├─ casefile/        ⭐ 조사 외장두뇌 (SQLite + FTS5)
│  ├─ artifacts/       ⭐ content-addressed 스토어 + 캐시 + provenance
│  ├─ acquisition/     search/fetch/archive/download (yt-dlp·gallery-dl·ArchiveBox 래핑)
│  ├─ recon/           ⭐ 정찰: Source 추상 + Federated Query Planner + coverage
│  │   ├─ sources/surface.ts  (SearXNG)
│  │   ├─ sources/archive.ts  (Wayback CDX·archive.today·Common Crawl)
│  │   ├─ sources/deep.ts     (Prowlarr·NZBHydra·Crawlee 로그인크롤)
│  │   └─ sources/dark.ts     (Tor/Ahmia·i2pd·Hyphanet 게이트웨이)
│  ├─ vault/           자격증명 금고(암호화) + 인증/쿠키 세션
│  ├─ profiles/        ⭐ 도메인 프로파일 (jp-media·western-tv·games config)
│  ├─ identify/        chromaprint·whisper·역이미지·OCR·ffmpeg 래퍼
│  ├─ swarm/           ⭐ 통일 P2P 추상화 + job 매니저
│  │   ├─ adapters/bt.ts      (qbittorrent-nox WebUI API + bitmagnet 검색)
│  │   ├─ adapters/ed2k.ts    (amuled EC / amutorrent 재사용)
│  │   ├─ adapters/pd.ts      (Windows 서브샌드박스 핸들)
│  │   └─ adapters/share.ts
│  ├─ policy/          capability·egress·감사로그
│  └─ sandbox/         Sandbox 추상 + docker / e2b(firecracker) 어댑터
│      └─ windows/     PD/Share용 Windows 워커 + GUI 자동화
├─ skills/
│  ├─ wayback-sweep/        아카이브 전수조사 (prompt)
│  ├─ deepweb-sweep/        딥웹(트래커·포럼·Usenet·IRC) 전수조사 (executable)
│  ├─ onion-hunt/           Tor/I2P/Hyphanet 다크웹 탐색 (executable)
│  ├─ jp/                   일본: pd-share-hunt·niconico-archive·5ch-trace·nyaa-sweep
│  ├─ western-tv/           서양TV: lostmediawiki-index·btn-ptp·archive-org-tv·physical-watch
│  ├─ games/                게임: romset-verify·myrient-fetch·prototype-hunt·proto-authenticate
│  ├─ lostwave-id/          미상 음원 식별 절차 (prompt)
│  ├─ youtube-recover/      삭제영상 복원 트리 (prompt)
│  ├─ forum-discord-crawl/  커뮤니티 단서 수집 (executable)
│  ├─ swarm-hunt/           "해시만 알 때 전 망 전수취득" (executable)
│  ├─ pd-search/            Perfect Dark GUI 조작 (executable)
│  └─ share-search/         Share GUI 조작 (executable)
└─ apps/
   └─ cli/                  aivm case "1970년대 미상 CM송 찾아줘"
```

`protocol`을 host/guest 양쪽이 import → 계약 단일 소스.

---

## 12. MVP 로드맵

| 단계 | 내용 | 가치 |
|---|---|---|
| **1** | `artifacts` + `casefile` | 외장두뇌 + 참조 I/O — **코어, 여기부터** |
| **2** | `acquisition` (search/fetch/archive) + 캐시 | 단서 수집 |
| **3** | `recon` + `vault`: **surface(SearXNG) + deep(Prowlarr/NZBHydra·Crawlee)** | **`discover()` fan-out** — 정찰의 80% |
| **4** | `swarm`: **BT(qbittorrent+bitmagnet) + eD2k/Kad(amuled)** | RPC라 가장 빨리 "실제로 받아짐" |
| **5** | `runtime` + Claude(Agent SDK) 연동 | 두뇌가 1~4를 운전 |
| **6** | `identify` 스킬 (chromaprint·whisper·역이미지·OCR) | 바이너리 → 단서 |
| **7** | `recon` dark: **Tor+Ahmia · i2pd · Hyphanet** + OPSEC 신원격리 | 다크웹 + 안전 가드레일 |
| **8** | `swarm`: **PD/Share** (Windows 서브샌드박스 + GUI 자동화) | 난이도 최상 |
| **9** | `policy` + `sandbox` E2B 전환 + VPN egress | 격리·감사·프로덕션 |

권장 출발점: **`casefile` 스키마 확정**(모든 것이 의존하는 코어) 또는 **`recon` → SearXNG 어댑터**(가장 빨리 "검색이 되는" 단계) 중 택1.

---

## 13. 참고 (출처)

- 샌드박스: [e2b-dev/infra](https://github.com/e2b-dev/infra) · [awesome-sandbox](https://github.com/restyler/awesome-sandbox)
- BT 인덱서: [bitmagnet-io/bitmagnet](https://github.com/bitmagnet-io/bitmagnet) · [magnetico](https://github.com/boramalper/magnetico)
- BT 클라이언트: [qBittorrent WebUI API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-5.0))
- eD2k/Kad: [amule-project/amule](https://github.com/amule-project/amule) · [got3nks/amutorrent](https://github.com/got3nks/amutorrent)
- 오디오 지문: [acoustid/chromaprint](https://github.com/acoustid/chromaprint) · [worldveil/dejavu](https://github.com/worldveil/dejavu) · [marin-m/SongRec](https://github.com/marin-m/SongRec)
- 수집/아카이빙: [yt-dlp](https://github.com/yt-dlp/yt-dlp) · [gallery-dl](https://github.com/mikf/gallery-dl) · [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox)
- 정찰(surface): [SearXNG](https://github.com/searxng/searxng) · 크롤러 [Crawlee](https://github.com/apify/crawlee)
- 정찰(deep/Usenet): [Prowlarr](https://github.com/Prowlarr/Prowlarr) · [NZBHydra2](https://github.com/theotherp/nzbhydra2)
- 정찰(dark): [Ahmia](https://github.com/ahmia/ahmia-site)(.onion 검색) · [i2pd](https://github.com/PurpleI2P/i2pd)(I2P) · Hyphanet(구 Freenet)
- 일본: [nndownload](https://github.com/AlexAplin/nndownload)(Niconico) · [nyaadownloader](https://github.com/marcpinet/nyaadownloader) · AniDB/VGMdb API · 허브 5ch·Niconico·pixiv
- 서양TV: [Lost Media Wiki](https://lostmediawiki.com) · IMDb/TVmaze/TheTVDB · Internet Archive · BTN/PTP(사설트래커) · fuzzymemories.tv
- 게임: No-Intro/Redump/TOSEC DAT · [RomVault](https://wiki.romvault.com) · [no_intro_dat_matcher](https://github.com/lambdan/no_intro_dat_matcher) · [Myrient-Can-FixDAT](https://github.com/UnluckyForSome/Myrient-Can-FixDAT) · Myrient · Hidden Palace · TCRF · Unseen64
- Perfect Dark / Share: 제어 API 없음 (Windows 전용 폐쇄 클라이언트, GUI 자동화 필요)
