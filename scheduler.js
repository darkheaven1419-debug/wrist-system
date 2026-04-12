// scheduler.js
/**
 * 获取当前所有桌子上的活跃选手ID集合
 * @param {Object} division - 当前级别对象
 * @returns {Set<string>} 活跃选手ID集合
 */
export function getActivePlayers(division) {
    const active = new Set();
    if (!division.tables) return active;
    division.tables.forEach(t => {
        if (t.match) {
            active.add(t.match.p1);
            active.add(t.match.p2);
        }
    });
    return active;
}

/**
 * 从待比赛队列中获取下一场不冲突的比赛
 * 冲突条件：比赛的任一选手已在其他桌子上进行中
 * @param {Object} division - 当前级别对象
 * @returns {Object|null} 下一场比赛对象，若无则返回null
 */
export function getNextMatch(division) {
    const active = getActivePlayers(division);
    for (let i = 0; i < division.matchQueue.length; i++) {
        const m = division.matchQueue[i];
        if (!active.has(m.p1) && !active.has(m.p2)) {
            // 从队列中移除并返回
            division.matchQueue.splice(i, 1);
            return m;
        }
    }
    return null;
}

/**
 * 为所有空闲的桌子自动填充下一场比赛
 * @param {Object} division - 当前级别对象
 */
export function fillIdleTables(division) {
    // 总决赛期间不自动填充桌子
    if (division.finalsData) return;
    
    if (!division.tables) return;
    division.tables.forEach(table => {
        if (!table.match) {
            const next = getNextMatch(division);
            if (next) {
                table.match = next;
            }
        }
    });
}