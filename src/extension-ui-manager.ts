import {
	Disposable,
	OutputChannel,
	Position,
	StatusBarAlignment,
	StatusBarItem,
	Uri,
	window,
	commands,
} from 'vscode';
import * as path from 'path';
import type * as Discovery from './hub-discovery';
import type { BleConnectionManager } from './ble-connection';
import type { DeviceStateStore } from './ble-connection';
import { WebviewPanelManager } from './webview-panel';
import { runOnUsb, runProgramOnUsb, uploadToUsb, collectLocalFiles, compileLibrary } from './usb-runner';

/**
 * Central coordinator for all LEGO extension UI state and commands.
 *
 * Owns the status bar item, webview panel manager, and command
 * registrations in one place.  Ensures the webview panel is created
 * (lazily) whenever a connection-related UI update is requested so
 * that commands always propagate to every connected UI element.
 */
export class ExtensionUIManager implements Disposable {
	private statusBar!: StatusBarItem;
	private isConnected = false;
	private hubName = 'Unknown';
	private selectedBleAddress: string | null = null;
	private hubType: 'ble' | 'usb' | null = null;
	private hubDevice: string = '';

	/** Tracks the cancel function for the currently running USB program. */
	private usbRunCancel: (() => void) | null = null;

	/** Whether the webview panel has been created at least once. */
	private panelCreated = false;

	constructor(
		private bleManager: BleConnectionManager,
		private deviceState: DeviceStateStore,
		private outputChannel: OutputChannel,
		private consoleChannel: OutputChannel,
		private webviewPanelManager: WebviewPanelManager,
	) {
		this.statusBar = this.createStatusBar();
		this.wireUpDisconnectHandler();
	}

	private wireUpDisconnectHandler(): void {
		this.bleManager.onDisconnect = () => {
			this.isConnected = false;
			this.updateConnectionIcon(false);
			this.webviewPanelManager.showDisconnected();
			this.log('Hub disconnected (force or explicit).');
		};
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/**
	 * Register all extension commands.  Returns a disposable that
	 * unregisters every command when called.
	 */
	registerCommands(): Disposable {
		return Disposable.from(
			commands.registerCommand('lego.connectHub', () => this.handleConnect()),
			commands.registerCommand('lego.disconnectHub', () => this.handleDisconnect()),
			commands.registerCommand('lego.runOnHub', (slot?: number) => this.handleRunOnHub(slot)),
			commands.registerCommand('lego.uploadToHub', (uri?: Uri) => this.handleUploadToHub(uri)),
			commands.registerCommand('lego.stopHub', () => this.handleStopHub()),
			commands.registerCommand('lego.playSlotOnHub', (slot: number) => this.handlePlaySlotOnHub(slot)),
			commands.registerCommand('lego.showDeviceState', () => this.webviewPanelManager.show()),
		);
	}

	/**
	 * Immediately show the webview panel (creating it if necessary)
	 * and push the current device state into it.
	 */
	showPanel(): void {
		this.panelCreated = true;
		this.webviewPanelManager.show();
	}

	/** Dispose of all owned resources. */
	dispose(): void {
		this.statusBar.dispose();
	}

	// ── Status Bar ────────────────────────────────────────────────────────────

	private createStatusBar(): StatusBarItem {
		const btn = window.createStatusBarItem(
			'lego.connectHub',
			StatusBarAlignment.Left,
			101,
		);
		this.statusBar = btn;
		this.updateConnectionIcon(false);
		btn.command = 'lego.connectHub';
		btn.tooltip = 'LEGO Spike Prime: Click to connect';

		// Defer .show() until after VS Code's UI is fully initialized.
		setImmediate(() => {
			btn.show();
		});

		return btn;
	}

	
	public setHubName(name: string): void {
		this.hubName = name;
		if (this.isConnected) {
			this.statusBar.text = `$(check) Connected to ${this.hubName}`;
		}
	}

	private updateConnectionIcon(connected: boolean): void {
		this.isConnected = connected;
		this.setContext(connected);
		if (connected) {
			this.statusBar.text = `$(check) Connected to ${this.hubName}`;
			this.statusBar.tooltip = 'LEGO Spike Prime: Click for menu';
		} else {
			this.statusBar.text = '$(plug) Connect to Hub';
			this.statusBar.tooltip = 'LEGO Spike Prime: Click to connect';
		}
	}

	private setContext(connected: boolean): void {
		// Lazy require — vscode module is only available after activation.
		const vscode = require('vscode');
		if (vscode.setContext) {
			vscode.setContext('lego.isConnected', connected);
		}
	}

	// ── Command Handlers ──────────────────────────────────────────────────────

	private async handleConnect(): Promise<void> {
		this.log('Connect button clicked');

		// Reveal the console channel so the user sees live output.
		this.outputChannel.show(true);

		if (this.isConnected) {
			// Left-click when connected: show a QuickPick menu.
			this.log('Already connected — showing menu');
			const menuChoice = await window.showQuickPick(
				[
					{ label: '$(output) Device State', description: 'View device state', value: 'state' },
					{ label: '$(circle-slash) Disconnect', description: 'Disconnect from hub', value: 'disconnect' },
				],
				{ placeHolder: 'LEGO Spike Prime: Choose an action' },
			);
			if (menuChoice?.value === 'state') {
				this.showPanel();
			} else if (menuChoice?.value === 'disconnect') {
				await commands.executeCommand('lego.disconnectHub');
			}
			return;
		}

		// ── Scanning phase ───────────────────────────────────────────────
		this.log('Connecting to hub — starting scan');
		this.statusBar.text = '$(loading) Scanning for Hubs…';
		this.statusBar.tooltip = 'LEGO Spike Prime: Scanning for hubs…';

		// Create the panel so scanning UI is visible immediately.
		this.panelCreated = true;
		this.webviewPanelManager.showScanning();

		try {
			this.log('Calling hub-discovery scanForBLEHubs');

			// Run BLE and USB scans in parallel.
			const blePromise = (async () => {
					try {
						const { scanForBLEHubs } = await import('./hub-discovery');
						return await scanForBLEHubs((msg: string) => this.log(msg));
					} catch (err) {
this.log(`BLE scan error: ${(err as Error).message}`);
						return [] as any[];
					}
				})();
			const usbPromise = (async () => {
				try {
					const { scanUsbHubs } = await import('./usb-scan');
					return await scanUsbHubs();
				} catch {
					return [] as import('./usb-scan').UsbHubInfo[];
				}
			})();

			const [bleHubs, usbHubs] = await Promise.all([blePromise, usbPromise]);
			this.log(`BLE scan found ${bleHubs.length}, USB scan found ${usbHubs.length} hub(s)`);

			const allHubs: Array<{
				source: 'ble' | 'usb';
				name?: string;
				address?: string;
				device?: string;
				model?: string;
				rssi?: number;
			}> = [];

			for (const h of bleHubs) {
				allHubs.push({ source: 'ble', name: h.name, address: h.address, model: h.model, rssi: h.rssi });
			}
			for (const h of usbHubs) {
				allHubs.push({ source: 'usb', device: h.device });
			}

			if (allHubs.length === 0) {
				this.log('No hubs found');
				window.showInformationMessage(
					'No hubs found. Make sure your hub is turned on (BLE) or connected via USB.',
				);
				this.updateConnectionIcon(false);
				this.webviewPanelManager.showDisconnected();
				return;
			}

			this.log(`Showing QuickPick for ${allHubs.length} hub(s)`);
			const choices = allHubs.map((h) => {
				if (h.source === 'ble') {
					return {
						label: `\u{1F4F6} ${h.name || h.address}`,
						description: `[BLE] ${h.address}`,
						value: { source: 'ble' as const, name: h.name, address: h.address },
					};
				} else {
					return {
						label: `\u{1F50C} SPIKE Prime Hub`,
						description: `[USB] ${h.device}`,
						value: { source: 'usb' as const, device: h.device },
					};
				}
			});

			const selected = await window.showQuickPick(choices, {
				placeHolder: 'Select a hub to connect',
			});

			if (!selected) {
				this.log('User cancelled hub selection');
				this.updateConnectionIcon(false);
				this.webviewPanelManager.showDisconnected();
				return;
			}

			// ── BLE connection ───────────────────────────────────────────
			if (selected.value.source === 'ble') {
				const bleName = selected.value.name || selected.value.address || 'Unknown Hub';
				const bleAddr = selected.value.address || '';
				this.setHubName(bleName);
				this.selectedBleAddress = bleAddr;

				try {
					await this.bleManager.connect(bleAddr);
					this.updateConnectionIcon(true);
					this.hubType = 'ble';
					this.hubDevice = bleAddr;
					this.log(`Connected to ${bleName} (${bleAddr})`);
					window.showInformationMessage(`Connected to ${bleName}`);
					this.webviewPanelManager.showConnected('ble');
				} catch (err) {
					this.updateConnectionIcon(false);
					this.log(`BLE connection failed: ${(err as Error).message}`);
					window.showErrorMessage(`Failed to connect to ${bleName}: ${(err as Error).message}`);
					this.webviewPanelManager.showConnectionFailed();
				}
				return;
			}

			// ── USB connection ───────────────────────────────────────────
			this.setHubName('SPIKE Prime Hub');
			this.updateConnectionIcon(true);
			this.hubType = 'usb';
			this.hubDevice = selected.value.device || '';
			this.log(`Connected to ${selected.value.device} (USB)`);
			window.showInformationMessage(`Connected to SPIKE Prime Hub via ${selected.value.device}`);
			this.webviewPanelManager.showConnected('usb');

		} catch (err) {
			await this.handleScanError(err as Error);
		}
	}

	private async handleScanError(err: Error): Promise<void> {
		this.log(`Hub scan error: ${err.message}`);

		// BLE scan failed completely — try USB only.
		if (err.message.includes('BLE adapter') || err.message.includes('Cannot find module') ||
			err.message.includes('module not found') || err.message.includes('EACCES') ||
			err.message.includes('permission')) {

			this.log('BLE scan failed — trying USB-only');
			try {
				const { scanUsbHubs } = await import('./usb-scan');
				const usbHubs = await scanUsbHubs();
				this.log(`USB scan found ${usbHubs.length} hub(s)`);

				if (usbHubs.length === 0) {
					window.showInformationMessage(
						'No hubs found. BLE is unavailable and no USB hub detected.',
					);
					this.updateConnectionIcon(false);
					this.webviewPanelManager.showDisconnected();
					return;
				}

				const choices = usbHubs.map((h) => ({
					label: `\u{1F50C} SPIKE Prime Hub`,
					description: `[USB] ${h.device}`,
					value: h.device,
				}));

				const selected = await window.showQuickPick(choices, {
					placeHolder: 'Select a USB hub to connect',
				});
				if (selected) {
					this.setHubName('SPIKE Prime Hub');
					this.updateConnectionIcon(true);
					this.log(`Connected to ${selected}`);
					window.showInformationMessage(`Connected to ${selected}`);
				} else {
					this.log('User cancelled USB hub selection');
				}
				this.updateConnectionIcon(false);
				this.webviewPanelManager.showDisconnected();
			} catch (usbErr) {
				this.log(`USB scan also failed: ${(usbErr as Error).message}`);
				this.updateConnectionIcon(false);
				this.webviewPanelManager.showDisconnected();
				window.showInformationMessage(
					'Could not connect to any hub. BLE is unavailable and USB scan also failed. ' +
					'Make sure your hub is powered on and connected via USB.',
				);
			}
			return;
		}

		// Other scan errors.
		this.log(`Scan error: ${err.message}`);
		window.showInformationMessage(
			'No hubs found. Make sure your hub is turned on and in pairing mode.',
		);
		this.updateConnectionIcon(false);
	}

	private async handleDisconnect(): Promise<void> {
		this.log('Disconnecting from hub');
		this.bleManager.clearState();
		this.bleManager.disconnect();
		this.selectedBleAddress = null;
		this.hubType = null;
		this.hubDevice = '';
		this.updateConnectionIcon(false);
		this.webviewPanelManager.showDisconnected();
		window.showInformationMessage('Disconnected from hub.');
	}

	private async handleRunOnHub(slot?: number | string): Promise<void> {
		// ── Slot provided externally (webview or alias) ────────────────────
		if (typeof slot === 'number') {
			await this.runOnHubViaSlot(slot);
			return;
		}

		// ── No slot — editor-driven flow ──────────────────────────────────
		const editor = window.activeTextEditor;
		if (!editor) {
			window.showInformationMessage('Open a Python file first.');
			return;
		}

		const filePath = editor.document.uri.fsPath;

		// Determine the slot from a `# slot: N` comment on line 1.
		const existingSlot = this.extractSlotFromFirstLine(editor);
		if (existingSlot !== null) {
			slot = existingSlot;
		} else {
			// No slot comment — prompt the user to pick one.
			const slots = Array.from({ length: 20 }, (_, i) => `${i}`);
			const selected = await window.showQuickPick(slots, {
				placeHolder: 'Select a slot to run on (0-19)',
			});
			if (!selected) {
				return;
			}
			slot = parseInt(selected, 10);
			// Persist the slot comment for future runs.
			await this.insertSlotComment(editor, slot);
		}

		await this.runOnHubViaSlot(slot);
	}

	/**
	 * Execute the program on the connected hub using the given slot.
	 * Routes to BLE or USB depending on the current connection type.
	 */
	private async runOnHubViaSlot(slot: number): Promise<void> {
		// Reveal the console channel so the user sees live output.
		this.consoleChannel.show(true);

		if (this.hubType === null) {
			window.showInformationMessage(
				'No hub connected. Use the Connect button to connect to a hub first.',
			);
			return;
		}

		if (this.hubType === 'ble') {
			try {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Running BLE program flow request for slot ${slot}`,
				);
				await this.bleManager.runSlot(slot);
				window.showInformationMessage(`Program started on hub (slot ${slot}) via BLE.`);
			} catch (err) {
				window.showErrorMessage(
					`Failed to run on hub via BLE: ${(err as Error).message}`,
				);
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] BLE run failed: ${(err as Error).message}`,
				);
			}
		} else if (this.hubType === 'usb') {
			try {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Running program on hub via USB (slot ${slot})`,
				);
				const run = runProgramOnUsb(this.hubDevice, `:program/${String(slot).padStart(2, '0')}/program.py`);
				this.usbRunCancel = run.cancel.bind(run);
				run.onOutput = (chunk: string) => { this.consoleChannel.append(chunk); };
				await run.promise;
				this.usbRunCancel = null;
			} catch (err) {
				window.showErrorMessage(
					`Failed to run on hub via USB: ${(err as Error).message}`,
				);
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] USB run failed: ${(err as Error).message}`,
				);
			}
		}
	}

	private async handleUploadToHub(arg?: Uri | number | string): Promise<void> {
		// ── Slot provided externally (webview) ─────────────────────────────
		if (typeof arg === 'number') {
			await this.uploadToHubViaSlot(arg);
			return;
		}

		// ── Uri from VS Code (editor/title menu) ───────────────────────────
		let editor: typeof window.activeTextEditor | undefined;
		if (arg instanceof Uri) {
			editor = window.visibleTextEditors.find(
				(e) => e.document.uri.fsPath === arg!.fsPath,
			);
		}
		if (!editor) {
			editor = window.activeTextEditor;
		}
		if (!editor) {
			window.showInformationMessage('Open a Python file first.');
			return;
		}

		const filePath = editor.document.uri.fsPath;

		// Determine the slot from a `# slot: N` comment on line 1.
		const existingSlot = this.extractSlotFromFirstLine(editor);
		if (existingSlot !== null) {
			await this.uploadToHubViaSlot(existingSlot, filePath);
			return;
		}

		// No slot comment — prompt the user to pick one.
		const slots = Array.from({ length: 20 }, (_, i) => `${i}`);
		const selected = await window.showQuickPick(slots, {
			placeHolder: 'Select a slot to upload to (0-19)',
		});
		if (!selected) {
			return;
		}
		const slot = parseInt(selected, 10);
		// Persist the slot comment for future runs.
		await this.insertSlotComment(editor, slot);
		await this.uploadToHubViaSlot(slot, filePath);
	}

	/**
	 * Upload the file at *filePath* to the connected hub's slot.
	 * Routes to BLE or USB depending on the current connection type.
	 */
	private async uploadToHubViaSlot(slot: number, filePath?: string): Promise<void> {
		// Reveal the console channel so the user sees live output from the run.
		this.consoleChannel.show(true);

		if (this.hubType === null) {
			window.showInformationMessage(
				'No hub connected. Use the Connect button to connect to a hub first.',
			);
			return;
		}

		const fileName = 'program.py'; // hub only runs program.py/program.mpy by default

		if (this.hubType === 'ble') {
			const fs = await import('fs');
			const buildDir = filePath ? path.join(path.dirname(filePath), 'build') : path.join(process.cwd(), 'build');
			const compiledPath = filePath ? await compileLibrary(filePath, buildDir) : filePath!;
			const isMpy = compiledPath.endsWith('.mpy');
			const uploadFileName = isMpy ? 'program.mpy' : 'program.py';
			const code = fs.readFileSync(compiledPath);
			try {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Uploading to slot ${slot} via BLE (${uploadFileName}).`,
				);
				await this.bleManager.uploadSlot(slot, code, uploadFileName);
				window.showInformationMessage(`Uploaded "${uploadFileName}" to slot ${slot} (BLE).`);
			} catch (err) {
				window.showErrorMessage(
					`Failed to upload via BLE: ${(err as Error).message}`,
				);
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] BLE upload failed: ${(err as Error).message}`,
				);
			}
		} else if (this.hubType === 'usb' && filePath) {
			try {
				const baseDir = path.dirname(filePath);
				const allFiles = collectLocalFiles(filePath, baseDir);
				// collectLocalFiles returns [libraries..., mainFile] — main file is always last.
				const libraries = allFiles.slice(0, -1);
				const mainFile = allFiles[allFiles.length - 1];

				const fileDesc = libraries.length > 0
					? `${libraries.length} library file(s) + ${path.basename(mainFile!)}`
					: path.basename(mainFile!);
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Uploading via USB: ${fileDesc} → slot ${slot}`,
				);
				const upload = uploadToUsb(this.hubDevice, mainFile!, fileName, slot, true, libraries);
				this.usbRunCancel = upload.cancel.bind(upload);
				upload.onOutput = (chunk: string) => { this.consoleChannel.append(chunk); };
				upload.promise.catch((err: Error) => {
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] USB upload failed: ${err.message}`,
					);
					window.showErrorMessage(`Failed to upload via USB: ${err.message}`);
				});
				window.showInformationMessage(`Uploaded "${fileDesc}" to slot ${slot} (USB). Program will start shortly.`);
			} catch (err) {
				window.showErrorMessage(
					`Failed to upload via USB: ${(err as Error).message}`,
				);
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] USB upload failed: ${(err as Error).message}`,
				);
			}
		} else {
			window.showErrorMessage('No hub connected. Connect a hub before uploading.');
		}
	}

	private async handleStopHub(): Promise<void> {
		this.outputChannel.appendLine('[LEGO Spike Prime] Stop requested.');
		if (this.hubType === null) {
			window.showInformationMessage('No hub connected. Use the Connect button to connect to a hub first.');
			return;
		}
		if (this.hubType === 'ble') {
			try {
				await this.bleManager.stopSlot(0);
				window.showInformationMessage('Program stopped on hub via BLE.');
			} catch (err) {
				window.showErrorMessage(`Failed to stop on hub via BLE: ${(err as Error).message}`);
				this.outputChannel.appendLine(`[LEGO Spike Prime] BLE stop failed: ${(err as Error).message}`);
			}
		} else if (this.hubType === 'usb') {
			try {
				// Kill the local mpremote process (frees the serial port),
				// then send reset to actually stop the program on the hub.
				if (this.usbRunCancel) {
					this.usbRunCancel();
					this.usbRunCancel = null;
					// Small delay to let the port release before reset connects.
					await new Promise((r) => setTimeout(r, 300));
				}
				await import('child_process').then(({ spawn }) => {
					spawn('mpremote', ['connect', this.hubDevice, 'reset']);
				});
				window.showInformationMessage('Program stopped on hub via USB.');
			} catch (err) {
				window.showErrorMessage(`Failed to stop on hub via USB: ${(err as Error).message}`);
				this.outputChannel.appendLine(`[LEGO Spike Prime] USB stop failed: ${(err as Error).message}`);
			}
		}
	}

	private handlePlaySlotOnHub(slot: number): void {
		// Delegate to the unified run handler — same backend path regardless of entry point.
		void this.handleRunOnHub(slot);
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private log(msg: string): void {
		const line = `[LEGO Spike Prime] ${msg}`;
		this.outputChannel.appendLine(line);
		console.log(line);
	}

	private extractSlotFromFirstLine(editor: typeof window.activeTextEditor): number | null {
		if (!editor || !editor.document) return null;
		const firstLine = editor.document.lineAt(0).text.trim();
		const match = firstLine.match(/^#\s*slot:\s*(\d+)\s*$/);
		return match ? parseInt(match[1], 10) : null;
	}

	private async insertSlotComment(editor: typeof window.activeTextEditor, slot: number): Promise<void> {
		if (!editor || !editor.document) return;
		const firstLine = editor.document.lineAt(0).text.trim();
		const slotPattern = /^#\s*slot:\s*\d+\s*$/;
		const slotComment = `# slot: ${slot}`;

		if (slotPattern.test(firstLine)) {
			await editor.edit((edit) => {
				edit.replace(editor.document.lineAt(0).range, slotComment);
			});
		} else {
			await editor.edit((edit) => {
				edit.insert(new Position(0, 0), `${slotComment}\n`);
			});
		}
	}
}