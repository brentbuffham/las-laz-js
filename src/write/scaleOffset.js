// src/write/scaleOffset.js
//==========================================================
// Pick a LAS scale and offset for a set of bounds — Kirra's rule
// (LASWriter.calculateScaleOffset): the offset is the centre of
// the bounds, the scale starts at 0.001 (millimetres) and grows by
// tens until the range fits comfortably inside an int32, or shrinks
// for tiny extents.
//==========================================================

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
	return {
		scale: { x: s, y: s, z: s },
		offset: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 }
	};
}
