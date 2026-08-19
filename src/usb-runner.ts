import { spawn } from 'child_process';
import { Buffer } from 'buffer';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

interface CancelablePromise {
	promise: Promise<string>;
	cancel: () => void;
	onOutput?: (chunk: string) => void;
}

// ── Module skip sets (mirrors scripts/build.py) ─────────────────────────────

/** Built-in / MicroPython / hub modules that should NOT be uploaded. */
const STDLIB_MODULES = new Set([
	'__future__', '_thread', 'abc', 'antigravity', 'array', 'asyncio',
	'builtins', 'cmath', 'collections', 'contextlib', 'datetime',
	'errno', 'gc', 'genericpath', 'heapq', 'html', 'io', 'math',
	'microbit', 'micropython', 'operator', 'os', 'passive', 'pbui',
	'pi', 'platform', 'ppid', 'random', 're', 'runloop', 'select',
	'shutil', 'socket', 'statistics', 'struct', 'sys', 'time',
	'ucollections', 'uerrno', 'urandom', 'ure', 'urllib', 'uzlib',
	'webbrowser', 'weakref', 'websocket', 'ws', 'framebuf',
	'video', 'wave', 'utime',
]);

/** SPIKE Prime hub builtins — always available on the hub. */
const SPIKE_BUILTINS = new Set([
	'hub', 'port', 'motion_sensor', 'sound', 'button', 'display',
	'speaker',
]);

/** Third-party modules shipped on the hub. */
const THIRD_PARTY_MODULES = new Set([
	'motor_pair',
]);

const SKIP_MODULES = new Set([...STDLIB_MODULES, ...SPIKE_BUILTINS, ...THIRD_PARTY_MODULES]);

/** Lightweight logger for upload progress messages. */
function logUpload(msg: string): void {
	console.log(`[lego-sbx] ${msg}`);
}

/**
 * Compile a single .py file to .mpy using mpy-cross.
 *
 * Writes the .mpy into *buildDir* (created if needed).  Returns the .mpy
 * path on success, or the original .py path on failure (graceful fallback).
 */
export function compileLibrary(sourcePath: string, buildDir: string): Promise<string> {
	const fs = require('fs');
	const mpyName = `${path.basename(sourcePath, '.py')}.mpy`;
	const mpyPath = path.join(buildDir, mpyName);

	// Ensure build directory exists.
	if (!fs.existsSync(buildDir)) {
		fs.mkdirSync(buildDir, { recursive: true });
	}

	return new Promise<string>((resolve) => {
		const cp = spawn('mpy-cross', ['-o', mpyPath, sourcePath], { stdio: ['pipe', 'pipe', 'pipe'] });

		cp.on('close', (code) => {
			if (code === 0) {
				const size = fs.statSync(mpyPath).size;
				logUpload(`  Compiled ${path.basename(sourcePath)} → ${mpyName} (${size} bytes)`);
				resolve(mpyPath);
			} else {
				logUpload(`  ⚠ mpy-cross failed for ${path.basename(sourcePath)}, using .py source`);
				resolve(sourcePath);
			}
		});

		cp.on('error', () => {
			logUpload(`  ⚠ mpy-cross not found, using .py source`);
			resolve(sourcePath);
		});
	});
}

// ── Import parsing & module resolution ───────────────────────────────────────

/**
 * Extract top-level module names imported by a file.
 *
 * Mirrors scripts/build.py::parse_imports.  Strips a leading ``lib.``
 * prefix (a common convention for project-local packages) so that
 * ``from lib.navigation import foo`` resolves to the ``navigation``
 * module on disk.
 */
export function parseImports(content: string): string[] {
	const imports: string[] = [];
	const pattern = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/;

	for (const line of content.split('\n')) {
		const stripped = line.trim();
		if (stripped.startsWith('#') || stripped.startsWith('"""') || stripped.startsWith("'''")) {
			continue;
		}
		const m = pattern.exec(line);
		if (m) {
			const module = m[1] || m[2];
			// Strip leading "lib." prefix used for local packages
			const clean = module.startsWith('lib.') ? module.slice(4) : module;
			const top = clean.split('.')[0];
			imports.push(top);
		}
	}

	return imports;
}

/**
 * Try to resolve a module name to a local .py file on disk.
 *
 * Mirrors scripts/build.py::resolve_module.  Checks the base directory
 * first, then the ``lib/`` directory as a fallback for local library
 * packages.
 */
export function resolveModule(module: string, baseDir: string): string | null {
	// Check project root
	const pyCandidate = path.join(baseDir, `${module}.py`);
	if (require('fs').existsSync(pyCandidate)) return pyCandidate;

	const initCandidate = path.join(baseDir, module, '__init__.py');
	if (require('fs').existsSync(initCandidate)) return initCandidate;

	// Fallback: check lib/ directory for local library packages
	const libPyCandidate = path.join(baseDir, 'lib', `${module}.py`);
	if (require('fs').existsSync(libPyCandidate)) return libPyCandidate;

	const libInitCandidate = path.join(baseDir, 'lib', module, '__init__.py');
	if (require('fs').existsSync(libInitCandidate)) return libInitCandidate;

	return null;
}

/**
 * Collect all importable local files reachable from the main file.
 *
 * Mirrors scripts/build.py::collect_files.  BFS from the main file,
 * resolving each import, skipping stdlib/builtins/third-party sets.
 * Returns the library files first (sorted by name), then the main file last.
 */
export function collectLocalFiles(mainFilePath: string, baseDir: string): string[] {
	const visited = new Set<string>();
	const order: string[] = [];
	const queue: [string, boolean][] = [[mainFilePath, true]];

	while (queue.length > 0) {
		const [filePath, isMain] = queue.shift()!;
		const canonical = require('fs').realpathSync(filePath);

		if (visited.has(canonical)) continue;
		visited.add(canonical);

		const moduleName = require('path').basename(canonical, '.py');
		if (SKIP_MODULES.has(moduleName)) continue;
		if (!resolveModule(moduleName, baseDir)) {
			if (!filePath.endsWith('.py')) continue;
		}

		order.push(canonical);

		// Read imports from this file and resolve them
		try {
			const content = require('fs').readFileSync(filePath, 'utf-8');
			const imports = parseImports(content);
			for (const mod of imports) {
				const resolved = resolveModule(mod, baseDir);
				if (resolved && !visited.has(require('fs').realpathSync(resolved))) {
					queue.push([resolved, false]);
				}
			}
		} catch {
			// If we can't read the file, skip its imports
		}
	}

	// Main file last, everything else alphabetically
	const mainResolved = require('fs').realpathSync(mainFilePath);
	const others = order
		.filter((f) => require('fs').realpathSync(f) !== mainResolved)
		.sort((a, b) => require('path').basename(a).localeCompare(require('path').basename(b)));
	const mainFiles = order.filter((f) => require('fs').realpathSync(f) === mainResolved);

	return [...others, ...mainFiles];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a Python file on the hub connected at *devicePath*.
 *
 * Steps:
 *  1. Copy the file to the hub at `/flash/program.py`
 *  2. Start execution with `mpremote run program.py`
 *
 * Returns a promise that resolves when the program finishes, plus a `cancel`
 * method to kill the running program (useful for the stop button).
 *
 * @param devicePath - USB device path (e.g. '/dev/ttyACM0')
 * @param filePath   - Absolute path to the Python file on the local machine
 * @returns A promise that resolves with the program output, with a `.cancel()` method
 * @throws Error if mpremote exits with non-zero status
 */
export function runOnUsb(devicePath: string, filePath: string): CancelablePromise {
	let runProc: ReturnType<typeof spawn> | null = null;

	const result: CancelablePromise = {
		promise: new Promise<string>((resolve, reject) => {
			const remotePath = '/flash/program.py';

			// Step 1: Copy the file to the hub
			const cpProc = spawn('mpremote', ['connect', devicePath, 'cp', filePath, remotePath], {
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			let cpStdout = '';
			let cpStderr = '';

			cpProc.stdout!.on('data', (chunk: Buffer) => {
				cpStdout += chunk.toString();
				result.onOutput?.(chunk.toString());
			});
			cpProc.stderr!.on('data', (chunk: Buffer) => {
				cpStderr += chunk.toString();
				result.onOutput?.(chunk.toString());
			});

			cpProc.on('close', (cpCode) => {
				if (cpCode !== 0 && cpCode !== null) {
					reject(new Error(`mpremote cp failed (exit ${cpCode}). ${cpStdout}${cpStderr}`));
					return;
				}

				// Step 2: Run the file on the hub
				runProc = spawn('mpremote', ['connect', devicePath, 'run', remotePath], {
					stdio: ['pipe', 'pipe', 'pipe'],
				});

				let runStdout = '';
				let runStderr = '';

				runProc.stdout!.on('data', (chunk: Buffer) => {
					runStdout += chunk.toString();
					result.onOutput?.(chunk.toString());
				});
				runProc.stderr!.on('data', (chunk: Buffer) => {
					runStderr += chunk.toString();
					result.onOutput?.(chunk.toString());
				});

				runProc.on('close', (runCode) => {
					const combined = (runStdout + runStderr).trim();
					if (runCode !== 0 && runCode !== null) {
						reject(new Error(`mpremote run failed (exit ${runCode}). ${combined}`));
						return;
					}
					resolve(combined);
				});

				runProc.on('error', (err) => {
					reject(new Error(`Failed to run on hub: ${err.message}`));
				});
			});

			cpProc.on('error', (err) => {
				reject(new Error(`Failed to copy file to hub: ${err.message}`));
			});
		}),
		cancel: () => { if (runProc) { runProc.kill(); runProc = null; } },
	};

	return result;
}

/**
 * Upload a file to the hub connected at *devicePath* into the given slot.
 *
 * Steps:
 *  1. Compile library files to .mpy (if enabled) and copy them to the hub root (`:`)
 *  2. Copy the main file to the hub at `:program/{NN}/program.py`
 *  3. Optionally start execution via `mpremote exec`
 *
 * @param devicePath - USB device path (e.g. '/dev/ttyACM0')
 * @param filePath   - Absolute path to the Python file on the local machine
 * @param fileName   - Name for the file on the hub (default 'program.py')
 * @param slot       - Target slot number (0-19)
 * @param startAfter - Whether to run the file after copying (default true)
 * @param libraries  - Additional local files to upload to the hub root (default [])
 * @param compileLibraries - Compile libraries to .mpy before upload (default true)
 * @returns A promise that resolves when the operation completes, with a `.cancel()` method
 * @throws Error if mpremote exits with non-zero status
 */
export function uploadToUsb(
	devicePath: string,
	filePath: string,
	fileName: string = 'program.py',
	slot: number = 0,
	startAfter: boolean = true,
	libraries: string[] = [],
	compileLibraries: boolean = true,
): CancelablePromise {
	let cpProc: ReturnType<typeof spawn> | null = null;
	let runCancel = () => {};

	const result: CancelablePromise = {
		promise: new Promise<string>((resolve, reject) => {
			(async () => {
				const paddedSlot = String(slot).padStart(2, '0');
				const remotePath = `:program/${paddedSlot}/${fileName}`;

				/**
				 * Spawn a single `mpremote cp` and call *onDone* on success.
				 * Pipes stdout/stderr through the result callback.
				 */
				const cpOne = (localPath: string, remote: string, onDone: () => void): void => {
					cpProc = spawn('mpremote', ['connect', devicePath, 'cp', localPath, remote], {
						stdio: ['pipe', 'pipe', 'pipe'],
					});

					let stdout = '';
					let stderr = '';

					cpProc.stdout!.on('data', (chunk: Buffer) => {
						const txt = chunk.toString();
						stdout += txt;
						result.onOutput?.(txt);
					});
					cpProc.stderr!.on('data', (chunk: Buffer) => {
						const txt = chunk.toString();
						stderr += txt;
						result.onOutput?.(txt);
					});

					cpProc.on('close', (code) => {
						if (code !== 0 && code !== null) {
							reject(new Error(`mpremote cp failed (exit ${code}). ${stdout}${stderr}`));
							return;
						}
						logUpload(`  ✓ ${path.basename(localPath)}`);
						onDone();
					});

					cpProc.on('error', (err) => {
						reject(new Error(`Failed to copy ${path.basename(localPath)} to hub: ${err.message}`));
					});
				};

				/** Kick off the post-copy action (run or just resolve). */
				const finishCopy = (): void => {
					if (!startAfter) {
						resolve('');
						return;
					}
					const run = runProgramOnUsb(devicePath, remotePath);
					runCancel = run.cancel;
					run.promise.then(resolve, reject);
					run.onOutput = (chunk: string) => { result.onOutput?.(chunk); };
				};

					const buildDir = path.join(path.dirname(filePath), 'build');
					if (libraries.length > 0) {
						// Compile libraries + main to .mpy (runs inside the Promise, so async is fine).
						if (compileLibraries) {
							logUpload(`Compiling ${libraries.length + 1} file(s)…`);
						}
						const compiled: Record<string, string> = {};
						let compileError = false;

						// Resolve all library compilations in parallel.
						const compileResults = await Promise.all(
							libraries.map(async (libPath) => {
								if (!compileLibraries) return libPath;
								try {
									const mpy = await compileLibrary(libPath, buildDir);
									compiled[libPath] = mpy;
									return mpy;
								} catch {
									compileError = true;
									return libPath; // fall back to .py
								}
							}),
						);

						if (compileError) {
							logUpload('Some compilations failed, falling back to .py sources');
						}

						logUpload(`Uploading ${libraries.length} library file(s) to hub root…`);
						let idx = 0;
						const uploadNext = async (): Promise<void> => {
							if (idx < libraries.length) {
								const libPath = libraries[idx++];
								const uploadPath = compiled[libPath] || libPath;
								logUpload(`  ${path.basename(uploadPath)} → :${path.basename(uploadPath)}`);
								cpOne(uploadPath, `:${path.basename(uploadPath)}`, uploadNext);
							} else {
								// All libraries uploaded — compile and upload main program as .mpy.
								logUpload('Compiling main program file…');
								if (compileLibraries) {
									try {
										const mainMpy = await compileLibrary(filePath, buildDir);
										const mainRemote = `:program/${paddedSlot}/program.mpy`;
										logUpload(`  ${path.basename(mainMpy)} → ${mainRemote}`);
										cpOne(mainMpy, mainRemote, finishCopy);
									} catch {
										logUpload('  ⚠ Compilation failed, using .py source');
										cpOne(filePath, remotePath, finishCopy);
									}
								} else {
									cpOne(filePath, remotePath, finishCopy);
								}
							}
						};
						uploadNext();
					} else {
						// No libraries — compile and upload main file as .mpy.
						if (compileLibraries) {
							logUpload('Compiling main program file…');
							try {
								const mainMpy = await compileLibrary(filePath, buildDir);
								const mainRemote = `:program/${paddedSlot}/program.mpy`;
								logUpload(`  ${path.basename(mainMpy)} → ${mainRemote}`);
								cpOne(mainMpy, mainRemote, finishCopy);
							} catch {
								logUpload('  ⚠ Compilation failed, using .py source');
								cpOne(filePath, remotePath, finishCopy);
							}
						} else {
							logUpload('Uploading main program file…');
							cpOne(filePath, remotePath, finishCopy);
						}
					}
			})();
		}),
		cancel: () => {
			if (cpProc) { cpProc.kill(); cpProc = null; }
			runCancel();
		},
	};

	return result;
}

/**
 * Run a program already on the hub without copying it first.
 *
 * Uses `mpremote exec` to inject Python code that imports the module
 * from the hub's filesystem and calls `runloop.run()`.
 * Suitable for "play" when the program is already stored on the hub.
 *
 * Supports paths like:
 *  - `:program/00/program.py` — program slot 0
 *  - `program/00/program.py`  — program slot 0 (no `:` prefix)
 *  - `program.py`             — /flash/program.py
 *
 * @param devicePath  - USB device path (e.g. '/dev/ttyACM0')
 * @param programPath - Path to the program on the hub
 * @returns A promise that resolves when the program finishes, with a `.cancel()` method
 * @throws Error if mpremote exits with non-zero status
 */
export function runProgramOnUsb(
	devicePath: string,
	programPath: string = 'program.py',
): CancelablePromise {
	let proc: ReturnType<typeof spawn> | null = null;

	const result: CancelablePromise = {
		promise: new Promise<string>((resolve, reject) => {
			// mpremote run only works with local files — use exec to run uploaded programs.
			// Follows the same pattern as scripts/run.py.
			const normalized = programPath.startsWith(':') ? programPath.slice(1) : programPath;

			// Derive module name and sys.path directory from the program path.
			let moduleName: string;
			let sysPath: string;

			if (/^program\/\d{2}\//.test(normalized)) {
				// e.g. program/00/program.py → dir=/flash/program/00, module=program
				const parts = normalized.split('/');
				const fileName = parts.pop()!;
				sysPath = `/flash/program/${parts[1]}`;
				moduleName = fileName.replace(/\.(py|mpy)$/, '');
			} else {
				// e.g. program.py → dir=/flash, module=program
				sysPath = '/flash';
				moduleName = normalized.replace(/\.(py|mpy)$/, '');
			}

			const execCode = [
				'import sys',
				`sys.path.insert(0, '${sysPath}')`,
				`import ${moduleName}`,
				'import runloop',
				'import helpers',
				`runloop.run(${moduleName}.main(), helpers.stop_on_button())`,
			].join('; ');

			proc = spawn(
				'mpremote',
				['connect', devicePath, 'exec', execCode],
				{ stdio: ['pipe', 'pipe', 'pipe'] },
			);

			let stdout = '';
			let stderr = '';

			proc.stdout!.on('data', (chunk: Buffer) => {
				stdout += chunk.toString();
				result.onOutput?.(chunk.toString());
			});
			proc.stderr!.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
				result.onOutput?.(chunk.toString());
			});

			proc.on('close', (code) => {
				const combined = (stdout + stderr).trim();
				if (code !== 0 && code !== null) {
					reject(new Error(`mpremote exec failed (exit ${code}). ${combined}`));
					return;
				}
				resolve(combined);
			});

			proc.on('error', (err) => {
				reject(new Error(`Failed to run on hub: ${err.message}`));
			});
		}),
		cancel: () => { if (proc) { proc.kill(); proc = null; } },
	};

	return result;
}