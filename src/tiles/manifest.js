// src/tiles/manifest.js
//==========================================================
// A tile store's manifest, kept in two slots (store-a.json,
// store-b.json) written alternately. Each slot is { seq, sum, body }
// with sum the FNV-1a of the body's JSON, so a write cut short
// leaves the other slot, and opening takes the valid one with the
// higher seq.
//==========================================================

/** The store layout this library writes and reads. */
export var LAYOUT_VERSION = 1;

/** The manifest's two slots. */
export var MANIFEST_NAMES = Object.freeze(["store-a.json", "store-b.json"]);

/**
 * 32-bit FNV-1a of some bytes.
 * @param {Uint8Array} bytes
 * @returns {number} an unsigned 32-bit hash
 */
export function fnv1a(bytes) {
	var h = 0x811c9dc5;
	for (var i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0; // bits-ok (a hash, not a position)
}

function utf8(text) { return new TextEncoder().encode(text); }

async function readSlot(backend, name) {
	var bytes = await backend.get(name);
	if (!bytes) return null;
	try {
		var slot = JSON.parse(new TextDecoder().decode(bytes));
		if (!slot || typeof slot.seq !== "number" || !slot.body) return null;
		if (fnv1a(utf8(JSON.stringify(slot.body))) !== slot.sum) return null;
		return slot;
	} catch (e) {
		return null;
	}
}

/**
 * The newest valid manifest, or null when neither slot holds one.
 * @param {object} backend - from openBackend
 * @returns {Promise<{seq: number, body: object}|null>}
 */
export async function readManifest(backend) {
	var a = await readSlot(backend, MANIFEST_NAMES[0]), b = await readSlot(backend, MANIFEST_NAMES[1]);
	var best = a && (!b || a.seq > b.seq) ? a : b;
	return best ? { seq: best.seq, body: best.body } : null;
}

/**
 * Write a manifest into the slot not holding the newest one.
 * @param {object} backend - from openBackend
 * @param {object} body - JSON-able
 * @returns {Promise<number>} the new seq
 */
export async function writeManifest(backend, body) {
	var a = await readSlot(backend, MANIFEST_NAMES[0]), b = await readSlot(backend, MANIFEST_NAMES[1]);
	var seqA = a ? a.seq : 0, seqB = b ? b.seq : 0;
	var seq = Math.max(seqA, seqB) + 1;
	var name = seqA >= seqB && a ? MANIFEST_NAMES[1] : MANIFEST_NAMES[0];
	var text = JSON.stringify(body);
	await backend.put(name, utf8(JSON.stringify({ seq: seq, sum: fnv1a(utf8(text)), body: body })));
	return seq;
}
