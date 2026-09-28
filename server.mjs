import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const SERVICE_KEY_RAW = String(process.env.PUBLIC_DATA_SERVICE_KEY || '').trim();
const API_BASE = 'http://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius';
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(self)'
  });
  res.end(data);
}

function text(res, status, body, type='text/plain; charset=utf-8') {
  const data = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': type.includes('html') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(data);
}

function safeServiceKey() {
  if (!SERVICE_KEY_RAW) return '';
  try {
    return SERVICE_KEY_RAW.includes('%') ? decodeURIComponent(SERVICE_KEY_RAW) : SERVICE_KEY_RAW;
  } catch {
    return SERVICE_KEY_RAW;
  }
}

async function nominatimSearch(q, limit=5) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('countrycodes', 'kr');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'ko');
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Sanggwon-Web-Analyzer/2.1 (+https://sanggwon-mobile-api.onrender.com)',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5'
      }
    });
    if (!r.ok) return [];
    const arr = await r.json();
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function normalizeKoreanAddressText(v) {
  return String(v || '')
    .replace(/^대한민국\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/번지/g, '')
    .trim();
}

function buildExpandedAddressFromLocality(original, localityResult, localityToken) {
  const a = localityResult?.address || {};
  const remainder = original.replace(localityToken, '').trim();

  const parts = [
    remainder,
    localityToken,
    a.city_district,
    a.county,
    a.city,
    a.state_district,
    a.state,
    '대한민국'
  ].map(x => String(x || '').trim()).filter(Boolean);

  return [...new Set(parts)].join(', ');
}

async function geocode(address) {
  const normalized = normalizeKoreanAddressText(address);
  if (!normalized) throw new Error('ADDRESS_REQUIRED');

  // Known default point retained for reliable demo/search start.
  if (/풍암/.test(normalized) && /1074/.test(normalized)) {
    return { lat: 35.12339, lon: 126.8829774, displayName: '광주광역시 서구 풍암동 1074', resolvedQuery: normalized };
  }

  const directVariants = [...new Set([
    normalized,
    `${normalized}, 대한민국`,
    normalized.replace(/\s+(\d+(?:-\d+)?)$/, ' $1'),
    `대한민국 ${normalized}`
  ])].filter(Boolean);

  // 1. Direct search first.
  for (const q of directVariants) {
    const arr = await nominatimSearch(q, 5);
    if (arr[0]) {
      return {
        lat: Number(arr[0].lat),
        lon: Number(arr[0].lon),
        displayName: arr[0].display_name || q,
        resolvedQuery: q
      };
    }
  }

  // 2. If the address is abbreviated, resolve the 읍/면/동/리 first,
  //    then rebuild the road address with its upper administrative areas.
  const tokens = normalized.split(' ');
  const localityToken = tokens.find(t => /(읍|면|동|리)$/.test(t));
  if (localityToken) {
    const localityQueries = [
      `${localityToken}, 대한민국`,
      localityToken
    ];

    for (const lq of localityQueries) {
      const localities = await nominatimSearch(lq, 10);
      for (const loc of localities) {
        const expanded = buildExpandedAddressFromLocality(normalized, loc, localityToken);
        const candidates = [
          expanded,
          expanded.replace(/, 대한민국$/, ''),
          `${normalized}, ${loc.display_name || ''}`
        ].filter(Boolean);

        for (const q of [...new Set(candidates)]) {
          const arr = await nominatimSearch(q, 5);
          if (arr[0]) {
            return {
              lat: Number(arr[0].lat),
              lon: Number(arr[0].lon),
              displayName: arr[0].display_name || q,
              resolvedQuery: q
            };
          }
        }
      }
    }
  }

  // 3. Road + building number fallback:
  //    search locality, then search the road phrase inside that locality context.
  const roadMatch = normalized.match(/(.+?(?:로|길|대로))\s*(\d+(?:-\d+)?)/);
  if (roadMatch && localityToken) {
    const roadPart = `${roadMatch[1].trim()} ${roadMatch[2]}`;
    const localities = await nominatimSearch(`${localityToken}, 대한민국`, 10);

    for (const loc of localities) {
      const a = loc.address || {};
      const context = [
        localityToken,
        a.county,
        a.city,
        a.state,
        '대한민국'
      ].filter(Boolean).join(', ');

      const q = `${roadPart}, ${context}`;
      const arr = await nominatimSearch(q, 5);
      if (arr[0]) {
        return {
          lat: Number(arr[0].lat),
          lon: Number(arr[0].lon),
          displayName: arr[0].display_name || q,
          resolvedQuery: q
        };
      }
    }
  }

  throw new Error('ADDRESS_GEOCODING_FAILED');
}

function extractApiError(raw, status) {
  const s = String(raw || '').trim();
  if (!s) return `HTTP ${status}`;
  try {
    const obj = JSON.parse(s);
    const h = obj?.response?.header || obj?.header || obj?.cmmMsgHeader || {};
    return h.resultMsg || h.returnAuthMsg || h.errMsg || h.resultCode || `HTTP ${status}`;
  } catch {}
  const m = s.match(/<(?:returnAuthMsg|errMsg|resultMsg|resultCode)>([^<]+)<\//i);
  return m ? m[1] : `HTTP ${status}`;
}

function parsePayload(raw) {
  const s = String(raw || '').trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch {
    const msg = extractApiError(s, 200);
    throw new Error(`PUBLIC_DATA_API_ERROR|${msg}`);
  }
  const body = obj?.body || obj?.response?.body;
  if (!body) {
    const msg = obj?.header?.resultMsg || obj?.response?.header?.resultMsg || '응답 본문 없음';
    throw new Error(`PUBLIC_DATA_API_ERROR|${msg}`);
  }
  let items = body.items?.item ?? body.items ?? [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  const totalCount = Number(body.totalCount || items.length || 0);
  return { items, totalCount };
}

async function getPage(lat, lon, radius, pageNo) {
  const serviceKey = safeServiceKey();
  if (!serviceKey) throw new Error('SERVICE_KEY_MISSING');
  const url = new URL(API_BASE);
  url.searchParams.set('ServiceKey', serviceKey);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', '100');
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('cx', String(lon));
  url.searchParams.set('cy', String(lat));
  url.searchParams.set('type', 'json');
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': 'Sanggwon-Mobile-Analyzer/1.0' } });
  } catch (e) {
    throw new Error(`NETWORK_TO_PUBLIC_DATA_FAILED|${e.message}`);
  }
  const raw = await r.text();
  if (!r.ok) {
    const msg = extractApiError(raw, r.status);
    if (r.status === 403) throw new Error(`PUBLIC_DATA_FORBIDDEN|${msg}`);
    throw new Error(`PUBLIC_DATA_HTTP_ERROR|${r.status}|${msg}`);
  }
  return parsePayload(raw);
}

function normalizeStore(x) {
  const lat = Number(x.lat);
  const lon = Number(x.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: String(x.bizesId || ''),
    name: String(x.bizesNm || '상호 미상'),
    branch: String(x.brchNm || ''),
    largeCode: String(x.indsLclsCd || ''),
    largeCategory: String(x.indsLclsNm || '기타'),
    midCode: String(x.indsMclsCd || ''),
    midCategory: String(x.indsMclsNm || ''),
    smallCode: String(x.indsSclsCd || ''),
    smallCategory: String(x.indsSclsNm || ''),
    address: String(x.rdnmAdr || ''),
    lotAddress: String(x.lnoAdr || ''),
    lat, lon
  };
}

function countBy(stores, prop) {
  const m = new Map();
  for (const s of stores) {
    const name = String(s[prop] || '기타').trim() || '기타';
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count }))
    .sort((a,b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
}

async function analyze(address, radius) {
  const cacheKey = `${address}__${radius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  const center = await geocode(address);
  const first = await getPage(center.lat, center.lon, radius, 1);
  const pages = Math.max(1, Math.ceil(first.totalCount / 100));
  const raw = [...first.items];
  for (let p=2; p<=pages; p++) {
    const next = await getPage(center.lat, center.lon, radius, p);
    raw.push(...next.items);
  }
  const stores = raw.map(normalizeStore).filter(Boolean);
  const data = {
    query: { address, radius },
    center,
    total: stores.length,
    countsLarge: countBy(stores, 'largeCategory'),
    countsMid: countBy(stores, 'midCategory'),
    stores
  };
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

async function analyzeCoord(lat, lon, radius) {
  const cacheKey = `coord__${lat.toFixed(6)}__${lon.toFixed(6)}__${radius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  const first = await getPage(lat, lon, radius, 1);
  const pages = Math.max(1, Math.ceil(first.totalCount / 100));
  const raw = [...first.items];
  for (let p=2; p<=pages; p++) {
    const next = await getPage(lat, lon, radius, p);
    raw.push(...next.items);
  }
  const stores = raw.map(normalizeStore).filter(Boolean);
  const data = {
    query: { mode: 'coord', radius },
    center: { lat, lon, displayName: '다각형 검색 중심점' },
    total: stores.length,
    countsLarge: countBy(stores, 'largeCategory'),
    countsMid: countBy(stores, 'midCategory'),
    stores
  };
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function mapError(err) {
  const msg = String(err?.message || err || 'UNKNOWN');
  const [code, ...rest] = msg.split('|');
  const detail = rest.join('|');
  const known = new Set(['SERVICE_KEY_MISSING','ADDRESS_REQUIRED','ADDRESS_GEOCODING_FAILED','NETWORK_TO_PUBLIC_DATA_FAILED','PUBLIC_DATA_FORBIDDEN','PUBLIC_DATA_HTTP_ERROR','PUBLIC_DATA_API_ERROR']);
  if (known.has(code)) return { code, error: detail || code };
  return { code: 'SERVER_ERROR', error: msg };
}

const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon'
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && file !== path.resolve(PUBLIC_DIR, 'index.html')) {
    return text(res, 403, 'Forbidden');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return text(res, 404, 'Not found');
  return text(res, 200, fs.readFileSync(file), mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(req.url || '/', base);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end();
  }
  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, version: 'web-2.1', keyConfigured: Boolean(SERVICE_KEY_RAW) });
  }
  if (url.pathname === '/api/geocode') {
    const address = String(url.searchParams.get('address') || '').trim();
    if (!address) return json(res, 400, { code:'ADDRESS_REQUIRED', error:'주소를 입력해야 함' });
    try {
      const point = await geocode(address);
      return json(res, 200, point);
    } catch (e) {
      const mapped = mapError(e);
      return json(res, 502, mapped);
    }
  }
  if (url.pathname === '/api/stores-coord') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radius = Number(url.searchParams.get('radius') || 500);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return json(res, 400, { code:'COORD_INVALID', error:'위도·경도 값이 올바르지 않음' });
    }
    if (!Number.isFinite(radius) || radius < 50 || radius > 2000) {
      return json(res, 400, { code:'RADIUS_INVALID', error:'반경은 50~2000m 범위여야 함' });
    }
    try {
      const data = await analyzeCoord(lat, lon, Math.round(radius));
      return json(res, 200, data);
    } catch (e) {
      const mapped = mapError(e);
      const status = mapped.code === 'PUBLIC_DATA_FORBIDDEN' ? 403 : (mapped.code === 'SERVICE_KEY_MISSING' ? 503 : 502);
      return json(res, status, mapped);
    }
  }
  if (url.pathname === '/api/stores') {
    const address = String(url.searchParams.get('address') || '').trim();
    const radius = Number(url.searchParams.get('radius') || 500);
    if (!address) return json(res, 400, { code:'ADDRESS_REQUIRED', error:'주소를 입력해야 함' });
    if (!Number.isFinite(radius) || radius < 50 || radius > 2000) return json(res, 400, { code:'RADIUS_INVALID', error:'반경은 50~2000m 범위여야 함' });
    try {
      const data = await analyze(address, Math.round(radius));
      return json(res, 200, data);
    } catch (e) {
      const mapped = mapError(e);
      const status = mapped.code === 'PUBLIC_DATA_FORBIDDEN' ? 403 : (mapped.code === 'SERVICE_KEY_MISSING' ? 503 : 502);
      return json(res, status, mapped);
    }
  }
  return serveStatic(req, res, decodeURIComponent(url.pathname));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sanggwon Web App running on port ${PORT}`);
  console.log(`API key configured: ${Boolean(SERVICE_KEY_RAW)}`);
});
