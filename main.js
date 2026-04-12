import { uuid, deepCopy, showToast, showAlertModal, closeAlertModal, escapeHtml, exportHistory as exportHistoryUtil, exportData as exportDataUtil, importDataPrompt as importDataPromptUtil, getPinyin } from './utils.js';
import { pushHistory, undoLastMatch as undoStore } from './store.js';
import { initDoubleElimination, processMatchResult } from './engine.js';
import { recalcFinalRanks, getLiveRanking } from './ranking.js';
import { getActivePlayers, getNextMatch, fillIdleTables } from './scheduler.js';

// ======================= 全局状态 =======================
let state = {
    tournaments: [],
    currentTournamentId: null,
    currentDivisionId: null,
    view: 'tournaments',
    numTables: 1,               // 初始值，之后完全由自动计算决定
    referees: []                // 全局裁判池
};

let top8Alerted = false;
let manualTableId = null;
let manualSelected = [];

// 默认裁判数据（根据你的要求）
const DEFAULT_REFEREES = [
    { id: 'ref1', name: '张梓桐', canChief: true, restrictions: ['左手75'] },
    { id: 'ref2', name: '杨彦琪', canChief: false, restrictions: [] },
    { id: 'ref3', name: '郁鑫', canChief: true, restrictions: ['无差别'] },
    { id: 'ref4', name: '范宇骁', canChief: true, restrictions: ['无差别'] },
    { id: 'ref5', name: '夏彬熇', canChief: true, restrictions: ['无差别'] },
    { id: 'ref6', name: '李嘉豪', canChief: true, restrictions: ['无差别'] },
    { id: 'ref7', name: '兆乙天', canChief: false, restrictions: ['左手75', '右手75', '右手85', '右手95'] },
    { id: 'ref8', name: '彭彦博', canChief: false, restrictions: ['右手无差别'] },
    { id: 'ref9', name: '王事显', canChief: false, restrictions: ['左手75', '右手75', '右手85'] },
    { id: 'ref10', name: '李泽豪', canChief: false, restrictions: [] },
    { id: 'ref11', name: '秦泽淼', canChief: true, restrictions: ['左手75', '右手75'] }
];

// ======================= 辅助函数 =======================
function getCurrentTournament() { return state.tournaments.find(t => t.id === state.currentTournamentId); }
function getCurrentDivision() {
    const tour = getCurrentTournament();
    return tour ? tour.divisions.find(d => d.id === state.currentDivisionId) : null;
}

function syncTablesForCurrentDivision() {
    const div = getCurrentDivision();
    if (div) {
        while (div.tables.length < state.numTables) {
            div.tables.push({ id: div.tables.length + 1, match: null, lastMatch: null });
        }
        div.tables.length = state.numTables;
        div.tables.forEach((t, i) => { t.id = i + 1; });
    }
}

function save() { 
    localStorage.setItem('wristPower_final', JSON.stringify(state)); 
}

function load() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset') === '1') {
        localStorage.removeItem('wristPower_final');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    const raw = localStorage.getItem('wristPower_final');
    if (raw) {
        state = JSON.parse(raw);
        // 兼容旧数据
        if (!state.numTables) state.numTables = 1;
        if (!state.view) state.view = 'tournaments';
        if (!state.referees || state.referees.length === 0) state.referees = DEFAULT_REFEREES;
        state.tournaments.forEach(t => {
            t.divisions.forEach(div => {
                if (!div.players) div.players = [];
                if (!div.winners) div.winners = [];
                if (!div.losers) div.losers = [];
                if (!div.matchQueue) div.matchQueue = [];
                if (!div.tables) div.tables = [];
                if (!div.finalsData) div.finalsData = null;
                if (!div.history) div.history = [];
                if (!div.matchHistory) div.matchHistory = [];
                if (!div.eliminatedOrder) div.eliminatedOrder = [];
                if (!div.refereeAssignments) div.refereeAssignments = [];
                div.players.forEach(p => { if (!p.pinyin) p.pinyin = getPinyin(p.name); });
                div.tables.forEach(tb => { if (tb.lastMatch === undefined) tb.lastMatch = null; });
            });
        });
    } else {
        const defaultTournament = { id: uuid(), name: '2025 腕力锦标赛', divisions: [] };
        state.tournaments = [defaultTournament];
        state.currentTournamentId = defaultTournament.id;
        state.view = 'tournaments';
        state.referees = DEFAULT_REFEREES;
    }
    syncTablesForCurrentDivision();
    updateBackButton();
}

function updateBackButton() {
    const btn = document.getElementById('back-button');
    if (btn) {
        if (state.view === 'tournaments') btn.classList.add('hidden');
        else btn.classList.remove('hidden');
    }
}

function getProgress(div) {
    if (!div.players.length) return 0;
    const totalMatches = 2 * div.players.length - 1;
    const completed = div.matchHistory ? div.matchHistory.length : 0;
    return totalMatches > 0 ? Math.min(100, Math.floor((completed / totalMatches) * 100)) : 0;
}

// ======================= 自动调整桌子数（核心新功能） =======================
function autoAdjustTables(division) {
    const aliveCount = division.players.filter(p => p.losses < 2).length;
    let targetTables = 1;
    if (aliveCount > 16) targetTables = 3;
    else if (aliveCount > 8) targetTables = 2;
    
    if (state.numTables !== targetTables) {
        // 如果桌子减少，把多出桌子上的比赛放回队列
        if (targetTables < state.numTables) {
            for (let i = targetTables; i < division.tables.length; i++) {
                if (division.tables[i].match) {
                    division.matchQueue.unshift(division.tables[i].match);
                    division.tables[i].match = null;
                }
            }
        }
        state.numTables = targetTables;
        syncTablesForCurrentDivision();
        fillIdleTables(division);
        // 自动分配裁判（如果已有分配规则）
        if (division.refereeAssignments?.length) {
            autoAssignRefereesForDivision(division);
        }
        showToast(`自动调整为 ${targetTables} 张桌子 (存活${aliveCount}人)`, false);
    }
}

// ======================= 裁判管理 =======================
function autoAssignRefereesForDivision(division) {
    const divisionName = division.name;
    // 筛选可用裁判：不包含该级别的限制，且不参赛
    const available = state.referees.filter(ref => {
        // 限制：裁判的 restrictions 数组中任一项被级别名包含即不可用
        const restricted = ref.restrictions.some(r => divisionName.includes(r));
        if (restricted) return false;
        const isPlayer = division.players.some(p => p.name === ref.name);
        return !isPlayer;
    });
    
    const chiefs = available.filter(r => r.canChief);
    const assistants = available.filter(r => !r.canChief);
    const allAvailable = [...chiefs, ...assistants];
    
    const assignments = [];
    for (let i = 0; i < state.numTables; i++) {
        // 循环分配，尽量让主裁是可做主裁的
        const chiefIdx = (i * 2) % allAvailable.length;
        const assistIdx = (i * 2 + 1) % allAvailable.length;
        assignments.push({
            tableId: i + 1,
            chief: allAvailable[chiefIdx]?.id || null,
            assistant: allAvailable[assistIdx]?.id || null
        });
    }
    division.refereeAssignments = assignments;
    save();
    refreshMatchSubViews(division);
    showToast('裁判已自动分配');
}

// 裁判管理模态框相关
function showRefereeModal() {
    renderRefereeList();
    document.getElementById('referee-modal').classList.remove('hidden');
}

function hideRefereeModal() {
    document.getElementById('referee-modal').classList.add('hidden');
}

function renderRefereeList() {
    const container = document.getElementById('referee-list');
    container.innerHTML = state.referees.map(ref => `
        <div class="bg-zinc-800 rounded-2xl p-3 flex items-center justify-between">
            <div>
                <span class="font-medium">${escapeHtml(ref.name)}</span>
                <span class="text-xs ml-2 ${ref.canChief ? 'text-cyan-400' : 'text-zinc-400'}">${ref.canChief ? '可主裁' : '仅副裁'}</span>
                ${ref.restrictions.length ? `<div class="text-xs text-amber-400 mt-1">限制：${ref.restrictions.join(', ')}</div>` : ''}
            </div>
            <div class="flex gap-2">
                <button data-action="editReferee" data-id="${ref.id}" class="text-zinc-400 hover:text-white"><i class="fa-solid fa-pencil"></i></button>
                <button data-action="deleteReferee" data-id="${ref.id}" class="text-red-400 hover:text-red-300"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('');
}

function addBulkReferees() {
    const txt = document.getElementById('referee-bulk-input').value;
    const lines = txt.split('\n').map(s => s.trim()).filter(s => s);
    if (lines.length === 0) { showToast('请输入裁判信息', true); return; }
    const newReferees = [];
    for (const line of lines) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 2) continue;
        const name = parts[0];
        const canChief = parts[1].toLowerCase().includes('是') || parts[1].toLowerCase() === 'true';
        const restrictions = parts.slice(2).filter(s => s);
        // 避免重复添加同名裁判（简单处理）
        if (!state.referees.some(r => r.name === name)) {
            newReferees.push({
                id: uuid(),
                name,
                canChief,
                restrictions
            });
        }
    }
    state.referees.push(...newReferees);
    document.getElementById('referee-bulk-input').value = '';
    save();
    renderRefereeList();
    showToast(`添加了 ${newReferees.length} 名裁判`);
}

function resetDefaultReferees() {
    state.referees = DEFAULT_REFEREES.map(r => ({ ...r, id: uuid() })); // 重新生成ID
    save();
    renderRefereeList();
    showToast('已重置为默认裁判名单');
}

function editReferee(id) {
    const ref = state.referees.find(r => r.id === id);
    if (!ref) return;
    // 简单弹窗编辑，这里可以优化为表单，但为保持简洁使用 prompt
    const newName = prompt('姓名', ref.name);
    if (newName) ref.name = newName;
    const newChief = confirm('是否可做主裁？') ? true : false;
    ref.canChief = newChief;
    const newRestrictions = prompt('限制级别（逗号分隔）', ref.restrictions.join(','));
    ref.restrictions = newRestrictions.split(',').map(s => s.trim()).filter(s => s);
    save();
    renderRefereeList();
    showToast('裁判信息已更新');
}

function deleteReferee(id) {
    state.referees = state.referees.filter(r => r.id !== id);
    save();
    renderRefereeList();
    showToast('裁判已删除');
}

// ======================= 核心比赛操作 =======================
function startTournament(div) {
    if (!div.players.length) { showToast('请先添加选手', true); return false; }
    if (div.winners.length > 0 && !confirm('比赛已进行，重新开始将清除所有记录，是否继续？')) return false;
    
    initDoubleElimination(div);
    autoAdjustTables(div);      // 自动设置桌子数
    fillIdleTables(div);
    // 自动分配裁判（如果没有手动分配过）
    if (!div.refereeAssignments || div.refereeAssignments.length === 0) {
        autoAssignRefereesForDivision(div);
    }
    save();
    renderFullView();
    showToast('比赛开始！首轮对阵已生成');
    return true;
}

function recordMatchResult(tableId, winnerId, loserId) {
    const div = getCurrentDivision();
    const table = div.tables.find(t => t.id === tableId);
    if (!table || !table.match) return;
    const match = table.match;
    pushHistory(div);
    const finalsStarted = processMatchResult(div, match, winnerId, loserId);
    if (div.matchHistory && div.matchHistory.length > 0) {
        div.matchHistory[0].table = tableId;
    }
    table.lastMatch = { winnerId, loserId, matchId: match.id };
    table.match = null;
    
    fillIdleTables(div);
    autoAdjustTables(div);      // 每次结果后重新计算桌子数
    save();
    refreshMatchSubViews(div);
    
    const alive = div.players.filter(p => p.losses < 2).length;
    if (alive === 8 && !top8Alerted) {
        top8Alerted = true;
        showAlertModal('🏅 前8强诞生', '恭喜进入前8强，比赛将自动切换为单桌模式。');
    } else if (alive === 4) {
        showAlertModal('🔥 半决赛开启', '前4强已产生，胜者组决赛和败者组决赛即将进行。');
    } else if (div.finalsData && finalsStarted) {
        showAlertModal('🏆 总决赛', `胜者组冠军 ${div.finalsData.p1Name} vs 败者组冠军 ${div.finalsData.p2Name}\n三局两胜！`);
        showBo3Modal(div);
    }
}

function undoLastMatch() {
    const div = getCurrentDivision();
    if (!div.history || !div.history.length) { showToast('无操作可撤回', true); return; }
    if (undoStore(div)) {
        top8Alerted = false;
        if (div.finalsData) hideBo3Modal();
        save();
        autoAdjustTables(div);
        refreshMatchSubViews(div);
        const alive = div.players.filter(p => p.losses < 2).length;
        if (alive <= 8 && state.numTables === 1 && !top8Alerted) {
            top8Alerted = true;
            showAlertModal('🏅 前8强诞生', '比赛已自动切换为单桌模式。');
        }
        showToast('已撤回上一场比赛');
    }
}

function undoSingleTable(tableId) {
    const div = getCurrentDivision();
    const table = div.tables.find(t => t.id === tableId);
    if (!table || !table.lastMatch) { showToast('该桌没有可撤回的比赛', true); return; }
    // 简单处理：调用全局撤回并提醒（后续可优化）
    if (!div.history.length) return;
    const lastSnapshot = div.history[div.history.length - 1];
    const lastTable = lastSnapshot.tables.find(t => t.id === tableId);
    if (lastTable && lastTable.match && lastTable.match.id === table.lastMatch.matchId) {
        undoLastMatch();
    } else {
        showToast('只能撤回最近一场比赛，请使用全局撤回', true);
    }
}

function randomSeeding() {
    const div = getCurrentDivision();
    if (!div) return;
    if (div.winners.length > 0 && !confirm('随机抽签将重置比赛，确定吗？')) return;
    for (let i = div.players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [div.players[i], div.players[j]] = [div.players[j], div.players[i]];
    }
    div.winners = [];
    div.losers = [];
    div.matchQueue = [];
    div.tables.forEach(t => { t.match = null; t.lastMatch = null; });
    div.finalsData = null;
    div.history = [];
    div.matchHistory = [];
    div.eliminatedOrder = [];
    div.players.forEach(p => { p.losses = 0; p.rank = null; p.displayRank = null; });
    top8Alerted = false;
    autoAdjustTables(div);
    save();
    refreshMatchSubViews(div);
    showToast('已随机打乱选手顺序');
}

// 删除手动设置桌子数函数，不再暴露给用户

function goBack() {
    if (state.view === 'match') {
        state.view = 'divisions';
        state.currentDivisionId = null;
        renderFullView();
    } else if (state.view === 'divisions') {
        state.view = 'tournaments';
        state.currentTournamentId = null;
        renderFullView();
    }
}

function editCurrentDivisionName() {
    const div = getCurrentDivision();
    if (!div) return;
    const newName = prompt('修改级别名称', div.name);
    if (newName && newName.trim()) {
        div.name = newName.trim();
        save();
        renderFullView();
        showToast('级别名称已更新');
    }
}

// ======================= BO3 决赛 =======================
function showBo3Modal(div) {
    const modal = document.getElementById('bo3-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.getElementById('bo3-players').innerHTML = `<div class="text-cyan-300 text-3xl">${escapeHtml(div.finalsData.p1Name)}</div><div class="text-4xl text-zinc-500">VS</div><div class="text-amber-300 text-3xl">${escapeHtml(div.finalsData.p2Name)}</div>`;
    document.getElementById('bo3-name-p1').innerText = div.finalsData.p1Name;
    document.getElementById('bo3-name-p2').innerText = div.finalsData.p2Name;
    document.getElementById('bo3-score-p1').innerText = div.finalsData.score1;
    document.getElementById('bo3-score-p2').innerText = div.finalsData.score2;
}
function hideBo3Modal() { document.getElementById('bo3-modal')?.classList.add('hidden'); }
function updateBo3UI(div) {
    document.getElementById('bo3-score-p1').innerText = div.finalsData.score1;
    document.getElementById('bo3-score-p2').innerText = div.finalsData.score2;
}
function bo3Win(side) {
    const div = getCurrentDivision();
    if (!div.finalsData) return;
    if (side === 1) div.finalsData.score1++;
    else div.finalsData.score2++;
    updateBo3UI(div);
    if (div.finalsData.score1 >= 2 || div.finalsData.score2 >= 2) {
        const championId = div.finalsData.score1 >= 2 ? div.finalsData.p1Id : div.finalsData.p2Id;
        const runnerId = div.finalsData.score1 >= 2 ? div.finalsData.p2Id : div.finalsData.p1Id;
        const champion = div.players.find(p => p.id === championId);
        const runner = div.players.find(p => p.id === runnerId);
        champion.rank = 1;
        runner.rank = 2;
        champion.losses = 0;
        runner.losses = 1;
        div.matchHistory.unshift({
            timestamp: new Date().toLocaleString(),
            winner: champion.name,
            loser: runner.name,
            group: '决赛BO3',
            winnerId: championId,
            loserId: runnerId,
            table: '决赛'
        });
        recalcFinalRanks(div);
        div.finalsData = null;
        hideBo3Modal();
        const third = div.players.find(p => p.rank === 3);
        let rankMsg = `冠军：${champion.name}\n亚军：${runner.name}\n`;
        if (third) rankMsg += `季军：${third.name}\n`;
        rankMsg += `完整排名已更新至右侧面板。`;
        showAlertModal('🏆 比赛结束', rankMsg);
        save();
        refreshMatchSubViews(div);
    }
}

// ======================= 手动分配 =======================
function assignMatchToTable(tableId) {
    const div = getCurrentDivision();
    const table = div.tables.find(t => t.id === tableId);
    if (table.match) return;
    const next = getNextMatch(div);
    if (next) table.match = next;
    else showToast('无待比赛', true);
    save();
    refreshMatchSubViews(div);
}

function showManualAssignModal(tableId) {
    const div = getCurrentDivision();
    const available = div.players.filter(p => p.losses < 2);
    const container = document.getElementById('manual-pool-select');
    container.innerHTML = '';
    manualTableId = tableId;
    manualSelected = [];
    available.forEach(p => {
        const btn = document.createElement('div');
        btn.className = 'bg-zinc-800 rounded-2xl p-3 cursor-pointer hover:bg-zinc-700 text-center';
        btn.innerText = `${p.name} (${p.losses}负)`;
        btn.dataset.playerId = p.id;
        btn.addEventListener('click', () => {
            if (manualSelected.includes(p.id)) {
                manualSelected = manualSelected.filter(id => id !== p.id);
                btn.classList.remove('border-cyan-400', 'border-2');
            } else {
                if (manualSelected.length < 2) {
                    manualSelected.push(p.id);
                    btn.classList.add('border-cyan-400', 'border-2');
                }
            }
            document.getElementById('manual-confirm-btn').disabled = manualSelected.length !== 2;
        });
        container.appendChild(btn);
    });
    document.getElementById('manual-modal').classList.remove('hidden');
}

function confirmManualAssign() {
    if (manualSelected.length !== 2) return;
    const div = getCurrentDivision();
    const table = div.tables.find(t => t.id === manualTableId);
    if (!table || table.match) return;
    if (manualSelected[0] === manualSelected[1]) {
        showToast('不能选择同一位选手', true);
        return;
    }
    const match = {
        id: uuid(),
        p1: manualSelected[0],
        p2: manualSelected[1],
        group: 'winners',
        winner: null,
        loser: null
    };
    table.match = match;
    hideManualModal();
    save();
    refreshMatchSubViews(div);
}
function hideManualModal() { document.getElementById('manual-modal').classList.add('hidden'); }

// ======================= 赛事/级别管理 =======================
function addTournament() {
    const name = prompt('比赛名称', '新比赛');
    if (name) {
        state.tournaments.push({ id: uuid(), name, divisions: [] });
        state.currentTournamentId = state.tournaments[state.tournaments.length-1].id;
        save();
        renderFullView();
    }
}
function editTournament(id) {
    const tour = state.tournaments.find(t => t.id === id);
    if (tour) {
        const newName = prompt('修改比赛名称', tour.name);
        if (newName) { tour.name = newName; save(); renderFullView(); }
    }
}
function deleteTournament(id) {
    if (state.tournaments.length <= 1) { showToast('至少保留一个比赛', true); return; }
    if (!confirm('删除比赛将同时删除其所有级别和数据，确定吗？')) return;
    state.tournaments = state.tournaments.filter(t => t.id !== id);
    if (state.currentTournamentId === id) state.currentTournamentId = state.tournaments[0]?.id || null;
    save();
    renderFullView();
}
function selectTournament(id) {
    state.currentTournamentId = id;
    state.view = 'divisions';
    renderFullView();
}
function addDivision() {
    const tour = getCurrentTournament();
    if (!tour) return;
    const side = prompt('选择级别类型：输入“左手”或“右手”', '右手');
    if (!side) return;
    let defaultName = '';
    if (side.includes('左')) defaultName = '左手75kg';
    else if (side.includes('右')) defaultName = '右手75kg';
    else defaultName = side + '级别';
    const name = prompt('级别名称', defaultName);
    if (name) {
        tour.divisions.push({
            id: uuid(),
            name,
            players: [],
            winners: [],
            losers: [],
            matchQueue: [],
            tables: [],
            finalsData: null,
            history: [],
            matchHistory: [],
            eliminatedOrder: [],
            refereeAssignments: []
        });
        save();
        renderFullView();
    }
}
function editDivision(id) {
    const tour = getCurrentTournament();
    const div = tour.divisions.find(d => d.id === id);
    if (div) {
        const newName = prompt('修改级别名称', div.name);
        if (newName) { div.name = newName; save(); renderFullView(); }
    }
}
function deleteDivision(id) {
    const tour = getCurrentTournament();
    if (!tour) return;
    if (!confirm('删除级别将清除所有选手和比赛数据，确定吗？')) return;
    tour.divisions = tour.divisions.filter(d => d.id !== id);
    if (state.currentDivisionId === id) state.currentDivisionId = null;
    save();
    renderFullView();
}
function selectDivision(id) {
    state.currentDivisionId = id;
    state.view = 'match';
    syncTablesForCurrentDivision();
    renderFullView();
}
function clearCurrentDivision() {
    const div = getCurrentDivision();
    if (div && confirm(`清空级别“${div.name}”所有数据？`)) {
        div.players = [];
        div.winners = [];
        div.losers = [];
        div.matchQueue = [];
        div.tables = [];
        div.finalsData = null;
        div.history = [];
        div.matchHistory = [];
        div.eliminatedOrder = [];
        div.refereeAssignments = [];
        syncTablesForCurrentDivision();
        save();
        renderFullView();
    }
}
function addBulkPlayers() {
    const div = getCurrentDivision();
    if (!div) return;
    const txt = document.getElementById('bulk-input').value;
    let names = txt.split(/[,\n]/).map(s => s.trim()).filter(s => s);
    if (names.length === 0) {
        showToast('请输入选手姓名', true);
        return;
    }
    const existingNames = new Set(div.players.map(p => p.name.trim().toLowerCase()));
    const newPlayers = [];
    const duplicates = [];
    for (const name of names) {
        const normalized = name.trim().toLowerCase();
        if (existingNames.has(normalized)) {
            duplicates.push(name);
        } else {
            const player = {
                id: uuid(),
                name: name.trim(),
                losses: 0,
                rank: null,
                pinyin: getPinyin(name.trim())
            };
            newPlayers.push(player);
            existingNames.add(normalized);
        }
    }
    if (newPlayers.length === 0) {
        showToast('所有选手均已存在，未添加任何新选手', true);
        return;
    }
    div.players.push(...newPlayers);
    document.getElementById('bulk-input').value = '';
    save();
    refreshMatchSubViews(div);
    let msg = `添加 ${newPlayers.length} 人`;
    if (duplicates.length > 0) {
        msg += `，跳过重复：${duplicates.slice(0, 3).join(', ')}${duplicates.length > 3 ? '等' : ''}`;
        showToast(msg, false);
    } else {
        showToast(msg);
    }
}

// ======================= 视图渲染 =======================
function renderFullView() {
    if (state.view === 'tournaments') renderTournamentsList();
    else if (state.view === 'divisions') renderDivisionsList();
    else if (state.view === 'match') renderMatchView();
    updateBackButton();
}

function renderTournamentsList() {
    const root = document.getElementById('app-root');
    root.innerHTML = `
        <div class="bg-zinc-900 rounded-3xl p-6">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-3xl font-bold">🏟️ 我的比赛</h2>
                <button data-action="addTournament" class="bg-cyan-400 text-black px-6 py-3 rounded-3xl font-bold"><i class="fa-solid fa-plus"></i> 新建比赛</button>
            </div>
            <div id="tournaments-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"></div>
        </div>
    `;
    const container = document.getElementById('tournaments-list');
    if (state.tournaments.length === 0) {
        container.innerHTML = '<div class="col-span-full text-center py-12 text-zinc-400">暂无比赛，点击“新建比赛”开始</div>';
        return;
    }
    container.innerHTML = state.tournaments.map(t => `
        <div class="tournament-card rounded-3xl p-6" data-action="selectTournament" data-id="${t.id}">
            <div class="flex justify-between items-start">
                <div>
                    <h3 class="text-2xl font-bold">${escapeHtml(t.name)}</h3>
                    <p class="text-zinc-400 text-sm mt-1">级别数：${t.divisions.length}</p>
                </div>
                <div class="flex gap-2">
                    <i class="fa-solid fa-pencil text-zinc-400 hover:text-white" data-action="editTournament" data-id="${t.id}"></i>
                    <i class="fa-solid fa-trash text-red-400 hover:text-red-300" data-action="deleteTournament" data-id="${t.id}"></i>
                </div>
            </div>
        </div>
    `).join('');
}

function renderDivisionsList() {
    const tour = getCurrentTournament();
    if (!tour) { renderTournamentsList(); return; }
    const leftDivs = [], rightDivs = [], otherDivs = [];
    tour.divisions.forEach(div => {
        const name = div.name;
        if (name.includes('左') || name.includes('Left') || name.toLowerCase().includes('left')) leftDivs.push(div);
        else if (name.includes('右') || name.includes('Right') || name.toLowerCase().includes('right')) rightDivs.push(div);
        else otherDivs.push(div);
    });
    const root = document.getElementById('app-root');
    root.innerHTML = `
        <div class="bg-zinc-900 rounded-3xl p-6">
            <div class="flex justify-between items-center mb-6">
                <div>
                    <h2 class="text-3xl font-bold">${escapeHtml(tour.name)}</h2>
                    <p class="text-zinc-400">管理比赛级别</p>
                </div>
                <button data-action="addDivision" class="bg-cyan-400 text-black px-6 py-3 rounded-3xl font-bold"><i class="fa-solid fa-plus"></i> 新增级别</button>
            </div>
            ${leftDivs.length ? `<div class="mb-8"><h3 class="text-2xl font-semibold mb-4 flex items-center gap-2"><i class="fa-solid fa-hand-back-fist text-cyan-400"></i> 左手组</h3><div id="left-divisions-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"></div></div>` : ''}
            ${rightDivs.length ? `<div class="mb-8"><h3 class="text-2xl font-semibold mb-4 flex items-center gap-2"><i class="fa-solid fa-hand-peace text-amber-400"></i> 右手组</h3><div id="right-divisions-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"></div></div>` : ''}
            ${otherDivs.length ? `<div><h3 class="text-2xl font-semibold mb-4">其他组</h3><div id="other-divisions-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"></div></div>` : ''}
        </div>
    `;
    const renderGroup = (containerId, divs) => {
        const container = document.getElementById(containerId);
        if (container) {
            container.innerHTML = divs.map(d => `
                <div class="division-card rounded-3xl p-6" data-action="selectDivision" data-id="${d.id}">
                    <div class="flex justify-between items-start">
                        <h3 class="text-2xl font-bold">${escapeHtml(d.name)}</h3>
                        <div class="flex gap-2">
                            <i class="fa-solid fa-pencil text-zinc-400 hover:text-white" data-action="editDivision" data-id="${d.id}"></i>
                            <i class="fa-solid fa-trash text-red-400 hover:text-red-300" data-action="deleteDivision" data-id="${d.id}"></i>
                        </div>
                    </div>
                    <p class="text-zinc-400 text-sm mt-2">选手：${d.players.length}人</p>
                </div>
            `).join('');
        }
    };
    renderGroup('left-divisions-list', leftDivs);
    renderGroup('right-divisions-list', rightDivs);
    renderGroup('other-divisions-list', otherDivs);
}

function renderMatchView() {
    const div = getCurrentDivision();
    if (!div) { renderDivisionsList(); return; }
    const progress = getProgress(div);
    const root = document.getElementById('app-root');
    root.innerHTML = `
        <div class="flex flex-col lg:flex-row gap-6">
            <div class="w-full lg:w-80 flex-shrink-0 bg-zinc-900 rounded-3xl p-6 h-fit sticky top-24">
                <div class="flex justify-between items-baseline mb-4">
                    <div class="flex items-center gap-2">
                        <h2 class="text-2xl font-bold" id="division-name-title">${escapeHtml(div.name)}</h2>
                        <i class="fa-solid fa-pencil text-zinc-400 hover:text-white text-sm" data-action="editCurrentDivisionName"></i>
                    </div>
                    <div data-action="clearCurrentDivision" class="text-xs flex items-center gap-1 text-red-400"><i class="fa-solid fa-trash"></i>清空本级别</div>
                </div>
                <div class="mb-6">
                    <p class="text-zinc-400 text-sm mb-2"><i class="fa-solid fa-clipboard"></i> 批量添加选手（一行一个或逗号分隔）</p>
                    <textarea id="bulk-input" rows="4" class="w-full bg-black border border-zinc-700 rounded-2xl px-4 py-3 text-lg placeholder-zinc-500 focus:outline-none focus:border-cyan-400 resize-none" placeholder="张三&#10;李四,王五&#10;赵六"></textarea>
                    <button data-action="addBulkPlayers" class="mt-3 w-full bg-cyan-400 hover:bg-cyan-300 text-black font-bold py-4 rounded-3xl text-lg"><i class="fa-solid fa-plus"></i>立即添加</button>
                </div>
                <button data-action="startTournament" class="w-full bg-gradient-to-r from-emerald-500 to-green-600 text-white font-bold py-4 rounded-3xl mb-6"><i class="fa-solid fa-play"></i> 开始比赛</button>
                <button data-action="randomSeeding" class="w-full bg-amber-500 hover:bg-amber-400 text-black font-bold py-4 rounded-3xl mb-6"><i class="fa-solid fa-shuffle"></i> 随机抽签（打乱顺序）</button>
                <div class="mb-6">
                    <div class="flex justify-between text-sm text-zinc-400 mb-3"><span>全部选手 <span id="total-players">${div.players.length}</span>人</span></div>
                    <div id="mini-players-list" class="max-h-64 overflow-y-auto space-y-2 pr-2"></div>
                </div>
                <div>
                    <div class="flex justify-between text-sm text-emerald-400 mb-3"><span><i class="fa-solid fa-hourglass-half"></i> 待机选手池</span><span id="pool-count" class="bg-emerald-900 text-emerald-400 px-3 py-0.5 rounded-3xl text-xs"></span></div>
                    <div id="pool-list" class="max-h-80 overflow-y-auto space-y-2 text-sm"></div>
                </div>
            </div>
            <div class="flex-1">
                <div class="flex justify-between items-center mb-4 flex-wrap gap-2">
                    <div class="flex items-center gap-3">
                        <h3 class="text-xl font-semibold">比赛桌子 <span class="text-sm font-normal text-zinc-400">(自动: ${state.numTables}桌)</span></h3>
                        <button data-action="showHistoryModal" class="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-2xl text-sm flex items-center gap-2"><i class="fa-solid fa-list-ul"></i> 比赛历史</button>
                        <button data-action="autoAssignRefereesForCurrent" class="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-2xl text-sm flex items-center gap-2"><i class="fa-solid fa-gavel"></i> 重新分配裁判</button>
                    </div>
                    <div class="bg-zinc-800 rounded-2xl px-4 py-2 text-sm flex items-center gap-2">
                        <i class="fa-solid fa-chart-simple text-cyan-400"></i>
                        <span>赛程进度</span>
                        <div class="w-32 bg-zinc-700 rounded-full h-2 overflow-hidden">
                            <div id="progress-bar" class="bg-cyan-400 h-full rounded-full" style="width: ${progress}%"></div>
                        </div>
                        <span id="progress-text" class="text-cyan-300 font-mono">${progress}%</span>
                    </div>
                </div>
                <div id="tables-container" class="grid grid-cols-1 md:grid-cols-2 gap-6"></div>
                <div class="mt-8 bg-zinc-900 rounded-3xl p-6">
                    <h3 class="text-lg font-semibold mb-4"><i class="fa-solid fa-trophy text-yellow-400"></i> 完整排名</h3>
                    <div id="standings-list" class="space-y-2 max-h-[400px] overflow-y-auto pr-2"></div>
                </div>
            </div>
        </div>
    `;
    refreshMatchSubViews(div);
}

function refreshMatchSubViews(div) {
    const titleEl = document.getElementById('division-name-title');
    if (titleEl) titleEl.innerText = div.name;
    
    const progress = getProgress(div);
    const bar = document.getElementById('progress-bar');
    const text = document.getElementById('progress-text');
    if (bar) bar.style.width = progress + '%';
    if (text) text.innerText = progress + '%';
    
    const container = document.getElementById('tables-container');
    if (container) {
        container.innerHTML = '';
        div.tables.forEach(table => {
            const card = document.createElement('div');
            card.className = `table-card rounded-3xl p-6 ${table.match ? 'ring-2 ring-cyan-400/40' : 'border border-zinc-700'}`;
            
            // 获取裁判分配
            const assignment = div.refereeAssignments?.find(a => a.tableId === table.id);
            const chief = state.referees.find(r => r.id === assignment?.chief);
            const assistant = state.referees.find(r => r.id === assignment?.assistant);
            const chiefName = chief?.name || '待分配';
            const assistName = assistant?.name || '待分配';
            
            if (!table.match) {
                card.innerHTML = `
                    <div class="text-center py-6">
                        <div class="inline-flex items-center justify-center w-16 h-16 bg-zinc-700 rounded-2xl mb-4"><i class="fa-solid fa-chair text-4xl text-zinc-400"></i></div>
                        <p class="text-2xl font-semibold mb-1">桌子 ${table.id} · 空闲</p>
                        <div class="text-xs text-zinc-400 mb-2">
                            👨‍⚖️ 主裁：${escapeHtml(chiefName)} ｜ 副裁：${escapeHtml(assistName)}
                        </div>
                        <button data-action="assignMatchToTable" data-table="${table.id}" class="bg-emerald-400 hover:bg-emerald-300 text-black font-bold py-3 px-6 rounded-3xl w-full"><i class="fa-solid fa-arrow-right"></i> 从队列取一场比赛</button>
                        <button data-action="showManualAssignModal" data-table="${table.id}" class="mt-2 bg-white/10 hover:bg-white/20 text-white font-bold py-3 rounded-3xl w-full">手动分配</button>
                    </div>
                `;
            } else {
                const p1 = div.players.find(p => p.id === table.match.p1);
                const p2 = div.players.find(p => p.id === table.match.p2);
                if (!p1 || !p2) return;
                const groupLabel = table.match.group === 'winners' ? '🏅胜者组' : '💀败者组';
                card.innerHTML = `
                    <div class="flex justify-between text-xs font-mono mb-3"><div>桌子 ${table.id} ${groupLabel}</div><div class="text-emerald-400">比赛中</div></div>
                    <div class="text-center text-xs text-zinc-400 mb-2">
                        👨‍⚖️ 主裁：${escapeHtml(chiefName)} ｜ 副裁：${escapeHtml(assistName)}
                    </div>
                    <div class="flex justify-between items-center">
                        <div data-action="recordMatchResult" data-table="${table.id}" data-winner="${p1.id}" data-loser="${p2.id}" class="flex-1 text-center cursor-pointer">
                            <div class="player-name text-cyan-300">${escapeHtml(p1.name)}</div>
                            <div class="text-xs text-zinc-400 mt-0">${escapeHtml(p1.pinyin)}</div>
                            <div class="mt-4"><button class="win-button bg-cyan-400 text-black font-black w-28 h-28 rounded-3xl mx-auto flex items-center justify-center text-2xl">胜</button></div>
                        </div>
                        <div class="px-6 text-4xl font-light text-zinc-600">VS</div>
                        <div data-action="recordMatchResult" data-table="${table.id}" data-winner="${p2.id}" data-loser="${p1.id}" class="flex-1 text-center cursor-pointer">
                            <div class="player-name text-amber-300">${escapeHtml(p2.name)}</div>
                            <div class="text-xs text-zinc-400 mt-0">${escapeHtml(p2.pinyin)}</div>
                            <div class="mt-4"><button class="win-button bg-amber-400 text-black font-black w-28 h-28 rounded-3xl mx-auto flex items-center justify-center text-2xl">胜</button></div>
                        </div>
                    </div>
                    <div class="text-center text-xs text-zinc-500 mt-6"><button data-action="undoSingleTable" data-table="${table.id}" class="bg-zinc-800 px-4 py-2 rounded-full hover:bg-red-800"><i class="fa-solid fa-rotate-left"></i> 仅本桌撤回</button></div>
                `;
            }
            container.appendChild(card);
        });
    }
    
    // 待机池
    const activeSet = getActivePlayers(div);
    const pool = div.players.filter(p => p.losses < 2 && !activeSet.has(p.id));
    const poolCount = document.getElementById('pool-count');
    if (poolCount) poolCount.innerText = `${pool.length}人`;
    const poolContainer = document.getElementById('pool-list');
    if (poolContainer) {
        poolContainer.innerHTML = pool.map(p => `
            <div class="bg-zinc-800 rounded-2xl px-4 py-3 flex justify-between items-center">
                <div>
                    <div class="font-medium">${escapeHtml(p.name)}</div>
                    <div class="text-xs text-zinc-400">${escapeHtml(p.pinyin)}</div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="loss-${p.losses}">${p.losses}/2</span>
                </div>
            </div>
        `).join('') || '<div class="text-center text-zinc-500">待机池空</div>';
    }
    
    // 迷你选手列表
    const sorted = [...div.players].sort((a,b) => (a.displayRank || 999) - (b.displayRank || 999));
    const miniList = document.getElementById('mini-players-list');
    if (miniList) {
        miniList.innerHTML = sorted.slice(0,8).map(p => `
            <div class="flex justify-between bg-zinc-800 rounded-2xl px-4 py-3 items-center">
                <div>
                    <div class="font-medium">${escapeHtml(p.name)}</div>
                    <div class="text-xs text-zinc-400">${escapeHtml(p.pinyin)}</div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="loss-${Math.min(p.losses,2)}">${p.losses}/2</span>
                </div>
            </div>
        `).join('');
    }
    document.getElementById('total-players').innerText = div.players.length;
    
    // 排名面板
    const hasChampion = div.players.some(p => p.rank === 1);
    const standingsContainer = document.getElementById('standings-list');
    if (standingsContainer) {
        if (hasChampion) {
            recalcFinalRanks(div);
            const finalSorted = [...div.players].sort((a,b) => (a.displayRank || 999) - (b.displayRank || 999));
            standingsContainer.innerHTML = finalSorted.map(p => {
                let cls = '', medal = '';
                if (p.rank === 1) { cls = 'rank-1'; medal = '🥇'; }
                else if (p.rank === 2) { cls = 'rank-2'; medal = '🥈'; }
                else if (p.rank === 3) { cls = 'rank-3'; medal = '🥉'; }
                return `
                    <div class="standing-item flex items-center px-5 py-4 rounded-3xl mb-2 bg-zinc-800/60 ${cls}">
                        <div class="flex items-center justify-center w-12 h-12 text-4xl mr-4">${medal}</div>
                        <div class="flex-1">
                            <span class="font-bold text-xl">${p.displayRank}</span>
                            <span class="ml-4 font-semibold">${escapeHtml(p.name)}</span>
                            <div class="text-xs text-zinc-400">${escapeHtml(p.pinyin)}</div>
                        </div>
                        <div class="text-right">
                            <span class="loss-${Math.min(p.losses || 0, 2)} font-mono text-sm">${p.losses || 0}/2</span>
                        </div>
                    </div>`;
            }).join('');
        } else {
            const liveRanking = getLiveRanking(div);
            standingsContainer.innerHTML = liveRanking.slice(0,8).map((p, idx) => `
                <div class="flex items-center px-5 py-4 rounded-3xl mb-2 bg-zinc-800/60">
                    <div class="flex items-center justify-center w-12 h-12 text-2xl font-bold mr-4">${idx+1}</div>
                    <div class="flex-1">
                        <div class="font-semibold text-lg">${escapeHtml(p.name)}</div>
                        <div class="text-xs text-zinc-400">${escapeHtml(p.pinyin)}</div>
                    </div>
                    <div class="text-right">
                        <span class="loss-${Math.min(p.losses, 2)} font-mono text-sm">${p.losses}/2</span>
                    </div>
                </div>
            `).join('');
        }
    }
}

// ======================= 全局菜单与模态框 =======================
function showMenu() { document.getElementById('menu-overlay').classList.remove('hidden'); }
function hideMenu() { document.getElementById('menu-overlay').classList.add('hidden'); }
function showHistoryModal() {
    const div = getCurrentDivision();
    const container = document.getElementById('history-list');
    if (!div.matchHistory || div.matchHistory.length === 0) {
        container.innerHTML = '<div class="text-center text-zinc-500 py-8">暂无比赛记录</div>';
    } else {
        container.innerHTML = div.matchHistory.map(h => `
            <div class="history-entry bg-zinc-800 rounded-2xl p-4">
                <div class="font-mono text-xs text-zinc-400">${h.timestamp}</div>
                <div class="font-semibold text-lg">${h.winner} 击败 ${h.loser}</div>
                <div class="text-xs text-zinc-400">${h.group} | ${h.table ? '桌'+h.table : '决赛'}</div>
            </div>
        `).join('');
    }
    document.getElementById('history-modal').classList.remove('hidden');
}
function hideHistoryModal() { document.getElementById('history-modal').classList.add('hidden'); }
function exportHistory() { const div = getCurrentDivision(); if (div) exportHistoryUtil(div); }
function exportData() { exportDataUtil(state); }
function importDataPrompt() { importDataPromptUtil((imported) => { state = imported; syncTablesForCurrentDivision(); save(); renderFullView(); showToast('导入成功'); }); }
function resetAllData() { if (confirm('彻底清空全部数据？')) { localStorage.removeItem('wristPower_final'); location.reload(); } }

// ======================= 全局事件委托 =======================
function handleGlobalClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    const tableId = target.dataset.table ? parseInt(target.dataset.table) : null;
    const winner = target.dataset.winner;
    const loser = target.dataset.loser;
    const side = target.dataset.side ? parseInt(target.dataset.side) : null;
    const closeMenu = target.dataset.closeMenu === 'true';
    
    switch (action) {
        case 'goBack': goBack(); break;
        case 'showMenu': showMenu(); break;
        case 'addTournament': addTournament(); break;
        case 'editTournament': editTournament(id); break;
        case 'deleteTournament': deleteTournament(id); break;
        case 'selectTournament': selectTournament(id); break;
        case 'addDivision': addDivision(); break;
        case 'editDivision': editDivision(id); break;
        case 'deleteDivision': deleteDivision(id); break;
        case 'selectDivision': selectDivision(id); break;
        case 'clearCurrentDivision': clearCurrentDivision(); break;
        case 'addBulkPlayers': addBulkPlayers(); break;
        case 'startTournament': { const div = getCurrentDivision(); if (div) startTournament(div); } break;
        case 'randomSeeding': randomSeeding(); break;
        case 'recordMatchResult': recordMatchResult(tableId, winner, loser); break;
        case 'assignMatchToTable': assignMatchToTable(tableId); break;
        case 'showManualAssignModal': showManualAssignModal(tableId); break;
        case 'confirmManualAssign': confirmManualAssign(); break;
        case 'hideManualModal': hideManualModal(); break;
        case 'undoSingleTable': undoSingleTable(tableId); break;
        case 'undoLastMatch': undoLastMatch(); break;
        case 'exportData': exportData(); break;
        case 'importDataPrompt': importDataPrompt(); break;
        case 'resetAllData': resetAllData(); break;
        case 'showHistoryModal': showHistoryModal(); break;
        case 'hideHistoryModal': hideHistoryModal(); break;
        case 'exportHistory': exportHistory(); break;
        case 'bo3Win': bo3Win(side); break;
        case 'hideBo3Modal': hideBo3Modal(); break;
        case 'editCurrentDivisionName': editCurrentDivisionName(); break;
        // 裁判相关
        case 'showRefereeModal': showRefereeModal(); break;
        case 'hideRefereeModal': hideRefereeModal(); break;
        case 'addBulkReferees': addBulkReferees(); break;
        case 'resetDefaultReferees': resetDefaultReferees(); break;
        case 'editReferee': editReferee(id); break;
        case 'deleteReferee': deleteReferee(id); break;
        case 'autoAssignRefereesForCurrent': { const div = getCurrentDivision(); if (div) autoAssignRefereesForDivision(div); } break;
        default: break;
    }
    if (closeMenu) hideMenu();
    if (action.startsWith('select') || action.includes('Tournament') || action.includes('Division')) {
        e.preventDefault();
    }
}

document.addEventListener('click', handleGlobalClick);

window.App = {
    closeAlertModal,
    hideBo3Modal,
    hideHistoryModal,
    hideManualModal,
    hideMenu,
    hideRefereeModal,
    showMenu
};

// 初始化
load();
renderFullView();
window.state = state;