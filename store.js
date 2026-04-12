import { deepCopy } from './utils.js';

export function pushHistory(division) {
    if (!division.history) division.history = [];
    const snapshot = deepCopy({
        winners: division.winners,
        losers: division.losers,
        matchQueue: division.matchQueue,
        tables: division.tables,
        finalsData: division.finalsData,
        players: division.players,
        matchHistory: division.matchHistory,
        eliminatedOrder: division.eliminatedOrder
    });
    division.history.push(snapshot);
    if (division.history.length > 30) division.history.shift();
}

export function undoLastMatch(division) {
    if (!division.history || division.history.length === 0) return false;
    const last = division.history.pop();
    division.winners = last.winners;
    division.losers = last.losers;
    division.matchQueue = last.matchQueue;
    division.tables = last.tables;
    division.finalsData = last.finalsData;
    division.players = last.players;
    division.matchHistory = last.matchHistory;
    division.eliminatedOrder = last.eliminatedOrder;
    return true;
}