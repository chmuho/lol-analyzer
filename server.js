const express = require('express');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = 3000;
const DDRAGON_VERSION = '16.9.1';

app.use(express.static('.'));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Riot-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
          else reject({ status: r.statusCode, data: parsed });
        } catch (e) {
          reject({ status: r.statusCode, error: 'JSON Error' });
        }
      });
    }).on('error', reject);
  });
}

function riotErrorMessage(error) {
  return error?.data?.status?.message || error?.error || error?.message || 'Unknown error';
}

let champData = {};
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

function getChampion(championId) {
  return champData[championId] || { name: '알 수 없음', id: '' };
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
      mostPlayed: null
    };
  }

  const totals = validGames.reduce((acc, game) => {
    acc.wins += game.win ? 1 : 0;
    acc.kills += game.k;
    acc.deaths += game.d;
    acc.assists += game.a;
    const key = game.champ?.id || 'unknown';
    if (!acc.champions[key]) {
      acc.champions[key] = { ...game.champ, games: 0, wins: 0 };
    }
    acc.champions[key].games += 1;
    acc.champions[key].wins += game.win ? 1 : 0;
    return acc;
  }, { wins: 0, kills: 0, deaths: 0, assists: 0, champions: {} });

  const count = validGames.length;
  const mostPlayed = Object.values(totals.champions).sort((a, b) => b.games - a.games || b.wins - a.wins)[0] || null;

  return {
    count,
    wins: totals.wins,
    losses: count - totals.wins,
    winRate: Math.round((totals.wins / count) * 100),
    avgKills: Number((totals.kills / count).toFixed(1)),
    avgDeaths: Number((totals.deaths / count).toFixed(1)),
    avgAssists: Number((totals.assists / count).toFixed(1)),
    avgKda: Number(((totals.kills + totals.assists) / Math.max(totals.deaths, 1)).toFixed(2)),
    mostPlayed
  };
}

async function buildCurrentGameAnalysis(game, apiKey) {
  const participants = await Promise.all(game.participants.map(async (p) => {
    if (p.bot || !p.puuid) {
      const rank = pickRank([]);
      return {
        teamId: p.teamId,
        name: 'Bot',
        tag: '',
        champion: getChampion(p.championId),
        rank,
        mostChampion: null,
        threat: buildThreat(rank, p.championId, null)
      };
    }

    const [account, rankEntries, mastery] = await Promise.all([
      httpsGet('asia.api.riotgames.com', `/riot/account/v1/accounts/by-puuid/${p.puuid}`, apiKey).catch(() => null),
      httpsGet('kr.api.riotgames.com', `/lol/league/v4/entries/by-puuid/${p.puuid}`, apiKey).catch(() => []),
      httpsGet('kr.api.riotgames.com', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/top?count=1`, apiKey).catch(() => [])
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
      name: account?.gameName || '알 수 없음',
      tag: account?.tagLine || '',
      champion: getChampion(p.championId),
      rank,
      mostChampion,
      threat: buildThreat(rank, p.championId, mostChampion)
    };
  }));

  const blueTeam = summarizeTeam(100, '블루팀', participants.filter(p => p.teamId === 100));
  const redTeam = summarizeTeam(200, '레드팀', participants.filter(p => p.teamId === 200));
  const diff = blueTeam.summary.powerScore - redTeam.summary.powerScore;

  return {
    gameMode: game.gameMode,
    gameQueueConfigId: game.gameQueueConfigId,
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

    const account = await httpsGet('asia.api.riotgames.com', `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, apiKey);
    const summoner = await httpsGet('kr.api.riotgames.com', `/lol/summoner/v4/summoners/by-puuid/${account.puuid}`, apiKey);
    const rank = await httpsGet('kr.api.riotgames.com', `/lol/league/v4/entries/by-puuid/${account.puuid}`, apiKey).catch(() => []);

    const mastery = await httpsGet('kr.api.riotgames.com', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}/top?count=3`, apiKey).catch(() => []);
    const mostChampions = mastery.map(m => ({
      name: getChampion(m.championId).name,
      id: getChampion(m.championId).id,
      points: m.championPoints,
      level: m.championLevel
    }));

    const matchIds = await httpsGet('asia.api.riotgames.com', `/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=20`, apiKey).catch(() => []);
    const lastGames = await Promise.all(matchIds.map(async (id) => {
      try {
        const match = await httpsGet('asia.api.riotgames.com', `/lol/match/v5/matches/${id}`, apiKey);
        const p = match.info.participants.find(player => player.puuid === account.puuid);
        return p ? { win: p.win, champ: getChampion(p.championId), k: p.kills, d: p.deaths, a: p.assists } : null;
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
    const status = error?.status === 404 ? 404 : 500;
    res.status(status).json({ error: riotErrorMessage(error) });
  }
});

app.listen(PORT, () => console.log(`서버 실행: http://localhost:${PORT}`));
