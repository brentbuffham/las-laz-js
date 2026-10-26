// src/fragments/resolution.js
//==========================================================
// What a cloud can resolve, for every findFragments result: the point
// spacing (spacing.js), the floor (the smallest rock it measures, 30
// spacings), a resolution tier, the sheets (fragments flatter than
// c / b 0.15: surface, not rock) and the warnings. A coarse cloud is
// warned of loudly, never refused.
//
// How good a cloud is, by its point spacing (pointSpacing, metres),
// from S4_250_403 scored against 118 hand-drawn rocks:
//
//   spacing        resolution    what you get
//   <= 0.017       fine          rocks down to ~0.5 m come out whole; a
//                                size curve from the floor up. ODM
//                                --pc-quality ultra at full image scale
//                                gave 0.016 (1.4 cm by area): use it for
//                                photogrammetry.
//   <= 0.035       coarse        rocks over ~0.7-1 m only (ODM default,
//                                0.028); P-values under the floor are
//                                not sizes.
//   <= 0.05        oversize      only rocks over ~1-1.5 m: oversize, not
//                                a size curve.
//   above          unresolved    no rocks: patches of surface (an 8 cm
//                                heave survey found none at all).
//
// The floor is 30 spacings: the clouds scored lost most rocks under
// about 25-28 spacings (0.45 m at 0.016, 0.7 m at 0.028).
//==========================================================

export var FLOOR_SPACINGS = 30, SHEET_CB = 0.15;
var TIERS = [[0.017, "fine"], [0.035, "coarse"], [0.05, "oversize"]];
var MD_LOW = 2.5, MD_HIGH = 8, SHEET_SHARE = 0.3, FLOOR_SHARE = 0.25;

// a spacing to 3 significant figures; a size to 2 decimals
function sp(v) { return String(Number(v.toPrecision(3))); }
function sz(v) { return v.toFixed(2); }

/**
 * The resolution tier of a point spacing (metres).
 * @param {number} spacing
 * @returns {string} "fine", "coarse", "oversize" or "unresolved"; null for a spacing that is not a number.
 */
export function resolutionOf(spacing) {
	if (!(spacing > 0)) return null;
	for (var i = 0; i < TIERS.length; i++) if (spacing <= TIERS[i][0]) return TIERS[i][1];
	return "unresolved";
}

/**
 * Add what the cloud resolves to a findFragments result: spacing, floor, resolution, warnings;
 * `sheet` on each fragment. In place.
 * @param {object} fr - the result (fragments, surfaceArea, unassignedArea).
 * @param {number} spacing - pointSpacing of the run's points (NaN: too few).
 * @param {{maxDistance?: number, ignored?: string[], sideOn?: boolean}} given - what the caller set: maxDistance
 *   (given, not defaulted) for its warning; ignored, options the method does not use; sideOn, the watershed's
 *   side-on test.
 * @returns {object} fr.
 */
export function resultFields(fr, spacing, given) {
	var g = given || {}, warnings = [], floor = FLOOR_SPACINGS * spacing, res = resolutionOf(spacing);
	var sheetArea = 0, area = fr.unassignedArea, big = null;
	fr.fragments.forEach(function (f) {
		f.sheet = !(f.axes[1] > 0) || f.axes[2] / f.axes[1] < SHEET_CB;
		if (f.sheet) sheetArea += f.area;
		area += f.area;
		if (!big || f.area > big.area) big = f;
	});
	if (res === "coarse") warnings.push({ code: "COARSE", message: "Point spacing " + sp(spacing) + ": rocks under about " + sz(floor) + " are not measured; P-values under that are not sizes." });
	else if (res === "oversize") warnings.push({ code: "OVERSIZE_ONLY", message: "Point spacing " + sp(spacing) + ": only rocks over about " + sz(floor) + " can be measured. Use this for oversize, not for a size curve." });
	else if (res === "unresolved") warnings.push({ code: "UNRESOLVED", message: "Point spacing " + sp(spacing) + ": this cloud cannot resolve rocks; the fragments are mostly patches of surface. Rock sizing needs a spacing of about 0.017 or finer (photogrammetry at full image scale, e.g. ODM --pc-quality ultra)." });
	if (g.maxDistance !== undefined && spacing > 0) {
		var ratio = g.maxDistance / spacing;
		if (ratio < MD_LOW || ratio > MD_HIGH) warnings.push({ code: "MAX_DISTANCE", message: "maxDistance " + g.maxDistance + " is " + Math.round(ratio) + " point spacings (" + sp(spacing) + "); about 4 (" + sp(4 * spacing) + ") suits this cloud." });
	}
	if (area > 0 && sheetArea > SHEET_SHARE * area) warnings.push({ code: "SHEETS", message: Math.round(100 * sheetArea / area) + "% of the surface is flat patches, counted under the lower limit." });
	if (big && fr.surfaceArea > 0 && big.area > FLOOR_SHARE * fr.surfaceArea) warnings.push({ code: "FLOOR", message: "Fragment " + big.id + " covers " + Math.round(100 * big.area / fr.surfaceArea) + "% of the surface: the floor or a wall? Draw the polygon round the pile (or delete it) and run again." });
	if (g.sideOn) warnings.push({ code: "SIDE_ON", message: "This cloud is seen side-on; the watershed sees from above: use method facets." });
	if (g.ignored && g.ignored.length) warnings.push({ code: "IGNORED_OPTIONS", message: "The watershed does not use " + g.ignored.join(", ") + "." });
	fr.spacing = spacing; fr.floor = floor; fr.resolution = res; fr.warnings = warnings;
	return fr;
}
