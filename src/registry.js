'use strict';

const fsp = require('fs/promises');

/**
 * Slot registry (SPEC.md §5). Windows cooperate through one JSON file with
 * heartbeat-expiring claims, so a crashed window's slot is reclaimed on its own.
 *
 * No `vscode` import: everything it needs is injected, which is what lets
 * test/registry.test.js drive it directly.
 */
class SlotRegistry {
	/**
	 * @param {object} deps
	 * @param {string} deps.filePath registry file
	 * @param {string} deps.sessionId identifies this window
	 * @param {() => number} deps.staleMs claim expiry
	 * @param {(msg: string) => void} [deps.trace]
	 * @param {() => number} [deps.jitter] conflict-settle delay in ms; injectable for tests
	 */
	constructor({ filePath, sessionId, staleMs, trace, jitter }) {
		this.filePath = filePath;
		this.sessionId = sessionId;
		this.staleMs = staleMs;
		this.trace = trace || (() => { });
		this.jitter = jitter || (() => 100 + Math.floor(Math.random() * 300));
	}

	async read() {
		try {
			const raw = await fsp.readFile(this.filePath, 'utf8');
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed.claims) ? parsed.claims : [];
		} catch (err) {
			if (err && err.code !== 'ENOENT') {
				this.trace(`registry read failed, starting empty: ${err.message}`);
			}
			return [];
		}
	}

	async write(claims) {
		// Temp file + rename, so a window reading mid-write never sees a partial file.
		const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await fsp.writeFile(tmp, JSON.stringify({ claims }, null, '\t'), 'utf8');
		await fsp.rename(tmp, this.filePath);
	}

	/** Claims still being heartbeated. */
	live(claims, now = Date.now()) {
		const stale = this.staleMs();
		return claims.filter(c => c && typeof c.slot === 'number' && now - c.ts < stale);
	}

	static lowestFreeSlot(claims) {
		const used = new Set(claims.map(c => c.slot));
		let n = 0;
		while (used.has(n)) {
			n++;
		}
		return n;
	}

	async claim() {
		const now = Date.now();
		const others = this.live(await this.read(), now).filter(c => c.sid !== this.sessionId);
		const mine = { sid: this.sessionId, slot: SlotRegistry.lowestFreeSlot(others), ts: now };
		await this.write([...others, mine]);
		return mine.slot;
	}

	/**
	 * Two windows opening at the same moment can pick the same slot: both read the
	 * registry before either wrote. Settle it after a jittered delay — the claim with
	 * the later timestamp yields, sessionId breaks exact ties.
	 */
	async resolveConflict() {
		await new Promise(r => setTimeout(r, this.jitter()));
		const claims = this.live(await this.read());
		const mine = claims.find(c => c.sid === this.sessionId);
		if (!mine) {
			this.trace('own claim vanished (stale or overwritten), re-claiming');
			return this.claim();
		}
		const rival = claims.find(c =>
			c.sid !== this.sessionId &&
			c.slot === mine.slot &&
			(c.ts < mine.ts || (c.ts === mine.ts && c.sid < this.sessionId))
		);
		if (!rival) {
			return mine.slot;
		}
		this.trace(`slot ${mine.slot} collided with ${rival.sid}, yielding`);
		return this.claim();
	}

	async heartbeat(slot, folder) {
		try {
			const now = Date.now();
			const others = this.live(await this.read(), now).filter(c => c.sid !== this.sessionId);
			await this.write([...others, { sid: this.sessionId, slot, ts: now, folder: folder || null }]);
		} catch (err) {
			this.trace(`heartbeat failed: ${err.message}`);
		}
	}

	async release() {
		try {
			const claims = await this.read();
			await this.write(claims.filter(c => c.sid !== this.sessionId));
		} catch (err) {
			this.trace(`release failed: ${err.message}`);
		}
	}
}

module.exports = { SlotRegistry };
