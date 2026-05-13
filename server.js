const express = require('express');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
let DDRAGON_VERSION = '16.9.1';
const RECENT_MATCH_COUNT = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

app.use(express.static('.'));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Riot-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const apiCache = new Map();

function cacheKey(hostname, path) {
  return `${hostname}${path}`;
}

function getCached(hostname, path) {
  const cached = apiCache.get(cacheKey(hostname, path));
  if (!cached || cached.expiresAt < Date.now()) return null;
  return cached.value;
}

function setCached(hostname, path, value, ttl = CACHE_TTL_MS) {
  apiCache.set(cacheKey(hostname, path), {
    value,
    expiresAt: Date.now() + ttl
  });
}

function isRateLimit(error) {
  return error?.status === 429 || error?.data?.status?.message === 'rate limit exceeded';
}

function httpsGet(hostname, path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, headers: { 'X-Riot-Token': apiKey } };
    https.get(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (r.statusCode === 200) resolve(parsed);
          else reject({ status: r.statusCode, data: parsed, retryAfter: Number(r.headers['retry-after'] || 0) });
        } catch (e) {
          reject({ status: r.statusCode, error: 'JSON Error' });
        }
      });
    }).on('error', reject);
  });
}

async function cachedHttpsGet(hostname, path, apiKey, ttl = CACHE_TTL_MS) {
  const cached = getCached(hostname, path);
  if (cached) return cached;

  const value = await httpsGet(hostname, path, apiKey);
  setCached(hostname, path, value, ttl);
  return value;
}

function riotErrorMessage(error) {
  return error?.data?.status?.message || error?.error || error?.message || 'Unknown error';
}

let champData = {};
let championList = [];

function publicJsonGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          if (r.statusCode === 200) resolve(JSON.parse(d));
          else reject({ status: r.statusCode });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function publicTextGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
      }
    };

    https.get(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode === 200) resolve(d);
        else reject({ status: r.statusCode, error: `HTTP ${r.statusCode}` });
      });
    }).on('error', reject);
  });
}

async function cachedPublicTextGet(hostname, path, ttl = CACHE_TTL_MS) {
  const cached = getCached(hostname, path);
  if (cached) return cached;
  const value = await publicTextGet(hostname, path);
  setCached(hostname, path, value, ttl);
  return value;
}

function decodeNextPayload(html) {
  return html.replace(/\\"/g, '"').replace(/\\n/g, '').replace(/\\u0026/g, '&');
}

function extractJsonArray(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('[', markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function normalizeChampionKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findChampionByOpggKey(key) {
  const normalized = normalizeChampionKey(key);
  const aliases = {
    monkeyking: 'monkeyking',
    renata: 'renata',
    nunu: 'nunu',
    drmundo: 'drmundo'
  };
  const target = aliases[normalized] || normalized;
  return championList.find(c => normalizeChampionKey(c.id) === target || normalizeChampionKey(c.name) === target);
}

function toInternalPosition(positionName) {
  return {
    TOP: 'TOP',
    JUNGLE: 'JUNGLE',
    MID: 'MIDDLE',
    MIDDLE: 'MIDDLE',
    ADC: 'BOTTOM',
    BOTTOM: 'BOTTOM',
    SUPPORT: 'UTILITY',
    UTILITY: 'UTILITY'
  }[String(positionName || '').toUpperCase()] || 'MIDDLE';
}

function opggTierLabel(item) {
  const rank = Number(item.positionRank || 0);
  const tier = Number(item.positionTier || item.positionTierData?.tier || 4);
  if (tier === 1 && rank <= 3) return 'OP';
  return String(Math.min(Math.max(tier, 1), 5));
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseOpggChampionStats(html) {
  const text = decodeNextPayload(html);
  const json = extractJsonArray(text, '"data":[{"key"');
  if (!json) return [];

  const rows = JSON.parse(json);
  return rows.map(item => {
    const champion = findChampionByOpggKey(item.key);
    if (!champion) return null;
    return {
      key: item.key,
      name: champion.name,
      id: champion.id,
      role: toInternalPosition(item.positionName),
      tier: opggTierLabel(item),
      rank: finiteNumber(item.positionRank, 999),
      winRate: finiteNumber(item.positionWinRate),
      pickRate: finiteNumber(item.positionPickRate),
      banRate: finiteNumber(item.positionBanRate),
      roleRate: finiteNumber(item.positionRoleRate, null),
      counterStats: (item.positionCounters || []).map(counter => {
        const counterChampion = champData[counter.champion_id];
        return {
          name: counterChampion?.name || counter.name,
          winRate: finiteNumber(counter.win_rate ?? counter.winRate ?? counter.positionWinRate ?? counter.win, null)
        };
      }).filter(Boolean),
      counters: (item.positionCounters || []).map(counter => {
        const counterChampion = champData[counter.champion_id];
        return counterChampion?.name || counter.name;
      }).filter(Boolean),
      source: 'OP.GG'
    };
  }).filter(Boolean);
}

function parseOpggRunes(html) {
  const text = decodeNextPayload(html);
  const json = extractJsonArray(text, '"rune_pages"');
  if (!json) return null;
  const runePages = JSON.parse(json);
  const page = runePages?.[0];
  const build = page?.builds?.[0];
  if (!page || !build) return null;

  return {
    source: 'OP.GG',
    pickRate: Number(((page.pick_rate || 0) * 100).toFixed(1)),
    winRate: Number(((page.win_rate || 0) * 100).toFixed(1)),
    play: page.play || 0,
    primary: build.primary_perk_style,
    secondary: build.perk_sub_style,
    keystone: page.primary_rune || build.main_runes?.[0]?.find(r => r.isActive),
    mainRunes: build.main_runes || [],
    subRunes: build.sub_runes || [],
    shards: build.shards || []
  };
}

async function loadDdragonData() {
  try {
    const versions = await publicJsonGet('https://ddragon.leagueoflegends.com/api/versions.json');
    DDRAGON_VERSION = versions[0] || DDRAGON_VERSION;
    const json = await publicJsonGet(`https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/data/ko_KR/champion.json`);
    champData = {};
    championList = Object.values(json.data).map(c => {
      const item = { key: c.key, id: c.id, name: c.name, title: c.title, tags: c.tags || [] };
      champData[c.key] = { name: c.name, id: c.id };
      return item;
    }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  } catch (error) {
    console.error('[ddragon load failed]', error);
  }
}

loadDdragonData();

/*
https.get(`https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/data/ko_KR/champion.json`, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    Object.values(json.data).forEach(c => {
      champData[c.key] = { name: c.name, id: c.id };
    });
  });
}).on('error', error => console.error('[ddragon load failed]', error));
*/

function getChampion(championId) {
  return champData[championId] || { name: '알 수 없음', id: '' };
}

function patchVersionLabel() {
  const parts = DDRAGON_VERSION.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : DDRAGON_VERSION;
}

function compactPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : '-';
}

function homeRoleLabel(role) {
  return POSITION_LABEL[role] || '전체';
}

function homeTierLabel(tier) {
  return tier === 'OP' ? 'OP' : `${tier}티어`;
}

function fallbackHomePayload() {
  const patch = patchVersionLabel();
  return {
    ddragonVersion: DDRAGON_VERSION,
    patch,
    patchUrl: `https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/`,
    metaSource: '최신 데이터 대기중',
    matchupSource: '챔피언 분석 데이터 기반',
    cards: [
      { type: 'neutral', title: `최신 데이터 ${patch}`, text: `Data Dragon ${DDRAGON_VERSION} 기준으로 챔피언/아이콘 정보를 불러왔습니다.` },
      { type: 'up', title: '챔피언 데이터 자동 갱신', text: '새 챔피언이나 이름 변경이 있으면 서버 시작 시 최신 목록을 다시 가져옵니다.' },
      { type: 'neutral', title: '패치노트 바로가기', text: '세부 버프/너프는 Riot 공식 패치노트에서 최신 내용을 확인할 수 있습니다.' },
      { type: 'down', title: '통계 연동 준비', text: '승률 급상승/밴율 변화는 별도 통계 데이터 소스를 붙이면 자동화됩니다.' }
    ],
    metaCards: [],
    matchupCards: [],
    quickCards: [
      { title: '연승/연패 흐름', text: '프로필 옆 배지로 최근 분위기를 바로 확인합니다.' },
      { title: '팀 전력 비교', text: 'LIVE 게임이면 양 팀 평균 승률과 현재 픽 숙련도를 비교합니다.' }
    ],
    spotlightCards: []
  };
}

app.get('/api/home-meta', async (req, res) => {
  const payload = fallbackHomePayload();
  try {
    const path = '/lol/champions?position=all&region=kr&tier=emerald&type=ranked';
    const html = await cachedPublicTextGet('op.gg', path, 15 * 60 * 1000);
    const rows = parseOpggChampionStats(html);
    const rankedRows = rows.filter(row => row?.name);
    const top = [...rankedRows].sort((a, b) => (a.rank || 999) - (b.rank || 999));
    const pick = [...rankedRows].sort((a, b) => (b.pickRate || 0) - (a.pickRate || 0));
    const ban = [...rankedRows].sort((a, b) => (b.banRate || 0) - (a.banRate || 0));
    const win = [...rankedRows].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
    const matchupRows = top.filter(row => row.counters?.length).slice(0, 2);

    if (rankedRows.length) {
      payload.metaSource = 'KR Emerald 공개 통계';
      payload.matchupSource = 'OP.GG 카운터 기반';
      payload.cards = [
        { type: 'neutral', title: `최신 데이터 ${payload.patch}`, text: `챔피언 아이콘은 Data Dragon ${DDRAGON_VERSION}, 메타 요약은 KR Emerald 통계를 사용합니다.` },
        { type: 'up', title: `OP ${top[0]?.name || '-'}`, text: `${homeRoleLabel(top[0]?.role)} ${homeTierLabel(top[0]?.tier)} · 승률 ${compactPercent(top[0]?.winRate)} · 픽률 ${compactPercent(top[0]?.pickRate)}` },
        { type: 'up', title: `픽률 최고 ${pick[0]?.name || '-'}`, text: `${homeRoleLabel(pick[0]?.role)}에서 픽률 ${compactPercent(pick[0]?.pickRate)}로 가장 자주 등장합니다.` },
        { type: 'down', title: `밴률 주의 ${ban[0]?.name || '-'}`, text: `밴률 ${compactPercent(ban[0]?.banRate)} · 상대 조합 확인 가치가 높은 챔피언입니다.` }
      ];
      payload.metaCards = [
        { tag: 'OP 티어', title: `${top[0]?.name || '-'}`, text: `${homeRoleLabel(top[0]?.role)} · ${homeTierLabel(top[0]?.tier)} · 승률 ${compactPercent(top[0]?.winRate)}` },
        { tag: '승률 상위', title: `${win[0]?.name || '-'}`, text: `${homeRoleLabel(win[0]?.role)} · 승률 ${compactPercent(win[0]?.winRate)} · 픽률 ${compactPercent(win[0]?.pickRate)}` },
        { tag: '밴픽 주의', title: `${ban[0]?.name || '-'}`, text: `밴률 ${compactPercent(ban[0]?.banRate)} · 게임 전 카운터 확인 추천` }
      ];
      payload.matchupCards = matchupRows.map(row => ({
        title: `${homeRoleLabel(row.role)}: ${row.name} 상대 주의`,
        text: `자주 불리한 상대로 ${row.counters.slice(0, 3).join(', ')} 목록이 잡힙니다. 챔피언 분석에서 룬과 쉬운 상대를 같이 확인하세요.`
      }));
      payload.quickCards = [
        { title: '인게임 현재 픽 숙련도', text: 'LIVE 게임이면 현재 플레이 중인 챔피언 숙련도로 위험도를 다시 계산합니다.' },
        { title: '챔피언 분석 바로 활용', text: 'KR/Emerald 기준 티어, 룬, 어려운 상대와 쉬운 상대를 한 화면에서 확인합니다.' }
      ];
      payload.spotlightCards = [
        {
          id: top[0]?.id,
          name: top[0]?.name || '-',
          text: `${homeRoleLabel(top[0]?.role)} · ${homeTierLabel(top[0]?.tier)} · OP 지표`,
          stat: compactPercent(top[0]?.winRate)
        },
        {
          id: pick[0]?.id,
          name: pick[0]?.name || '-',
          text: `${homeRoleLabel(pick[0]?.role)} · 픽률 최고`,
          stat: compactPercent(pick[0]?.pickRate)
        },
        {
          id: ban[0]?.id,
          name: ban[0]?.name || '-',
          text: `${homeRoleLabel(ban[0]?.role)} · 밴률 주의`,
          stat: compactPercent(ban[0]?.banRate)
        },
        {
          id: win[0]?.id,
          name: win[0]?.name || '-',
          text: `${homeRoleLabel(win[0]?.role)} · 승률 상위`,
          stat: compactPercent(win[0]?.winRate)
        }
      ];
    }

    res.json(payload);
  } catch (error) {
    res.json(payload);
  }
});

app.get('/api/champions', (req, res) => {
  res.json({
    ddragonVersion: DDRAGON_VERSION,
    champions: championList
  });
});

app.get('/api/champion-meta', async (req, res) => {
  try {
    const region = String(req.query.region || 'global').toLowerCase();
    const tier = String(req.query.tier || 'platinum_plus').toLowerCase();
    const position = String(req.query.position || 'all').toLowerCase();
    const path = `/lol/champions?position=${encodeURIComponent(position)}&region=${encodeURIComponent(region)}&tier=${encodeURIComponent(tier)}&type=ranked`;
    const html = await cachedPublicTextGet('op.gg', path, 15 * 60 * 1000);
    const rows = parseOpggChampionStats(html);
    res.json({
      ddragonVersion: DDRAGON_VERSION,
      source: 'OP.GG public champion stats',
      rows
    });
  } catch (error) {
    res.status(502).json({ error: riotErrorMessage(error), rows: [] });
  }
});

app.get('/api/champion-runes', async (req, res) => {
  try {
    const key = String(req.query.key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const region = String(req.query.region || 'global').toLowerCase();
    const tier = String(req.query.tier || 'platinum_plus').toLowerCase();
    const position = String(req.query.position || 'jungle').toLowerCase();
    if (!key) return res.status(400).json({ error: 'Missing champion key' });

    const path = `/lol/champions/${encodeURIComponent(key)}/build/${encodeURIComponent(position)}?region=${encodeURIComponent(region)}&tier=${encodeURIComponent(tier)}&type=ranked`;
    const html = await cachedPublicTextGet('op.gg', path, 15 * 60 * 1000);
    const runes = parseOpggRunes(html);
    res.json({ source: 'OP.GG public champion build', runes });
  } catch (error) {
    res.status(502).json({ error: riotErrorMessage(error), runes: null });
  }
});

function getSpectatorRiotId(participant) {
  if (participant.riotId) {
    const [gameName, tagLine = ''] = String(participant.riotId).split('#');
    return { gameName, tagLine };
  }

  if (participant.gameName) {
    return { gameName: participant.gameName, tagLine: participant.tagLine || '' };
  }

  return null;
}

const TIER_SCORE = {
  IRON: 1,
  BRONZE: 2,
  SILVER: 3,
  GOLD: 4,
  PLATINUM: 5,
  EMERALD: 6,
  DIAMOND: 7,
  MASTER: 8,
  GRANDMASTER: 9,
  CHALLENGER: 10,
  UNRANKED: 0
};

const POSITION_LABEL = {
  TOP: '탑',
  JUNGLE: '정글',
  MIDDLE: '미드',
  BOTTOM: '원딜',
  UTILITY: '서폿',
  INVALID: '기타',
  NONE: '기타',
  '': '기타'
};

const POSITION_ORDER = {
  TOP: 1,
  JUNGLE: 2,
  MIDDLE: 3,
  BOTTOM: 4,
  UTILITY: 5,
  NONE: 9
};
const POSITION_SEQUENCE = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const CHAMPION_POSITION_HINTS = {
  Thresh: ['UTILITY'],
  Blitzcrank: ['UTILITY'],
  Nautilus: ['UTILITY'],
  Leona: ['UTILITY'],
  Rakan: ['UTILITY'],
  Lulu: ['UTILITY'],
  Nami: ['UTILITY'],
  Yuumi: ['UTILITY'],
  Janna: ['UTILITY'],
  Soraka: ['UTILITY'],
  Milio: ['UTILITY'],
  Braum: ['UTILITY'],
  Alistar: ['UTILITY'],
  Pyke: ['UTILITY'],
  Senna: ['UTILITY', 'BOTTOM'],
  Morgana: ['UTILITY', 'MIDDLE'],
  Karma: ['UTILITY', 'MIDDLE'],
  Seraphine: ['UTILITY', 'BOTTOM', 'MIDDLE'],
  Jhin: ['BOTTOM'],
  Ezreal: ['BOTTOM'],
  Kaisa: ['BOTTOM'],
  Caitlyn: ['BOTTOM'],
  Jinx: ['BOTTOM'],
  Ashe: ['BOTTOM', 'UTILITY'],
  Vayne: ['BOTTOM', 'TOP'],
  Lucian: ['BOTTOM', 'MIDDLE'],
  Draven: ['BOTTOM'],
  Samira: ['BOTTOM'],
  Xayah: ['BOTTOM'],
  Zeri: ['BOTTOM'],
  Sivir: ['BOTTOM'],
  Aphelios: ['BOTTOM'],
  Nilah: ['BOTTOM'],
  LeeSin: ['JUNGLE'],
  Khazix: ['JUNGLE'],
  Rengar: ['JUNGLE'],
  Evelynn: ['JUNGLE'],
  Elise: ['JUNGLE'],
  Nidalee: ['JUNGLE'],
  Graves: ['JUNGLE'],
  Kindred: ['JUNGLE'],
  Viego: ['JUNGLE'],
  MasterYi: ['JUNGLE'],
  Nocturne: ['JUNGLE'],
  Rammus: ['JUNGLE'],
  Sejuani: ['JUNGLE'],
  Zac: ['JUNGLE'],
  Ivern: ['JUNGLE'],
  Lillia: ['JUNGLE'],
  Hecarim: ['JUNGLE'],
  Fiddlesticks: ['JUNGLE'],
  JarvanIV: ['JUNGLE'],
  Vi: ['JUNGLE'],
  XinZhao: ['JUNGLE'],
  Warwick: ['JUNGLE', 'TOP'],
  Gwen: ['TOP', 'JUNGLE'],
  Darius: ['TOP'],
  Garen: ['TOP'],
  Fiora: ['TOP'],
  Camille: ['TOP'],
  Riven: ['TOP'],
  Jax: ['TOP', 'JUNGLE'],
  Renekton: ['TOP'],
  Aatrox: ['TOP'],
  Jayce: ['TOP', 'MIDDLE'],
  Kennen: ['TOP'],
  Ornn: ['TOP'],
  Sion: ['TOP'],
  Malphite: ['TOP'],
  Mordekaiser: ['TOP'],
  Irelia: ['TOP', 'MIDDLE'],
  Akali: ['MIDDLE', 'TOP'],
  Ahri: ['MIDDLE'],
  Zed: ['MIDDLE', 'JUNGLE'],
  Yasuo: ['MIDDLE', 'TOP', 'BOTTOM'],
  Yone: ['MIDDLE', 'TOP'],
  Viktor: ['MIDDLE'],
  Syndra: ['MIDDLE'],
  Orianna: ['MIDDLE'],
  Leblanc: ['MIDDLE'],
  TwistedFate: ['MIDDLE'],
  Ryze: ['MIDDLE', 'TOP'],
  Sylas: ['MIDDLE', 'JUNGLE'],
  Katarina: ['MIDDLE'],
  Fizz: ['MIDDLE'],
  Xerath: ['MIDDLE', 'UTILITY'],
  Hwei: ['MIDDLE', 'UTILITY'],
  Lux: ['MIDDLE', 'UTILITY'],
  Annie: ['MIDDLE'],
  Anivia: ['MIDDLE'],
  Azir: ['MIDDLE']
};

function normalizePosition(position) {
  const key = String(position || 'NONE').toUpperCase();
  return POSITION_LABEL[key] && key !== 'INVALID' ? key : 'NONE';
}

function positionCandidates(player) {
  const championId = player.champion?.id;
  if (CHAMPION_POSITION_HINTS[championId]) return CHAMPION_POSITION_HINTS[championId];
  return POSITION_SEQUENCE;
}

function withFallbackPositions(players) {
  const used = new Set(players.map(p => p.position).filter(position => position && position !== 'NONE'));
  const assigned = players.map(player => ({ ...player }));
  const unresolved = assigned.filter(player => !player.position || player.position === 'NONE');

  unresolved
    .sort((a, b) => positionCandidates(a).length - positionCandidates(b).length)
    .forEach(player => {
      const fallback = positionCandidates(player).find(position => !used.has(position))
        || POSITION_SEQUENCE.find(position => !used.has(position))
        || 'NONE';
      player.position = fallback;
      used.add(fallback);
    });

  return assigned;
}

function pickRank(entries) {
  const solo = entries.find(r => r.queueType === 'RANKED_SOLO_5x5');
  const flex = entries.find(r => r.queueType === 'RANKED_FLEX_SR');
  const rank = solo || flex || entries[0];

  if (!rank) {
    return {
      queueType: 'UNRANKED',
      tier: 'UNRANKED',
      rank: '',
      leaguePoints: 0,
      wins: 0,
      losses: 0,
      winRate: 0
    };
  }

  const totalGames = rank.wins + rank.losses;
  return {
    queueType: rank.queueType,
    leagueId: rank.leagueId,
    leagueName: rank.leagueName,
    leaguePosition: rank.leaguePosition,
    leagueSize: rank.leagueSize,
    tier: rank.tier,
    rank: rank.rank,
    leaguePoints: rank.leaguePoints,
    wins: rank.wins,
    losses: rank.losses,
    winRate: totalGames ? Math.round((rank.wins / totalGames) * 100) : 0
  };
}

async function enrichRanksWithLeaguePosition(entries, apiKey) {
  return Promise.all((entries || []).map(async (entry) => {
    if (!entry.leagueId) return entry;
    try {
      const league = await cachedHttpsGet('kr.api.riotgames.com', `/lol/league/v4/leagues/${entry.leagueId}`, apiKey, 30 * 60 * 1000);
      const order = { I: 4, II: 3, III: 2, IV: 1 };
      const leagueEntries = [...(league.entries || [])].sort((a, b) => {
        if ((b.leaguePoints || 0) !== (a.leaguePoints || 0)) return (b.leaguePoints || 0) - (a.leaguePoints || 0);
        return (b.wins || 0) - (a.wins || 0) || (a.losses || 0) - (b.losses || 0) || (order[b.rank] || 0) - (order[a.rank] || 0);
      });
      const index = leagueEntries.findIndex(item =>
        (entry.puuid && item.puuid === entry.puuid) ||
        (entry.summonerId && item.summonerId === entry.summonerId)
      );
      return {
        ...entry,
        leagueName: league.name,
        leaguePosition: index >= 0 ? index + 1 : null,
        leagueSize: leagueEntries.length || null
      };
    } catch (e) {
      return entry;
    }
  }));
}

function participantPerformanceScore(p) {
  const challenges = p.challenges || {};
  return (
    (p.kills || 0) * 2.4 +
    (p.assists || 0) * 1.35 -
    (p.deaths || 0) * 1.15 +
    (p.totalDamageDealtToChampions || 0) / 950 +
    (p.goldEarned || 0) / 1200 +
    (p.visionScore || 0) * 0.22 +
    (challenges.killParticipation || 0) * 10 +
    (challenges.damagePerMinute || 0) / 120
  );
}

function performanceBadge(match, player) {
  const teamPlayers = (match.info.participants || []).filter(p => p.teamId === player.teamId);
  const sorted = teamPlayers
    .map(p => ({ puuid: p.puuid, score: participantPerformanceScore(p) }))
    .sort((a, b) => b.score - a.score);
  if (sorted[0]?.puuid !== player.puuid) return '';
  return player.win ? 'MVP' : 'ACE';
}

function rankPower(rank) {
  const base = TIER_SCORE[rank?.tier] || 0;
  if (!base || base >= TIER_SCORE.MASTER) return base;
  const divisionBonus = { IV: 0, III: 0.25, II: 0.5, I: 0.75 }[rank?.rank] || 0;
  return base + divisionBonus;
}

function averageTierLabel(score) {
  if (!score) return 'UNRANKED';
  const tiers = [
    ['IRON', 1],
    ['BRONZE', 2],
    ['SILVER', 3],
    ['GOLD', 4],
    ['PLATINUM', 5],
    ['EMERALD', 6],
    ['DIAMOND', 7],
    ['MASTER', 8],
    ['GRANDMASTER', 9],
    ['CHALLENGER', 10]
  ];
  const tierBase = Math.max(1, Math.min(10, Math.floor(score)));
  const tier = tiers.find(item => item[1] === tierBase) || tiers[0];
  if (tierBase >= TIER_SCORE.MASTER) return `${tier[0]} 1`;
  const fraction = Math.max(0, Math.min(0.99, score - tierBase));
  const division = fraction >= 0.75 ? 1 : fraction >= 0.5 ? 2 : fraction >= 0.25 ? 3 : 4;
  return `${tier[0]} ${division}`;
}

function buildThreat(rank, championId, currentChampionMastery) {
  const reasons = [];
  let score = rankPower(rank) * 10;
  const totalRankGames = (rank?.wins || 0) + (rank?.losses || 0);
  const masteryPoints = currentChampionMastery?.points || 0;

  if (rank?.winRate >= 62 && totalRankGames >= 25) {
    score += 24;
    reasons.push('랭크 승률 매우 높음');
  } else if (rank?.winRate >= 56 && totalRankGames >= 20) {
    score += 14;
    reasons.push('랭크 승률 높음');
  } else if (rank?.winRate <= 45 && totalRankGames >= 20) {
    score -= 10;
    reasons.push('랭크 승률 낮음');
  }

  if (currentChampionMastery && currentChampionMastery.championId === championId) {
    if (masteryPoints >= 800000) {
      score += 22;
      reasons.push('현재 픽 장인급 숙련도');
    } else if (masteryPoints >= 300000) {
      score += 15;
      reasons.push('현재 픽 숙련도 높음');
    } else if (masteryPoints >= 100000) {
      score += 8;
      reasons.push('현재 픽 숙련도 있음');
    } else if (masteryPoints > 0) {
      reasons.push('현재 픽 경험 있음');
    }
  }

  if (rank?.tier === 'UNRANKED') {
    reasons.push('랭크 정보 없음');
  }

  if (score >= 105) return { label: '집중 견제', level: 'extreme', score, reasons };
  if (score >= 86) return { label: '위험', level: 'danger', score, reasons };
  if (score >= 68) return { label: '주의', level: 'warn', score, reasons };
  if (score >= 48) return { label: '변수', level: 'steady', score, reasons };
  return { label: '안정', level: 'safe', score, reasons };
}

function summarizeTeam(teamId, name, players) {
  const rankedPlayers = players.filter(p => p.rank?.tier !== 'UNRANKED');
  const avgTierScore = rankedPlayers.length
    ? rankedPlayers.reduce((sum, p) => sum + rankPower(p.rank), 0) / rankedPlayers.length
    : 0;
  const avgWinRate = players.length
    ? Math.round(players.reduce((sum, p) => sum + (p.rank?.winRate || 0), 0) / players.length)
    : 0;
  const mainPickCount = players.filter(p => (p.currentChampionMastery?.points || 0) >= 100000).length;
  const highMasteryCount = players.filter(p => (p.currentChampionMastery?.points || 0) >= 500000).length;
  const threatScore = players.length
    ? Math.round(players.reduce((sum, p) => sum + (p.threat?.score || 0), 0) / players.length)
    : 0;
  const powerScore = Math.round((avgTierScore * 9) + avgWinRate + (mainPickCount * 5) + (highMasteryCount * 3));

  return {
    teamId,
    name,
    players,
    summary: {
      avgTierScore: Number(avgTierScore.toFixed(1)),
      avgTierLabel: averageTierLabel(avgTierScore),
      avgWinRate,
      mainPickCount,
      highMasteryCount,
      threatScore,
      powerScore
    }
  };
}

function countOpeningStreak(games) {
  const validGames = games.filter(Boolean);
  if (!validGames.length) return { type: 'none', count: 0, label: '기록 없음' };

  const firstResult = validGames[0].win;
  const count = validGames.findIndex(g => g.win !== firstResult);
  const streakCount = count === -1 ? validGames.length : count;

  return {
    type: firstResult ? 'win' : 'loss',
    count: streakCount,
    label: `${streakCount}${firstResult ? '연승' : '연패'} 중`
  };
}

function buildRecentSummary(games) {
  const validGames = games.filter(Boolean);

  if (!validGames.length) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgKills: 0,
      avgDeaths: 0,
      avgAssists: 0,
      avgKda: 0,
      mostPlayed: null,
      championStats: [],
      positionStats: [],
      streak: { type: 'none', count: 0, label: '기록 없음' }
    };
  }

  const totals = validGames.reduce((acc, game) => {
    acc.wins += game.win ? 1 : 0;
    acc.kills += game.k;
    acc.deaths += game.d;
    acc.assists += game.a;

    const champKey = game.champ?.id || 'unknown';
    if (!acc.champions[champKey]) {
      acc.champions[champKey] = { ...game.champ, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    }
    acc.champions[champKey].games += 1;
    acc.champions[champKey].wins += game.win ? 1 : 0;
    acc.champions[champKey].kills += game.k;
    acc.champions[champKey].deaths += game.d;
    acc.champions[champKey].assists += game.a;

    const positionKey = normalizePosition(game.position);
    if (!acc.positions[positionKey]) {
      acc.positions[positionKey] = { key: positionKey, label: POSITION_LABEL[positionKey] || positionKey, games: 0, wins: 0 };
    }
    acc.positions[positionKey].games += 1;
    acc.positions[positionKey].wins += game.win ? 1 : 0;

    return acc;
  }, { wins: 0, kills: 0, deaths: 0, assists: 0, champions: {}, positions: {} });

  const count = validGames.length;
  const championStats = Object.values(totals.champions)
    .map(c => ({
      ...c,
      losses: c.games - c.wins,
      winRate: Math.round((c.wins / c.games) * 100),
      avgKda: Number(((c.kills + c.assists) / Math.max(c.deaths, 1)).toFixed(2))
    }))
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate)
    .slice(0, 5);

  const positionStats = Object.values(totals.positions)
    .map(p => ({
      ...p,
      losses: p.games - p.wins,
      winRate: Math.round((p.wins / p.games) * 100),
      pickRate: Math.round((p.games / count) * 100)
    }))
    .sort((a, b) => b.games - a.games);

  return {
    count,
    wins: totals.wins,
    losses: count - totals.wins,
    winRate: Math.round((totals.wins / count) * 100),
    avgKills: Number((totals.kills / count).toFixed(1)),
    avgDeaths: Number((totals.deaths / count).toFixed(1)),
    avgAssists: Number((totals.assists / count).toFixed(1)),
    avgKda: Number(((totals.kills + totals.assists) / Math.max(totals.deaths, 1)).toFixed(2)),
    mostPlayed: championStats[0] || null,
    championStats,
    positionStats,
    streak: countOpeningStreak(validGames)
  };
}

async function buildCurrentGameAnalysis(game, apiKey) {
  const rawParticipants = (game.participants || [])
    .map(p => ({ ...p, teamId: Number(p.teamId) }))
    .filter(p => p.teamId === 100 || p.teamId === 200)
    .filter((p, index, list) => {
      const key = p.puuid || `${p.teamId}-${p.championId}-${p.summonerId || index}`;
      return list.findIndex(item => (item.puuid || `${item.teamId}-${item.championId}-${item.summonerId || index}`) === key) === index;
    });

  const participants = await Promise.all(rawParticipants.map(async (p) => {
    if (p.bot || !p.puuid) {
      const rank = pickRank([]);
      return {
        teamId: p.teamId,
        name: '비공개',
        tag: '',
        nameStatus: p.bot ? 'private' : 'missing-puuid',
        nameReason: p.bot ? '봇 또는 익명 처리된 참가자입니다.' : '참가자 식별값을 받지 못했습니다.',
        champion: getChampion(p.championId),
        position: normalizePosition(p.teamPosition || p.individualPosition || p.position),
        rank,
        mostChampion: null,
        currentChampionMastery: null,
        threat: buildThreat(rank, p.championId, null)
      };
    }

    const spectatorRiotId = getSpectatorRiotId(p);
    const [account, rankEntries, currentMastery] = await Promise.all([
      cachedHttpsGet('asia.api.riotgames.com', `/riot/account/v1/accounts/by-puuid/${p.puuid}`, apiKey).catch(() => null),
      cachedHttpsGet('kr.api.riotgames.com', `/lol/league/v4/entries/by-puuid/${p.puuid}`, apiKey).catch(() => []),
      cachedHttpsGet('kr.api.riotgames.com', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/by-champion/${p.championId}`, apiKey).catch(() => null)
    ]);

    const currentChampionMastery = currentMastery ? {
      ...getChampion(p.championId),
      championId: p.championId,
      level: currentMastery.championLevel || 0,
      points: currentMastery.championPoints || 0
    } : null;
    const rank = pickRank(rankEntries);

    return {
      teamId: p.teamId,
      name: account?.gameName || spectatorRiotId?.gameName || '비공개',
      tag: account?.tagLine || spectatorRiotId?.tagLine || '',
      nameStatus: account || spectatorRiotId ? 'ok' : 'unavailable',
      nameReason: account ? '' : spectatorRiotId ? 'Spectator 데이터의 Riot ID를 사용했습니다.' : 'Riot ID 조회에 실패했습니다.',
      champion: getChampion(p.championId),
      position: normalizePosition(p.teamPosition || p.individualPosition || p.position),
      rank,
      mostChampion: currentChampionMastery,
      currentChampionMastery,
      threat: buildThreat(rank, p.championId, currentChampionMastery)
    };
  }));

  const sortByPosition = (a, b) => (POSITION_ORDER[a.position] || 9) - (POSITION_ORDER[b.position] || 9);
  let bluePlayers = withFallbackPositions(participants.filter(p => p.teamId === 100)).sort(sortByPosition);
  let redPlayers = withFallbackPositions(participants.filter(p => p.teamId === 200)).sort(sortByPosition);

  const blueTeam = summarizeTeam(100, '블루팀', bluePlayers.slice(0, 5));
  const redTeam = summarizeTeam(200, '레드팀', redPlayers.slice(0, 5));
  const allPlayers = [...blueTeam.players, ...redTeam.players];
  const rankedPlayers = allPlayers.filter(p => p.rank?.tier !== 'UNRANKED');
  const avgTierScore = rankedPlayers.length
    ? rankedPlayers.reduce((sum, p) => sum + rankPower(p.rank), 0) / rankedPlayers.length
    : 0;
  const diff = blueTeam.summary.powerScore - redTeam.summary.powerScore;

  return {
    gameMode: game.gameMode,
    gameQueueConfigId: game.gameQueueConfigId,
    debug: {
      rawCount: game.participants?.length || 0,
      filteredCount: rawParticipants.length,
      blueCount: blueTeam.players.length,
      redCount: redTeam.players.length,
      rawTeamIds: [...new Set((game.participants || []).map(p => p.teamId))]
    },
    advantage: {
      teamId: Math.abs(diff) < 8 ? null : diff > 0 ? 100 : 200,
      label: Math.abs(diff) < 8 ? '비슷함' : diff > 0 ? '블루팀 우세' : '레드팀 우세',
      diff: Math.abs(diff)
    },
    summary: {
      avgTierScore: Number(avgTierScore.toFixed(1)),
      avgTierLabel: averageTierLabel(avgTierScore),
      rankedCount: rankedPlayers.length,
      playerCount: allPlayers.length
    },
    teams: [blueTeam, redTeam]
  };
}

app.get('/api/summoner/:name/:tag', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    const tag = decodeURIComponent(req.params.tag).trim();
    const apiKey = process.env.RIOT_API_KEY?.trim();

    if (!apiKey) {
      return res.status(500).json({ error: 'RIOT_API_KEY가 .env에 없습니다.' });
    }

    const account = await cachedHttpsGet('asia.api.riotgames.com', `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, apiKey);
    const summoner = await cachedHttpsGet('kr.api.riotgames.com', `/lol/summoner/v4/summoners/by-puuid/${account.puuid}`, apiKey);
    const rawRank = await cachedHttpsGet('kr.api.riotgames.com', `/lol/league/v4/entries/by-puuid/${account.puuid}`, apiKey).catch(() => []);
    const rank = await enrichRanksWithLeaguePosition(rawRank, apiKey);

    const mastery = await cachedHttpsGet('kr.api.riotgames.com', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}/top?count=5`, apiKey).catch(() => []);
    const mostChampions = mastery.map(m => ({
      name: getChampion(m.championId).name,
      id: getChampion(m.championId).id,
      points: m.championPoints,
      level: m.championLevel
    }));

    const matchIds = await cachedHttpsGet('asia.api.riotgames.com', `/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=${RECENT_MATCH_COUNT}`, apiKey).catch(() => []);
    const lastGames = await Promise.all(matchIds.map(async (id) => {
      try {
        const match = await cachedHttpsGet('asia.api.riotgames.com', `/lol/match/v5/matches/${id}`, apiKey, 30 * 60 * 1000);
        const p = match.info.participants.find(player => player.puuid === account.puuid);
        return p ? {
          win: p.win,
          champ: getChampion(p.championId),
          position: normalizePosition(p.individualPosition || p.teamPosition),
          k: p.kills,
          d: p.deaths,
          a: p.assists,
          badge: performanceBadge(match, p)
        } : null;
      } catch (e) {
        return null;
      }
    }));

    let currentGame = null;
    let currentGameStatus = { ok: false, reason: '' };
    try {
      const game = await httpsGet('kr.api.riotgames.com', `/lol/spectator/v5/active-games/by-summoner/${account.puuid}`, apiKey);
      currentGame = await buildCurrentGameAnalysis(game, apiKey);
      currentGameStatus = { ok: true, reason: '현재 게임 조회 성공' };
    } catch (e) {
      currentGameStatus = {
        ok: false,
        reason: e.status === 404 ? '현재 KR 서버에서 진행 중인 게임을 찾지 못했습니다.' : `관전 API 조회 실패: ${riotErrorMessage(e)}`
      };
      currentGame = null;
    }

    res.json({
      name: account.gameName,
      tag: account.tagLine,
      level: summoner.summonerLevel,
      rank,
      mostChampions,
      lastGames,
      recentSummary: buildRecentSummary(lastGames),
      currentGame,
      currentGameStatus,
      ddragonVersion: DDRAGON_VERSION,
      iconUrl: `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/profileicon/${summoner.profileIconId}.png`
    });
  } catch (error) {
    console.error('[summoner search failed]', error);
    if (isRateLimit(error)) {
      const retryText = error.retryAfter ? ` ${error.retryAfter}초 뒤 다시 시도해주세요.` : ' 잠시 후 다시 시도해주세요.';
      return res.status(429).json({ error: `Riot API 요청 제한에 걸렸습니다.${retryText}` });
    }
    const status = error?.status === 404 ? 404 : 500;
    res.status(status).json({ error: riotErrorMessage(error) });
  }
});

app.listen(PORT, () => console.log(`서버 실행: http://localhost:${PORT}`));
