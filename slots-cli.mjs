#!/usr/bin/env node
// The admission gate's CLI: the hand launcher and the runner share one lock.
//
//   node slots-cli.mjs acquire --class heavy --task ENG-69 [--worktree <path>] [--launcher hand]
//                              [--pid <pid>] [--docker-cloud-ok] [--wait <seconds>]
//   node slots-cli.mjs attach --id <claimId> --pid <pid>
//   node slots-cli.mjs release --id <claimId> [--code <exitCode>]
//   node slots-cli.mjs status [--json]
//   node slots-cli.mjs report [--since <date>] [--json] (the routing pilot's summary of ended claims)
//   node slots-cli.mjs peak --pid <pid> --class heavy [--id <claimId>]   (sample until it exits)
//   node slots-cli.mjs reap                             (record a reap notice's memory)
//
// Options: --dir <path> (default ~/.codex-jobs/.slots), --mode advise|enforce, --reserve-gib <n>,
// --max-heavy <n>. acquire prints one JSON line; exit 0 admitted, 3 held (the reason is in it).
// Node 24, no dependencies.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, GIB, samplePeak, SlotsGate, SLOT_DEFAULTS } from "./slots.mjs";

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const args = { command, flags: {} };
	for (let i = 0; i < rest.length; i++) {
		const name = rest[i].replace(/^--/, "");
		const next = rest[i + 1];
		if (next === undefined || next.startsWith("--")) args.flags[name] = true;
		else {
			args.flags[name] = next;
			i++;
		}
	}
	return args;
}

function gateFrom(args) {
	return new SlotsGate({
		dir: args.flags.dir ?? SLOT_DEFAULTS.dir,
		mode: args.flags.mode ?? SLOT_DEFAULTS.mode,
		reserveBytes: args.flags["reserve-gib"] ? Number(args.flags["reserve-gib"]) * GIB : SLOT_DEFAULTS.reserveBytes,
		maxHeavy: args.flags["max-heavy"] ? Number(args.flags["max-heavy"]) : SLOT_DEFAULTS.maxHeavy,
		log: (message) => console.error(`[slots] ${message}`),
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(args) {
	const klass = args.flags.class ?? "heavy";
	const waitSeconds = Number(args.flags.wait ?? 0);
	const gate = gateFrom(args);
	const deadline = Date.now() + waitSeconds * 1000;
	for (;;) {
		const result = await gate.acquire({
			klass,
			task: args.flags.task ?? null,
			worktree: args.flags.worktree ?? null,
			launcher: args.flags.launcher ?? "hand",
			pid: args.flags.pid ? Number(args.flags.pid) : null,
			pidStartMs: args.flags["pid-start"] ? Number(args.flags["pid-start"]) : null,
			dockerCloudEligible: args.flags["docker-cloud-ok"] === true,
			// a hand job's only routing fact is the launcher's own word that it is portable.
			route: args.flags["docker-cloud-ok"] === true
				? { advice: "cloud", reasons: ["the launcher marked it portable"] }
				: null,
		});
		if (result.admitted) {
			console.log(JSON.stringify({ admitted: true, claimId: result.claim.id, reason: result.reason, advisory: result.advisory }));
			return 0;
		}
		if (Date.now() + 5000 > deadline) {
			console.log(JSON.stringify({ admitted: false, reason: result.reason }));
			return 3;
		}
		console.error(`[slots] waiting: ${result.reason}`);
		await sleep(Math.min(5000, deadline - Date.now()));
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	switch (args.command) {
		case "acquire":
			process.exitCode = await acquire(args);
			return;
		case "attach": {
			const gate = gateFrom(args);
			const claim = await gate.attach(args.flags.id, { pid: Number(args.flags.pid), pidStartMs: args.flags["pid-start"] ? Number(args.flags["pid-start"]) : null });
			console.log(JSON.stringify({ attached: claim.id, pid: claim.pid }));
			return;
		}
		case "release": {
			const gate = gateFrom(args);
			const released = await gate.release(args.flags.id, { code: args.flags.code != null ? Number(args.flags.code) : null });
			console.log(JSON.stringify({ released }));
			if (!released) process.exitCode = 4;
			return;
		}
		case "status": {
			const gate = gateFrom(args);
			const status = await gate.status();
			if (args.flags.json === true) {
				console.log(JSON.stringify(status, null, 2));
				return;
			}
			const gib = (bytes) => (bytes == null ? "unknown" : `${(bytes / GIB).toFixed(1)} GiB`);
			console.log(`mode: ${status.mode}; reserve ${gib(status.reserveBytes)}; max heavy ${status.maxHeavy}`);
			console.log(`memory: available ${gib(status.memory.availableBytes)}, commit free ${gib(status.memory.commitAvailableBytes)}`);
			for (const [klass, peak] of Object.entries(status.peaks)) {
				const host = peak.hostBytes != null ? `, ${gib(peak.hostBytes)} taken from available memory` : "";
				console.log(`peak (${klass}): working set ${gib(peak.bytes)}${host} (${peak.at})`);
			}
			if (!status.claims.length) console.log("claims: none");
			for (const claim of status.claims) {
				console.log(
					`claim ${claim.id.slice(0, 8)}: ${claim.class} ${claim.task ?? "(no task)"} — ${claim.launcher}, pid ${claim.pid ?? "none"}, since ${claim.since}${claim.dockerCloudEligible ? ", docker-cloud eligible" : ""}${claim.route ? `, advice ${claim.route}` : ""}`,
				);
			}
			for (const ended of status.history) {
				console.log(`ended ${ended.task}: ${ended.endedHow}${ended.exitCode != null ? `, exit ${ended.exitCode}` : ""}${ended.peakBytes != null ? `, peak ${gib(ended.peakBytes)}` : ""}${ended.hostPeakBytes != null ? ` (${gib(ended.hostPeakBytes)} from available)` : ""}${ended.route ? `, advice ${ended.route}` : ""} (${ended.endedAt})`);
			}
			return;
		}
		case "report": {
			const gate = gateFrom(args);
			const report = await gate.report({ since: typeof args.flags.since === "string" ? args.flags.since : null });
			console.log(args.flags.json === true ? JSON.stringify(report, null, 2) : formatReport(report));
			return;
		}
		case "peak": {
			const gate = gateFrom(args);
			const klass = args.flags.class ?? "heavy";
			const claimId = typeof args.flags.id === "string" ? args.flags.id : null;
			const peak = await samplePeak({ pid: Number(args.flags.pid), klass, gate, claimId, log: (m) => console.error(`[slots] ${m}`) });
			console.log(JSON.stringify({ peakBytes: peak }));
			return;
		}
		case "reap": {
			// when a reap notice arrives, record the memory at that moment.
			const gate = gateFrom(args);
			const memory = await gate.probe();
			const dir = gate.dir;
			await mkdir(dir, { recursive: true });
			await appendFile(join(dir, "reaps.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...memory })}\n`);
			console.log(JSON.stringify({ recorded: true, ...memory }));
			return;
		}
		default:
			console.error("usage: slots-cli.mjs acquire|attach|release|status|report|peak|reap (see the header)");
			process.exitCode = 2;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`slots: ${error.message}`);
		process.exit(1);
	});
}
