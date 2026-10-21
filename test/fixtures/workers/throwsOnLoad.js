// test/fixtures/workers/throwsOnLoad.js
//==========================================================
// A worker entry that fails while loading, as a blocked or broken worker
// script would: the pool must fall back to one thread, not fail the read.
//==========================================================
throw new Error("this worker never starts");
