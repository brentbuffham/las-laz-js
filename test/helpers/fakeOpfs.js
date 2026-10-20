// test/helpers/fakeOpfs.js
//==========================================================
// In-memory stand-in for an OPFS directory handle, with
// FileSystemSyncAccessHandle-like file access. Test-only.
// Missing entries raise DOMException "NotFoundError" like OPFS.
// Sync access handles take an exclusive lock: a second handle, or
// removeEntry on a locked file, raises "NoModificationAllowedError".
//==========================================================

function notFound(name) {
	return new DOMException("not found: " + name, "NotFoundError");
}

function locked(name) {
	return new DOMException("locked: " + name, "NoModificationAllowedError");
}

function createFileEntry(name) {
	var entry = { kind: "file", name: name, data: new Uint8Array(0), lastModified: Date.now(), locked: false };
	entry.handle = {
		kind: "file",
		name: name,
		// Like OPFS, a File snapshot of the current bytes
		getFile: async function () { return new File([entry.data.slice()], name, { lastModified: entry.lastModified }); },
		createSyncAccessHandle: async function () {
			if (entry.locked) throw locked(name);
			entry.locked = true;
			return {
				read: function (buf, opts) {
					var at = (opts && opts.at) || 0;
					var n = Math.max(0, Math.min(buf.length, entry.data.length - at));
					buf.set(entry.data.subarray(at, at + n));
					return n;
				},
				write: function (buf, opts) {
					var at = (opts && opts.at) || 0;
					var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
					if (at + bytes.length > entry.data.length) {
						var grown = new Uint8Array(at + bytes.length);
						grown.set(entry.data);
						entry.data = grown;
					}
					entry.data.set(bytes, at);
					entry.lastModified = Date.now();
					return bytes.length;
				},
				truncate: function (n) {
					var next = new Uint8Array(n);
					next.set(entry.data.subarray(0, Math.min(n, entry.data.length)));
					entry.data = next;
				},
				getSize: function () { return entry.data.length; },
				flush: function () {},
				close: function () { entry.locked = false; }
			};
		}
	};
	return entry;
}

/**
 * @returns {object} directory handle with getDirectoryHandle, getFileHandle,
 *   removeEntry, values(), plus test hooks setLastModified(name, ms) and fileBytes(name).
 */
export function createFakeRoot(name) {
	var entries = new Map();
	var dir = {
		kind: "directory",
		name: name || "",
		getDirectoryHandle: async function (name, opts) {
			if (!entries.has(name)) {
				if (!(opts && opts.create)) throw notFound(name);
				entries.set(name, { kind: "directory", handle: createFakeRoot(name) });
			}
			return entries.get(name).handle;
		},
		getFileHandle: async function (name, opts) {
			if (!entries.has(name)) {
				if (!(opts && opts.create)) throw notFound(name);
				entries.set(name, createFileEntry(name));
			}
			return entries.get(name).handle;
		},
		removeEntry: async function (name) {
			var entry = entries.get(name);
			if (!entry) throw notFound(name);
			if (entry.locked) throw locked(name);
			entries.delete(name);
		},
		values: async function* () {
			for (var entry of entries.values()) yield entry.handle;
		},
		setLastModified: function (name, ms) { entries.get(name).lastModified = ms; },
		fileBytes: function (name) { return entries.has(name) ? entries.get(name).data : null; }
	};
	return dir;
}
