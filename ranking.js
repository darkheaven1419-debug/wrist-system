export function recalcFinalRanks(division) {
    // 只在决赛结束后（冠军和亚军已产生）时才计算奖牌
    const champion = division.players.find(p => p.rank === 1);
    const runnerUp = division.players.find(p => p.rank === 2);
    if (!champion || !runnerUp) return; // 未结束，不显示金银铜

    const eliminated = [...division.eliminatedOrder];
    let rank = 3;
    for (let i = eliminated.length - 1; i >= 0; i--) {
        const pid = eliminated[i];
        const player = division.players.find(p => p.id === pid);
        if (player && (!player.rank || player.rank > 2)) {
            player.rank = rank++;
        }
    }
    const sorted = [...division.players].sort((a, b) => {
        if (a.rank && b.rank) return a.rank - b.rank;
        if (a.rank) return -1;
        if (b.rank) return 1;
        return (b.losses || 0) - (a.losses || 0);
    });
    sorted.forEach((p, idx) => { p.displayRank = idx + 1; });
    // 确保冠军亚军 rank 正确
    if (champion) champion.rank = 1;
    if (runnerUp) runnerUp.rank = 2;
}

// 用于实时排名（不显示奖牌，只显示负场）
export function getLiveRanking(division) {
    const players = [...division.players];
    players.sort((a, b) => {
        if (a.losses !== b.losses) return a.losses - b.losses;
        return (a.displayRank || 0) - (b.displayRank || 0);
    });
    return players;
}