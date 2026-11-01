// src/progressBar.js
//==========================================================
// One 0..1 progress bar over a run of steps, reported as
// onProgress(done, total) with total 1000 that never goes back.
// sub(from, to) is the onProgress of a step that fills that part of
// the bar (steps report done / total of their own).
//==========================================================

export var BAR_TOTAL = 1000;

/**
 * @param {function(number, number)|undefined} onProgress
 * @returns {{at: function(number), sub: function(number, number): function(number, number)}} at(f): the bar at f (0..1)
 */
export function sharedBar(onProgress) {
	var last = -1;
	function at(f) {
		if (!onProgress) return;
		var done = Math.round(Math.min(1, Math.max(0, f)) * BAR_TOTAL);
		if (done > last) { last = done; onProgress(done, BAR_TOTAL); }
	}
	return { at: at, sub: function (from, to) { return function (d, t) { at(from + (to - from) * (t > 0 ? d / t : 1)); }; } };
}
