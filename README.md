# 📚 Notion‑Tabanlı Wiki API

Bu repository, Notion veritabanınızı bir **REST API** olarak sunar. Vercel Edge ortamında çalışır ve aşağıdaki özellikleri sunar:

- **Sayfa, liste, arama** ve **breadcrumb** (üst‑sayfa) endpointleri
- **CORS** ve **rate‑limit** korumaları
- KV (Upstash/Redis) ya da bellek içi cache ile hızlı yanıtlar
- Markdown → HTML dönüşümü (sanitized)
- Kolay lokal geliştirme (`npm run dev` / `npx vercel dev`)

## 🔧 Çevre Değişkenleri
`.env` dosyanıza (veya Vercel dashboard'ınıza) aşağıdaki değişkenleri ekleyin:
```
NOTION_API_KEY=your_notion_secret
NOTION_DATABASE_ID=your_database_id
# KV (opsiyonel) – Upstash/Redis Rest API
KV_REST_API_URL=https://...rest.upstash.io
KV_REST_API_TOKEN=your_kv_token
# CORS izinli origin'ler (virgülle ayrılmış)
CORS_ALLOWLIST=https://mydomain.com, http://localhost:3000
```
> **Not:** `KV_REST_API_URL` ve `KV_REST_API_TOKEN` sağlanmazsa sistem, bellek içi cache (`LOCAL_CACHE`) kullanır.

## 📡 API Kullanımı
### 1️⃣ Sayfa Listesi
```
GET /api/notion?list=true&limit=100
```
*`limit`* parametresi opsiyoneldir (default 2000). Sadece `Kamu` statüsündeki sayfalar döner.

### 2️⃣ Tek Sayfa (slug)
```
GET /api/notion?slug=ornek-sayfa-slugu
```
HTML render'ı `content` alanında bulunur.

### 3️⃣ Arama
```
GET /api/notion?search=aranacak+kelime
```
Minimum 2 karakter olmalı, saniyede 30 istek limiti vardır.

### 4️⃣ Çocuk Sayfalar (parent_id)
```
GET /api/notion?parent_id=PAGE_ID
```
Belirtilen sayfanın alt‑sayfalarını getirir.

### 5️⃣ Breadcrumb / Tek Sayfa Bilgisi (id)
```
GET /api/notion?id=PAGE_ID
```
Sayfanın meta verilerini (id, title, slug, tags, …) döner.

## ⏱️ Rate‑Limit
- IP başına **120** istek/saniye (genel)
- Arama için **30** istek/saniye
Limit aşıldığında `429 Too Many Requests` ve `Retry‑After` başlığı döner.

## 🛡️ Güvenlik
- **CORS**: `CORS_ALLOWLIST` içinde tanımlı origin'ler izinli. `*` sadece development ortamında aktif.
- **HTML sanitizasyonu**: `marked` render'ı ve özel `sanitizeRawHtml` fonksiyonu üzerinden tehlikeli etiket ve event‑handler'lar kaldırılır.
- **Cache**: KV veya bellek içi cache sayesinde aynı içerik hızlıca sunulur.

## 🏗️ Geliştirme
Kod değişikliği yaptıktan sonra Vercel dev otomatik olarak yeniden yükler. Yeni endpoint eklemek için `handler` fonksiyonuna ekleme yapın ve gerekli cache anahtarlarını tanımlayın.

## 📜 Lisans
Bu proje MIT lisansı altında dağıtılmaktadır. (LICENSE dosyasına bakınız.)

---
*Bu README, projenin amacı, kurulum adımları, çevre değişkenleri, API uç noktaları ve geliştirme rehberi hakkında detaylı Türkçe açıklama sunar.*
