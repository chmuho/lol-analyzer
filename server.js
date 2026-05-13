const express = require('express');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = 3000;
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

app.get('/api/home-meta', (req, res) => {
  const patch = patchVersionLabel();
  res.json({
    ddragonVersion: DDRAGON_VERSION,
    patch,
    patchUrl: `https://www.leagueoflegends.com/ko-kr/news/tags/patch-notes/`,
    cards: [
      { type: 'neutral', title: `최신 데이터 ${patch}`, text: `Data Dragon ${DDRAGON_VERSION} 기준으로 챔피언/아이콘 정보를 불러왔습니다.` },
      { type: 'up', title: '챔피언 데이터 자동 갱신', text: '새 챔피언이나 이름 변경이 있으면 서버 시작 시 최신 목록을 다시 가져옵니다.' },
      { type: 'neutral', title: '패치노트 바로가기', text: '세부 버프/너프는 Riot 공식 패치노트에서 최신 내용을 확인할 수 있습니다.' },
      { type: 'down', title: '통계 연동 준비', text: '승률 급상승/밴율 변화는 별도 통계 데이터 소스를 붙이면 자동화됩니다.' }
    ]
  });
});

app.get('/api/champions', (req, res) => {
  res.json({
    ddragonVersion: DDRAGON_VERSION,
    champions: championList
  });
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
  NONE: '기타',
  '': '기타'
};

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
    tier: rank.tier,
    rank: rank.rank,
    leaguePoints: rank.leaguePoints,
    wins: rank.wins,
    losses: rank.losses,
    winRate: totalGames ? Math.round((rank.wins / totalGames) * 100) : 0
  };
}

function rankPower(rank) {
  return TIER_SCORE[rank?.tier] || 0;
}

function buildThreat(rank, championId, mostChampion) {
  const reasons = [];
  let score = rankPower(rank) * 10;
  const totalRankGames = (rank?.wins || 0) + (rank?.losses || 0);

  if (rank?.winRate >= 58 && totalRankGames >= 20) {
    score += 18;
    reasons.push('승률 높음');
  } else if (rank?.winRate <= 45 && totalRankGames >= 20) {
    score -= 10;
    reasons.push('승률 낮음');
  }

  if (mostChampion && mostChampion.championId === championId) {
    score += 18;
    reasons.push('모스트 픽');
  }

  if ((mostChampion?.points || 0) >= 500000) {
    score += 10;
    reasons.push('숙련도 높음');
  }

  if (rank?.tier === 'UNRANKED') {
    reasons.push('랭크 정보 없음');
  }

  if (score >= 88) return { label: '위험', level: 'danger', score, reasons };
  if (score >= 58) return { label: '주의', level: 'warn', score, reasons };
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
  const mainPickCount = players.filter(p => p.threat?.reasons?.includes('모스트 픽')).length;
  const highMasteryCount = players.filter(p => (p.mostChampion?.points || 0) >= 500000).length;
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

    const positionKey = game.position || 'NONE';
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
        name: '비공개/조회 불가',
        tag: '',
        nameStatus: p.bot ? 'private' : 'missing-puuid',
        nameReason: p.bot ? '봇 또는 익명 처리된 참가자입니다.' : '참가자 식별값을 받지 못했습니다.',
        champion: getChampion(p.championId),
        rank,
        mostChampion: null,
        threat: buildThreat(rank, p.championId, null)
      };
    }

    const spectatorRiotId = getSpectatorRiotId(p);
    const [account, rankEntries, mastery] = await Promise.all([
      cachedHttpsGet('asia.api.riotgames.com', `/riot/account/v1/accounts/by-puuid/${p.puuid}`, apiKey).catch(() => null),
      cachedHttpsGet('kr.api.riotgames.com', `/lol/league/v4/entries/by-puuid/${p.puuid}`, apiKey).catch(() => []),
      cachedHttpsGet('kr.api.riotgames.com', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/top?count=1`, apiKey).catch(() => [])
    ]);

    const topMastery = mastery[0];
    const mostChampion = topMastery ? {
      ...getChampion(topMastery.championId),
      championId: topMastery.championId,
      level: topMastery.championLevel,
      points: topMastery.championPoints
    } : null;
    const rank = pickRank(rankEntries);

    return {
      teamId: p.teamId,
      name: account?.gameName || spectatorRiotId?.gameName || '비공개/조회 불가',
      tag: account?.tagLine || spectatorRiotId?.tagLine || '',
      nameStatus: account || spectatorRiotId ? 'ok' : 'unavailable',
      nameReason: account ? '' : spectatorRiotId ? 'Spectator 데이터의 Riot ID를 사용했습니다.' : 'Riot ID 조회에 실패했습니다.',
      champion: getChampion(p.championId),
      rank,
      mostChampion,
      threat: buildThreat(rank, p.championId, mostChampion)
    };
  }));

  let bluePlayers = participants.filter(p => p.teamId === 100);
  let redPlayers = participants.filter(p => p.teamId === 200);

  const blueTeam = summarizeTeam(100, '블루팀', bluePlayers.slice(0, 5));
  const redTeam = summarizeTeam(200, '레드팀', redPlayers.slice(0, 5));
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
    const rank = await cachedHttpsGet('kr.api.riotgames.com', `/lol/league/v4/entries/by-puuid/${account.puuid}`, apiKey).catch(() => []);

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
          position: p.individualPosition || p.teamPosition || 'NONE',
          k: p.kills,
          d: p.deaths,
          a: p.assists
        } : null;
      } catch (e) {
        return null;
      }
    }));

    let currentGame = null;
    try {
      const game = await httpsGet('kr.api.riotgames.com', `/lol/spectator/v5/active-games/by-summoner/${account.puuid}`, apiKey);
      currentGame = await buildCurrentGameAnalysis(game, apiKey);
    } catch (e) {
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
