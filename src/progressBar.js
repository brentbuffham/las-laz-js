// src/progressBar.js
//==========================================================
// One 0..1 progress bar over a run of steps, reported as
// onProgress(done, total) with total 1000 that never goes back.
// sub(from, to) is the onProgress of a step that fills that part of
// the bar (steps report done / total of their own); ticker(from, to,
// total) is the call a loop makes with its count as it goes.
// A signal given to the bar is looked at on every report: a run on
// this thread that ticks stops with ABORTED where a stop can reach it.
//==========================================================

import { LasError, ERROR_CODES } from "./errors.js";

export var BAR_TOTAL = 1000;

/**
 * @param {function(number, number)|undefined} onProgress
 * @param {AbortSignal} [signal]
 * @param {number} [total] - what the bar counts to (default 1000; the point count for a run that reports points)
 * @returns {{at: function(number), sub: function(number, number): function(number, number), ticker: function(number, number, number): function(number)}}
 *   at(f): the bar at f (0..1); ticker(from, to, count): a function of the count so far that moves the bar from `from`
 *   to `to` as the count goes to `count`, reporting at most every 0.2 % of the bar
 */
export function sharedBar(onProgress, signal, total) {
	if (onProgress !== undefined && typeof onProgress !== "function") throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "onProgress must be a function");
	var last = -1, all = total === undefined ? BAR_TOTAL : total;
	function at(f) {
		if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "the run was stopped");
		if (!onProgress) return;
		var done = Math.round(Math.min(1, Math.max(0, f)) * all);
		if (done > last) { last = done; onProgress(done, all); }
	}
	function ticker(from, to, count) {
		if (!onProgress && !signal) return function () {};
		var step = Math.max(1, Math.floor(count / 500)), next = 0;
		return function (done) {
			if (done < next && done < count) return;
			next = done + step;
			at(from + (to - from) * (count > 0 ? done / count : 1));
		};
	}
	return { at: at, ticker: ticker, sub: function (from, to) { return function (d, t) { at(from + (to - from) * (t > 0 ? d / t : 1)); }; } };
}
