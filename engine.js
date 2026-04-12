import { uuid, showToast } from './utils.js';

// 清理队列中包含指定选手的所有比赛
function removeMatchesWithPlayer(division, playerId) {
    division.matchQueue = division.matchQueue.filter(m => m.p1 !== playerId && m.p2 !== playerId);
}

export function initDoubleElimination(division) {
    if (!division.players.length) return false;
    let players = [...division.players];
    for (let i = players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [players[i], players[j]] = [players[j], players[i]];
    }
    division.winners = players.map(p => p.id);
    division.losers = [];
    division.matchQueue = [];
    division.finalsData = null;
    division.matchHistory = [];
    division.history = [];
    division.eliminatedOrder = [];
    division.players.forEach(p => { p.losses = 0; p.rank = null; p.displayRank = null; });
    generateMatchesForGroup(division, 'winners');
    return true;
}

function generateMatchesForGroup(division, group) {
    let players = group === 'winners' ? [...division.winners] : [...division.losers];
    // 过滤掉已淘汰的（防御）
    players = players.filter(pid => {
        const p = division.players.find(p => p.id === pid);
        return p && p.losses < 2;
    });
    if (players.length < 2) return;
    // 随机打乱
    for (let i = players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [players[i], players[j]] = [players[j], players[i]];
    }
    // 轮空处理
    if (players.length % 2 === 1) {
        const bye = players.pop();
        if (group === 'winners') {
            division.winners = [bye, ...division.winners.filter(id => id !== bye)];
        } else {
            division.losers = [bye, ...division.losers.filter(id => id !== bye)];
        }
        const playerName = division.players.find(p => p.id === bye)?.name || '?';
        showToast(`${playerName} 轮空晋级`, false);
    }
    const matches = [];
    for (let i = 0; i < players.length; i += 2) {
        matches.push({
            id: uuid(),
            p1: players[i],
            p2: players[i+1],
            group: group,
            winner: null,
            loser: null
        });
    }
    division.matchQueue.push(...matches);
}

export function processMatchResult(division, match, winnerId, loserId) {
    match.winner = winnerId;
    match.loser = loserId;
    const winner = division.players.find(p => p.id === winnerId);
    const loser = division.players.find(p => p.id === loserId);
    division.matchHistory.unshift({
        timestamp: new Date().toLocaleString(),
        winner: winner.name,
        loser: loser.name,
        group: match.group === 'winners' ? '胜者组' : '败者组',
        winnerId, loserId
    });

    if (match.group === 'winners') {
        loser.losses = (loser.losses || 0) + 1;
        division.winners = division.winners.filter(id => id !== loserId);
        division.losers.push(loserId);
    } else {
        loser.losses = (loser.losses || 0) + 1;
        division.losers = division.losers.filter(id => id !== loserId);
        if (loser.losses >= 2) {
            division.eliminatedOrder.push(loserId);
            // 关键修复：淘汰选手后，从待比赛队列中移除所有包含该选手的比赛
            removeMatchesWithPlayer(division, loserId);
        }
    }

    // 基于当前活跃选手（未淘汰）生成下一轮比赛
    const activeWinners = division.winners.filter(pid => {
        const p = division.players.find(p => p.id === pid);
        return p && p.losses < 2;
    });
    const activeLosers = division.losers.filter(pid => {
        const p = division.players.find(p => p.id === pid);
        return p && p.losses < 2;
    });

    if (activeWinners.length >= 2 && !division.matchQueue.some(m => m.group === 'winners')) {
        generateMatchesForGroup(division, 'winners');
    }
    if (activeLosers.length >= 2 && !division.matchQueue.some(m => m.group === 'losers')) {
        generateMatchesForGroup(division, 'losers');
    }

    return checkAndStartFinals(division);
}

function checkAndStartFinals(division) {
    if (division.finalsData) return false;
    const activeWinners = division.winners.filter(pid => {
        const p = division.players.find(p => p.id === pid);
        return p && p.losses < 2;
    });
    const activeLosers = division.losers.filter(pid => {
        const p = division.players.find(p => p.id === pid);
        return p && p.losses < 2;
    });
    if (activeWinners.length === 1 && activeLosers.length === 1) {
        const finalistW = division.players.find(p => p.id === activeWinners[0]);
        const finalistL = division.players.find(p => p.id === activeLosers[0]);
        division.finalsData = {
            p1Id: finalistW.id, p1Name: finalistW.name,
            p2Id: finalistL.id, p2Name: finalistL.name,
            score1: 0, score2: 0
        };
        division.matchQueue = [];
        division.tables.forEach(t => { t.match = null; });
        return true;
    }
    return false;
}