/**
 * MacroLens — Cloudflare Worker
 * 역할:
 *   1. FRED API 프록시 (API Key 은닉)
 *   2. NY Fed Primary Dealer CSV 프록시 (CORS 우회)
 *   3. Fed H.4.1 HTML 파싱 (대차대조표 자동 분석)
 *   4. 모든 응답에 CORS 헤더 부착
 *
 * 환경변수 (CF Dashboard > Workers > Settings > Variables):
 *   FRED_API_KEY  =  발급받은 FRED API 키
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KV 캐시 키 & TTL 설정 (FRED 데이터만 캐시)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const KV_KEYS = {
  liq:        'liq_data_v2',
  yieldsHist: 'yields_hist_v1',
  calendar:   'calendar_v1',
  t2:         't2_data_v1',
  t3:         't3_global_v1',
  qraActive:  'qra_active_v1',
  qraPending: 'qra_pending_v1',
  liqTower:   'liq_tower_v1',
};
const KV_TTL = {
  liq:        7200,
  yieldsHist: 86400,
  calendar:   21600,
  t2:         7200,
  t3:         7200,
  qraActive:  86400 * 95,  // 95일 (분기+여유)
  qraPending: 86400 * 30,  // 30일
  liqTower:   3600 * 6,    // 6h
};

const kvGet = async (env, key) => {
  try { return await env.MMF_KV.get(key, { type: 'json' }); }
  catch(e) { return null; }
};
const kvPut = async (env, key, data, ttl) => {
  try {
    const payload = { ...data, _savedAt: new Date().toISOString() };
    await env.MMF_KV.put(key, JSON.stringify(payload), { expirationTtl: ttl });
    return payload;
  } catch(e) {
    console.error('[KV PUT ERROR]', key, e.message);
    return data;
  }
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url   = new URL(request.url);
    const path  = url.pathname;
    const force = url.searchParams.get('force') === '1';

    try {
      if (path.startsWith('/fred'))          return await fredProxy(url, env);
      if (path.startsWith('/nyfed-raw'))     return await nyFedRaw(url);
      if (path.startsWith('/nyfed'))         return await fredProxy(url, env);
      if (path.startsWith('/ofr-fsi'))       return await ofrFsi(env);
      if (path.startsWith('/ofr'))           return await ofrFallback(url, env);
      if (path.startsWith('/h41-history'))   return await h41HistoryFetcher(url);
      if (path.startsWith('/h41-html'))      return await h41HtmlParser();
      if (path.startsWith('/h41'))           return await h41Parser(env);
      if (path.startsWith('/multifред'))     return await fredMulti(url, env);
      if (path.startsWith('/dxy'))           return await dxyAnalysis();
      if (path.startsWith('/jpy'))           return await jpyCarryRisk();
      if (path.startsWith('/yahoo-chart'))   return await yahooChart(url);
      if (path.startsWith('/yahoo'))         return await yahooProxy(url);
      if (path.startsWith('/ism'))           return await ismProxy(url);
      if (path.startsWith('/ici-raw'))       return await iciRaw();
      if (path.startsWith('/ici'))           return await iciMMF(env, ctx);
      if (path.startsWith('/pipe3'))         return await pipe3CreditRisk(env, ctx);
      // ⚠️ 더 구체적인 경로를 반드시 먼저 — /liq-tower가 /liq보다 앞에
      if (path.startsWith('/liq-tower'))     return await liqTowerCached(env, force, ctx);
      if (path.startsWith('/liq'))           return await liqCached(env, force, ctx);
      if (path.startsWith('/yields-hist'))   return await yieldsHistCached(env, force, ctx);
      if (path.startsWith('/calendar'))      return await calendarEndpoint(env, force, ctx);
      if (path.startsWith('/t2'))            return await t2Cached(env, force, ctx);
      if (path.startsWith('/t3'))            return await t3Cached(env, force, ctx);
      // QRA 엔드포인트 — /qra-apply, /qra-preview 등 구체적인 것 먼저
      if (path.startsWith('/qra-status'))    return await qraStatus(env);
      if (path.startsWith('/qra-preview'))   return await qraPreview(env);
      if (path.startsWith('/qra-apply'))     return await qraApply(request, env);
      if (path.startsWith('/qra-dismiss'))   return await qraDismiss(env);
      if (path.startsWith('/srf'))           return await srfProxy();
      if (path.startsWith('/cds-api-test'))  return await cdsApiTest();
      if (path.startsWith('/cds-live'))      return await cdsLive();
      if (path.startsWith('/cds-debug'))     return await cdsDebug();
      if (path.startsWith('/cds-raw'))       return await cdsRaw(url);
      if (path.startsWith('/auction-debug')) return await auctionDebug();
      if (path.startsWith('/auction-html-debug')) return await auctionHtmlDebug();

      return json({ error: 'Unknown route' }, 404);
    } catch(e) {
      return json({ error: e.message }, 500);
    }
  },

  // Cron 트리거 — FRED 데이터 주기적 갱신
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      refreshLiq(env),
      refreshYieldsHist(env),
      refreshT2(env),
      refreshT3(env),
      fetchCalendar(env).then(data => kvPut(env, KV_KEYS.calendar, data, KV_TTL.calendar)),
      refreshLiqTower(env),
    ]));
    // 수요일에만 QRA 자동 감지
    const isWednesday = new Date().getUTCDay() === 3;
    if (isWednesday) {
      ctx.waitUntil(checkNewQra(env));
    }
  }
};

// ── KV-first 래퍼 ─────────────────────────────────────
async function liqCached(env, force = false, ctx) {
  if (!force) {
    const cached = await kvGet(env, KV_KEYS.liq);
    if (cached) return json(cached);
  }
  const resp = await liqDataEndpoint(env);
  const data = await resp.json();  // clone 불필요 — 아래서 json(data)로 반환
  const putPromise = kvPut(env, KV_KEYS.liq, data, KV_TTL.liq);
  if (ctx?.waitUntil) ctx.waitUntil(putPromise); else await putPromise;
  return json(data);  // body 이미 소비됐으므로 resp 재사용 금지
}

async function yieldsHistCached(env, force = false, ctx) {
  if (!force) {
    const cached = await kvGet(env, KV_KEYS.yieldsHist);
    if (cached) return json(cached);
  }
  const resp = await yieldsHistory(env);
  const data = await resp.json();
  const putPromise = kvPut(env, KV_KEYS.yieldsHist, data, KV_TTL.yieldsHist);
  if (ctx?.waitUntil) ctx.waitUntil(putPromise); else await putPromise;
  return json(data);
}

// ── Cron 갱신 함수 ────────────────────────────────────
async function calendarEndpoint(env, force = false, ctx) {
  if (!force) {
    const cached = await kvGet(env, KV_KEYS.calendar);
    if (cached) return json(cached);
  }
  const data = await fetchCalendar(env);
  const putPromise = kvPut(env, KV_KEYS.calendar, data, KV_TTL.calendar);
  if (ctx?.waitUntil) ctx.waitUntil(putPromise); else await putPromise;
  return json(data);
}

// ── FRED 이벤트 캘린더 ─────────────────────────────────
async function fetchCalendar(env) {
  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) return { error: 'FRED_API_KEY 없음', events: [] };

  // 주요 릴리즈 ID 및 메타 (high/medium만 표시)
  const RELEASES = {
    21:  { nameKo: '소비자물가 (CPI)',        imp: 'high',   tag: '인플레', series:'CPIAUCSL',  fmt:'yoy'  },
    6:   { nameKo: '생산자물가 (PPI)',        imp: 'high',   tag: '인플레', series:'PPIACO',    fmt:'yoy'  },
    46:  { nameKo: '개인소비지출 (PCE)',      imp: 'high',   tag: '인플레', series:'PCEPI',     fmt:'yoy'  },
    10:  { nameKo: '고용보고서 (NFP)',        imp: 'high',   tag: '고용',   series:'PAYEMS',    fmt:'mom'  },
    22:  { nameKo: '신규실업수당',            imp: 'medium', tag: '고용',   series:'ICSA',      fmt:'val'  },
    138: { nameKo: '구인이직보고서 (JOLTS)',  imp: 'medium', tag: '고용',   series:'JTSJOL',    fmt:'val'  },
    31:  { nameKo: 'GDP 성장률',              imp: 'high',   tag: '성장',   series:'A191RL1Q225SBEA', fmt:'val' },
    56:  { nameKo: '소매판매',               imp: 'medium', tag: '성장',   series:'RSAFS',     fmt:'mom'  },
    175: { nameKo: 'FOMC 의사록',            imp: 'high',   tag: '연준',   series:null,        fmt:null   },
    33:  { nameKo: 'ISM 제조업 PMI',         imp: 'medium', tag: '경기',   series:'NAPM',      fmt:'val'  },
    57:  { nameKo: 'ISM 서비스업 PMI',       imp: 'medium', tag: '경기',   series:'NMFCI',     fmt:'val'  },
    237: { nameKo: '주택착공',               imp: 'medium', tag: '주택',   series:'HOUST',     fmt:'val'  },
    82:  { nameKo: '소비자심리 (미시간)',     imp: 'medium', tag: '경기',   series:'UMCSENT',   fmt:'val'  },
    113: { nameKo: '내구재 주문',            imp: 'medium', tag: '성장',   series:'DGORDER',   fmt:'mom'  },
  };

  // 발표 데이터 fetch 헬퍼 (D-DAY 이벤트용)
  const fetchLatest = async (seriesId, fmtType) => {
    if (!seriesId) return null;
    try {
      const limit = fmtType === 'yoy' ? 14 : 2;
      const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&limit=${limit}&sort_order=desc`;
      const r = await fetch(u, { cf: { cacheTtl: 1800 } });
      if (!r.ok) return null;
      const d = await r.json();
      const obs = (d.observations || []).filter(o => o.value !== '.');
      if (!obs.length) return null;
      const cur  = parseFloat(obs[0].value);
      const prev = obs[1] ? parseFloat(obs[1].value) : null;
      if (fmtType === 'yoy') {
        const yr = obs[12] ? parseFloat(obs[12].value) : null;
        if (yr == null || yr === 0) return null;
        const yoy = ((cur - yr) / yr * 100).toFixed(2);
        return { label: `YoY ${yoy >= 0 ? '+' : ''}${yoy}%`, val: parseFloat(yoy) };
      } else if (fmtType === 'mom') {
        if (prev == null || prev === 0) return null;
        const mom = ((cur - prev) / Math.abs(prev) * 100).toFixed(1);
        return { label: `MoM ${mom >= 0 ? '+' : ''}${mom}%`, val: parseFloat(mom) };
      } else {
        const unit = seriesId === 'ICSA' || seriesId === 'JTSJOL' ? '만' : '';
        const dispVal = (seriesId === 'ICSA' || seriesId === 'JTSJOL')
          ? (cur / 1000).toFixed(1) + '만 건'
          : cur.toFixed(1);
        return { label: dispVal, val: cur };
      }
    } catch(e) { return null; }
  };

  const today = new Date();
  const end   = new Date(today);
  end.setDate(end.getDate() + 45);
  const fmt = d => d.toISOString().slice(0, 10);

  try {
    const u = `https://api.stlouisfed.org/fred/releases/dates`
      + `?api_key=${apiKey}&file_type=json`
      + `&realtime_start=${fmt(today)}&realtime_end=${fmt(end)}`
      + `&sort_order=asc&limit=500&include_release_dates_with_no_data=true`;
    const r = await fetch(u, { cf: { cacheTtl: 3600 } });
    if (!r.ok) return { error: `FRED ${r.status}`, events: [] };
    const d = await r.json();

    const todayStr = fmt(today);
    const events = (d.release_dates || [])
      .filter(e => RELEASES[e.release_id])
      .map(e => {
        const meta = RELEASES[e.release_id];
        const diff = Math.round((new Date(e.date) - today) / 86400000);
        return {
          date:      e.date,
          dday:      diff === 0 ? 'D-DAY' : diff > 0 ? `D-${diff}` : `D+${Math.abs(diff)}`,
          name:      meta.nameKo,
          imp:       meta.imp,
          tag:       meta.tag,
          series:    meta.series   ?? null,
          seriesFmt: meta.fmt      ?? null,
          released:  null,  // D-DAY 시 채워짐
        };
      })
      // 같은 날 같은 릴리즈 중복 제거
      .filter((e, i, arr) =>
        arr.findIndex(x => x.date === e.date && x.name === e.name) === i
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    // D-DAY 이벤트에 발표 데이터 병렬 fetch
    const todayEvents = events.filter(e => e.date === todayStr && e.seriesFmt);
    if (todayEvents.length > 0) {
      const results = await Promise.all(
        todayEvents.map(e => fetchLatest(e.series, e.seriesFmt))
      );
      todayEvents.forEach((e, i) => { e.released = results[i]; });
    }

    return { events, fetchedAt: fmt(today), _savedAt: new Date().toISOString() };
  } catch(e) {
    return { error: e.message, events: [] };
  }
}

async function t2Cached(env, force = false, ctx) {
  if (!force) {
    const cached = await kvGet(env, KV_KEYS.t2);
    if (cached) return json(cached);
  }
  const resp = await t2DataEndpoint(env);
  const data = await resp.json();
  const putPromise = kvPut(env, KV_KEYS.t2, data, KV_TTL.t2);
  if (ctx?.waitUntil) ctx.waitUntil(putPromise); else await putPromise;
  return json(data);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 실물경제 탭 (t2) — 3개 섹션 데이터
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function t2DataEndpoint(env) {
  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) return json({ error: 'FRED_API_KEY 없음' }, 500);

  // FRED 단일 시리즈 fetch 헬퍼 (최근 N개, desc)
  const fredArr = async (id, limit = 2) => {
    try {
      const u = `https://api.stlouisfed.org/fred/series/observations`
        + `?series_id=${id}&api_key=${apiKey}&file_type=json`
        + `&limit=${limit}&sort_order=desc`;
      const r = await fetch(u, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.observations || [])
        .filter(o => o.value !== '.')
        .map(o => ({ date: o.date, value: parseFloat(o.value), released: o.realtime_start ?? null }));
    } catch(e) { return []; }
  };

  // Atlanta Fed GDPNow 파싱 (HTML 스크래핑 → FRED fallback)
  const gdpNowFetch = async () => {
    // ── 1순위: FRED GDPNOW vintage dates (헤드라인 + 전 추정치) ──
    try {
      const u = `https://api.stlouisfed.org/fred/series/observations`
        + `?series_id=GDPNOW&api_key=${apiKey}&file_type=json`
        + `&realtime_start=1776-07-04&realtime_end=9999-12-31`
        + `&sort_order=desc&limit=10`;
      const r = await fetch(u, { cf: { cacheTtl: 1800 } });
      if (!r.ok) throw new Error(`FRED ${r.status}`);
      const d = await r.json();
      const obs = (d.observations || []).filter(o => o.value !== '.');
      if (!obs.length) throw new Error('no obs');
      const latestDate = obs[0].date;
      const sameQtr = obs
        .filter(o => o.date === latestDate)
        .sort((a, b) => (b.realtime_start || '').localeCompare(a.realtime_start || ''));
      const current = parseFloat(sameQtr[0].value);
      const prevEst = sameQtr[1] ? parseFloat(sameQtr[1].value) : null;
      const delta   = prevEst != null ? +(current - prevEst).toFixed(2) : null;

      // ── 2순위: Atlanta Fed HTML에서 기여도 데이터 파싱 ──
      let components = null;
      let qualityWarning = false;
      let warningReason  = null;
      try {
        const hr = await fetch('https://www.atlantafed.org/cqer/research/gdpnow', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          cf: { cacheTtl: 7200 },
        });
        if (hr.ok) {
          const html = await hr.text();
          // Atlanta Fed 페이지 내 JSON 데이터 블록 파싱 시도
          // data-* 또는 script 태그 내 subcomponent 값 추출
          const numRe = /-?\d+\.?\d*/g;
          // PCE contribution
          const pceM   = html.match(/pce[^>]*>([-\d.]+)/i);
          const invM   = html.match(/inventor[^>]*>([-\d.]+)/i);
          const nxM    = html.match(/net.export[^>]*>([-\d.]+)/i);
          const govM   = html.match(/government[^>]*>([-\d.]+)/i);
          const grossM = html.match(/gross.private[^>]*>([-\d.]+)/i);
          const parse  = m => m ? parseFloat(m[1]) : null;
          const pce = parse(pceM), inv = parse(invM), nx = parse(nxM), gov = parse(govM), gross = parse(grossM);
          if (pce != null || inv != null || nx != null || gov != null) {
            components = { pce, investment: gross, inventories: inv, netExports: nx, government: gov };
          }
        }
      } catch(_) {}

      // components가 없어도 경고 로직 (current 기준)
      if (components && current != null && Math.abs(current) > 0.1) {
        const invShare = components.inventories != null ? Math.abs(components.inventories) / Math.abs(current) : 0;
        const govShare = components.government  != null ? Math.abs(components.government)  / Math.abs(current) : 0;
        if      (invShare > 0.5)           { qualityWarning = true; warningReason = '재고'; }
        else if (govShare > 0.5)           { qualityWarning = true; warningReason = '정부지출'; }
        else if (invShare + govShare > 0.6){ qualityWarning = true; warningReason = '재고+정부지출'; }
      }

      return {
        current, prevEst, delta,
        asOf:    sameQtr[0]?.realtime_start?.slice(0, 10) ?? null,
        qtrDate: latestDate,
        components, qualityWarning, warningReason,
        source: 'fred',
      };
    } catch(e) {
      return null;
    }
  };

  // 병렬 fetch — 전체 시리즈
  const [
    gdpNow,
    mfgNY, mfgPhi, mfgDal, mfgRich,          // Section 1: 제조업 4개
    svcDal, svcNY, svcRich,                    // Section 1: 서비스 3개
    jolts, tempHelp, icsa, ic4wsa, payems, unrate, sahm,  // Section 2 (5-Stage Pipeline)
    umcsent, psavert, delinq, rsafs, rsxfs, cpiT2,  // Section 3
  ] = await Promise.all([
    gdpNowFetch(),
    // ── 지역 연준 제조업 4개 (25개월 차트용)
    fredArr('GACDISA066MSFRBNY',  25),  // NY 엠파이어 스테이트
    fredArr('GACDFSA066MSFRBPHI', 25),  // 필라델피아 Fed
    fredArr('BACTSAMFRBDAL',      25),  // Dallas Fed
    fredArr('MFGBAPIRCHM',        25),  // Richmond Fed — fallback 허용
    // ── 지역 연준 서비스업 3개 (확정 FRED ID)
    fredArr('TSSOSBACTUAMFRBDAL', 25),  // Dallas TSSOS (Texas 서비스)
    fredArr('BACDINA066MNFRBNY',  25),  // NY 서비스 (Business Leaders Survey)
    fredArr('GABNDIF066MNFRBPHI', 25),  // Philly 비제조업 (Richmond 미제공, Philly로 대체)
    fredArr('JTSJOL',        14),  // YoY(12개월) + 스파크라인 + 3개월 추세
    fredArr('TEMPHELPS',     8),   // consecNeg(4개 필요) + 스파크라인
    fredArr('ICSA',          5),   // 서킷브레이커용 최신 주간 raw값
    fredArr('IC4WSA',       56),   // 4주 이동평균: YoY(52주) + 스파크라인(24주)
    fredArr('PAYEMS',        6),   // 3MMA(4개 필요) + 스파크라인
    fredArr('UNRATE',        6),   // 스파크라인
    fredArr('SAHMREALTIME',  6),   // 스파크라인
    fredArr('UMCSENT',      38),   // YoY(12M) + 3MMA + 3년 스파크라인(36M)
    fredArr('PSAVERT',      62),   // 3MMA + delta + 5년 시계열(60M)
    fredArr('DRCCLACBS',    22),   // YoY(4분기) + 5년 시계열(20Q)
    fredArr('RSAFS',        14),   // 명목 헤드라인 참고값
    fredArr('RSXFS',        15),   // 통제그룹 근사: 자동차 제외 소매 MoM 계산용
    fredArr('CPIAUCSL',     15),   // CPI: 실질화 연산용
  ]);

  // 요약 헬퍼
  const s = arr => ({
    current: arr[0]?.value ?? null,
    prev:    arr[1]?.value ?? null,
    delta:   (arr[0]?.value != null && arr[1]?.value != null)
             ? +(arr[0].value - arr[1].value).toFixed(3) : null,
    asOf:    arr[0]?.date ?? null,
  });

  // ── 지역 연준 복합 계산 헬퍼 ──
  const regionalComposite = (arrays) => {
    // 날짜 기준 정렬 후 최근 24개월 히스토리 생성
    // 각 시리즈의 가장 최근 날짜 기준으로 교차점 찾기
    const validArrays = arrays.filter(a => a.length > 0);
    if (!validArrays.length) return { current: null, prev: null, asOf: null, series: [], hist: [] };

    // 최신값 (각 시리즈의 [0])
    const vals = validArrays.map(a => a[0]?.value ?? null).filter(v => v != null);
    const current = vals.length ? +(vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(1) : null;
    const prevVals = validArrays.map(a => a[1]?.value ?? null).filter(v => v != null);
    const prev = prevVals.length ? +(prevVals.reduce((s,v)=>s+v,0)/prevVals.length).toFixed(1) : null;

    // 히스토리: NY 기준 날짜로 정렬 (가장 긴 시리즈)
    const anchor = validArrays.reduce((a,b) => a.length >= b.length ? a : b);
    const hist = anchor.slice(0, 24).reverse().map(entry => {
      const date = entry.date;
      const pointVals = validArrays.map(a => {
        const match = a.find(d => d.date === date);
        return match?.value ?? null;
      }).filter(v => v != null);
      return {
        date,
        composite: pointVals.length ? +(pointVals.reduce((s,v)=>s+v,0)/pointVals.length).toFixed(1) : null,
      };
    });

    // 개별 시리즈 최근값 (라인 차트용)
    const seriesHist = validArrays.map((arr, i) => ({
      data: anchor.slice(0, 24).reverse().map(entry => {
        const match = arr.find(d => d.date === entry.date);
        return match?.value ?? null;
      }),
    }));

    return { current, prev, delta: current != null && prev != null ? +(current-prev).toFixed(1) : null,
             asOf: anchor[0]?.date ?? null, hist, seriesHist, count: validArrays.length };
  };

  const mfgComposite = regionalComposite([mfgNY, mfgPhi, mfgDal, mfgRich]);
  const svcComposite = regionalComposite([svcDal, svcNY, svcRich]);

  // 신호등 로직 (0 기준)
  const mfgSignal = (() => {
    const vals = [mfgNY[0]?.value, mfgPhi[0]?.value, mfgDal[0]?.value, mfgRich[0]?.value]
      .filter(v => v != null);
    if (!vals.length) return { level: 'unknown', label: '—' };
    const below0 = vals.filter(v => v < 0).length;
    if (below0 === vals.length) return { level: 'red',    label: '🔴 전면 수축 — ISM 하락·고용 축소 선행' };
    if (below0 >= vals.length/2) return { level: 'yellow', label: '🟡 혼조 — 지역별 편차. 추가 관망' };
    return                              { level: 'green',  label: '🟢 전국적 확장 국면 회복' };
  })();

  const svcSignal = (() => {
    const vals = [svcDal[0]?.value, svcNY[0]?.value, svcRich[0]?.value]
      .filter(v => v != null);
    if (!vals.length) return { level: 'unknown', label: '—' };
    const below0 = vals.filter(v => v < 0).length;
    if (below0 === vals.length) return { level: 'red',    label: '🔴 서비스 전면 수축 — 소비 둔화 위험' };
    if (below0 >= vals.length/2) return { level: 'yellow', label: '🟡 서비스 혼조 — 지역별 편차 지속' };
    return                              { level: 'green',  label: '🟢 서비스 확장 유지' };
  })();

  // ── Section 2: Labor Pipeline 계산 ────────────────────────
  const joltsYoY = (jolts[0]?.value != null && jolts[12]?.value != null && jolts[12].value > 0)
    ? +((jolts[0].value - jolts[12].value) / jolts[12].value * 100).toFixed(1) : null;
  const joltsDecline3m = jolts.length >= 3 &&
    jolts[0].value < jolts[1].value && jolts[1].value < jolts[2].value;
  const joltsSeries = jolts.slice(0, 6).reverse()
    .map(d => ({ date: d.date.slice(0,7), value: +(d.value/1000).toFixed(3) }));

  const tempConsecNeg = tempHelp.length >= 4 &&
    (tempHelp[0].value - tempHelp[1].value) < 0 &&
    (tempHelp[1].value - tempHelp[2].value) < 0 &&
    (tempHelp[2].value - tempHelp[3].value) < 0;
  const tempDelta = (tempHelp[0]?.value != null && tempHelp[1]?.value != null)
    ? +(tempHelp[0].value - tempHelp[1].value).toFixed(1) : null;
  const tempSeries = tempHelp.slice(0, 6).reverse()
    .map(d => ({ date: d.date.slice(0,7), value: d.value }));

  const ic4wsaCur    = ic4wsa[0]?.value ?? null;
  const ic4wsaYearAgo = ic4wsa.length >= 52 ? (ic4wsa[51]?.value ?? null) : null;
  const ic4wsaYoy    = (ic4wsaCur != null && ic4wsaYearAgo != null && ic4wsaYearAgo > 0)
    ? +((ic4wsaCur - ic4wsaYearAgo) / ic4wsaYearAgo * 100).toFixed(1) : null;
  const icsaLatest   = icsa[0]?.value ?? null;
  const ic4wsaCB     = (icsaLatest != null && ic4wsaCur != null && ic4wsaCur > 0) &&
    ((icsaLatest - ic4wsaCur) / ic4wsaCur >= 0.15);
  const ic4wsaCBPct  = (ic4wsaCB && ic4wsaCur)
    ? +(((icsaLatest - ic4wsaCur) / ic4wsaCur) * 100).toFixed(0) : null;
  const ic4wsaSeries = ic4wsa.slice(0, 24).reverse()
    .map(d => ({ date: d.date.slice(5), value: d.value }));

  const nfpLatest = (payems[0]?.value != null && payems[1]?.value != null)
    ? Math.round(payems[0].value - payems[1].value) : null;
  const nfpDeltas = [];
  for (let i = 0; i < Math.min(payems.length - 1, 5); i++) {
    if (payems[i]?.value != null && payems[i+1]?.value != null)
      nfpDeltas.push(Math.round(payems[i].value - payems[i+1].value));
  }
  const nfpMma3 = nfpDeltas.length >= 3
    ? Math.round((nfpDeltas[0] + nfpDeltas[1] + nfpDeltas[2]) / 3) : null;
  const nfpCB   = nfpLatest != null && nfpLatest < 0;
  const nfpSeries = nfpDeltas.slice().reverse().map((v, i) => ({
    date: payems[nfpDeltas.length - i]?.date?.slice(0,7) ?? '',
    value: v,
  }));

  const sahmCur      = sahm[0]?.value ?? null;
  const sahmTriggered = sahmCur != null && sahmCur >= 0.50;
  const sahmSeries   = sahm.slice(0, 6).reverse()
    .map(d => ({ date: d.date.slice(0,7), value: d.value }));
  const unrateDelta  = (unrate[0]?.value != null && unrate[1]?.value != null)
    ? +(unrate[0].value - unrate[1].value).toFixed(2) : null;
  const unrateSeries = unrate.slice(0, 6).reverse()
    .map(d => ({ date: d.date.slice(0,7), value: d.value }));
  const tempTrend = tempHelp.length >= 3
    ? (tempHelp[0].value < tempHelp[1].value && tempHelp[1].value < tempHelp[2].value
       ? 'declining' : tempHelp[0].value > tempHelp[1].value ? 'rising' : 'flat')
    : null;

  // ── Section 3: Consumer Health 계산 ──────────────────────
  const mkSentiment = (arr) => {
    if (!arr.length) return { current:null, prev:null, mma3:null, yoy:null, decline3m:false, sig:'green', asOf:null };
    const cur  = arr[0]?.value ?? null;
    const prev = arr[1]?.value ?? null;
    const yoy  = (cur != null && arr[12]?.value != null && arr[12].value > 0)
      ? +((cur - arr[12].value) / arr[12].value * 100).toFixed(1) : null;
    const mma3 = (arr[0]?.value != null && arr[1]?.value != null && arr[2]?.value != null)
      ? +((arr[0].value + arr[1].value + arr[2].value) / 3).toFixed(1) : null;
    const decline3m = arr.length >= 4 &&
      arr[0].value < arr[1].value && arr[1].value < arr[2].value && arr[2].value < arr[3].value;
    const sig = yoy != null && yoy < -10 ? 'red'
      : (decline3m || (yoy != null && yoy < 0)) ? 'yellow' : 'green';
    // 스파크라인용 시계열 (최대 36개월, 고→최신 순서)
    const series = arr.slice(0, 36).reverse()
      .map(d => ({ date: d.date.slice(0,7), value: d.value }));
    // 12개월 평균 (기준 점선용)
    const recent12 = arr.slice(0, 12).filter(d => d.value != null);
    const avg12 = recent12.length
      ? +(recent12.reduce((s,d) => s+d.value, 0) / recent12.length).toFixed(1) : null;
    return { current: cur, prev, mma3, yoy, decline3m, sig,
      asOf: (arr[0]?.released ?? arr[0]?.date)?.slice(0,7) ?? null, series, avg12 };
  };
  const umcData  = mkSentiment(umcsent);

  const psaCur   = psavert[0]?.value ?? null;
  const psaPrev  = psavert[1]?.value ?? null;
  const psaDelta = (psaCur != null && psaPrev != null) ? +(psaCur - psaPrev).toFixed(2) : null;
  const psaMma3  = (psavert[0]?.value != null && psavert[1]?.value != null && psavert[2]?.value != null)
    ? +((psavert[0].value + psavert[1].value + psavert[2].value) / 3).toFixed(1) : null;
  const psaSig   = psaCur == null ? 'green' : psaCur < 4.0 ? 'red' : psaCur < 5.0 ? 'yellow' : 'green';

  const delCur      = delinq[0]?.value ?? null;
  const delPrev     = delinq[1]?.value ?? null;
  const delYoyDelta = (delCur != null && delinq[4]?.value != null)
    ? +(delCur - delinq[4].value).toFixed(2) : null;
  const delSig      = delCur == null ? 'green' : delCur > 3.0 ? 'red' : delCur > 2.5 ? 'yellow' : 'green';

  const rsxfsMom = [];
  for (let i = 0; i < Math.min(rsxfs.length - 1, 13); i++) {
    const p = rsxfs[i+1]?.value, c = rsxfs[i]?.value;
    if (c != null && p != null && p > 0)
      rsxfsMom.push({ date: rsxfs[i].date, value: +((c - p) / p * 100).toFixed(2) });
    else break;
  }
  const cpiMomArr = [];
  for (let i = 0; i < Math.min(cpiT2.length - 1, 13); i++) {
    const p = cpiT2[i+1]?.value, c = cpiT2[i]?.value;
    if (c != null && p != null && p > 0)
      cpiMomArr.push({ date: cpiT2[i].date, value: +((c - p) / p * 100).toFixed(2) });
    else break;
  }
  // Real Core MoM: 인덱스 기반 정렬 (발표일 차이 보정)
  const realCoreMomArr = [];
  const rcMaxLen = Math.min(rsxfsMom.length, cpiMomArr.length);
  for (let i = 0; i < rcMaxLen; i++) {
    realCoreMomArr.push({ date: rsxfsMom[i].date, value: +(rsxfsMom[i].value - cpiMomArr[i].value).toFixed(2) });
  }
  const realCoreCur  = realCoreMomArr[0]?.value ?? null;
  const realCore3MMA = realCoreMomArr.length >= 3
    ? +((realCoreMomArr[0].value + realCoreMomArr[1].value + realCoreMomArr[2].value) / 3).toFixed(2) : null;
  const rsafsHist = rsafs.slice(0, 13).reverse().map((d, i, arr) => {
    if (i === 0) return { date: d.date, mom: null };
    const mom = arr[i-1].value > 0
      ? +((d.value - arr[i-1].value) / arr[i-1].value * 100).toFixed(2) : null;
    return { date: d.date, mom };
  }).filter(d => d.mom !== null);
  const rsafsLatestMom = rsafsHist.length ? rsafsHist[rsafsHist.length-1].mom : null;
  const retailSig = realCoreCur == null ? 'green'
    : realCoreCur >= 0 ? 'green'
    : (realCore3MMA != null && realCore3MMA >= 0) ? 'yellow' : 'red';
  // 스파크라인용 시계열 (12개월, 고→최신 순서)
  const realRetailSeries = realCoreMomArr.slice(0, 12).reverse();
  // 3MMA 시계열 (같은 날짜 기준, null 허용)
  const realRetailMma3Series = realRetailSeries.map((d, i, arr) => ({
    date: d.date,
    value: i >= 2
      ? +((arr[i].value + arr[i-1].value + arr[i-2].value) / 3).toFixed(2)
      : null,
  }));
  const sentGreen = umcData.sig === 'green';
  const divCB     = sentGreen && psaSig === 'red' && delSig === 'red';

  return json({
    _savedAt: new Date().toISOString(),
    // Section 1: Corporate Pulse
    corporate: {
      gdpNow,
      mfg: { ...mfgComposite, signal: mfgSignal,
             labels: ['NY 엠파이어', '필라델피아', 'Dallas', 'Richmond'] },
      svc: { ...svcComposite, signal: svcSignal,
             labels: ['Dallas 서비스', 'NY 서비스', 'Philly 비제조업'] },
    },
    // Section 2: Labor Pipeline (5-Stage)
    labor: {
      jolts: {
        current:    jolts[0]?.value ?? null,
        asOf:       (jolts[0]?.released ?? jolts[0]?.date)?.slice(0,7) ?? null,
        yoy:        joltsYoY, decline3m: joltsDecline3m, series: joltsSeries,
      },
      tempHelp: {
        current:    tempHelp[0]?.value ?? null, prev: tempHelp[1]?.value ?? null,
        delta:      tempDelta,
        asOf:       (tempHelp[0]?.released ?? tempHelp[0]?.date)?.slice(0,7) ?? null,
        consecNeg:  tempConsecNeg, series: tempSeries,
      },
      ic4wsa: {
        current:        ic4wsaCur, icsaLatest, asOf: (icsa[0]?.released ?? icsa[0]?.date)?.slice(0,7) ?? null,
        yoy:            ic4wsaYoy, circuitBreaker: ic4wsaCB, cbPct: ic4wsaCBPct, series: ic4wsaSeries,
      },
      payems: {
        latest: nfpLatest, mma3: nfpMma3,
        asOf:   (payems[0]?.released ?? payems[0]?.date)?.slice(0,7) ?? null,
        circuitBreaker: nfpCB, series: nfpSeries,
      },
      sahm: {
        current: sahmCur, asOf: (sahm[0]?.released ?? sahm[0]?.date)?.slice(0,7) ?? null,
        triggered: sahmTriggered, series: sahmSeries,
      },
      unrate: {
        current: unrate[0]?.value ?? null, prev: unrate[1]?.value ?? null,
        delta:   unrateDelta,
        asOf:    (unrate[0]?.released ?? unrate[0]?.date)?.slice(0,7) ?? null,
        series:  unrateSeries,
      },
    },
    // Section 3: Consumer Health (3-Stage Pipeline)
    consumer: {
      umcsent:  { ...umcData },
      psavert:  { current: psaCur, prev: psaPrev, delta: psaDelta, mma3: psaMma3, sig: psaSig,
                  asOf: (psavert[0]?.released ?? psavert[0]?.date)?.slice(0,7) ?? null,
                  series5y: psavert.slice(0, 62).reverse()
                    .filter(d => d.date >= '2019-01-01')
                    .map(d => ({ date: d.date, value: d.value })) },
      delinq:   { current: delCur, prev: delPrev, yoyDelta: delYoyDelta, sig: delSig,
                  asOf: (delinq[0]?.released ?? delinq[0]?.date)?.slice(0,7) ?? null,
                  series5y: delinq.slice(0, 22).reverse()
                    .filter(d => d.date >= '2019-01-01')
                    .map(d => ({ date: d.date, value: d.value })) },
      realRetail: { current: realCoreCur, mma3: realCore3MMA, nominalMom: rsafsLatestMom,
                    sig: retailSig, asOf: (rsafs[0]?.released ?? rsafs[0]?.date)?.slice(0,7) ?? null,
                    series: realRetailSeries, mma3Series: realRetailMma3Series },
      divCB,
      rsafsHist,
    },
  });
}

async function refreshT2(env) {
  try {
    const resp = await t2DataEndpoint(env);
    const data = await resp.json();
    await kvPut(env, KV_KEYS.t2, data, KV_TTL.t2);
  } catch(e) { console.error('refreshT2:', e.message); }
}

// ── T3 Global ───────────────────────────────────────────
async function t3Cached(env, force = false, ctx) {
  if (!force) {
    const cached = await kvGet(env, KV_KEYS.t3);
    if (cached) return json(cached);
  }
  const body = await t3GlobalData(env, force);
  const putPromise = kvPut(env, KV_KEYS.t3, body, KV_TTL.t3);
  if (ctx?.waitUntil) ctx.waitUntil(putPromise); else await putPromise;
  return json(body);
}

async function refreshT3(env) {
  try {
    const body = await t3GlobalData(env, false);
    await kvPut(env, KV_KEYS.t3, body, KV_TTL.t3);
  } catch(e) { console.error('refreshT3:', e.message); }
}

// t3GlobalEndpoint: KV 캐시 래퍼 (외부 호환용)
async function t3GlobalEndpoint(env, force = false) {
  const body = await t3GlobalData(env, force);
  return json(body);
}

async function t3GlobalData(env, force = false) {
  // ── Yahoo Finance 차트 fetch 헬퍼 (period1/period2 기반) ─
  const yfFetch = async (ticker) => {
    const now    = Math.floor(Date.now() / 1000);
    const p1     = now - 5 * 365 * 24 * 3600; // 5년 전
    const url    = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${p1}&period2=${now}`;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Accept': 'application/json' },
        cf: force ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 3600 },
      });
      if (!r.ok) return [];
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return [];
      const ts = result.timestamp || [];
      const cl = result.indicators?.quote?.[0]?.close || [];
      return ts
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0,10), value: cl[i] }))
        .filter(p => p.value != null && p.value > 0 && isFinite(p.value));
    } catch(e) { return []; }
  };

  // USDCNH=X 폴백: 데이터 부족 시 USDCNY=X 사용
  const yfCnh = async () => {
    const data = await yfFetch('USDCNH=X');
    if (data.length >= 30) return data;
    const fallback = await yfFetch('USDCNY=X');
    return fallback.length > data.length ? fallback : data;
  };

  const yf = yfFetch; // 하위 호환

  // ── FRED 헬퍼 ────────────────────────────────────────
  const apiKey = env?.FRED_API_KEY;
  const fiveYAgo = new Date(); fiveYAgo.setFullYear(fiveYAgo.getFullYear() - 5);
  const obsStart = fiveYAgo.toISOString().slice(0,10);

  const fredArr = async (id) => {
    if (!apiKey) return [];
    try {
      const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=asc&observation_start=${obsStart}&limit=2000&frequency=d&aggregation_method=lin`;
      const r = await fetch(u, { cf: force ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 86400 } });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.observations || [])
        .filter(o => o.value !== '.')
        .map(o => ({ date: o.date, value: parseFloat(o.value) }));
      // asc 순서 = 이미 chronological
    } catch(e) { return []; }
  };

  // ── 병렬 fetch ───────────────────────────────────────
  const [dxy, gold, silver, copper, usdcnh, spy, eem, broadDollar,
         audusd, kospi, eurusd, fez] = await Promise.all([
    yf('DX-Y.NYB'),
    yf('GC=F'),
    yf('SI=F'),
    yf('HG=F'),
    yfCnh(),
    yf('SPY'),
    yf('EEM'),
    fredArr('DTWEXBGS'),
    yf('AUDUSD=X'),   // 아시아 원자재 프록시
    yf('^KS11'),      // KOSPI (yfFetch가 encodeURIComponent 처리)
    yf('EURUSD=X'),   // 유로존 통화 프록시
    yf('FEZ'),        // 유로스톡스 50 ETF
  ]);

  // ── 계산 헬퍼 ────────────────────────────────────────
  const sma = (arr, n) => arr.map((v, i, a) => {
    if (i < n-1) return null;
    const slice = a.slice(i-n+1, i+1).map(x => x.value);
    if (slice.some(x => x == null)) return null;
    return +(slice.reduce((s,x) => s+x, 0) / n).toFixed(4);
  });

  // ratio 시리즈 (날짜 기준 join)
  const ratioSeries = (a, b) => {
    const bMap = Object.fromEntries(b.map(d => [d.date, d.value]));
    return a.map(d => {
      const bv = bMap[d.date];
      if (!bv || bv === 0) return null;
      return { date: d.date, value: +(d.value / bv).toFixed(6) };
    }).filter(Boolean);
  };

  // 최근 N개 (가장 오래된 날짜순)
  const recent = (arr, n) => arr.slice(-n);

  // 3MMA 계산 후 마지막 2개 비교 (최근 20개 중 유효값 사용)
  const mma3Trend = (arr) => {
    if (arr.length < 3) return null;
    const vals = arr.slice(-20).map(d => d.value).filter(v => v != null && v > 0 && isFinite(v));
    if (vals.length < 3) return null;
    const cur3 = (vals.slice(-3).reduce((s,v) => s+v, 0) / 3);
    const prv3 = vals.length >= 4
      ? (vals.slice(-4,-1).reduce((s,v) => s+v, 0) / 3)
      : cur3; // 비교값 없으면 flat
    return { cur: +cur3.toFixed(4), prv: +prv3.toFixed(4), dir: cur3 > prv3 ? 'up' : cur3 < prv3 ? 'down' : 'flat' };
  };

  // 200DMA 최신값
  const dma200Latest = (arr) => {
    const vals = arr.slice(-200).map(d => d.value).filter(Boolean);
    if (vals.length < 200) return null;
    return +(vals.reduce((s,v) => s+v, 0) / 200).toFixed(4);
  };

  // ── GSR (금/은 비율) ────────────────────────────────
  const gsrSeries = ratioSeries(gold, silver);
  const gsr200DMA = dma200Latest(gsrSeries);
  const gsrCur    = gsrSeries.at(-1)?.value ?? null;
  const gsrAbove  = (gsrCur != null && gsr200DMA != null) ? gsrCur > gsr200DMA : null;
  // 신호: 현재가 > 200DMA → 위험 (안전자산 도피)
  const gsrSig    = gsrCur == null ? 'green' : gsrAbove ? 'red' : 'green';
  // 200DMA 대비 이격도(%)
  const gsrSpread = (gsrCur != null && gsr200DMA != null && gsr200DMA > 0)
    ? +((gsrCur - gsr200DMA) / gsr200DMA * 100).toFixed(2) : null;

  // ── 구리/금 비율 (Dr. Copper) ───────────────────────
  const cgSeries = ratioSeries(copper, gold);
  const cgMma3   = mma3Trend(cgSeries);
  const cgCur    = cgSeries.at(-1)?.value ?? null;
  // 신호: 현재가 > 3MMA → 성장 팽창 / < 3MMA → 수축 압력
  const cgSig    = cgCur == null || !cgMma3 ? 'yellow'
    : cgCur > cgMma3.cur ? 'green' : 'red';
  // 3MMA 대비 현재가 모멘텀(%)
  const cgSpread = (cgCur != null && cgMma3?.cur && cgMma3.cur > 0)
    ? +((cgCur - cgMma3.cur) / cgMma3.cur * 100).toFixed(3) : null;

  // ── USD/CNH ──────────────────────────────────────────
  const cnhMma3 = mma3Trend(usdcnh);
  const cnhCur  = usdcnh.at(-1)?.value ?? null;
  // 신호: 현재가 > 3MMA → 위안화 약세 → 압박 / < 3MMA → 강세 → 안정
  const cnhSig  = cnhCur == null || !cnhMma3 ? 'yellow'
    : cnhCur > cnhMma3.cur ? 'red' : 'green';
  // 3MMA 대비 이격 pips (×10000)
  const cnhSpread = (cnhCur != null && cnhMma3?.cur)
    ? +((cnhCur - cnhMma3.cur) / cnhMma3.cur * 100).toFixed(2) : null;

  // ── SPY/EEM 비율 ────────────────────────────────────
  const seRatio  = ratioSeries(spy, eem);
  const seMma3   = mma3Trend(seRatio);
  const seCur    = seRatio.at(-1)?.value ?? null;
  // 신호: 현재가 > 3MMA → 미국 쏠림(yellow) / < 3MMA → 자본 확산(green)
  const seSig    = seCur == null || !seMma3 ? 'yellow'
    : seCur > seMma3.cur ? 'yellow' : 'green';
  // 3MMA 대비 변화율(%)
  const seSpread = (seCur != null && seMma3?.cur && seMma3.cur > 0)
    ? +((seCur - seMma3.cur) / seMma3.cur * 100).toFixed(3) : null;

  // ── DXY vs Broad Dollar — 다이버전스 차트용 시리즈 ──
  // yf()는 이미 chronological, broadDollar는 fredArr asc로 chronological
  const cutoff = obsStart;
  const dxySeries5y   = dxy.filter(d => d.date >= cutoff);
  const broadSeries5y = broadDollar; // 이미 asc + observation_start로 5년치

  return {
    _savedAt: new Date().toISOString(),
    // Block 1 Row 1: 다이버전스 차트
    dxy:         { series: dxySeries5y, latest: dxySeries5y.at(-1) },
    broadDollar: { series: broadSeries5y, latest: broadSeries5y.at(-1) },
    spy5y:       spy.filter(d => d.date >= cutoff),

    // ── Block 2: 성장 엔진 ────────────────────────────────
    asiaEngine: (() => {
      const audS   = audusd.filter(d => d.date >= cutoff);
      const kospiS = kospi.filter(d => d.date >= cutoff);
      return {
        aud:   { series: audS,   latest: audS.at(-1)   ?? audusd.at(-1)   },
        kospi: { series: kospiS, latest: kospiS.at(-1) ?? kospi.at(-1)    },
      };
    })(),
    euroEngine: (() => {
      const eurS = eurusd.filter(d => d.date >= cutoff);
      const fezS = fez.filter(d => d.date >= cutoff);
      return {
        eurusd: { series: eurS, latest: eurS.at(-1) ?? eurusd.at(-1) },
        fez:    { series: fezS, latest: fezS.at(-1) ?? fez.at(-1)   },
      };
    })(),
    // Block 1 Row 2: 4-Card KPI
    gsr: {
      current: gsrCur, dma200: gsr200DMA, aboveDMA: gsrAbove, sig: gsrSig, spread: gsrSpread,
      series: recent(gsrSeries, 400).map(d => ({ date: d.date, value: d.value })),
    },
    copperGold: {
      current: cgCur, mma3: cgMma3, sig: cgSig, spread: cgSpread,
      series: recent(cgSeries, 400).map(d => ({ date: d.date, value: d.value })),
    },
    usdcnh: {
      current: cnhCur, mma3: cnhMma3, sig: cnhSig, spread: cnhSpread,
      series: recent(usdcnh, 400).map(d => ({ date: d.date, value: d.value })),
    },
    spyEem: {
      current: seCur, mma3: seMma3, sig: seSig, spread: seSpread,
      series: recent(seRatio, 400).map(d => ({ date: d.date, value: d.value })),
    },
  };
}


async function refreshLiq(env) {
  try {
    const resp = await liqDataEndpoint(env);
    const data = await resp.json();
    await kvPut(env, KV_KEYS.liq, data, KV_TTL.liq);
  } catch(e) { console.error('refreshLiq:', e.message); }
}

async function refreshYieldsHist(env) {
  try {
    const resp = await yieldsHistory(env);
    const data = await resp.json();
    await kvPut(env, KV_KEYS.yieldsHist, data, KV_TTL.yieldsHist);
  } catch(e) { console.error('refreshYieldsHist:', e.message); }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. FRED API 프록시
//    GET /fred?series_id=SOFR&limit=30&sort_order=desc
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fredProxy(url, env) {
  const seriesId  = url.searchParams.get('series_id');
  const limit     = url.searchParams.get('limit')      || '60';
  const sortOrder = url.searchParams.get('sort_order') || 'desc';
  const units     = url.searchParams.get('units')      || '';

  if (!seriesId) return json({ error: 'series_id required' }, 400);

  const apiKey = env.FRED_API_KEY;
  let fredUrl  = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${seriesId}`
    + `&api_key=${apiKey}`
    + `&file_type=json`
    + `&limit=${limit}`
    + `&sort_order=${sortOrder}`;

  if (units) fredUrl += `&units=${units}`;

  const resp = await fetch(fredUrl, { cf: { cacheTtl: 3600 } }); // 1h 캐시
  if (!resp.ok) return json({ error: `FRED error ${resp.status}` }, resp.status);

  const data = await resp.json();
  return json(data);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. OFR 대체 — FRED 기반 PD 포지션 + MMF 전체
//    GET /ofr?type=pd   → FRED PDPOSCLC (PD 국채 순포지션, 주간)
//    GET /ofr?type=mmf  → FRED WRMFNS + WRMFSL 합산 (전체 MMF)
//
//    OFR API(data.financialresearch.gov)가 서버사이드 요청 403 차단.
//    FRED 대체:
//      PDPOSCLC  = Primary Dealer Net Coupon Positions (백만달러, 주간)
//      WRMFNS    = 소매 MMF (~$2.3T, 십억달러)
//      WRMFSL    = 기관 MMF (~$4.5T, 십억달러)
//      합산       ≈ ICI 전체 산업 ~$6.8T
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function ofrFallback(url, env) {
  const type = url.searchParams.get('type') || 'pd';

  if (type === 'pd') {
    // FRED PDPOSCLC — Primary Dealer Net Coupon Securities (백만달러)
    const fredUrl = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=PDPOSCLC&api_key=${env.FRED_API_KEY}&file_type=json&limit=2&sort_order=desc`;
    const resp = await fetch(fredUrl, { cf: { cacheTtl: 86400 } });
    if (!resp.ok) return json({ error: `FRED PDPOSCLC ${resp.status}` }, 502);
    const data  = await resp.json();
    const obs   = (data.observations || []).filter(o => o.value !== '.');
    const v0    = obs[0] ? parseFloat(obs[0].value) : null;
    const v1    = obs[1] ? parseFloat(obs[1].value) : null;
    return json({
      source:      'FRED PDPOSCLC',
      description: 'Primary Dealer Net Coupon Securities (Millions USD)',
      value:       v0,
      date:        obs[0]?.date || null,
      prevValue:   v1,
      delta:       (v0 != null && v1 != null) ? v0 - v1 : null,
      unit:        'millions_usd',
    });
  }

  if (type === 'mmf') {
    // FRED WRMFNS + WRMFSL 병렬 fetch → 합산
    const [rRetail, rInst] = await Promise.all([
      fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=WRMFNS&api_key=${env.FRED_API_KEY}&file_type=json&limit=2&sort_order=desc`,
        { cf: { cacheTtl: 86400 } }),
      fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=WRMFSL&api_key=${env.FRED_API_KEY}&file_type=json&limit=2&sort_order=desc`,
        { cf: { cacheTtl: 86400 } }),
    ]);
    if (!rRetail.ok || !rInst.ok) return json({ error: 'FRED MMF fetch failed' }, 502);
    const [dRetail, dInst] = await Promise.all([rRetail.json(), rInst.json()]);
    const obsR = (dRetail.observations || []).filter(o => o.value !== '.');
    const obsI = (dInst.observations  || []).filter(o => o.value !== '.');
    const retail = obsR[0] ? parseFloat(obsR[0].value) : null;
    const inst   = obsI[0] ? parseFloat(obsI[0].value) : null;
    const total  = (retail != null && inst != null) ? retail + inst : null;
    const prevR  = obsR[1] ? parseFloat(obsR[1].value) : null;
    const prevI  = obsI[1] ? parseFloat(obsI[1].value) : null;
    const prevTotal = (prevR != null && prevI != null) ? prevR + prevI : null;
    return json({
      source:      'FRED WRMFNS + WRMFSL',
      description: 'Total MMF Assets = Retail + Institutional (Billions USD)',
      value:       total,
      date:        obsR[0]?.date || null,
      retail,
      institutional: inst,
      prevValue:   prevTotal,
      delta:       (total != null && prevTotal != null) ? total - prevTotal : null,
      unit:        'billions_usd',
    });
  }

  return json({ error: 'type must be pd or mmf' }, 400);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NY Fed Primary Dealer — 구조 확인용 RAW 테스트
//    GET /nyfed-raw               → PDPOSGST-TOT (국채 Net Position)
//    GET /nyfed-raw?series=TIPS   → PDPOSTIPS-TOT (TIPS 포함 전체)
//    GET /nyfed-raw?series=MBS    → PDPOSMBS-TOT (MBS)
//
//    올바른 엔드포인트: /api/pd/get/timeseries/{SERIES_CODE}.json
//    (이전: /api/pd/get/TREAS/latest.json — 잘못된 형식, 400 반환)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function nyFedRaw(url) {
  const seriesMap = {
    'GST':  'PDPOSGST-TOT',   // 국채 (TIPS 제외) Net Position
    'TIPS': 'PDPOSTIPS-TOT',  // TIPS
    'MBS':  'PDPOSMBS-TOT',   // MBS
    'FGS':  'PDPOSFGS-TOT',   // 기관채 (MBS 제외)
  };
  const key    = (url.searchParams.get('series') || 'GST').toUpperCase();
  const series = seriesMap[key] || 'PDPOSGST-TOT';

  const nyFedUrl = `https://markets.newyorkfed.org/api/pd/get/timeseries/${series}.json`;

  const resp = await fetch(nyFedUrl, {
    headers: {
      'User-Agent': 'MacroLens/1.0 (macrolens.app)',
      'Accept':     'application/json',
    },
    cf: { cacheTtl: 0 },
  });

  const status  = resp.status;
  const headers = Object.fromEntries(resp.headers.entries());
  const text    = await resp.text();

  if (!resp.ok) {
    return json({ _debug: true, url: nyFedUrl, status, headers, body: text });
  }

  let raw;
  try { raw = JSON.parse(text); } catch(e) {
    return json({ _debug: true, url: nyFedUrl, status, parseError: e.message, body: text.slice(0, 500) });
  }

  return json({
    _debug:       true,
    url:          nyFedUrl,
    series,
    status,
    topLevelKeys: Object.keys(raw),
    structure:    Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        Array.isArray(v)
          ? `Array(${v.length}) — keys: ${v[0] ? Object.keys(v[0]).join(', ') : 'empty'}`
          : (typeof v === 'object' && v !== null)
            ? `Object — keys: ${Object.keys(v).join(', ')}`
            : typeof v
      ])
    ),
    // 배열이면 첫 레코드, 오브젝트면 한 단계 더 탐색
    sample: (() => {
      for (const v of Object.values(raw)) {
        if (Array.isArray(v) && v.length) return { type:'array', first: v[0], last: v[v.length-1] };
        if (typeof v === 'object' && v !== null) {
          for (const vv of Object.values(v)) {
            if (Array.isArray(vv) && vv.length) return { type:'nested_array', first: vv[0], last: vv[vv.length-1] };
          }
        }
      }
      return null;
    })(),
    raw,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ICI MMF — 정식 파싱 엔드포인트
//    GET /ici   → ICI 주간 MMF 전체 잔고 파싱
//    응답: { total, retail, institutional, change, weekEnded, source }
//    단위: 조달러(T) — "$7.86T" 형태로 가공
//
//    파싱 근거 (테스트 확인):
//      pattern_2: "assets increased by $38.68 billion to $7.86 trillion"
//      → 첫 번째 "increased by $X billion to $Y trillion" 문장에서
//        total($Y), change($X) 추출
//      pattern_3: "increased by $X billion to $Y trillion" (여러 줄)
//        → [0]=전체, [1]=소매, [2]=정부MMF, ...
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function iciMMF(env, ctx) {
  const KV_KEY = 'mmf_history_v1';

  // ── Step 1: KV에서 기존 누적 히스토리 읽기 ──
  let kvHistory = [];
  try {
    if (env?.MMF_KV) {
      const stored = await env.MMF_KV.get(KV_KEY, { type: 'json' });
      if (Array.isArray(stored)) kvHistory = stored;
    }
  } catch(e) { /* KV 읽기 실패 시 빈 배열로 진행 */ }

  // ── Step 2: ICI 페이지 스크래핑 ──
  const iciUrl = 'https://www.ici.org/research/stats/mmf';
  const resp = await fetch(iciUrl, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    cf: { cacheTtl: 21600 },
  });

  if (!resp.ok) {
    // 스크래핑 실패 시 KV 히스토리만이라도 반환
    return json({
      error:   `ICI fetch failed: ${resp.status}`,
      source:  'ICI (KV fallback)',
      history: kvHistory,
      kvCount: kvHistory.length,
    }, resp.status >= 500 ? 502 : 200);
  }

  const html = await resp.text();

  // ── Step 3: 파싱 ──
  // 최신 전체 총자산
  const totalMatch = html.match(/\$([\d.]+)\s*trillion/i);
  const total = totalMatch ? parseFloat(totalMatch[1]) : null;

  // 흐름 (소매/기관 분리)
  const flowPat = /(?:increased|decreased) by \$([\d.]+)\s*billion to \$([\d.]+)\s*trillion/gi;
  const flows = [];
  let m;
  while ((m = flowPat.exec(html)) !== null && flows.length < 5) {
    const sign = m[0].toLowerCase().startsWith('decreased') ? -1 : 1;
    flows.push({ change: sign * parseFloat(m[1]), value: parseFloat(m[2]) });
  }
  const changeB = flows[0]?.change ?? null;
  const retailT = flows[1]?.value  ?? null;
  const instT   = total != null && retailT != null ? +(total - retailT).toFixed(3) : null;

  // 날짜 파싱 — "week ended Wednesday, March 19" 또는 "week ended Wednesday, March 19, 2026"
  const dateMatch = html.match(/week ended\s+\w+,\s+(\w+ \d+(?:,?\s*\d{4})?)/i);
  const weekEnded = dateMatch ? dateMatch[1].trim() : null;

  // 연도 보정: "March 19" → "March 19, 2026" (연도 없으면 현재 연도 추가)
  const normalizeDate = (d) => {
    if (!d) return null;
    if (/\d{4}/.test(d)) return d;  // 이미 연도 있음
    return `${d}, ${new Date().getFullYear()}`;
  };
  const weekEndedFull = normalizeDate(weekEnded);

  if (total === null) {
    return json({
      error:   'ICI 파싱 실패: trillion 수치 미발견',
      htmlLength: html.length,
      history: kvHistory,
      kvCount: kvHistory.length,
    }, 500);
  }

  // ── Step 4: KV 누적 — 이번 주차가 없으면 추가 ──
  const newEntry = {
    weekEnded: weekEndedFull,
    total:     +total.toFixed(3),          // $T
    totalB:    +(total * 1000).toFixed(1), // $B 환산 (4W Δ 계산용)
    retail:    retailT != null ? +retailT.toFixed(3) : null,
    inst:      instT   != null ? +instT.toFixed(3)   : null,
    changeB:   changeB != null ? +changeB.toFixed(2) : null,
    savedAt:   new Date().toISOString().slice(0, 10),
  };

  // 중복 방지: weekEnded가 같으면 업데이트, 없으면 앞에 추가
  const exists = kvHistory.findIndex(h => h.weekEnded === newEntry.weekEnded);
  if (exists >= 0) {
    kvHistory[exists] = newEntry;  // 수정치(revision) 반영
  } else {
    kvHistory.unshift(newEntry);   // 최신이 index 0
  }

  // 최대 52주 보관 (1년)
  kvHistory = kvHistory.slice(0, 52);

  // ── Step 5: KV 저장 — ctx.waitUntil로 응답 후에도 완료 보장 ──
  if (env?.MMF_KV) {
    const putPromise = env.MMF_KV.put(KV_KEY, JSON.stringify(kvHistory), {
      expirationTtl: 60 * 60 * 24 * 400,
    }).catch(e => console.error('[KV PUT ERROR] iciMMF', e.message));
    if (ctx?.waitUntil) ctx.waitUntil(putPromise);
  }

  // ── Step 6: 반환 ──
  return json({
    source:        'ICI (ici.org) + KV 누적',
    weekEnded:     weekEndedFull,
    total,
    retail:        retailT,
    institutional: instT,
    changeB,
    unit:          'trillion_usd',
    history:       kvHistory,   // KV 누적 전체 히스토리 (최신→과거 순)
    kvCount:       kvHistory.length,
  });
}

// ── /ici-raw 는 디버그용으로 유지 ──
async function iciRaw() {
  const iciUrl = 'https://www.ici.org/research/stats/mmf';
  const resp = await fetch(iciUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    cf: { cacheTtl: 0 },
  });
  const status = resp.status;
  if (!resp.ok) return json({ status, note: '접근 차단' });
  const html = await resp.text();
  const totalMatch = html.match(/\$([\d.]+)\s*trillion/i);
  const flowPat = /increased by \$([\d.]+)\s*billion to \$([\d.]+)\s*trillion/gi;
  const flows = []; let m;
  while ((m = flowPat.exec(html)) !== null && flows.length < 4) flows.push({ change: m[1], value: m[2] });
  const dateMatch = html.match(/week ended\s+\w+,\s+(\w+ \d+,?\s*\d{4}|\w+ \d+)/i);
  return json({ status, total: totalMatch?.[1], flows, weekEnded: dateMatch?.[1], htmlLength: html.length });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3-C. H.4.1 역사적 데이터 (주간 아카이브)
//    GET /h41-history?weeks=N    최근 N주치 핵심 지표
//    Fed 아카이브: federalreserve.gov/releases/h41/YYYYMMDD/
//    그래프용 시계열 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function h41HistoryFetcher(url) {
  const weeks  = Math.min(parseInt(url.searchParams.get('weeks') || '12'), 52);
  const debug  = url.searchParams.get('debug') === '1';

  // ── STEP 1: Fed H.4.1 인덱스에서 실제 릴리즈 URL 목록 수집 ──
  // 수요일 data → 목요일 발표 → 아카이브도 목요일 날짜 사용
  const INDEX_URL = 'https://www.federalreserve.gov/releases/h41/';
  let releaseUrls = [];
  const urlAttempts = [];

  try {
    const idxResp = await fetch(INDEX_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MacroMonitor/1.0)' },
      cf: { cacheTtl: 3600 },
    });
    if (idxResp.ok) {
      const idxHtml = await idxResp.text();
      // 인덱스 페이지에서 /releases/h41/YYYYMMDD/ 형태 링크 추출
      const linkRe = /href="\/releases\/h41\/(\d{8})\/"/gi;
      let m;
      while ((m = linkRe.exec(idxHtml)) !== null) {
        const dateStr = m[1];
        if (!releaseUrls.find(u => u.date === dateStr)) {
          releaseUrls.push({
            date: dateStr,
            url: `https://www.federalreserve.gov/releases/h41/${dateStr}/`,
          });
        }
      }
      // 날짜 내림차순 정렬 후 최근 N개만
      releaseUrls.sort((a, b) => b.date.localeCompare(a.date));
      releaseUrls = releaseUrls.slice(0, weeks);
    }
  } catch(e) {
    urlAttempts.push({ step: 'index', error: e.message });
  }

  // 인덱스 파싱 실패 시 목요일 날짜 추정으로 폴백
  if (!releaseUrls.length) {
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    // 가장 최근 수요일 구하기
    let d = new Date(now);
    const dow = d.getDay(); // 0=Sun
    const daysToLastWed = (dow + 4) % 7;
    d.setDate(d.getDate() - daysToLastWed);
    // 수요일+1 = 목요일(발표일)
    for (let i = 0; i < weeks; i++) {
      const thu = new Date(d);
      thu.setDate(thu.getDate() + 1); // 목요일
      const dateStr = `${thu.getFullYear()}${pad(thu.getMonth()+1)}${pad(thu.getDate())}`;
      releaseUrls.push({
        date: dateStr,
        url: `https://www.federalreserve.gov/releases/h41/${dateStr}/`,
      });
      d.setDate(d.getDate() - 7);
    }
    urlAttempts.push({ step: 'fallback', msg: '인덱스 실패 → 목요일 날짜 추정 사용' });
  }

  // ── STEP 2: 각 릴리즈 HTML 파싱 ──
  const parseMetrics = async ({ date, url: fedUrl }) => {
    urlAttempts.push({ date, url: fedUrl, status: 'fetching' });
    try {
      const resp = await fetch(fedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MacroMonitor/1.0)' },
        cf: { cacheTtl: 604800 },
      });
      const status = resp.status;
      if (!resp.ok) {
        urlAttempts.push({ date, url: fedUrl, status, error: `HTTP ${status}` });
        return { date, url: fedUrl, httpStatus: status, error: `HTTP ${status}` };
      }
      const html = await resp.text();
      urlAttempts.push({ date, url: fedUrl, status: 'ok', htmlLen: html.length });

      const clean = s => s.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&')
        .replace(/&nbsp;/g,' ').replace(/&#x[\da-fA-F]+;/g,' ')
        .replace(/&#\d+;/g,' ').replace(/&[a-zA-Z]+;/g,' ')
        .replace(/\s+/g,' ').trim();
      const parseN = s => {
        if (!s) return null;
        const c = s.replace(/[^0-9.]/g,'');
        if (!c) return null;
        const n = parseFloat(c);
        return isNaN(n) || n === 0 ? null : n;
      };
      const tables = [];
      const tRe = /<table[\s\S]*?<\/table>/gi;
      let tm;
      while ((tm = tRe.exec(html)) !== null) tables.push(tm[0]);

      const extractRows = tbl => {
        const rows = [];
        const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let tr;
        while ((tr = trRe.exec(tbl)) !== null) {
          const cells = [];
          const tdRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
          let td;
          while ((td = tdRe.exec(tr[1])) !== null) cells.push(clean(td[1]));
          if (cells.length >= 1) rows.push(cells);
        }
        return rows;
      };
      const hasDataRow = (rows, pat, min=100000) => rows.some(r => {
        const lc = r[0].toLowerCase().replace(/\s+\d+$/,'').trim();
        const v = r.length > 1 ? parseN(r[1]) : null;
        return lc.includes(pat) && v != null && v >= min;
      });
      const getVal = (rows, pat) => {
        for (const r of rows) {
          const lc = r[0].toLowerCase().replace(/\s+\d+$/,'').trim();
          if (lc.includes(pat) && r.length > 1) {
            const v = parseN(r[1]);
            if (v != null && v > 0) return v;
          }
        }
        return null;
      };

      let tAssets=null, tLiabDet=null, tLiabSum=null, tMbs=null, tMat=null;
      for (const t of tables) {
        const rows = extractRows(t);
        if (!tAssets   && hasDataRow(rows,'reserve bank credit',5000000))       tAssets   = rows;
        if (!tLiabSum  && hasDataRow(rows,'currency in circulation',2000000))   tLiabSum  = rows;
        if (!tLiabDet  && hasDataRow(rows,'federal reserve notes, net',2000000)
                       && hasDataRow(rows,'depository institutions',2000000)
                       && rows.some(r=>r.length>=14))                           tLiabDet = rows;
        if (!tMbs      && hasDataRow(rows,'mortgage-backed securities held outright',1000000)) tMbs = rows;
        if (!tMat      && rows.some(r => r[0].toLowerCase().includes('remaining maturity') && r.length >= 8)) tMat = rows;
      }

      // ── 만기별 파싱 (Table[6] 매트릭스) ──
      // 구조: 헤더행(Remaining Maturity | Within 15 days | ...) + 자산행(Holdings cells[1..6])
      const MAT_KEYS   = ['within_15d','d16_90d','d91_1y','y1_5y','y5_10y','over_10y'];
      const matResult  = {};
      if (tMat) {
        let inSection = null;
        const holdingsSeen = {};
        for (const cells of tMat) {
          const lc = cells[0].toLowerCase().replace(/\s+\d+$/,'').trim();
          if (lc.includes('u.s. treasury securities'))  inSection = 'treasury';
          if (lc.includes('federal agency debt'))        inSection = 'agency';
          if (lc === 'holdings' && inSection) {
            holdingsSeen[inSection] = (holdingsSeen[inSection]||0) + 1;
            if (holdingsSeen[inSection] === 1) {          // 첫 번째 Holdings = 보유량
              MAT_KEYS.forEach((k, ci) => {
                const v = parseN(cells[ci+1]);
                if (v != null) matResult[inSection+'_'+k] = v; // Millions
              });
            }
          }
        }
      }

      const dm = html.match(/([A-Z][a-z]+ \d{1,2},\s*\d{4})/);
      // ON RRP domestic = rrp_total(Table2) - rrp_foreign(Table2)
      const rrp_total_m   = getVal(tLiabSum, 'reverse repurchase agreements');
      const rrp_foreign_m = getVal(tLiabSum, 'foreign official and international');
      const on_rrp_m = (rrp_total_m != null && rrp_foreign_m != null)
        ? rrp_total_m - rrp_foreign_m : rrp_total_m;
      return {
        date,
        releaseDate: dm ? dm[1] : date,
        httpStatus: 200,
        tableCount: tables.length,
        reserve_credit:   getVal(tAssets,  'reserve bank credit'),
        treasury_total:   getVal(tAssets,  'u.s. treasury securities'),
        securities_total: getVal(tAssets,  'securities held outright'),
        loans:            getVal(tAssets,  'loans'),                       // ← 긴급대출 추가
        reserve_balances: getVal(tLiabDet, 'depository institutions'),
        rrp_total:        rrp_total_m,
        rrp_foreign:      rrp_foreign_m,
        on_rrp_domestic:  on_rrp_m,
        rrp_bs:           getVal(tLiabDet, 'reverse repurchase agreements'),
        tga:              getVal(tLiabDet, 'u.s. treasury, general account'),
        fed_notes_net:    getVal(tLiabDet, 'federal reserve notes, net'),
        mbs_total:        getVal(tMbs,     'mortgage-backed securities held outright'),
        maturity:         matResult,
      };
    } catch(e) {
      urlAttempts.push({ date, url: fedUrl, status: 'error', error: e.message });
      return { date, url: fedUrl, httpStatus: 0, error: e.message };
    }
  };

  // 배치 fetch (8개씩)
  const results = [];
  for (let i = 0; i < releaseUrls.length; i += 8) {
    const batch = await Promise.all(releaseUrls.slice(i, i+8).map(parseMetrics));
    results.push(...batch);
  }

  const valid = results.filter(r => r && !r.error && r.reserve_balances != null);
  const B = v => v ? +(v/1000).toFixed(1) : null;

  return json({
    success: true,
    weeks_requested: weeks,
    weeks_retrieved: valid.length,
    urls_tried: releaseUrls.length,
    series: {
      labels:           valid.map(r => r.releaseDate),
      // ── Pipe1 핵심 ──
      reserve_balances: valid.map(r => B(r.reserve_balances)),
      rrp:              valid.map(r => B(r.rrp)),
      tga:              valid.map(r => B(r.tga)),
      buffer:           valid.map(r => (r.reserve_balances&&r.rrp) ? B(r.reserve_balances+r.rrp) : null),
      loans:            valid.map(r => B(r.loans)),                    // ← 긴급대출 시계열 추가
      // ── 자산 ──
      reserve_credit:      valid.map(r => B(r.reserve_credit)),   // 총자산 프록시 (B)
      treasury_total:      valid.map(r => B(r.treasury_total)),
      mbs_total:           valid.map(r => B(r.mbs_total)),
      // ── ON RRP domestic (rrp_total - rrp_foreign, B) ──
      on_rrp_domestic:     valid.map(r => r.on_rrp_domestic != null ? +(r.on_rrp_domestic/1000).toFixed(1) : null),
      // ── 만기별 국채 (treasury) — Millions → Billions ──
      treasury_within_15d: valid.map(r => B(r.maturity?.treasury_within_15d)),
      treasury_d16_90d:    valid.map(r => B(r.maturity?.treasury_d16_90d)),
      treasury_d91_1y:     valid.map(r => B(r.maturity?.treasury_d91_1y)),
      treasury_y1_5y:      valid.map(r => B(r.maturity?.treasury_y1_5y)),
      treasury_y5_10y:     valid.map(r => B(r.maturity?.treasury_y5_10y)),
      treasury_over_10y:   valid.map(r => B(r.maturity?.treasury_over_10y)),
      // ── 만기별 Agency/MBS ──
      agency_within_15d:   valid.map(r => B(r.maturity?.agency_within_15d)),
      agency_d16_90d:      valid.map(r => B(r.maturity?.agency_d16_90d)),
      agency_d91_1y:       valid.map(r => B(r.maturity?.agency_d91_1y)),
      agency_y1_5y:        valid.map(r => B(r.maturity?.agency_y1_5y)),
      agency_y5_10y:       valid.map(r => B(r.maturity?.agency_y5_10y)),
      agency_over_10y:     valid.map(r => B(r.maturity?.agency_over_10y)),
    },
    raw: results,
    ...(debug ? { urlAttempts } : {}),
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3-B. Fed H.4.1 원본 HTML 직접 파싱
//    GET /h41-html
//    CORS 차단 없음 (Worker 서버사이드 fetch)
//    Table 1: 자산/부채 전체, Table 2: 만기별 보유량
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function h41HtmlParser() {
  const FED_URL = 'https://www.federalreserve.gov/releases/h41/current/';
  let html;
  try {
    const resp = await fetch(FED_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MacroMonitor/1.0)', 'Accept': 'text/html' },
      cf: { cacheTtl: 21600 },
    });
    if (!resp.ok) throw new Error(`Fed HTTP ${resp.status}`);
    html = await resp.text();
  } catch(e) {
    return json({ success: false, error: `Fed 원본 HTML 접근 실패: ${e.message}` }, 502);
  }

  // ── 날짜 파싱 ──
  const releaseDateMatch = html.match(/([A-Z][a-z]+ \d{1,2},\s*\d{4})/);
  const releaseDate = releaseDateMatch ? releaseDateMatch[1].trim() : null;

  // ── 셀 정제 (엔티티 이중 디코딩 + 완전 정리) ──
  const cleanCell = (raw) => {
    let s = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&amp;/g, '&')           // 이중 인코딩 처리
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x[\da-fA-F]+;/g, ' ') // 16진수 엔티티
      .replace(/&#\d+;/g, ' ')          // 10진수 엔티티 (&#160; 등)
      .replace(/&[a-zA-Z]+;/g, ' ')     // 이름 엔티티 (&mdash; 등)
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  };

  // ── 숫자 파싱 (괄호=음수, 쉼표/공백 허용) ──
  const parseNum = (s) => {
    if (!s) return null;
    const neg = /^\([\d,. ]+\)$/.test(s.trim());
    const clean = s.replace(/[^0-9.]/g, '');
    if (!clean) return null;
    const n = parseFloat(clean);
    return isNaN(n) ? null : (neg ? -n : n);
  };

  // ── 테이블 행 추출 (th + td 모두) ──
  const extractRows = (tableHtml) => {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(tableHtml)) !== null) {
      const cellRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      const cells = [];
      let cell;
      while ((cell = cellRe.exec(tr[1])) !== null) cells.push(cleanCell(cell[1]));
      if (cells.length >= 1) rows.push(cells);
    }
    return rows;
  };

  // ── 테이블 분리 ──
  const tables = [];
  const tblRe = /<table[\s\S]*?<\/table>/gi;
  let tbl;
  while ((tbl = tblRe.exec(html)) !== null) tables.push(tbl[0]);

  // ── 테이블 식별 (숫자값 임계값 기반 — 헤더/각주 테이블 오매칭 방지) ──
  // 텍스트 포함 여부만으로 식별 시 숨겨진 테이블에 오매칭 발생
  // 반드시 실제 수치(>threshold)가 있는 행을 가진 테이블만 매칭
  let tAssets=null, tLiabSum=null, tLiabDet=null, tMbs=null, tMat=null, tMemo=null, tNotes=null;

  const hasDataRow = (rows, labelPattern, minVal=100000, colIdx=1) => {
    // label 매칭 + 실제 수치(minVal M 이상) 행 존재 여부
    for (const cells of rows) {
      const lc = cells[0].toLowerCase().replace(/\s+\d+$/, '').trim();
      if (!lc.includes(labelPattern)) continue;
      if (cells.length <= colIdx) continue;
      const v = parseNum(cells[colIdx]);
      if (v !== null && Math.abs(v) >= minVal) return true;
    }
    return false;
  };

  for (const t of tables) {
    const rows = extractRows(t);
    // ── 자산 테이블 (T1): "Reserve Bank credit" > $5T ──
    if (!tAssets && hasDataRow(rows, 'reserve bank credit', 5000000))
      tAssets = rows;
    // ── 부채 요약 (T2): "Currency in circulation" > $2T ──
    if (!tLiabSum && hasDataRow(rows, 'currency in circulation', 2000000))
      tLiabSum = rows;
    // ── 부채 상세 (T16): "Federal Reserve notes, net" > $2T AND col:14+ ──
    // col:14 조건 추가: 지역별 분리 테이블만 해당 → 헤더/요약 테이블 제외
    if (!tLiabDet &&
        hasDataRow(rows, 'federal reserve notes, net', 2000000, 1) &&
        hasDataRow(rows, 'depository institutions', 2000000, 1) &&
        rows.some(r => r.length >= 14)) {
      tLiabDet = rows;
    }
    // ── MBS (T8): "Mortgage-backed securities held outright" > $1T ──
    if (!tMbs && hasDataRow(rows, 'mortgage-backed securities held outright', 1000000))
      tMbs = rows;
    // ── 만기 (T6): "Remaining Maturity" 행 + col:8 ──
    if (!tMat && rows.some(r => r[0].toLowerCase().includes('remaining maturity') && r.length >= 8))
      tMat = rows;
    // ── 메모란덤 (T4): "Securities held in custody" > $2T ──
    if (!tMemo && hasDataRow(rows, 'securities held in custody', 2000000))
      tMemo = rows;
    // ── FR Notes (T19): "Federal Reserve notes outstanding" > $2T ──
    if (!tNotes && hasDataRow(rows, 'federal reserve notes outstanding', 2000000))
      tNotes = rows;
  }

  // ── 행 매칭 유틸 ──
  // deltaMode 'raw' : cells[colIdx+1]이 이미 변화량 (Table 1/2/4/8/19 구조)
  // deltaMode 'none': delta 계산 안 함 (Table 16, col:14 지역값이라 무의미)
  // deltaMode 'calc': cells[colIdx+1]이 이전값, 차이 계산
  const matchRow = (rows, patterns, colIdx=1, deltaMode='raw') => {
    if (!rows) return null;
    for (const cells of rows) {
      const lc = cells[0].toLowerCase().replace(/\s+\d+$/, '').trim();
      const match = patterns.some(p => lc.includes(p.toLowerCase()));
      if (match && cells.length > colIdx) {
        const val = parseNum(cells[colIdx]);
        if (val !== null && val !== 0) {
          let deltaB = null;
          if (deltaMode === 'raw' && cells.length > colIdx+1) {
            const d = parseNum(cells[colIdx+1]);
            if (d !== null) deltaB = d / 1000;
          } else if (deltaMode === 'calc' && cells.length > colIdx+1) {
            const prev = parseNum(cells[colIdx+1]);
            if (prev !== null) deltaB = (val - prev) / 1000;
          }
          return { val, deltaB, valueB: val/1000, valueM: val };
        }
      }
    }
    return null;
  };

  const rec = (key, label, rows, patterns, colIdx=1, deltaMode='raw') => {
    const r = matchRow(rows, patterns, colIdx, deltaMode);
    if (!r) return;
    data[key] = { label, ...r };
  };

  // recOrZero: 행을 찾지 못하면 0으로 기본값 설정 (FIMA Repo 평상시 $0 처리용)
  const recOrZero = (key, label, rows, patterns, colIdx=1, deltaMode='raw') => {
    const r = matchRow(rows, patterns, colIdx, deltaMode);
    data[key] = r
      ? { label, ...r }
      : { label, val: 0, deltaB: null, valueB: 0, valueM: 0, isZeroDefault: true };
  };

  const data = {};

  // ═══════════════════════════════════════════
  // SECTION 1: 자산 공급 요인 (Table[1], col:5)
  // cells[1]=현재주, cells[2]=전주, cells[3]=변화, cells[4]=작년
  // ═══════════════════════════════════════════
  rec('reserve_credit',   '연준 신용 총액',          tAssets, ['reserve bank credit']);
  rec('securities_total', '보유 증권 합계',           tAssets, ['securities held outright']);
  rec('treasury_total',   '미 국채 합계',             tAssets, ['u.s. treasury securities']);
  rec('treasury_bills',   '단기채 (T-Bills)',         tAssets, ['bills']);
  rec('treasury_notes',   '중장기채 (Notes&Bonds)',   tAssets, ['notes and bonds, nominal']);
  rec('treasury_tips',    'TIPS (물가연동)',           tAssets, ['inflation-indexed']);
  rec('agency_debt',      'Agency 채권',              tAssets, ['federal agency debt securities']);
  rec('mbs_t1',           'MBS (자산테이블)',          tAssets, ['mortgage-backed securities']);
  rec('loans',            '연준 대출',                tAssets, ['loans']);
  rec('repo_assets',      '환매조건부채권(자산합계)',   tAssets, ['repurchase agreements']);
  // FIMA Repo: 자산(Assets) 측 "Repurchase agreements > Foreign official"
  // 평상시 $0 (외국 중앙은행이 연준에서 비상 차입 없음) → recOrZero로 기본값 0 처리
  // ⚠️ 패턴 주의: tAssets에서만 검색하므로 tLiabSum의 "foreign official and international"과 구분됨
  recOrZero('fima_repo',  'FIMA Repo (긴급 대출)',    tAssets, ['foreign official']);
  rec('fx_assets',        '외화 자산',                tAssets, ['foreign currency denominated']);
  rec('gold_sdr',         '금·SDR',                  tAssets, ['gold stock', 'special drawing rights cert']);
  rec('total_supply',     '총 공급 요인',              tAssets, ['total factors supplying']);

  // ═══════════════════════════════════════════
  // SECTION 2: 부채 흡수 요인 (Table[2], col:5)
  // rrp_foreign = 외국 중앙은행의 정상 예치금(Foreign Official RRP)
  // → Pipe0 ON RRP domestic = rrp_total - rrp_foreign 계산에 사용 (올바른 용도)
  // ═══════════════════════════════════════════
  rec('currency_circ',    '유통 화폐',               tLiabSum, ['currency in circulation']);
  rec('rrp_total',        '역레포 합계',              tLiabSum, ['reverse repurchase agreements']);
  rec('rrp_foreign',      '외국계 정상 예치(역레포)', tLiabSum, ['foreign official and international']);
  rec('treasury_cash',    '재무부 현금보유',           tLiabSum, ['treasury cash holdings']);
  rec('reserve_bal_t2',   '준비금 잔고 (요인테이블)',  tLiabSum, ['reserve balances with federal']);
  rec('tga_t2',           'TGA (요인테이블)',          tLiabSum, ['u.s. treasury, general account', 'treasury, general account']);
  rec('total_absorb',     '총 흡수 요인',             tLiabSum, ['total factors absorbing']);

  // ═══════════════════════════════════════════
  // SECTION 3: 통합대차대조표 부채 (Table[16], col:14, col[1]=Total)
  // ═══════════════════════════════════════════
  rec('fed_notes_net',    'FR Notes (순)',            tLiabDet, ['federal reserve notes, net'], 1, 'none');
  rec('rrp_bs',           '역레포 (대차대조표)',       tLiabDet, ['reverse repurchase agreements'], 1, 'none');
  rec('deposits_total',   '예금 합계',               tLiabDet, ['deposits'], 1, 'none');
  rec('reserve_balances', '★ 은행 준비금',            tLiabDet, ['depository institutions'], 1, 'none');
  rec('tga',              '★ TGA (재무부 계정)',      tLiabDet, ['u.s. treasury, general account', 'treasury, general account'], 1, 'none');
  rec('foreign_deposits', '외국계 예금',              tLiabDet, ['foreign official', 'foreign and international'], 1, 'none');

  // ═══════════════════════════════════════════
  // SECTION 4: MBS 상세 (Table[8], col:2)
  // cells[1]=Wednesday값 (단일 컬럼)
  // ═══════════════════════════════════════════
  rec('mbs_total',        'MBS 보유 합계',            tMbs, ['mortgage-backed securities held outright']);
  rec('mbs_residential',  '주거용 MBS',               tMbs, ['residential mortgage-backed']);
  rec('mbs_commercial',   '상업용 MBS',               tMbs, ['commercial mortgage-backed']);
  rec('mbs_buy_commit',   'MBS 매입 약정',             tMbs, ['commitments to buy']);
  rec('mbs_sell_commit',  'MBS 매도 약정',             tMbs, ['commitments to sell']);

  // ═══════════════════════════════════════════
  // SECTION 5: 메모란덤 (Table[4], col:5) — 외국계 커스터디
  // ═══════════════════════════════════════════
  rec('custody_total',    '외국계 커스터디 합계',      tMemo, ['securities held in custody']);
  rec('custody_treasury', '커스터디 국채',             tMemo, ['marketable u.s. treasury']);
  rec('custody_agency',   '커스터디 Agency+MBS',      tMemo, ['federal agency debt and mortgage']);
  rec('custody_other',    '커스터디 기타',             tMemo, ['other securities']);
  rec('sec_lent',         '대출 증권',                tMemo, ['securities lent to dealers']);

  // ═══════════════════════════════════════════
  // SECTION 6: FR Notes & 담보 (Table[19], col:2)
  // ═══════════════════════════════════════════
  rec('notes_outstanding',    'FR Notes 발행 잔고',   tNotes, ['federal reserve notes outstanding']);
  rec('notes_collateralized', '담보 대상 Notes',      tNotes, ['federal reserve notes to be collateral']);
  rec('collateral_total',     '담보 합계',            tNotes, ['collateral held against']);
  rec('collateral_pledged',   '담보 국채+Agency+MBS', tNotes, ['u.s. treasury, agency debt, and mortgage']);

  // ═══════════════════════════════════════════
  // SECTION 7: 만기별 분포 (Table[6], 8열 매트릭스)
  // 구조: 행=자산유형, 열=만기구간
  // 열순서: [레이블 | Within15d | 16-90d | 91d-1y | 1y-5y | 5y-10y | 10y+ | Total]
  // ═══════════════════════════════════════════
  const matData = {};
  if (tMat) {
    // 헤더 행 파악: "Remaining Maturity" 행의 cells[1..7] = 만기 구간명
    let colHeaders = [];
    let inSection = null;
    let holdingsCount = { treasury: 0, agency: 0 };

    for (let i = 0; i < tMat.length; i++) {
      const cells = tMat[i];
      const lc = cells[0].toLowerCase().replace(/\s+\d+$/, '').trim();

      // 헤더 파악
      if (lc.includes('remaining maturity') && cells.length >= 4) {
        colHeaders = cells.slice(1).map(c => c.trim());
      }
      // 섹션 진입
      if (lc.includes('u.s. treasury securities'))       inSection = 'treasury';
      if (lc.includes('federal agency debt securities') ||
          lc.includes('mortgage-backed securities') && inSection === 'treasury') inSection = 'agency';

      // Holdings 행: 해당 섹션의 보유량
      if (lc === 'holdings' && inSection) {
        const sectionKey = inSection;
        holdingsCount[sectionKey] = (holdingsCount[sectionKey] || 0) + 1;
        // 첫 번째 Holdings = 보유량, 두 번째 Holdings = 다른 항목
        if (holdingsCount[sectionKey] === 1) {
          const MAT_KEYS = ['within_15d','d16_90d','d91_1y','y1_5y','y5_10y','over_10y'];
          const MAT_LABELS = ['15일 이하','16~90일','91일~1년','1~5년','5~10년','10년 초과'];
          cells.slice(1).forEach((cell, ci) => {
            if (ci >= MAT_KEYS.length) return;
            const val = parseNum(cell);
            if (val !== null) {
              matData[`${sectionKey}_${MAT_KEYS[ci]}`] = {
                asset:    sectionKey === 'treasury' ? '미 국채' : 'Agency/MBS',
                maturity: MAT_LABELS[ci],
                colHeader: colHeaders[ci] || MAT_LABELS[ci],
                valueM:  val,
                valueB:  val / 1000,
              };
            }
          });
          // Total 컬럼 (cells[7] if available)
          const totalCell = cells[7];
          if (totalCell) {
            const tot = parseNum(totalCell);
            if (tot !== null) {
              matData[`${sectionKey}_total`] = {
                asset:    sectionKey === 'treasury' ? '미 국채' : 'Agency/MBS',
                maturity: '합계',
                colHeader: '합계',
                valueM:  tot,
                valueB:  tot / 1000,
              };
            }
          }
        }
      }
    }
  }

  // ── 집계: 주요 요약 (대시보드 표시용) ──
  const summary = {
    // 자산
    total_securities:   data.securities_total?.valueB ?? null,
    treasury:           data.treasury_total?.valueB ?? null,
    agency_mbs:         (data.agency_debt?.valueM ?? 0) + (data.mbs_total?.valueM ?? 0),
    // 부채
    reserve_balances:   data.reserve_balances?.valueB ?? null,  // ★ Pipe1 핵심
    rrp:                data.rrp_bs?.valueB ?? data.rrp_total?.valueB ?? null,   // Table[16] Wednesday level 우선
    tga:                data.tga?.valueB ?? data.tga_t2?.valueB ?? null,
    currency:           data.currency_circ?.valueB ?? null,
    // 버퍼 (Pipe1 스코어링용)
    buffer_T:           null,  // 아래서 계산
    releaseDate,
  };
  // buffer_T: Pipe1 스코어링 핵심 — 준비금(WRESBAL 대체, Table[16]) + RRP(Table[16])
  // 단위: Billions USD
  if (summary.reserve_balances && summary.rrp) {
    summary.buffer_T = summary.reserve_balances + summary.rrp;
    summary.buffer_T_score = summary.buffer_T < 2000 ? '🔴 경색' :
                              summary.buffer_T < 2500 ? '🟡 주의' : '🟢 정상';
  }

  // ── 파싱 품질 ──
  const t1Found = Object.keys(data).length;
  const t2Found = Object.keys(matData).length;
  const parseQuality = t1Found >= 10 ? 'good' : t1Found >= 5 ? 'partial' : 'failed';

  // ── 디버그 ──
  const tableSamples = tables.slice(0, 22).map((t, idx) => {
    const rows = extractRows(t);
    const valid = rows.filter(c => c.length >= 2 && c[0].length > 3 && c[1]?.length > 0);
    return {
      tableIndex: idx,
      rowCount: rows.length,
      validRowCount: valid.length,
      sampleRows: valid.slice(0, 8).map(c => ({
        label: c[0].substring(0, 80),
        value: (c[1] || '').substring(0, 20),
        colCount: c.length,
      })),
    };
  }).filter(t => t.validRowCount > 0);

  return json({
    success: true,
    source:  'Federal Reserve H.4.1 HTML Direct Parse',
    url:     FED_URL,
    releaseDate,
    parseQuality,
    summary,          // ★ 대시보드 핵심값 (Pipe1 스코어링용)
    data,             // 전체 항목 (섹션별)
    maturity: matData,// 만기별 분포
    debug: {
      htmlLength:  html.length,
      tableCount:  tables.length,
      t1FoundCount: t1Found,
      t2FoundCount: t2Found,
      parseQuality,
      tablesIdentified: {
        assets: !!tAssets, liabSum: !!tLiabSum, liabDet: !!tLiabDet,
        mbs: !!tMbs, maturity: !!tMat, memo: !!tMemo, notes: !!tNotes,
      },
      tableSamples,
    },
  });
}


//    GET /h41
//    FRED에서 Fed balance sheet 핵심 시리즈 직접 조회
//    HTML 파싱보다 훨씬 안정적
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function h41Parser(env) {
  // Fed 대차대조표 FRED 시리즈 (모두 십억달러, 주간)
  const series = {
    WALCL:    '연준 총 자산',
    WSHOTSL:  '미 국채 보유',
    WMBSEC:   'MBS 보유',
    TOTRESNS: '은행 준비금',
    RRPONTSYD:'역레포 (ON RRP)',
    WTREGEN:  'TGA 재무부 계정',
    WDTGAL:   '연준 총 부채',
  };

  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) {
    // FRED API Key 없으면 fallback으로 퍼블릭 FRED 데이터 시도
    return json({ error: 'FRED_API_KEY not configured in Worker environment', hint: 'Set FRED_API_KEY in CF Dashboard > Workers > Settings > Variables' }, 500);
  }

  const results = await Promise.allSettled(
    Object.keys(series).map(async (id) => {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&limit=5&sort_order=desc`;
      const r = await fetch(url, { cf: { cacheTtl: 21600 } });
      if (!r.ok) throw new Error(`FRED ${id}: ${r.status}`);
      const data = await r.json();
      const obs = (data.observations||[]).filter(o=>o.value!=='.');
      return {
        id,
        label:     series[id],
        value:     obs[0] ? parseFloat(obs[0].value) : null,
        prevValue: obs[1] ? parseFloat(obs[1].value) : null,
        date:      obs[0]?.date || null,
        delta:     (obs[0]&&obs[1]) ? parseFloat(obs[0].value)-parseFloat(obs[1].value) : null,
        unit:      'Billions USD',
      };
    })
  );

  const data = {};
  let releaseDate = null;
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      data[r.value.id] = r.value;
      if (!releaseDate && r.value.date) releaseDate = r.value.date;
    }
  });

  return json({ success: true, releaseDate, data });
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. FRED 다중 시리즈 일괄 요청 (최신값만)
//    GET /multifред?ids=SOFR,IORB,RRPONTSYD,...
//    한 번의 요청으로 여러 시리즈 최신값 반환
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fredMulti(url, env) {
  const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!ids.length) return json({ error: 'ids parameter required (comma-separated)' }, 400);
  if (ids.length > 20) return json({ error: 'Max 20 series per request' }, 400);

  const apiKey = env.FRED_API_KEY;

  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const fredUrl = `https://api.stlouisfed.org/fred/series/observations`
        + `?series_id=${id}&api_key=${apiKey}&file_type=json&limit=2&sort_order=desc`;

      const resp = await fetch(fredUrl, { cf: { cacheTtl: 3600 } });
      if (!resp.ok) throw new Error(`FRED ${id}: ${resp.status}`);
      const data = await resp.json();

      const obs = data.observations || [];
      const latest  = obs.find(o => o.value !== '.');
      const prev    = obs.slice(1).find(o => o.value !== '.');

      return {
        id,
        value:     latest ? parseFloat(latest.value)  : null,
        date:      latest ? latest.date                : null,
        prevValue: prev   ? parseFloat(prev.value)    : null,
        prevDate:  prev   ? prev.date                  : null,
        delta:     (latest && prev)
          ? parseFloat(latest.value) - parseFloat(prev.value)
          : null,
      };
    })
  );

  const output = {};
  results.forEach((r, i) => {
    output[ids[i]] = r.status === 'fulfilled' ? r.value : { id: ids[i], error: r.reason?.message };
  });

  return json({ success: true, series: output, count: ids.length });
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. Yahoo Finance 프록시
//    GET /yahoo?tickers=SRUUF,SI=F,DX-Y.NYB,EEM
//    여러 티커를 콤마 구분으로 한 번에 요청
//    Yahoo Finance 비공식 API (v8 quote endpoint)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function yahooProxy(url) {
  const raw = url.searchParams.get('tickers') || '';
  const tickers = raw.split(',')
    .map(s => s.trim().replace(/%3D/gi, '='))  // GC%3DF → GC=F
    .filter(Boolean);
  if (!tickers.length) return json({ error: 'tickers parameter required' }, 400);
  if (tickers.length > 15) return json({ error: 'Max 15 tickers per request' }, 400);

  const results = await Promise.allSettled(
    tickers.map(async (ticker) => {
      // Yahoo Finance v8 crumbless endpoint (공개 quote)
      // interval=1m + range=1d → meta에 regularMarketChangePercent 포함
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`;
      const resp = await fetch(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        cf: { cacheTtl: 60 }, // 1분 캐시 (장중 실시간)
      });
      if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
      const data = await resp.json();

      const meta   = data?.chart?.result?.[0]?.meta;
      const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0];
      const timestamps = data?.chart?.result?.[0]?.timestamp || [];

      if (!meta) throw new Error('No meta data');

      const closes = quotes?.close || [];
      // 마지막 유효값
      let latest = null, prev = null;
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] !== null) { if (latest === null) latest = closes[i]; else if (prev === null) { prev = closes[i]; break; } }
      }

      // regularMarketChangePercent: meta에 있으면 사용 (장중 실시간)
      const regularPct = meta.regularMarketChangePercent ?? null;
      const regularPrice = meta.regularMarketPrice ?? latest;

      return {
        ticker,
        price:      regularPrice ?? latest,
        prevClose:  prev,
        delta:      (regularPrice && prev) ? regularPrice - prev : null,
        pctChange:  regularPct !== null ? regularPct : ((latest !== null && prev !== null) ? ((latest - prev) / prev) * 100 : null),
        currency:   meta.currency,
        name:       meta.shortName || ticker,
        date:       timestamps.length ? new Date(timestamps[timestamps.length-1] * 1000).toISOString().slice(0,10) : null,
      };
    })
  );

  const output = {};
  results.forEach((r, i) => {
    output[tickers[i]] = r.status === 'fulfilled'
      ? r.value
      : { ticker: tickers[i], error: r.reason?.message, price: null };
  });

  return json({ success: true, quotes: output, count: tickers.length });
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Yahoo Finance 차트 히스토리
//    GET /yahoo-chart?ticker=^VIX&range=1y
//    GET /yahoo-chart?ticker=^MOVE&range=6mo
//
//    range 옵션: 1mo 3mo 6mo 1y 2y 5y
//    interval: 1d (일간 고정)
//    응답: { ticker, dates[], closes[], meta }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function yahooChart(url) {
  const ticker = url.searchParams.get('ticker') || '^VIX';
  const range  = url.searchParams.get('range')  || '1y';

  // 허용 range 값
  const ALLOWED = ['1mo','3mo','6mo','1y','2y','5y'];
  const safeRange = ALLOWED.includes(range) ? range : '1y';

  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?interval=1d&range=${safeRange}`;

  const resp = await fetch(chartUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 3600 }, // 1h 캐시
  });

  if (!resp.ok) {
    return json({ error: `Yahoo chart HTTP ${resp.status}`, ticker, range: safeRange }, 502);
  }

  const data = await resp.json();
  const result     = data?.chart?.result?.[0];
  const meta       = result?.meta;
  const timestamps = result?.timestamp || [];
  const closes     = result?.indicators?.quote?.[0]?.close   || [];
  const volumes    = result?.indicators?.quote?.[0]?.volume  || [];

  if (!meta || !timestamps.length) {
    return json({ error: 'No chart data', ticker, range: safeRange }, 404);
  }

  // null 제거 + 날짜 포맷, volume 포함
  const pairs = timestamps
    .map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().slice(0,10),
      close:  closes[i],
      volume: volumes[i] ?? 0,
    }))
    .filter(p => p.close !== null && p.close !== undefined);

  return json({
    ticker,
    range:    safeRange,
    name:     meta.shortName || ticker,
    currency: meta.currency || '',
    count:    pairs.length,
    dates:    pairs.map(p => p.date),
    closes:   pairs.map(p => parseFloat(p.close.toFixed(2))),
    volumes:  pairs.map(p => p.volume),  // 자금 흐름 계산용
  });
}
//    GET /ism
//    Manufacturing PMI (pm) + Services PMI (nmi) 동시 반환
//    DBnomics API: https://api.db.nomics.world/v22/series/ISM/pmi
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function ismProxy(url) {
  const results = await Promise.allSettled([
    fetchDBnomics('ISM/pmi/pm'),   // Manufacturing PMI
    fetchDBnomics('ISM/pmi/nmi'),  // Non-Manufacturing (Services) PMI
  ]);

  const mfg = results[0].status === 'fulfilled' ? results[0].value : { error: results[0].reason?.message };
  const svc = results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason?.message };

  return json({ manufacturing: mfg, services: svc });
}

async function fetchDBnomics(seriesPath) {
  const apiUrl = `https://api.db.nomics.world/v22/series/${seriesPath}?observations=1&limit=1`;
  const resp = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 86400 }, // 24h 캐시 (월간 업데이트)
  });
  if (!resp.ok) throw new Error(`DBnomics HTTP ${resp.status}`);
  const data = await resp.json();

  const doc = data?.series?.docs?.[0];
  if (!doc) throw new Error('No series data');

  const periods = doc.period || [];
  const values  = doc.value  || [];
  const n = periods.length;

  return {
    series:    seriesPath,
    name:      doc.series_name,
    value:     n > 0 ? values[n-1]  : null,
    prevValue: n > 1 ? values[n-2]  : null,
    date:      n > 0 ? periods[n-1] : null,
    prevDate:  n > 1 ? periods[n-2] : null,
    delta:     (n > 1 && values[n-1] !== null && values[n-2] !== null)
               ? values[n-1] - values[n-2] : null,
  };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPE 2-A: DXY 모멘텀 (Wrecking Ball)
//    GET /dxy
//    Yahoo Finance DX-Y.NYB 1년치 일봉 → 50/200 DMA 계산
//    응답: currentPrice, dma50, dma200, spread50, spread200,
//          crossSignal ("GOLDEN"|"DEAD"|null), dmaGap, dates, closes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function dxyAnalysis() {
  const TICKER = 'DX-Y.NYB';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(TICKER)}`
    + `?interval=1d&range=1y`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 3600 },
  });

  if (!resp.ok) return json({ error: `Yahoo DXY HTTP ${resp.status}` }, 502);

  const data      = await resp.json();
  const result    = data?.chart?.result?.[0];
  const meta      = result?.meta;
  const tss       = result?.timestamp || [];
  const rawCloses = result?.indicators?.quote?.[0]?.close || [];

  if (!meta || !tss.length) return json({ error: 'DXY 데이터 없음' }, 404);

  // null 제거 + 날짜 정렬
  const pairs = tss
    .map((ts, i) => ({
      date:  new Date(ts * 1000).toISOString().slice(0, 10),
      close: rawCloses[i],
    }))
    .filter(p => p.close != null);

  const closes = pairs.map(p => p.close);
  const dates  = pairs.map(p => p.date);
  const n      = closes.length;

  // 이동평균 계산 헬퍼
  const sma = (arr, period) => {
    if (arr.length < period) return null;
    const slice = arr.slice(arr.length - period);
    return slice.reduce((a, b) => a + b, 0) / period;
  };

  const currentPrice = closes[n - 1];
  const dma50  = n >= 50  ? sma(closes, 50)  : null;
  const dma200 = n >= 200 ? sma(closes, 200) : null;

  // 이격도 (현재가 기준 %)
  const spread50  = (currentPrice != null && dma50  != null) ? ((currentPrice - dma50)  / dma50  * 100) : null;
  const spread200 = (currentPrice != null && dma200 != null) ? ((currentPrice - dma200) / dma200 * 100) : null;

  // 50/200 DMA 간 이격도 (크로스 선행 지표)
  // 양수: 50DMA > 200DMA (골든 방향), 음수: 50DMA < 200DMA (데드 방향)
  const dmaGap = (dma50 != null && dma200 != null) ? ((dma50 - dma200) / dma200 * 100) : null;

  // 크로스 신호: 전일 50DMA vs 200DMA로 전환 여부 판별
  let crossSignal = null;
  if (n >= 201 && dma200 != null) {
    const dma50prev  = sma(closes.slice(0, n - 1), 50);
    const dma200prev = sma(closes.slice(0, n - 1), 200);
    if (dma50prev != null && dma200prev != null) {
      const prevAbove = dma50prev > dma200prev;
      const currAbove = dma50  > dma200;
      if (!prevAbove && currAbove) crossSignal = 'GOLDEN';
      else if (prevAbove && !currAbove) crossSignal = 'DEAD';
    }
  }

  const fmt2 = v => v != null ? +v.toFixed(4) : null;

  return json({
    source:       'Yahoo Finance (DX-Y.NYB)',
    asOf:         dates[n - 1],
    currentPrice: fmt2(currentPrice),
    dma50:        fmt2(dma50),
    dma200:       fmt2(dma200),
    spread50:     dma50  != null ? +spread50.toFixed(3)  : null,  // % (현재가 vs 50DMA)
    spread200:    dma200 != null ? +spread200.toFixed(3) : null,  // % (현재가 vs 200DMA)
    dmaGap:       dmaGap != null ? +dmaGap.toFixed(3)   : null,  // % (50DMA vs 200DMA, 크로스 선행)
    crossSignal,          // "GOLDEN" | "DEAD" | null
    dataPoints:   n,
    // 최근 30일 시계열 (차트용)
    recent: {
      dates:  dates.slice(-30),
      closes: closes.slice(-30).map(v => +v.toFixed(4)),
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPE 2-B: 엔캐리 청산 리스크
//    GET /jpy
//    Yahoo Finance JPY=X 단일 티커 (^JYVIX 제거 — Yahoo 데이터 중단)
//
//    산출 지표:
//    ① 5일 변화율 (5d RoC): 방향성 마진콜 신호
//    ② 10일 역사적 변동성 (10d HV, 연율화): JYVIX 대체 지표
//       - 최근 10영업일 일일 수익률(ln 수익률) 표준편차 × sqrt(252) × 100
//       - 임계값: ≥20% → 마진콜 구간 / ≥15% → 감시 구간 (구 JYVIX 기준 그대로 유지)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function jpyCarryRisk() {
  // JPY=X 단독 fetch — 1개월치로 10d HV 계산에 충분한 데이터 확보
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('JPY=X')}`
    + `?interval=1d&range=1mo`;

  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    cf: { cacheTtl: 3600 },
  });
  if (!r.ok) return json({ error: `Yahoo JPY=X HTTP ${r.status}` }, 502);

  const d      = await r.json();
  const result = d?.chart?.result?.[0];
  if (!result)  return json({ error: 'JPY=X 데이터 없음' }, 502);

  const tss    = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const jpyPairs = tss
    .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter(p => p.close != null);

  if (jpyPairs.length < 6) return json({ error: 'JPY=X 데이터 부족 (최소 6일 필요)' }, 502);

  const jpyCloses = jpyPairs.map(p => p.close);
  const jpyN      = jpyCloses.length;

  // ── ① 5일 변화율 (방향성 신호)
  const jpyCurrent = jpyCloses[jpyN - 1];
  const jpy5dAgo   = jpyCloses[Math.max(0, jpyN - 6)];
  const jpyRoC5d   = jpy5dAgo != null ? (jpyCurrent - jpy5dAgo) / jpy5dAgo * 100 : null;

  // ── ② 10일 역사적 변동성 (HV) — JYVIX 대체
  // 수식: HV_10d = σ(ln_returns_10d) × sqrt(252) × 100  [%]
  // ln 수익률이 정규분포에 더 가깝고 복리 효과 반영
  const HV_WINDOW = 10;
  let jpyHV10d = null;
  if (jpyN >= HV_WINDOW + 1) {
    // 최근 10개의 ln 일일 수익률 계산 (10영업일 = 11개 종가 필요)
    const recentCloses = jpyCloses.slice(-(HV_WINDOW + 1));
    const lnReturns = [];
    for (let i = 1; i < recentCloses.length; i++) {
      if (recentCloses[i] > 0 && recentCloses[i - 1] > 0) {
        lnReturns.push(Math.log(recentCloses[i] / recentCloses[i - 1]));
      }
    }
    if (lnReturns.length >= 4) {
      const mu  = lnReturns.reduce((a, b) => a + b, 0) / lnReturns.length;
      const va  = lnReturns.map(x => (x - mu) ** 2).reduce((a, b) => a + b, 0) / (lnReturns.length - 1);
      const std = Math.sqrt(va);
      jpyHV10d  = +(std * Math.sqrt(252) * 100).toFixed(3); // 연율화, %
    }
  }

  // ── 마진콜 경보 판정
  // 기존 JYVIX 임계값을 HV로 대체: JYVIX 20 → HV 20%, JYVIX 15 → HV 15%
  const marginCallWarning = jpyRoC5d != null && jpyRoC5d <= -3.0;  // RoC 기준 (HV 독립)

  // signal: RoC와 HV 중 더 심각한 쪽 기준
  const rocSignal  = jpyRoC5d != null
    ? (jpyRoC5d <= -3.0 ? 'WARNING' : jpyRoC5d <= -1.5 ? 'WATCH' : 'NORMAL')
    : 'NORMAL';
  const hvSignal   = jpyHV10d != null
    ? (jpyHV10d >= 20 ? 'WARNING' : jpyHV10d >= 15 ? 'WATCH' : 'NORMAL')
    : 'NORMAL';
  const signalPri  = { WARNING: 2, WATCH: 1, NORMAL: 0 };
  const signal     = signalPri[rocSignal] >= signalPri[hvSignal] ? rocSignal : hvSignal;

  const fmt3 = v => v != null ? +v.toFixed(3) : null;

  return json({
    source:  'Yahoo Finance (JPY=X 단독 — ^JYVIX 데이터 중단으로 10d HV로 대체)',
    asOf:    jpyPairs[jpyN - 1]?.date,
    jpy: {
      current:     fmt3(jpyCurrent),
      fiveDayAgo:  fmt3(jpy5dAgo),
      roc5d:       jpyRoC5d != null ? +jpyRoC5d.toFixed(3) : null,
      note:        'USD/JPY. 하락(음수 RoC) = 엔 강세 = 마진콜 방향',
    },
    jpyHV: {
      hv10d:       jpyHV10d,           // 연율화 역사적 변동성 %, 10영업일
      window:      HV_WINDOW,
      method:      'σ(ln returns) × √252 × 100',
      signal:      hvSignal,
      note:        'JPY 10d HV (JYVIX 대체). ≥20% → 마진콜 / ≥15% → 감시',
    },
    marginCallWarning,
    signal,   // WARNING | WATCH | NORMAL (RoC와 HV 중 더 심각한 쪽)
    recent: {
      dates:     jpyPairs.slice(-20).map(p => p.date),
      jpyCloses: jpyPairs.slice(-20).map(p => fmt3(p.close)),
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPE 2-C: 금융 스트레스 지수 — FRED API 기반 (OFR FSI 2021년 폐지로 대체)
//    GET /ofr-fsi
//    데이터 소스: FRED API (기존 Worker FRED 프록시 재활용)
//      ① STLFSI4  — St. Louis Fed Financial Stress Index (주간)
//                   전체 시스템 스트레스의 가장 신뢰도 높은 공개 대리 지표
//      ② NFCI     — Chicago Fed National Financial Conditions Index (주간)
//                   자금 조달 포함 전반적 금융여건
//      ③ NFCICREDIT — NFCI Credit Subindex (주간)
//                     신용/자금 조달 스트레스 서브인덱스 (NFCI 구성요소)
//    신호 기준 (3개 동일): > 1.5 위험 / 0~1.5 경계 / < 0 안정
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function ofrFsi(env) {
  const apiKey  = env?.FRED_API_KEY;
  if (!apiKey) return json({ error: 'FRED_API_KEY 환경변수 없음' }, 500);

  const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

  // FRED 시리즈 3개 병렬 fetch (limit=5: 주간 → 최근 5주치)
  const fetchFred = async seriesId => {
    const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}`
      + `&file_type=json&limit=5&sort_order=desc`;
    try {
      const r = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return null;
      const d = await r.json();
      return (d.observations || []).filter(o => o.value !== '.');
    } catch(e) { return null; }
  };

  const [stlObs, nfciObs, creditObs] = await Promise.all([
    fetchFred('STLFSI4'),    // St. Louis Fed FSI (주간)
    fetchFred('NFCI'),       // Chicago Fed NFCI (주간)
    fetchFred('NFCICREDIT'), // NFCI Credit Sub-index (주간)
  ]);

  // 최신값 / 전주 대비 Δ 추출
  const cur  = obs => obs?.length > 0 ? +parseFloat(obs[0].value).toFixed(4) : null;
  const prv  = obs => obs?.length > 1 ? +parseFloat(obs[1].value).toFixed(4) : null;
  const dlt  = (c, p) => (c != null && p != null) ? +(c - p).toFixed(4) : null;
  const asOf = stlObs?.[0]?.date ?? null;

  const stlCur   = cur(stlObs),   stlPrv   = prv(stlObs);
  const nfciCur  = cur(nfciObs),  nfciPrv  = prv(nfciObs);
  const crdtCur  = cur(creditObs),crdtPrv  = prv(creditObs);

  // ── 시리즈별 임계값 판별 ──
  // STLFSI4: 0 = 장기 평균. 양수 = 스트레스 발생
  //   정상: ≤ 0 / 주의: 0~1.0 / 위험: > 1.0
  const sigStl = v => v == null ? 'g' : v > 1.0  ? 'r' : v > 0    ? 'a' : 'g';
  const lblStl = v => sigStl(v) === 'r' ? '위험' : sigStl(v) === 'a' ? '주의' : '정상';

  // NFCI / NFCICREDIT: 양수 = 긴축(위험), 음수 = 완화(정상)
  //   정상: ≤ -0.3 / 주의: -0.3~0 / 위험: > 0
  const sigNfc = v => v == null ? 'g' : v > 0    ? 'r' : v > -0.3  ? 'a' : 'g';
  const lblNfc = v => sigNfc(v) === 'r' ? '위험' : sigNfc(v) === 'a' ? '주의' : '정상';

  // 전체 최악 신호
  const sigPri  = {r:2, a:1, g:0};
  const sigs    = [sigStl(stlCur), sigNfc(nfciCur), sigNfc(crdtCur)];
  const worstSig = sigs.reduce((w, s) => sigPri[s] > sigPri[w] ? s : w, 'g');

  // 입체 해석
  const interpretation =
    (sigStl(stlCur) === 'r' && sigNfc(nfciCur) === 'r') ? 'SYSTEMIC_CRISIS'   // STLFSI4 + NFCI 동시 위험
    : (sigStl(stlCur) === 'r')                          ? 'STL_STRESS'         // 전체 스트레스 단독
    : (sigNfc(nfciCur) === 'r' || sigNfc(crdtCur) === 'r') ? 'FUNDING_STRESS'  // 자금조달/신용 경색
    : (worstSig === 'a')                                ? 'WATCH'
    : 'NORMAL';

  return json({
    source:     'FRED API (STLFSI4 + NFCI + NFCICREDIT) — OFR FSI 2021년 폐지로 대체',
    asOf,
    dataPoints: stlObs?.length ?? 0,
    note:       '주간 발표. STLFSI4: >1.0위험/>0주의/≤0정상 | NFCI/Credit: >0위험/>-0.3주의/≤-0.3정상',
    total: {
      label:   '전체 금융 스트레스 (STLFSI4)',
      current: stlCur,
      deltaWoW: dlt(stlCur, stlPrv),
      signal:  sigStl(stlCur),
      level:   lblStl(stlCur),
    },
    funding: {
      label:   '국가 금융 여건 (NFCI)',
      current: nfciCur,
      deltaWoW: dlt(nfciCur, nfciPrv),
      signal:  sigNfc(nfciCur),
      level:   lblNfc(nfciCur),
    },
    otherAdv: {
      label:   '신용 경색 (NFCI Credit)',
      current: crdtCur,
      deltaWoW: dlt(crdtCur, crdtPrv),
      signal:  sigNfc(crdtCur),
      level:   lblNfc(crdtCur),
    },
    worstSignal: worstSig,
    interpretation,
    recent: { dates: [], total: [], funding: [], otherAdv: [] },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SRF (Standing Repo Facility) 프록시
//    GET /srf
//    NY Fed repo/propositions/search.json → startDate/endDate 자동 계산
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function srfProxy() {
  // 최근 10 영업일 범위 (±14일 여유)
  const now      = new Date();
  const end      = now.toISOString().slice(0, 10);
  const startDt  = new Date(now); startDt.setDate(now.getDate() - 14);
  const start    = startDt.toISOString().slice(0, 10);

  try {
    const url = `https://markets.newyorkfed.org/api/rp/repo/propositions/search.json`
      + `?startDate=${start}&endDate=${end}`;
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 3600 },
    });
    if (!r.ok) return json({ error: `NY Fed SRF ${r.status}`, repo: { operations: [] } });
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch(e) {
    return json({ error: e.message, repo: { operations: [] } });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// fetchKoreaCds 단독 실행 진단 — /cds-live
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function cdsLive() {
  const step = {};
  try {
    const r = await fetch('https://www.worldgovernmentbonds.com/wp-json/cds/v1/main/', {
      method: 'POST',
      headers: {
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Content-Type':     'application/json',
        'Accept':           'application/json, */*',
        'Referer':          'https://www.worldgovernmentbonds.com/cds-historical-data/south-korea/5-years/',
        'Origin':           'https://www.worldgovernmentbonds.com',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        FUNCTION: 'CDS', DOMESTIC: true, DATE_RIF: '2099-12-31',
        OBJ:      { UNIT:'', DECIMAL:2, UNIT_DELTA:'%', DECIMAL_DELTA:2 },
        COUNTRY1: { SYMBOL:'29', PAESE:'29', PAESE_UPPERCASE:'SOUTH KOREA', BANDIERA:'kr', URL_PAGE:'south-korea' },
        COUNTRY2: null,
        OBJ1:     { DURATA_STRING:'5 Years', DURATA:60 },
        OBJ2:     null,
      }),
      cf: { cacheTtl: 0 },
    });

    step.httpStatus  = r.status;
    step.httpOk      = r.ok;
    if (!r.ok) return json({ ...step, result: null, error: 'HTTP not ok' });

    const data = await r.json();
    step.success    = data?.success;
    step.topKeys    = Object.keys(data);
    step.chartLen   = data?.chart?.length ?? 0;
    step.tableLen   = (data?.table ?? '').length;

    if (!data?.success) return json({ ...step, result: null, error: 'success=false' });

    const chart = data.chart ?? '';
    // 정규식 매칭 시도
    const m = chart.match(/"code"\s*:\s*"KR"\s*,\s*"value"\s*:\s*([\d]+\.[\d]+)/);
    step.patternMatched = !!m;
    step.rawMatch       = m?.[0]?.slice(0, 80) ?? null;
    step.extracted      = m ? parseFloat(m[1]) : null;

    // KR 근처 30자 스니펫
    const krIdx = chart.indexOf('"KR"');
    step.krSnippet = krIdx >= 0
      ? chart.slice(Math.max(0, krIdx - 20), krIdx + 100)
      : '(KR 키워드 없음)';

    return json({ ...step, result: step.extracted });
  } catch(e) {
    return json({ ...step, result: null, error: e.message });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WP REST API 파라미터 조합 테스트
//    GET /cds-api-test
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function cdsApiTest() {
  const jsBody = {
    FUNCTION: 'CDS', DOMESTIC: true, DATE_RIF: '2099-12-31',
    OBJ:      { UNIT:'', DECIMAL:2, UNIT_DELTA:'%', DECIMAL_DELTA:2 },
    COUNTRY1: { SYMBOL:'29', PAESE:'29', PAESE_UPPERCASE:'SOUTH KOREA', BANDIERA:'kr', URL_PAGE:'south-korea' },
    COUNTRY2: null,
    OBJ1:     { DURATA_STRING:'5 Years', DURATA:60 },
    OBJ2:     null,
  };
  const HDR = {
    'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Content-Type':     'application/json',
    'Accept':           'application/json, */*',
    'Referer':          'https://www.worldgovernmentbonds.com/cds-historical-data/south-korea/5-years/',
    'Origin':           'https://www.worldgovernmentbonds.com',
    'X-Requested-With': 'XMLHttpRequest',
  };
  const BASE = 'https://www.worldgovernmentbonds.com';

  // jsGlobalVars 전체 구조로 cds/v1/main 호출 — 응답 전체 구조 분석
  const r = await fetch(`${BASE}/wp-json/cds/v1/main/`, {
    method: 'POST', headers: HDR, body: JSON.stringify(jsBody), cf: { cacheTtl: 0 },
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch(e) {}

  // 최상위 키 목록
  const topKeys = parsed ? Object.keys(parsed) : [];

  // chart 제외한 모든 필드 값 추출
  const nonChartFields = {};
  if (parsed) {
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'chart') continue; // chart HTML 제외
      nonChartFields[k] = typeof v === 'string' && v.length > 200
        ? v.slice(0, 300) + '...'
        : v;
    }
  }

  // chart HTML 내 숫자 탐색 (20~200 범위 소수점)
  const chartHtml = parsed?.chart ?? '';
  const numRe = /(?:>|"|,|\s)((?:2[0-9]|[3-9]\d|1[0-9]\d)\.\d{1,2})(?:<|"|,|\s)/g;
  const numsInChart = [];
  let nm;
  while ((nm = numRe.exec(chartHtml)) !== null && numsInChart.length < 20) {
    const ctx = chartHtml.slice(Math.max(0, nm.index - 60), nm.index + 60)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    numsInChart.push({ val: parseFloat(nm[1]), ctx });
  }

  // result 필드가 있으면 그 안의 모든 키
  const resultFields = parsed?.result ? parsed.result : null;

  return json({
    status: r.status, bodyLen: text.length,
    topKeys,           // ← 최상위 JSON 키 목록
    nonChartFields,    // ← chart 제외한 모든 필드
    resultFields,      // ← result 객체 내용
    numsInChart,       // ← chart HTML 안의 숫자 목록
    chartLen: chartHtml.length,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDS HTML 원본 확인
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//    GET /cds-raw?url=historical|country
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function cdsRaw(reqUrl) {
  const which = reqUrl.searchParams.get('url') || 'historical';
  const TARGET = which === 'historical'
    ? 'https://www.worldgovernmentbonds.com/cds-historical-data/south-korea/5-years/'
    : 'https://www.worldgovernmentbonds.com/country/south-korea/';

  try {
    const r = await fetch(TARGET, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.google.com/',
      },
      cf: { cacheTtl: 0 },
    });

    const text  = await r.text();
    const total = text.length;

    // ① "basis points" 근처 텍스트
    const bpMatches = [];
    const bpRe = /basis\s+points/gi;
    let bm;
    while ((bm = bpRe.exec(text)) !== null) {
      const ctx = text.slice(Math.max(0, bm.index - 200), bm.index + 50);
      bpMatches.push(ctx.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    }

    // ② script 태그 중 CDS/korea 관련 내용
    const scriptMatches = [];
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = scriptRe.exec(text)) !== null) {
      const c = sm[1];
      if (/cds|south.?korea|sovereign/i.test(c) ||
          /(?:^|[^.\d])(2[0-9]|[3-9]\d|1[0-9]\d)\.\d{1,2}/m.test(c)) {
        scriptMatches.push(c.slice(0, 600));
      }
    }

    // ③ 25~60 범위 숫자 직접 탐색 (한국 CDS 예상 범위)
    const directRe = /(?:>|\s|,|")((?:2[5-9]|[3-5]\d)\.\d{1,2})(?:<|\s|,|"|bp)/g;
    const directNums = [];
    let dm;
    while ((dm = directRe.exec(text)) !== null && directNums.length < 20) {
      const ctx = text.slice(Math.max(0, dm.index-100), dm.index+80);
      directNums.push({ val: parseFloat(dm[1]), ctx: ctx.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() });
    }

    // ④ API URL 탐지 (동적 로딩 여부 확인)
    const apiUrls = [];
    const apiRe = /["']([^"']*(?:cds|korea|bond|api|data|json)[^"']{0,100})["']/gi;
    let am;
    while ((am = apiRe.exec(text)) !== null && apiUrls.length < 15) {
      apiUrls.push(am[1]);
    }

    // ⑤ 본문 텍스트만 추출 (body 내 p/div/span 텍스트)
    const bodyText = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                         .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ')
                         .slice(0, 3000);

    return json({ url: TARGET, status: r.status, totalLen: total,
      bpContexts: bpMatches, directNums, scriptDataSnippets: scriptMatches,
      apiUrls, bodyText });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDS 스크래핑 디버그
//    GET /cds-debug
//    여러 소스·User-Agent·정규식 조합을 한 번에 시도하여
//    어떤 방법이 실제로 동작하는지 확인용
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function cdsDebug() {
  const UA_LIST = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  ];

  const SOURCES = [
    {
      name: 'cds-historical-data/south-korea/5-years/ (신규)',
      url:  'https://www.worldgovernmentbonds.com/cds-historical-data/south-korea/5-years/',
    },
    {
      name: 'country/south-korea/ (기존)',
      url:  'https://www.worldgovernmentbonds.com/country/south-korea/',
    },
  ];

  // 정규식 패턴 — 좌측부터 더 정확한 패턴 우선
  const PATTERNS = [
    // ── 본문 서술문 (최우선 — historical-data 페이지) ──
    { label: '[★] stands at XX.XX basis points',
      re: /stands\s+at\s+([\d]+\.[\d]+)\s+basis\s+points/i },
    { label: '[★] CDS value stands at',
      re: /CDS\s+value\s+stands\s+at\s+([\d]+\.?[\d]*)/i },
    // ── historical-data 페이지 전용 패턴 ──
    { label: '[H] 테이블 첫 번째 행 숫자',
      re: /<tr[^>]*>[\s\S]{0,100}?<td[^>]*>([\d]{2,4}\.?\d*)\s*<\/td>/i },
    { label: '[H] data-value 속성',
      re: /data-value="([\d]{2,4}\.?\d*)"/i },
    { label: '[H] CDS Current 숫자',
      re: /current[\s\S]{0,100}?([\d]{2,4}\.?\d*)\s*(?:bp|<)/i },
    // ── country 페이지 전용 패턴 ──
    { label: '[C] 5 Years CDS 행 다음 td',
      re: /5\s*Years\s*CDS[\s\S]{0,500}?<td[^>]*>\s*([\d]{2,4}\.?\d*)\s*<\/td>/i },
    { label: '[C] CDS.*5.*Years 테이블 셀',
      re: /CDS[\s\S]{0,50}?5[\s\S]{0,50}?Years[\s\S]{0,300}?<td[^>]*>\s*([\d]{2,4}\.?\d*)/i },
    { label: '[C] cdsValue span',
      re: /cdsValue[^>]*>([\d]{2,4}\.?\d*)/i },
    { label: '[C] class.*cds.*숫자',
      re: /class="[^"]*cds[^"]*"[^>]*>\s*([\d]{2,4}\.?\d*)/i },
    // ── 공통 보조 패턴 ──
    { label: '[공통] 30~100 사이 단독 숫자 (유효 CDS 범위)',
      re: />\s*((?:[3-9]\d|[1-9]\d{2})\.?\d*)\s*(?:<|bp)/g,
      multi: true },
  ];

  const results = [];

  for (const src of SOURCES) {
    for (let uIdx = 0; uIdx < UA_LIST.length; uIdx++) {
      const ua = UA_LIST[uIdx];
      const entry = {
        source: src.name, uaIndex: uIdx,
        uaShort: ua.slice(0, 60) + '...',
        status: null, bodyLen: null, isBot: null,
        // 여러 스니펫 반환 (CDS 키워드 주변 5곳)
        snippets: [],
        matches: {},
      };

      try {
        const r = await fetch(src.url, {
          headers: {
            'User-Agent':      ua,
            'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control':   'no-cache',
            'Referer':         'https://www.google.com/',
          },
          cf: { cacheTtl: 0 },
        });
        entry.status  = r.status;
        const text    = await r.text();
        entry.bodyLen = text.length;
        entry.isBot   = text.toLowerCase().includes('captcha')
          || text.toLowerCase().includes('cf-error')
          || (text.toLowerCase().includes('cloudflare') && text.length < 5000);

        // CDS 키워드 위치 5곳 스니펫 수집
        const kw = /cds|credit.default/gi;
        let m;
        let count = 0;
        while ((m = kw.exec(text)) !== null && count < 5) {
          const start = Math.max(0, m.index - 60);
          const end   = Math.min(text.length, m.index + 300);
          const raw   = text.slice(start, end);
          entry.snippets.push(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
          count++;
        }
        if (!entry.snippets.length) {
          entry.snippets.push(text.slice(0, 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        }

        // 패턴 시도
        for (const pat of PATTERNS) {
          if (pat.multi) {
            // g 플래그 패턴 — 유효 범위 숫자 전체 수집
            const re = new RegExp(pat.re.source, pat.re.flags);
            const vals = [];
            let gm;
            while ((gm = re.exec(text)) !== null && vals.length < 10) {
              vals.push(parseFloat(gm[1]));
            }
            entry.matches[pat.label] = vals.length
              ? { raw: vals.join(', '), val: vals[0], allVals: vals }
              : null;
          } else {
            const gm = text.match(pat.re);
            if (gm) {
              const v = parseFloat(gm[1]);
              // 유효 CDS 범위 필터: 10bp~500bp
              entry.matches[pat.label] = (v >= 10 && v <= 500)
                ? { raw: gm[0].slice(0, 80), val: v }
                : { raw: gm[0].slice(0, 80), val: v, oob: true }; // oob=out of range
            } else {
              entry.matches[pat.label] = null;
            }
          }
        }

      } catch(e) {
        entry.status  = 'FETCH_ERROR';
        entry.snippets = [e.message];
      }

      results.push(entry);
      // 200 + 봇아님 이면 다음 UA 불필요
      if (entry.status === 200 && !entry.isBot) break;
    }
  }

  // 유효 범위(10~500bp) 내 값 추출 우선
  const best = results.find(r =>
    r.status === 200 && !r.isBot &&
    Object.values(r.matches).some(v => v && !v.oob)
  );
  const bestMatch = best
    ? Object.values(best.matches).find(v => v && !v.oob)
    : null;
  const extracted = bestMatch?.val ?? null;

  return json({ extracted, best: best?.source ?? null, results });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 국채 금리 3년 시계열 — Treasury Yield Ensemble
//    GET /yields-hist
//    DGS2/5/10/30 일간 3년치 → 날짜 정렬 후 반환
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function yieldsHistory(env) {
  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) return json({ error: 'FRED_API_KEY 없음' }, 500);

  const fredSeries = async (id) => {
    try {
      const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&limit=1000&sort_order=desc&observation_start=${threeYearsAgo()}`;
      const r = await fetch(u, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return {};
      const d = await r.json();
      const map = {};
      (d.observations || [])
        .filter(o => o.value !== '.')
        .forEach(o => { map[o.date] = parseFloat(o.value); });
      return map;
    } catch(e) { return {}; }
  };

  function threeYearsAgo() {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    return d.toISOString().slice(0, 10);
  }

  // 4개 시리즈 병렬 fetch
  const [m2, m5, m10, m30] = await Promise.all([
    fredSeries('DGS2'),
    fredSeries('DGS5'),
    fredSeries('DGS10'),
    fredSeries('DGS30'),
  ]);

  // DGS10 날짜를 앵커로 정렬 (가장 완전한 시리즈)
  const labels = Object.keys(m10).sort();

  return json({
    labels,
    dgs2:  labels.map(d => m2[d]  ?? null),
    dgs5:  labels.map(d => m5[d]  ?? null),
    dgs10: labels.map(d => m10[d] ?? null),
    dgs30: labels.map(d => m30[d] ?? null),
    count: labels.length,
    asOf:  new Date().toISOString().slice(0, 10),
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유동성 & 시장 탭 — FRED 통합 데이터
//    GET /liq
//    16개 FRED 시리즈 병렬 호출 후 구조화 JSON 반환
//    금리·스프레드·물가·MMF·예금 포함
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function liqDataEndpoint(env) {
  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) return json({ error: 'FRED_API_KEY 없음' }, 500);

  // FRED 관측치 배열 fetch 헬퍼 (. 결측 필터링)
  const fredArr = async (id, limit) => {
    try {
      const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&limit=${limit}&sort_order=desc`;
      const r = await fetch(u, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.observations || [])
        .filter(o => o.value !== '.')
        .map(o => ({ date: o.date, value: parseFloat(o.value), released: o.realtime_start ?? null }));
    } catch(e) { return []; }
  };

  // 병렬 fetch — 23개 시리즈
  const [
    mmfR, mmfI, bankDep,               // 유동성 흐름
    dgs2, dgs5, dgs10, dgs30,          // 국채 수익률 (일별)
    sp2_10, sp3m_10,                   // 스프레드 5년 히스토리
    cpi, coreCpi, ppi, pce,            // 물가 지수 15개월
    corePce, wages,                    // Core PCE + 임금 (CES0500000003)
    mich, bei10, t5y5y, tips10,        // 기대인플레이션 + 실질금리
    rrpSeries, sofrVolSeries,          // Repo Regime Matrix
    walclSeries, tregenSeries,         // Net Liquidity Momentum
  ] = await Promise.all([
    fredArr('WRMFNS',          12),  // 소매 MMF 주간
    fredArr('WRMFSL',          12),  // 기관 MMF 주간
    fredArr('DPSACBW027SBOG',  12),  // 상업은행 총 예금 주간
    fredArr('DGS2',            30),  // 30일치 → 20영업일 전(1M ago) 확보
    fredArr('DGS5',            30),
    fredArr('DGS10',           30),
    fredArr('DGS30',           30),
    fredArr('T10Y2Y',        1300),  // 2s10s 스프레드 5년치 (스파크라인용)
    fredArr('T10Y3M',        1300),  // 3m10y 스프레드 5년치
    fredArr('CPIAUCSL',        15),  // CPI 월별 (prevYoY 위해 15개)
    fredArr('CPILFESL',        15),  // Core CPI
    fredArr('PPIACO',          15),  // PPI
    fredArr('PCEPI',           15),  // PCE
    fredArr('PCEPILFE',        15),  // Core PCE (연준 공식 목표 지표)
    fredArr('CES0500000003',   15),  // 시간당 평균 임금 (민간 전체, 현행 시리즈)
    fredArr('MICH',             3),  // 미시간 1Y 기대인플레이션
    fredArr('T10YIE',          25),  // BEI 10Y — 25일치 (1M Δ 계산용)
    fredArr('T5YIFR',          25),  // 5Y5Y Forward — 25일치
    fredArr('DFII10',           3),  // TIPS 10Y 실질금리
    fredArr('RRPONTSYD',       30),  // ON RRP 잔고 일별 (NLM + Regime 공용, 30일치)
    fredArr('SOFRVOL',         10),  // SOFR 거래량 일별 ($B)
    fredArr('WALCL',            8),  // 연준 총자산 주간 (Millions → /1000 = $B)
    fredArr('WTREGEN',          8),  // 재무부 TGA 주간 ($B)
  ]);

  // ── MMF 합산 (날짜 매칭) ──
  const mmfMap = {};
  mmfR.forEach(d => { mmfMap[d.date] = { date: d.date, retail: d.value }; });
  mmfI.forEach(d => {
    if (mmfMap[d.date]) mmfMap[d.date].inst = d.value;
    else mmfMap[d.date] = { date: d.date, inst: d.value };
  });
  const mmfSeries = Object.values(mmfMap)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 12)
    .map(d => ({ ...d, total: (d.retail ?? 0) + (d.inst ?? 0) }));

  // ── 단순 요약 헬퍼 ──
  const cur  = a => a[0]?.value ?? null;
  const prv  = a => a[1]?.value ?? null;
  const dt   = a => cur(a) != null && prv(a) != null ? +(cur(a) - prv(a)).toFixed(4) : null;
  const asOf = a => a[0]?.date ?? null;
  const summ = (a, decPct=false) => ({
    current: cur(a), prev: prv(a), delta: dt(a), asOf: asOf(a),
    // 1개월 Δ: 20영업일 전 (일별 시리즈) — bp 단위 (* 100)
    delta1m: (a[0]?.value != null && a[20]?.value != null)
      ? +((a[0].value - a[20].value) * 100).toFixed(1) : null,
    ago1m: a[20]?.value ?? null,
    // YoY: 12개월 전 대비 (index 기반)
    yoy: (a[0]?.value != null && a[12]?.value != null && a[12].value > 0)
      ? +((a[0].value - a[12].value) / a[12].value * 100).toFixed(2)
      : null,
  });

  // ── Net Liquidity Momentum 계산 ──
  // WALCL: Millions → $B (÷1000), WTREGEN: $B, RRPONTSYD: $B
  // WALCL 날짜를 앵커로, 해당 날짜 이전 가장 가까운 RRPONTSYD 값 매칭
  const nlTimeSeries = [];
  for (let i = 0; i < Math.min(walclSeries.length, tregenSeries.length, 6); i++) {
    const walclEntry  = walclSeries[i];
    const tregenEntry = tregenSeries[i];
    if (!walclEntry || !tregenEntry) break;

    const walclB  = walclEntry.value / 1000;   // Millions → Billions
    const tregenB = tregenEntry.value / 1000;  // Millions → Billions (WTREGEN도 $M 단위)

    // WALCL 날짜(수요일) 이전/당일 RRPONTSYD 중 가장 최신값 매칭
    const anchorDate = walclEntry.date;
    const matchedRrp = rrpSeries.find(r => r.date <= anchorDate);
    const rrpB = matchedRrp?.value ?? null;

    if (walclB != null && tregenB != null && rrpB != null) {
      nlTimeSeries.push({
        date:   anchorDate,
        walcl:  +walclB.toFixed(2),
        tga:    +tregenB.toFixed(2),
        rrp:    +rrpB.toFixed(2),
        nl:     +(walclB - tregenB - rrpB).toFixed(2),
      });
    }
  }

  // 현재 NL + 4주 평균 + Momentum Score
  const nlCurrent = nlTimeSeries[0]?.nl ?? null;
  const nl4wAvg   = nlTimeSeries.length >= 5
    ? +(nlTimeSeries.slice(1, 5).reduce((s, d) => s + d.nl, 0) / 4).toFixed(2)
    : null;
  const nlScore   = (nlCurrent != null && nl4wAvg != null && Math.abs(nl4wAvg) > 1)
    ? +((nlCurrent - nl4wAvg) / Math.abs(nl4wAvg) * 100).toFixed(2)
    : null;
  const nlRegime  = nlScore == null ? null : nlScore > 0 ? 'risk_on' : 'risk_off';

  // ── Repo Regime Matrix 계산 ──
  // 각 시리즈 독립적으로 결측 제거 후 5영업일 Δ 계산
  // (날짜 불일치 가능 → asOf를 각각 별도 명시)
  const rrpDelta5d     = rrpSeries.length >= 5
    ? +(rrpSeries[0].value - rrpSeries[4].value).toFixed(2) : null;
  const sofrVolDelta5d = sofrVolSeries.length >= 5
    ? +(sofrVolSeries[0].value - sofrVolSeries[4].value).toFixed(2) : null;

  // 국면 판별 (서버사이드)
  let regime = null;
  if (rrpDelta5d != null) {
    if (rrpDelta5d > 0) {
      regime = 'contraction';   // 🔴 유동성 파킹
    } else if (sofrVolDelta5d != null && sofrVolDelta5d > 0) {
      regime = 'expansion';     // 🟢 정상 유입
    } else {
      regime = 'divergence';    // 🟡 분산 및 대기
    }
  }

    // 국채 수익률 — ago1m: 20영업일 전 값 (1개월 전 곡선 오버레이용)
    const yieldSumm = (a) => ({
      current: cur(a), prev: prv(a), delta: dt(a), asOf: asOf(a),
      ago1m:     a[19]?.value ?? null,   // 20번째 = 약 20영업일 전
      ago1mDate: a[19]?.date  ?? null,
    });
    // YoY 계산 헬퍼 (월간 지표: index 0=최신, index 12=1년 전)
    const yoy = (arr) => {
      const cur    = arr[0]?.value  ?? null;
      const yr     = arr[12]?.value ?? null;
      const prev   = arr[1]?.value  ?? null;
      const yrPrev = arr[13]?.value ?? null;
      const curYoY  = (cur  != null && yr     != null && yr     > 0) ? +((cur  - yr)     / yr     * 100).toFixed(2) : null;
      const prevYoY = (prev != null && yrPrev != null && yrPrev > 0) ? +((prev - yrPrev) / yrPrev * 100).toFixed(2) : null;
      return { current: cur, prev, curYoY, prevYoY, asOf: arr[0]?.date ?? null, released: arr[0]?.released ?? null };
    };

    return json({
    asOf: new Date().toISOString().slice(0, 10),
    // 유동성 흐름
    mmf: {
      series: mmfSeries,
      retail: summ(mmfR), inst: summ(mmfI),
      total: {
        current: (cur(mmfR) ?? 0) + (cur(mmfI) ?? 0) || null,
        prev:    (prv(mmfR) ?? 0) + (prv(mmfI) ?? 0) || null,
        delta:   (dt(mmfR) ?? 0) + (dt(mmfI) ?? 0) || null,
        asOf:    asOf(mmfR),
      },
    },
    bankDeposits: { series: bankDep, ...summ(bankDep) },
    // Net Liquidity Momentum
    nlMomentum: {
      currentNL:  nlCurrent,
      avg4wNL:    nl4wAvg,
      score:      nlScore,
      regime:     nlRegime,
      walcl:      nlTimeSeries[0]?.walcl  ?? null,
      tga:        nlTimeSeries[0]?.tga    ?? null,
      rrp:        nlTimeSeries[0]?.rrp    ?? null,
      series:     nlTimeSeries,
      asOf:       nlTimeSeries[0]?.date   ?? null,
    },
    // Repo Regime Matrix
    repoRegime: {
      regime,
      rrpDelta5d,
      sofrVolDelta5d,
      rrpCurrent:     rrpSeries[0]?.value    ?? null,
      sofrVolCurrent: sofrVolSeries[0]?.value ?? null,
      rrpAsOf:        rrpSeries[0]?.date     ?? null,
      sofrVolAsOf:    sofrVolSeries[0]?.date ?? null,
    },
    // 국채 수익률 (ago1m 포함)
    yields: {
      dgs2:  yieldSumm(dgs2),
      dgs5:  yieldSumm(dgs5),
      dgs10: yieldSumm(dgs10),
      dgs30: yieldSumm(dgs30),
    },
    // 스프레드 (역전 판단용 전체 히스토리 포함)
    spreads: {
      s2_10:  { ...summ(sp2_10),  history: sp2_10 },
      s3m_10: { ...summ(sp3m_10), history: sp3m_10 },
    },
    // 물가 & 실질금리
    inflation: {
      cpi:     yoy(cpi),
      coreCpi: yoy(coreCpi),
      ppi:     yoy(ppi),
      pce:     yoy(pce),
      corePce: yoy(corePce),
      wages:   yoy(wages),
      mich:    summ(mich),
      bei10:   summ(bei10),
      t5y5y:   summ(t5y5y),
      tips10:  summ(tips10),
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PIPE 3: 신용·실물 리스크
//    GET /pipe3
//    4개 지표 병렬 수집:
//    ① SLOOS (DRTSCILM)           — 은행 대출태도, 실물 자금 밸브 (분기)
//    ② IG OAS (BAMLC0A0CM)        — 우량 신용 스프레드, CRE 리스크 메인 (일별)
//    ③ CRE 연체율 (DRCRELEXFACBS) — 실제 부실 확인 보조 지표 (분기)
//    ④ CCC HY (BAMLH0A3HYC)       — 좀비기업 꼬리 리스크 (일별)
//    ⑤ 한국 CDS 스크래핑 (Track1) → EM HY (BAMLEMHBHYCRPIOAS) 백업 (Track2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function pipe3CreditRisk(env, ctx) {
  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) return json({ error: 'FRED_API_KEY 없음' }, 500);

  // ── FRED 공통 fetch 헬퍼 ──
  const fetchFred = async (seriesId, limit = 2) => {
    const url = `https://api.stlouisfed.org/fred/series/observations`
      + `?series_id=${seriesId}&api_key=${apiKey}&file_type=json`
      + `&limit=${limit}&sort_order=desc`;
    try {
      const r = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return null;
      const d = await r.json();
      const obs = (d.observations || []).filter(o => o.value !== '.');
      if (!obs.length) return null;
      const cur  = +parseFloat(obs[0].value).toFixed(4);
      const prev = obs.length > 1 ? +parseFloat(obs[1].value).toFixed(4) : null;
      return { current: cur, prev, delta: prev != null ? +(cur - prev).toFixed(4) : null, asOf: obs[0].date };
    } catch(e) { return null; }
  };

  // ── 한국 CDS 스크래핑 (Track 1) ──
  const fetchKoreaCds = async () => {
    try {
      // CDS 전용 엔드포인트: POST /wp-json/cds/v1/main
      // 응답: { success:true, chart: "...{\"code\":\"KR\",\"value\":33.10,...}..." }
      const r = await fetch('https://www.worldgovernmentbonds.com/wp-json/cds/v1/main/', {
        method: 'POST',
        headers: {
          'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Content-Type':     'application/json',
          'Accept':           'application/json, */*',
          'Referer':          'https://www.worldgovernmentbonds.com/cds-historical-data/south-korea/5-years/',
          'Origin':           'https://www.worldgovernmentbonds.com',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          FUNCTION: 'CDS', DOMESTIC: true, DATE_RIF: '2099-12-31',
          OBJ:      { UNIT:'', DECIMAL:2, UNIT_DELTA:'%', DECIMAL_DELTA:2 },
          COUNTRY1: { SYMBOL:'29', PAESE:'29', PAESE_UPPERCASE:'SOUTH KOREA', BANDIERA:'kr', URL_PAGE:'south-korea' },
          COUNTRY2: null,
          OBJ1:     { DURATA_STRING:'5 Years', DURATA:60 },
          OBJ2:     null,
        }),
        cf: { cacheTtl: 3600 },
      });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.success) return null;

      // chart HTML 안의 지도 데이터에서 KR(한국) 값 추출
      // 패턴: {"code":"KR","value":33.10,...}
      const chart = data.chart ?? '';
      const m = chart.match(/"code"\s*:\s*"KR"\s*,\s*"value"\s*:\s*([\d]+\.[\d]+)/);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return (v >= 10 && v <= 500) ? v : null;
    } catch(e) { return null; }
  };

  // 5개 병렬 실행
  const [sloos, igOas, creDelin, cccHy, emHy, koreaCds] = await Promise.all([
    fetchFred('DRTSCILM',          2),  // ① SLOOS (분기)
    fetchFred('BAMLC0A0CM',        2),  // ② IG OAS (일별)
    fetchFred('DRCRELEXFACBS',     2),  // ③ CRE 연체율 (분기)
    fetchFred('BAMLH0A3HYC',       2),  // ④ CCC HY (일별)
    fetchFred('BAMLEMHBHYCRPIOAS', 2),  // ⑤ EM HY 백업 (일별)
    fetchKoreaCds(),                    // ⑤ 한국 CDS Track1
  ]);

  // 한국 CDS: Track1 성공 시 사용, 실패 시 Track2(EM HY) 사용
  const sovereignTrack  = koreaCds != null ? 1 : 2;
  const sovereignVal    = koreaCds ?? emHy?.current ?? null;

  return json({
    source:   'FRED API + worldgovernmentbonds.com (CDS 스크래핑)',
    asOf:     new Date().toISOString().slice(0, 10),
    // ① SLOOS
    sloos: sloos ? { ...sloos, label: '실물 자금 밸브 (SLOOS · DRTSCILM)', freq: '분기' } : null,
    // ② IG OAS (메인 신호) + CRE 연체율 (보조)
    igOas: igOas ? { ...igOas, label: 'IG 회사채 OAS (BAMLC0A0CM)', freq: '일별' } : null,
    creDelinquency: creDelin ? { ...creDelin, label: 'CRE 대출 연체율 (DRCRELEXFACBS)', freq: '분기', unit: '%' } : null,
    // ③ CCC HY
    cccHy: cccHy ? { ...cccHy, label: 'CCC 이하 HY OAS (BAMLH0A3HYC)', freq: '일별' } : null,
    // ④ Sovereign
    sovereign: {
      track:   sovereignTrack,          // 1 = 한국 CDS, 2 = EM HY 백업
      value:   sovereignVal,
      koreaCds,                         // null이면 스크래핑 실패
      emHy:    emHy ?? null,
      label:   sovereignTrack === 1
        ? '한국 5Y CDS (worldgovernmentbonds.com)'
        : 'EM HY OAS 백업 (BAMLEMHBHYCRPIOAS)',
      unit:    sovereignTrack === 1 ? 'bp' : '%',
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유동성 관제탑 — 통합 데이터 (H.4.1 + FRED + QRA + Auctions)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function liqTowerCached(env, force = false, ctx) {
  if (!force) {
    const cached = await kvGet(env, KV_KEYS.liqTower);
    if (cached) return json(cached);
  }
  const data = await fetchLiqTowerData(env);
  const putPromise = kvPut(env, KV_KEYS.liqTower, data, KV_TTL.liqTower);
  if (ctx?.waitUntil) ctx.waitUntil(putPromise); else await putPromise;
  return json(data);
}

async function refreshLiqTower(env) {
  try {
    const data = await fetchLiqTowerData(env);
    await kvPut(env, KV_KEYS.liqTower, data, KV_TTL.liqTower);
  } catch(e) { console.error('refreshLiqTower:', e.message); }
}

async function fetchLiqTowerData(env) {
  const apiKey = env?.FRED_API_KEY;

  const fredVal = async (id) => {
    if (!apiKey) return null;
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=10`;
      const r = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return null;
      const d = await r.json();
      const obs = (d.observations || []).filter(o => o.value !== '.');
      return obs.length ? { value: parseFloat(obs[0].value), date: obs[0].date } : null;
    } catch(e) { return null; }
  };

  const fredSeries = async (id, limit = 52) => {
    if (!apiKey) return [];
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
      const r = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!r.ok) return [];
      const d = await r.json();
      return (d.observations || []).filter(o => o.value !== '.').map(o => ({
        date: o.date, value: parseFloat(o.value),
      })).reverse();
    } catch(e) { return []; }
  };

  const auctionsFetch = async () => {
    const BASE = 'https://www.treasurydirect.gov/TA_WS/securities';
    const hdrs = { 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0' };

    // JSONP 파싱 헬퍼: "jQuery123([{...}])" → [{...}]
    const parseJsonp = (text) => {
      const m = text.match(/\((\[[\s\S]*\])\)/);
      if (!m) return [];
      try { return JSON.parse(m[1]); } catch(e) { return []; }
    };

    const fetchJsonp = async (endpoint, type) => {
      const url = `${BASE}/${endpoint}?format=jsonp&limitByTerm=true&type=${type}&callback=cb`;
      try {
        const r = await fetch(url, { headers: hdrs });
        if (!r.ok) return [];
        return parseJsonp(await r.text());
      } catch(e) { return []; }
    };

    // upcoming: Bill, Note, Bond 병렬 fetch
    const [bills, notes, bonds] = await Promise.all([
      fetchJsonp('upcoming', 'Bill'),
      fetchJsonp('upcoming', 'Note'),
      fetchJsonp('upcoming', 'Bond'),
    ]);

    const all = [...bills, ...notes, ...bonds];
    return all.slice(0, 30).map(a => ({
      type:        a.securityType,
      term:        a.securityTerm,
      auctionDate: a.auctionDate?.slice(0, 10),
      issueDate:   a.issueDate?.slice(0, 10),
      offeringAmt: parseFloat(a.offeringAmount) || 0,
      cusip:       a.cusip,
    })).sort((a, b) => (a.issueDate || '').localeCompare(b.issueDate || ''));
  };

  const [walcl, rrp, rrpSeries, tga, walclSeries, auctions, qraActive] = await Promise.all([
    fredVal('WALCL'),
    fredVal('RRPONTSYD'),
    fredSeries('RRPONTSYD', 52),
    fredVal('WTREGEN'),
    fredSeries('WALCL', 15),
    auctionsFetch(),
    kvGet(env, KV_KEYS.qraActive),
  ]);

  // RRP 기반 T-Bill 동적 가중치
  const rrpBn = rrp?.value ?? 0;
  let billWeight, billWeightLabel;
  if (rrpBn > 500)      { billWeight = 0.2; billWeightLabel = '0.2 (충분한 RRP 완충)'; }
  else if (rrpBn > 100) { billWeight = 0.5; billWeightLabel = '0.5 (마찰적 흡수 시작)'; }
  else                  { billWeight = 1.0; billWeightLabel = '1.0 (RRP 소진, 장기채 동등 충격)'; }

  const vampire4w = buildVampireModel(auctions, rrpBn, billWeight, qraActive);

  // H.4.1 ForTower (KPI카드 + 부채구조 + WALCL 이상징후)
  const h41Tower = await fetchH41ForTower(env);

  return {
    _savedAt: new Date().toISOString(),
    fed: {
      walcl:       walcl,
      rrp:         rrp,
      rrpSeries:   rrpSeries.slice(-26),
      walclSeries: walclSeries,
      h41:         h41Tower,
    },
    auctions,
    vampire: {
      billWeight,
      billWeightLabel,
      rrpBn,
      weeks: vampire4w,
    },
    qraActive,
  };
}

// ── H.4.1 관제탑용 KPI + 부채구조 + WALCL 이상징후 ─────────
async function fetchH41ForTower(env) {
  const apiKey = env?.FRED_API_KEY;
  if (!apiKey) return null;

  const IDS_STD = {
    TOTRESNS:  { key: 'reserve_balances',  unitM: false },
    RRPONTSYD: { key: 'rrp',              unitM: false },
    WTREGEN:   { key: 'tga',              unitM: true  },
    WDTGAL:    { key: 'other_draining',   unitM: true  },
    WLCFLL:    { key: 'currency_in_circ_unused', unitM: true }, // 미사용, fed_notes_net 대체
  };

  const fetchFredObs = async (id, limit, unitM) => {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&limit=${limit}&sort_order=desc`;
      const r = await fetch(url, { cf: { cacheTtl: 21600 } });
      if (!r.ok) return null;
      const d = await r.json();
      const obs = (d.observations||[]).filter(o => o.value !== '.');
      if (!obs.length) return null;
      const scale = unitM ? 1000 : 1;
      return obs.map(o => ({ date: o.date, value: +(parseFloat(o.value)/scale).toFixed(1) }));
    } catch(e) { return null; }
  };

  const toKv = (obs) => {
    if (!obs?.length) return null;
    const cur  = obs[0].value;
    const prev = obs[1]?.value ?? null;
    return { cur, prev, delta: prev != null ? +(cur-prev).toFixed(1) : null, date: obs[0].date };
  };

  const [stdResults, walclObs, h41HtmlResult] = await Promise.all([
    Promise.all(Object.entries(IDS_STD).map(async ([id, {key, unitM}]) =>
      [key, toKv(await fetchFredObs(id, 3, unitM))]
    )),
    fetchFredObs('WALCL', 15, true),
    fetchH41HtmlData(),
  ]);

  const kv = Object.fromEntries(stdResults.filter(([,v]) => v));

  // WALCL 13주 국면 인식
  let walcl_anomaly = { status:'NORMAL', regime:'QT', avg_13w_delta:null, threshold:10, walcl_delta:null, loans_delta:null, walcl_cur:null, loans_cur:null };
  if (walclObs && walclObs.length >= 2) {
    const deltas = [];
    for (let i = 0; i < Math.min(13, walclObs.length-1); i++)
      deltas.push(+(walclObs[i].value - walclObs[i+1].value).toFixed(1));
    const walcl_delta   = deltas[0] ?? 0;
    const avg_13w_delta = deltas.length ? +(deltas.reduce((a,b)=>a+b,0)/deltas.length).toFixed(1) : 0;
    const regime    = avg_13w_delta < 0 ? 'QT' : 'QE';
    const threshold = regime === 'QT' ? 10 : +(avg_13w_delta+20).toFixed(1);
    const loans_delta = h41HtmlResult?.loans?.delta ?? 0;
    const loans_cur   = h41HtmlResult?.loans?.cur   ?? null;
    let status = 'NORMAL';
    if (loans_delta > 2 || walcl_delta > threshold)  status = 'SPIKE_WARNING';
    else if (walcl_delta > 0 && regime === 'QT')     status = 'WATCH';
    walcl_anomaly = { status, regime, avg_13w_delta, threshold, walcl_delta, walcl_cur: walclObs[0].value, loans_delta, loans_cur };
  }

  kv.total_assets = toKv(walclObs);

  const res   = kv.reserve_balances?.cur ?? 0;
  const rrpV  = kv.rrp?.cur              ?? 0;
  const tgaV  = kv.tga?.cur             ?? 0;
  const curr  = h41HtmlResult?.currency  ?? 0;
  const otherV= kv.other_draining?.cur   ?? 0;
  const totL  = +(res + rrpV + tgaV + curr + otherV).toFixed(1);
  const bufCur = +(res + rrpV).toFixed(1);
  const bufPrev = (kv.reserve_balances?.prev!=null && kv.rrp?.prev!=null)
    ? +(kv.reserve_balances.prev + kv.rrp.prev).toFixed(1) : null;

  return {
    ...kv,
    loans: h41HtmlResult?.loans ?? null,
    buffer: { cur: bufCur, prev: bufPrev, delta: bufPrev!=null ? +(bufCur-bufPrev).toFixed(1):null },
    liabilities: { res, rrp: rrpV, tga: tgaV, curr, other: otherV, total: totL },
    data_date: h41HtmlResult?.loans?.date ?? kv.reserve_balances?.date ?? null,
    walcl_anomaly,
    maturity: h41HtmlResult?.maturity ?? null,
  };
}

// ── H.4.1 HTML 통합 파싱 (loans + maturity + currency) ─────
async function fetchH41HtmlData() {
  try {
    const fakeUrl = new URL('https://dummy/h41-history?weeks=2');
    const resp = await h41HistoryFetcher(fakeUrl);
    const data = await resp.json();
    const s    = data?.series;
    if (!s) return { loans: null, maturity: null, currency: null };

    const lCur  = s.loans?.[0] ?? null;
    const lPrev = s.loans?.[1] ?? null;
    const loans = lCur != null ? {
      cur: lCur, prev: lPrev,
      delta: lPrev != null ? +(lCur-lPrev).toFixed(1) : null,
      date: s.labels?.[0] ?? null,
    } : null;

    const maturity = (s.treasury_within_15d?.[0] != null) ? {
      treasury_within_15d: s.treasury_within_15d?.[0] ?? null,
      treasury_d16_90d:    s.treasury_d16_90d?.[0]    ?? null,
      treasury_d91_1y:     s.treasury_d91_1y?.[0]     ?? null,
      treasury_y1_5y:      s.treasury_y1_5y?.[0]      ?? null,
      treasury_y5_10y:     s.treasury_y5_10y?.[0]     ?? null,
      treasury_over_10y:   s.treasury_over_10y?.[0]   ?? null,
    } : null;

    const rawCur = data?.raw?.[0];
    const currency = rawCur?.fed_notes_net != null
      ? +(rawCur.fed_notes_net / 1000).toFixed(1) : null;

    return { loans, maturity, currency };
  } catch(e) {
    console.error('[fetchH41HtmlData]', e.message);
    return { loans: null, maturity: null, currency: null };
  }
}

// ── TGA 뱀파이어 4주 추정 모델 ──────────────────────────
function buildVampireModel(auctions, rrpBn, billWeight, qraActive) {
  const now = new Date();
  const weeks = [];

  for (let w = 0; w < 4; w++) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + w * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const wsStr = weekStart.toISOString().slice(0,10);
    const weStr = weekEnd.toISOString().slice(0,10);

    // 해당 주 경매 결제 필터링
    const weekAuctions = auctions.filter(a => {
      const issue = a.issueDate?.slice(0,10);
      return issue >= wsStr && issue <= weStr;
    });

    let couponDrain = 0; // 장기채 (Note/Bond)
    let billAbsorb  = 0; // T-Bill
    const auctionDetail = [];

    for (const a of weekAuctions) {
      const amt = a.offeringAmt / 1e9; // 십억달러
      if (a.type === 'Bill') {
        billAbsorb += amt * billWeight;
        auctionDetail.push({ label: `T-Bill ${a.term}`, amtBn: amt, weighted: amt * billWeight });
      } else {
        couponDrain += amt;
        auctionDetail.push({ label: `${a.type} ${a.term}`, amtBn: amt, weighted: amt });
      }
    }

    // QT 추정 (연준 월 600억 달러 롤오프 → 주당 약 150억)
    const qtDrain = 15; // $15B/week 추정

    // 정부 지출 (월초/월말 추정)
    const dayOfMonth = weekStart.getDate();
    const govOutflow = (dayOfMonth <= 5 || dayOfMonth >= 26) ? -50 : -20; // $B

    const netDrain = couponDrain + billAbsorb + qtDrain + govOutflow;
    const isDangerZone = netDrain > 50; // $50B 임계값

    weeks.push({
      label:    `Week ${w+1}`,
      dateRange: `${wsStr} ~ ${weStr}`,
      netDrain: +netDrain.toFixed(1),
      breakdown: {
        couponDrain:  +couponDrain.toFixed(1),
        billAbsorb:   +billAbsorb.toFixed(1),
        qtDrain:      +qtDrain.toFixed(1),
        govOutflow:   +govOutflow.toFixed(1),
      },
      auctionDetail,
      isDangerZone,
    });
  }
  return weeks;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QRA — 상태 / 미리보기 / 적용 / 해제
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function qraStatus(env) {
  const [active, pending] = await Promise.all([
    kvGet(env, KV_KEYS.qraActive),
    kvGet(env, KV_KEYS.qraPending),
  ]);
  return json({ active, pending });
}

async function qraPreview(env) {
  const result = await fetchQraFromGemini(env);
  return json(result);
}

async function qraApply(request, env) {
  try {
    const body = await request.json();
    const data = body.data;
    if (!data?.target_quarter) return json({ error: 'invalid data' }, 400);

    // active에 저장
    await kvPut(env, KV_KEYS.qraActive, {
      ...data,
      applied_at: new Date().toISOString(),
      applied_by: body.auto ? 'auto' : 'user',
    }, KV_TTL.qraActive);

    // pending 해제
    const pending = await kvGet(env, KV_KEYS.qraPending);
    if (pending) {
      await kvPut(env, KV_KEYS.qraPending, { ...pending, status: 'applied' }, KV_TTL.qraPending);
    }

    // liqTower 캐시 무효화 (다음 요청에서 재계산)
    try { await env.MMF_KV.delete(KV_KEYS.liqTower); } catch(e) {}

    return json({ ok: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

async function qraDismiss(env) {
  const pending = await kvGet(env, KV_KEYS.qraPending);
  if (pending) {
    await kvPut(env, KV_KEYS.qraPending,
      { ...pending, status: 'dismissed' }, KV_TTL.qraPending);
  }
  return json({ ok: true });
}

// ── Gemini Google Search Grounding ─────────────────────
async function fetchQraFromGemini(env) {
  const apiKey = env?.GEMINI_API_KEY;
  if (!apiKey) return { error: 'GEMINI_API_KEY not configured' };

  const prompt = `You are a US Treasury document specialist.
Use Google Search to find the most recent Quarterly Refunding Announcement (QRA) from the US Treasury (home.treasury.gov).
Extract the data and return ONLY this JSON, no other text:
{
  "target_quarter": "2026 Q2",
  "net_borrowing_billions": 514,
  "tga_target_balance_billions": 850,
  "announcement_date": "2026-02-05",
  "source_url": "https://home.treasury.gov/news/press-releases/...",
  "pdf_url": "https://home.treasury.gov/system/files/...",
  "evidence_quote": "exact sentence from document with the borrowing number",
  "confidence": "high"
}
Rules: numbers in integer billions USD. pdf_url is null if not found. confidence is "high" if you found exact numbers, "medium" if estimated, "low" if uncertain.`;

  const MAX_RETRIES = 3;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }],
          }),
        }
      );

      // 429 Rate Limit → 지수 백오프 재시도
      if (res.status === 429) {
        const errText = await res.text();
        // 에러 메시지에서 retryDelay 파싱 (예: "12.5s")
        const delayMatch = errText.match(/"retryDelay":\s*"([\d.]+)s"/);
        const retrySec   = delayMatch ? parseFloat(delayMatch[1]) : 0;
        // 지수 백오프: max(응답제안 대기, 2^attempt * 5초), 최대 30초
        const waitMs = Math.min(Math.max(retrySec * 1000, Math.pow(2, attempt) * 5000), 30000);

        console.warn(`[Gemini 429] attempt ${attempt+1}/${MAX_RETRIES}, waiting ${waitMs}ms...`);

        if (attempt < MAX_RETRIES - 1) {
          await sleep(waitMs);
          continue;
        } else {
          return { error: 'Gemini rate limit exceeded (429). 무료 티어 일일 할당량 초과 또는 결제 설정 필요.', status: 429 };
        }
      }

      if (!res.ok) {
        const err = await res.text();
        console.error(`[Gemini] HTTP ${res.status}:`, err.slice(0, 200));
        return { error: `Gemini HTTP ${res.status}`, detail: err.slice(0, 300) };
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const clean = text.replace(/```json|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return { error: 'JSON 파싱 실패', raw: text.slice(0, 300) };
      const parsed = JSON.parse(match[0]);
      return { ...parsed, fetched_at: new Date().toISOString() };

    } catch(e) {
      console.error(`[Gemini] attempt ${attempt+1} error:`, e.message);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(Math.pow(2, attempt) * 3000);
        continue;
      }
      return { error: e.message };
    }
  }
  return { error: '최대 재시도 횟수 초과' };
}

// ── QRA 자동 감지 (Cron 수요일 실행) ──────────────────
async function checkNewQra(env) {
  try {
    const active  = await kvGet(env, KV_KEYS.qraActive);
    const pending = await kvGet(env, KV_KEYS.qraPending);

    // pending 이미 new 상태이면 스킵
    if (pending?.status === 'new') return;

    // 현재 기대 분기
    const expected = getCurrentQuarter();

    // 이미 현재 분기 적용 중이면 스킵
    if (active?.target_quarter === expected) return;

    // Gemini 검색
    const result = await fetchQraFromGemini(env);
    if (result.error) {
      console.error('[QRA CHECK ERROR]', result.error);
      return;
    }

    // 분기가 실제로 새로운 경우만 처리
    if (result.target_quarter === active?.target_quarter) return;

    if (result.confidence === 'high') {
      // HIGH → 자동 적용 + pending에 기록
      await kvPut(env, KV_KEYS.qraActive, {
        ...result,
        applied_at: new Date().toISOString(),
        applied_by: 'auto',
      }, KV_TTL.qraActive);
      await kvPut(env, KV_KEYS.qraPending, {
        status: 'auto_applied',
        detected_at: new Date().toISOString(),
        data: result,
      }, KV_TTL.qraPending);
      // liqTower 캐시 무효화
      try { await env.MMF_KV.delete(KV_KEYS.liqTower); } catch(e) {}
      console.log('[QRA AUTO APPLIED]', result.target_quarter);
    } else {
      // MEDIUM/LOW → pending 저장, 사용자 검토 요청
      await kvPut(env, KV_KEYS.qraPending, {
        status: 'new',
        detected_at: new Date().toISOString(),
        data: result,
      }, KV_TTL.qraPending);
      console.log('[QRA PENDING]', result.target_quarter, result.confidence);
    }
  } catch(e) {
    console.error('[checkNewQra ERROR]', e.message);
  }
}

function getCurrentQuarter() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const year  = now.getUTCFullYear();
  const q     = Math.ceil(month / 3);
  return `${year} Q${q}`;
}


// ── 경매 디버그 (/auction-debug) ─────────────────────────
async function auctionDebug() {
  const hdrs = { 'Accept': 'application/json' };
  const results = {};

  // 1. announced (현재 사용 중)
  try {
    const r = await fetch('https://www.treasurydirect.gov/TA_WS/securities/announced?format=json&type=Bill,Note,Bond&pagesize=20', { headers: hdrs });
    results.announced_status = r.status;
    const d = await r.json();
    results.announced_type   = Array.isArray(d) ? 'array' : typeof d;
    results.announced_length = Array.isArray(d) ? d.length : Object.keys(d||{}).length;
    results.announced_sample = Array.isArray(d) ? d.slice(0,2) : d;
  } catch(e) { results.announced_error = e.message; }

  // 2. upcoming
  try {
    const r = await fetch('https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json&type=Bill,Note,Bond&pagesize=20', { headers: hdrs });
    results.upcoming_status = r.status;
    const d = await r.json();
    results.upcoming_type   = Array.isArray(d) ? 'array' : typeof d;
    results.upcoming_length = Array.isArray(d) ? d.length : Object.keys(d||{}).length;
    results.upcoming_sample = Array.isArray(d) ? d.slice(0,2) : d;
  } catch(e) { results.upcoming_error = e.message; }

  // 3. auctioned (최근 완료)
  try {
    const r = await fetch('https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type=Bill,Note,Bond&pagesize=5', { headers: hdrs });
    results.auctioned_status = r.status;
    const d = await r.json();
    results.auctioned_length = Array.isArray(d) ? d.length : '?';
    results.auctioned_sample = Array.isArray(d) ? d.slice(0,1) : d;
  } catch(e) { results.auctioned_error = e.message; }

  return json(results);
}

// ── 경매 HTML 파싱 테스트 (/auction-html-debug) ──────────
async function auctionHtmlDebug() {
  const results = {};

  // 1. 웹페이지 HTML 직접 fetch
  try {
    const r = await fetch('https://www.treasurydirect.gov/auctions/upcoming/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    results.html_status = r.status;
    if (r.ok) {
      const html = await r.text();
      results.html_length = html.length;
      results.html_sample = html.slice(0, 500);

      // JSON 데이터 임베드 탐지
      const jsonMatch = html.match(/window\.__[A-Z_]+\s*=\s*(\{[\s\S]{0,2000})/);
      const apiMatch  = html.match(/["'](https?:\/\/[^"']*(?:auction|security|upcoming)[^"']*json[^"']*)['"]/gi);

      results.embedded_json = jsonMatch ? jsonMatch[1].slice(0,300) : null;
      results.api_urls_found = apiMatch ? apiMatch.slice(0,5) : [];
    }
  } catch(e) { results.html_error = e.message; }

  // 2. TA_WS search 엔드포인트 (다른 형식)
  try {
    const r = await fetch('https://www.treasurydirect.gov/TA_WS/securities/search?format=json&type=Bill&dateFieldName=auctionDate&startDate=2026-03-01&endDate=2026-04-30', {
      headers: { 'Accept': 'application/json' },
    });
    results.search_status = r.status;
    if (r.ok) {
      const d = await r.json();
      results.search_length = Array.isArray(d) ? d.length : 'not array';
      results.search_sample = Array.isArray(d) ? d.slice(0,1) : d;
    }
  } catch(e) { results.search_error = e.message; }

  return json(results);
}
