// Launches the engine with the scrubbed environment (env.mjs) and a time limit.
// Output is kept (tail-capped) for the run log and the issue's final comment.

import { spawn } from "node:child_process";

const TAIL_LIMIT = 200_000;

function tailCap(text) {
	return text.length > TAIL_LIMIT ? text.slice(text.length - TAIL_LIMIT) : text;
}

function killTree(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	} else {
		try {
			process.kill(-child.pid, "SIGKILL"); // detached: the child leads its own group
		} catch {
			child.kill("SIGKILL");
		}
	}
}

/** Calls `onLine` with each whole line of a stream; a partial line waits for the rest of it. */
function lineReader(onLine) {
	let partial = "";
	return (text) => {
		if (!onLine) return;
		const lines = (partial + text).split("\n");
		partial = tailCap(lines.pop());
		for (const line of lines) onLine(line);
	};
}

/**
 * Runs the engine's argv without a shell. Never throws on a nonzero exit:
 * the outcome is the result. Resolves { code, signal, timedOut, stdout, stderr }.
 * `onStdoutLine` and `onStderrLine` see each whole line of their stream as it arrives.
 */
export function runProcess({ argv, cwd, env, timeoutMs = 20 * 60_000, onSpawn, onStdoutLine, onStderrLine }) {
	return new Promise((resolvePromise) => {
		const [executable, ...args] = argv;
		const child = spawn(executable, args, {
			cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		// The admission gate samples the engine's tree from here; a listener's
		// failure must never fail the job.
		if (onSpawn) {
			try {
				onSpawn(child.pid);
			} catch {
				// Sampling is best-effort.
			}
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutMs);
		const stdoutLines = lineReader(onStdoutLine);
		const stderrLines = lineReader(onStderrLine);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (text) => {
			stdout = tailCap(stdout + text);
			stdoutLines(text);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text) => {
			stderr = tailCap(stderr + text);
			stderrLines(text);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ code: null, signal: null, timedOut, error: error.message, stdout, stderr });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolvePromise({ code, signal, timedOut, stdout, stderr });
		});
	});
}

/** The engine's argv with the prompt substituted for "{prompt}" (one element, no shell splitting). */
export function engineArgv(command, prompt) {
	return command.map((arg) => (arg === "{prompt}" ? prompt : arg));
}

/**
 * Reads the check reports an engine prints, one per line:
 * `RUNNER-CHECK: <name> = pass|fail`. Returns Map<name, boolean>; a check the engine did not
 * report is absent, which the caller shows as "not reported" rather than passed.
 */
export function parseCheckReports(output) {
	const reports = new Map();
	for (const line of String(output ?? "").split(/\r?\n/)) {
		const match = line.match(/^\s*RUNNER-CHECK:\s*(.+?)\s*=\s*(pass|fail)\s*$/i);
		if (match) reports.set(match[1].trim(), match[2].toLowerCase() === "pass");
	}
	return reports;
}
