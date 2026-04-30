# Millisec v2 — İnfrastruktur Sənədləşməsi

Bu layihə **millisec.live** (external) və **intranet.millisec.live** (intranet) veb saytlarının Docker əsaslı infrastrukturunu əhatə edir. Bütün komponentlər Docker Compose ilə idarə olunur və eyni Linux serverində çalışır.

---

## Mündəricat

- [Arxitektura](#arxitektura)
- [Qovluq strukturu](#qovluq-strukturu)
- [Servislərin izahı](#servislerin-izahi)
- [Şəbəkə izolyasiyası](#şəbəkə-izolyasiyası)
- [API endpointlər](#api-endpointlər)
- [MFA](#mfa)
- [Splunk inteqrasiyası](#splunk-inteqrasiyası)
- [SSL/TLS](#ssltls)
- [WireGuard VPN](#wireguard-vpn)
- [Təhlükəsizlik skanı](#təhlükəsizlik-skanı)
- [Deploy](#deploy)

---

## Arxitektura

```
İnternet
    │
    ▼
[Nginx : 80/443]  ← Reverse Proxy, trafik buradan daxil olur
    │
    ├──▶ millisec.live          → [frontend-external]
    │         └──▶ /api/        → [backend]
    │
    └──▶ intranet.millisec.live → [frontend-intranet]  ← yalnız VPN (10.8.0.0/24)
              └──▶ /api/        → [backend]
                                      │
                                      ▼
                               [PostgreSQL]  ← yalnız daxili şəbəkə
```

---

## Qovluq strukturu

```
millisec-v2/
├── docker-compose.yml          # Bütün servislərin tərifi
├── .env.example                # Mühit dəyişənlərinin nümunəsi
├── nginx/
│   └── nginx.conf              # Reverse proxy + intranet giriş qaydaları
├── frontend-external/
│   ├── Dockerfile              # Public sayt üçün Nginx image
│   ├── nginx-frontend.conf     # Frontend Nginx konfiquriyası
│   └── src/
│       └── index.html          # Public saytın əsas səhifəsi
├── frontend-intranet/
│   ├── Dockerfile              # İntranet sayt üçün Nginx image
│   ├── nginx-frontend.conf     # Frontend Nginx konfiquriyası
│   └── src/
│       └── index.html          # İntranet saytın əsas səhifəsi
├── backend/
│   ├── Dockerfile              # Multi-stage Node.js image
│   ├── package.json
│   └── src/
│       ├── server.js           # Express serveri, rate limiter, logger
│       ├── routes/
│       │   ├── auth.js         # POST /api/login
│       │   ├── profile.js      # GET /api/v1/profile
│       │   └── users.js        # GET /api/v1/users (admin)
│       ├── middleware/
│       │   └── auth.js         # JWT yoxlama middleware
│       └── config/
│           ├── database.js     # PostgreSQL bağlantı pool-u
│           └── splunk.js       # Splunk HEC log göndəricisi
├── database/
│   └── init.sql                # Cədvəl yaratma + standart istifadəçilər
├── vpn/
│   └── wg0.conf                # WireGuard VPN konfiquriyası
├── ssl/
│   └── certbot-init.sh         # Let's Encrypt sertifikat skripti
└── security/
    └── trivy-scan.sh           # Docker image təhlükəsizlik skanı
```

---

## Servislərin izahı

### `docker-compose.yml`

Bütün infrastruktur bu tək fayl ilə idarə olunur. Beş servis var:

| Servis | Image | Şəbəkə | Port |
|---|---|---|---|
| `nginx` | nginx:1.25-alpine | public_net | 80, 443 |
| `frontend-external` | local build | public_net | — |
| `frontend-intranet` | local build | public_net | — |
| `backend` | local build | public_net + private_net | — |
| `postgres` | postgres:16-alpine | private_net | — |

**Əsas məqamlar:**
- `postgres` yalnız `private_net`-də olduğu üçün internetdən birbaşa əlçatmazdır.
- `backend` hər iki şəbəkədədir — həm Nginx-dən sorğu alır (public_net), həm də PostgreSQL-ə qoşulur (private_net).
- Hər servisin `healthcheck` tərifi var — servis sağlam olmadan digər servis başlamaz (`depends_on: condition: service_healthy`).

---

### `nginx/nginx.conf`

Üç virtual host bloku var:

**1. `millisec.live` (external public sayt)**
- İstənilən IP-dən giriş mümkündür.
- `/api/` sorğuları backend konteynerinə yönləndirilir.
- `/` sorğuları frontend-external konteynerinə yönləndirilir.

**2. `intranet.millisec.live` (intranet)**
- `allow 10.8.0.0/24; deny all` — yalnız WireGuard VPN subnet-indən giriş mümkündür.
- Kənardan (public internet) bu domenə giriş cəhdi 403 ilə rədd edilir.

**3. Default server (IP ilə giriş — test məqsədli)**
- Birbaşa IP ilə giriş zamanı external frontend açılır.

**JSON log formatı:**
```nginx
log_format json_combined escape=json
    '{"time":"$time_iso8601","ip":"$remote_addr","method":"$request_method",'
    '"uri":"$request_uri","status":$status,"host":"$host"}';
```
Bu format Splunk HEC tərəfindən birbaşa parse edilə bilər.

---

### `backend/src/server.js`

Express.js əsaslı API serveri. Əsas funksiyalar:

- **`helmet()`** — HTTP təhlükəsizlik başlıqlarını əlavə edir (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` və s.)
- **`cors()`** — Yalnız icazəli domenlərdən sorğu qəbul edilir (`millisec.live`, `intranet.millisec.live`).
- **`loginLimiter`** — 15 dəqiqədə 10-dan çox giriş cəhdi bloklanır. Limit aşıldıqda Splunka `login_rate_limit` hadisəsi göndərilir.
- **Request logger** — Hər HTTP sorğusundan sonra `method`, `path`, `status`, `ip` məlumatları Splunka göndərilir.

---

### `backend/src/routes/auth.js` — `POST /api/login`

İstifadəçi girişini idarə edir.

**Axın:**
1. `username` + `password` qəbul edilir.
2. Verilənlər bazasında istifadəçi axtarılır. Tapılmasa belə `bcrypt.compare()` icra edilir — timing attack-ın qarşısı alınır.
3. Şifrə `bcrypt` ilə yoxlanılır.
4. `REQUIRE_MFA=true` və ya istifadəçinin `mfa_enabled=true` olduqda TOTP kodu tələb olunur (`speakeasy` kitabxanası).
5. Uğurlu girişdə 8 saatlıq JWT token qaytarılır.

**Splunk logları:**
| Hadisə | Status | Səbəb |
|---|---|---|
| `login_failed` | 401 | İstifadəçi tapılmadı |
| `login_failed` | 401 | Yanlış şifrə |
| `login_failed` | 401 | MFA kodu yanlış |
| `login_success` | 200 | Uğurlu giriş |

---

### `backend/src/routes/profile.js` — `GET /api/v1/profile`

JWT token daşıyan istifadəçinin öz məlumatlarını qaytarır. `verifyToken` middleware keçilmədən bu endpoint-ə giriş mümkün deyil.

**Nümunə cavab:**
```json
{
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@millisec.live",
    "role": "admin",
    "last_login": "2026-04-28T10:00:00Z",
    "created_at": "2026-01-01T00:00:00Z"
  }
}
```

---

### `backend/src/routes/users.js` — `GET /api/v1/users`

Yalnız `role: admin` olan istifadəçilər üçün — bütün istifadəçilərin siyahısını qaytarır. Admin olmayan istifadəçi müraciət etdikdə `403 Forbidden` qaytarılır. Bu 403-lər Splunk vasitəsilə izlənir.

---

### `backend/src/middleware/auth.js`

`Authorization: Bearer <token>` başlığını yoxlayır. Token yoxdursa və ya etibarsızdırsa `401` qaytarılır. Token doğrulananda `req.user` obyektinə `id`, `username`, `role` məlumatları yazılır.

---

### `backend/src/config/splunk.js`

Splunk HTTP Event Collector (HEC) ilə inteqrasiya. `.env`-də `SPLUNK_HEC_URL` və `SPLUNK_HEC_TOKEN` doldurulduqda bütün hadisələr avtomatik göndərilir. Hər event bu formatda göndərilir:

```json
{
  "time": 1714300000,
  "event": {
    "event": "login_failed",
    "reason": "wrong_password",
    "ip": "1.2.3.4",
    "username": "admin",
    "status": 401,
    "timestamp": "2026-04-28T10:00:00.000Z"
  }
}
```

**Splunk Dashboard üçün tövsiyə olunan axtarışlar:**
```spl
# 401 xətaları IP-ə görə
index=main event=login_failed | stats count by ip | sort -count

# 403 xətaları
index=main status=403 | timechart count

# DDoS əlaməti — API sorğularında artım
index=main event=http_request | timechart count span=1m
```

---

### `backend/src/config/database.js`

`pg.Pool` ilə PostgreSQL bağlantı pool-u. Maksimum 20 eyni anda bağlantı. `DB_HOST=postgres` — Docker Compose daxilində konteyner adı ilə əlaqə qurulur, portlar xaricə açılmır.

---

### `database/init.sql`

İlk işə salındıqda avtomatik icra edilir. İki cədvəl yaradır:

**`users` cədvəli** — İstifadəçi məlumatları:
- `password_hash` — bcrypt ilə şifrələnmiş (salt rounds: 12)
- `mfa_secret` — TOTP sirr açarı (Base32)
- `mfa_enabled` — MFA aktiv/deaktiv
- `last_login` — Son giriş vaxtı

**`login_logs` cədvəli** — Giriş tarixçəsi (gələcək audit üçün).

Standart istifadəçilər:
| İstifadəçi | Rol | Şifrə |
|---|---|---|
| `admin` | admin | `Admin123!` |
| `john` | user | `Admin123!` |
| `sarah` | staff | `Admin123!` |

> ⚠️ Deploy etməzdən əvvəl bu şifrələri mütləq dəyişdirin!

---

### `backend/Dockerfile`

Multi-stage build istifadə edilir:

```dockerfile
# Mərhələ 1: asılılıqları yüklə
FROM node:20-alpine AS builder
RUN npm install --omit=dev   # yalnız production asılılıqları

# Mərhələ 2: yalnız lazımlı faylları kopyala
FROM node:20-alpine
RUN adduser -S appuser       # root olmayan istifadəçi
USER appuser                 # container root ilə işləmir
```

Bu yanaşma image ölçüsünü azaldır və Trivy/Snyk skanında "running as root" xəbərdarlığının qarşısını alır.

---

### `frontend-external/Dockerfile` və `frontend-intranet/Dockerfile`

`nginx:1.25-alpine` əsasında minimal image. `nginxuser` ilə root-suz işləyir. Static HTML/CSS/JS faylları kopyalanır.

---

## Şəbəkə izolyasiyası

```
┌─────────────────────────────────────────┐
│           public_net (bridge)           │
│                                         │
│  [nginx] ──▶ [frontend-external]        │
│           ──▶ [frontend-intranet]       │
│           ──▶ [backend]                 │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│     private_net (bridge, internal:true) │
│                                         │
│          [backend] ──▶ [postgres]       │
│                                         │
│  ❌ İnternetdən bu şəbəkəyə giriş yoxdur│
└─────────────────────────────────────────┘
```

`internal: true` Docker-in bu şəbəkədən xaricə çıxışı tamamilə bağlamasını bildirir.

---

## API endpointlər

| Method | Endpoint | Açıqlama | Auth |
|---|---|---|---|
| `POST` | `/api/login` | İstifadəçi girişi, JWT qaytarır | — |
| `GET` | `/api/v1/profile` | Öz profil məlumatları | JWT |
| `GET` | `/api/v1/users` | Bütün istifadəçilər (admin) | JWT + admin role |
| `GET` | `/api/health` | Servis sağlamlıq yoxlaması | — |

**Giriş nümunəsi:**
```bash
# Login
curl -X POST https://millisec.live/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin123!","mfa_code":"123456"}'

# Profile (token ilə)
curl https://millisec.live/api/v1/profile \
  -H "Authorization: Bearer <token>"
```

---

## MFA

TOTP (Time-based One-Time Password) əsaslı MFA. Google Authenticator, Authy və ya istənilən TOTP tətbiqi ilə işləyir.

**Aktivləşdirmə:**
```bash
# .env faylında
REQUIRE_MFA=true
```

`REQUIRE_MFA=true` olduqda bütün istifadəçilər girişdə 6 rəqəmli TOTP kodu daxil etməlidir. Verilənlər bazasındakı `mfa_secret` sütununa Base32 sirr açarı yazılır.

**İstifadəçiyə QR kod göstərmək üçün:**
```
otpauth://totp/Millisec:<username>?secret=<mfa_secret>&issuer=Millisec
```

---

## Splunk inteqrasiyası

`.env` faylında aşağıdakıları doldurun:
```env
SPLUNK_HEC_URL=https://splunk-server:8088/services/collector/event
SPLUNK_HEC_TOKEN=your-hec-token
```

**Splunkda izlənən hadisələr:**

| Hadisə | Mənası |
|---|---|
| `login_failed` (401) | Uğursuz giriş cəhdi |
| `login_success` (200) | Uğurlu giriş |
| `login_rate_limit` (429) | Brute-force cəhdi |
| `http_request` + status 403 | İcazəsiz giriş cəhdi |
| `http_request` artımı | DDoS ehtimalı |

---

## SSL/TLS

`ssl/certbot-init.sh` skripti Let's Encrypt sertifikatını alır və Nginx-i HTTPS üçün konfiqurasiya edir.

```bash
chmod +x ssl/certbot-init.sh
sudo ./ssl/certbot-init.sh
```

Sertifikat alındıqdan sonra bütün HTTP sorğuları avtomatik HTTPS-ə yönləndirilir (301 redirect).

---

## WireGuard VPN

`vpn/wg0.conf` faylı WireGuard VPN konfiquriyasiyasını ehtiva edir. VPN qurulduqda şirkət əməkdaşları `10.8.0.0/24` subnetindən IP alır və `intranet.millisec.live`-a giriş əldə edirlər.

**VPN aktivləşdirmə:**
```bash
sudo wg-quick up /etc/wireguard/wg0.conf
sudo systemctl enable wg-quick@wg0
```

**VPN ilə intranet girişi axını:**
1. Əməkdaş VPN-ə qoşulur → `10.8.0.x` IP alır.
2. `intranet.millisec.live`-a müraciət edir.
3. Nginx `allow 10.8.0.0/24` qaydası ilə girişə icazə verir.
4. MFA kodu daxil edilir (əgər `REQUIRE_MFA=true`).
5. Giriş uğurlu olur.

---

## Təhlükəsizlik skanı

`security/trivy-scan.sh` skripti bütün Docker image-lərini Trivy ilə skan edir.

```bash
chmod +x security/trivy-scan.sh
./security/trivy-scan.sh
```

Skript aşağıdakı image-ləri skan edir:
- `millisec-backend`
- `millisec-frontend-external`
- `millisec-frontend-intranet`
- `nginx:1.25-alpine`
- `postgres:16-alpine`

Nəticə `security/scan-results/` qovluğuna JSON formatında yazılır. `CRITICAL` və ya `HIGH` səviyyəli zəiflik aşkar edildikdə skript `exit 1` ilə dayanır.

---

## Deploy

### 1. Reponu klon et

```bash
git clone https://github.com/your-org/millisec-v2.git
cd millisec-v2
```

### 2. Mühit dəyişənlərini tənzimlə

```bash
cp .env.example .env
nano .env
```

Minimum doldurulmalı sahələr:
```env
DB_PASSWORD=<güclü_şifrə>
JWT_SECRET=<minimum_32_simvol_sirr_açarı>
REQUIRE_MFA=true
SPLUNK_HEC_URL=https://splunk:8088/services/collector/event
SPLUNK_HEC_TOKEN=<hec_token>
```

### 3. SSL sertifikatı al

```bash
sudo ./ssl/certbot-init.sh
```

### 4. VPN-i aktivləşdir

```bash
sudo wg-quick up /etc/wireguard/wg0.conf
sudo systemctl enable wg-quick@wg0
```

### 5. Təhlükəsizlik skanını icra et

```bash
./security/trivy-scan.sh
```

### 6. Servisləri başlat

```bash
docker compose up -d
docker compose ps        # servislərin vəziyyətini yoxla
docker compose logs -f   # logları izlə
```

### 7. Test et

```bash
# External sayt
curl -I https://millisec.live

# API sağlamlıq yoxlaması
curl https://millisec.live/api/health

# İntranet (yalnız VPN-dən)
curl -I https://intranet.millisec.live

# İntranet (VPN-siz — 403 gəlməlidir)
curl -I https://intranet.millisec.live
```

---

## Faydalı əmrlər

```bash
# Servisləri yenidən başlat
docker compose restart

# Yalnız backend-i yenidən başlat
docker compose restart backend

# Logları izlə
docker compose logs -f backend
docker compose logs -f nginx

# Konteynerin daxilinə gir
docker compose exec backend sh
docker compose exec postgres psql -U millisec_user -d millisec

# Servisləri dayandır
docker compose down

# Servisləri + volumları sil (DİQQƏT: məlumatlar silinir)
docker compose down -v
```

---

## Lisenziya

Bu layihə Millisec şirkətinin daxili infrastruktur sənədləşməsidir.
