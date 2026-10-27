// src/write/scaleOffset.js
//==========================================================
// Pick a LAS scale and offset for a set of bounds — Kirra's rule
// (LASWriter.calculateScaleOffset): the scale starts at 0.001
// (millimetres) and grows by tens until the range fits comfortably
// inside an int32, or shrinks for tiny extents. The offset is the
// bounds' centre snapped to a round number, a multiple of 100,000 x the
// scale (100 m at millimetres), as PDAL and LAStools keep offsets round:
// the stored integers stay readable and files of one site share them.
// The snap moves the centre at most 50,000 counts; the range is at most
// 2e9, so every point stays well inside an int32.
//==========================================================

var SNAP = 100000;

/**
 * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} b
 * @returns {{scale:{x:number,y:number,z:number}, offset:{x:number,y:number,z:number}}}
 */
export function chooseScaleOffset(b) {
	var range = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
	var s = 0.001;
	while (range / s > 2000000000) s *= 10;
	while (range > 0 && range / s < 1000 && s > 0.0000001) s /= 10;
	s = Number(s.toPrecision(1));
	var u = s * SNAP;
	function snap(c) { var r = Math.round(c / u) * u; return Number(r.toPrecision(15)); }
	return {
		scale: { x: s, y: s, z: s },
		offset: { x: snap((b.minX + b.maxX) / 2), y: snap((b.minY + b.maxY) / 2), z: snap((b.minZ + b.maxZ) / 2) }
	};
}
