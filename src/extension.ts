import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
	ExtensionContext,
	window,
	OutputChannel,
	commands,
} from 'vscode';
import { BleConnectionManager, DeviceStateStore } from './ble-connection';
import { createConnectButton, updateConnectionIcon } from './statusbar';
import { ExtensionUIManager } from './extension-ui-manager';
import { WebviewPanelManager } from './webview-panel';

const execAsync = promisify(exec);

let bleManager: BleConnectionManager | null = null;

const TOOLS = [
	{ name: 'mpy-cross', pip: 'mpy-cross', desc: 'MicroPython bytecode compiler' },
	{ name: 'mpremote', pip: 'mpremote', desc: 'LEGO/MicroPython device utility' },
];

async function isToolAvailable(toolName: string): Promise<boolean> {
	const platform = process.platform;
	const cmd =
		platform === 'win32' ? `where "${toolName}"` : `which "${toolName}"`;
	try {
		await execAsync(cmd, { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

async function pipInstall(pipPackage: string): Promise<boolean> {
	try {
		await execAsync(`pip install --quiet "${pipPackage}"`, { timeout: 60000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run a one-time check for required CLI tools. Writes to the OutputChannel
 * (never suppressed by VS Code) and shows toast notifications.
 */
function runToolCheck(ch: OutputChannel) {
	ch.appendLine('[LEGO Spike Prime] Checking required tools...');

	const missing: typeof TOOLS[number][] = [];

	for (const tool of TOOLS) {
		ch.appendLine(`[LEGO Spike Prime] Checking ${tool.name}...`);
		if (!isToolAvailableSync(tool.name)) {
			ch.appendLine(`[LEGO Spike Prime] ${tool.name} not found.`);
			missing.push(tool);
		} else {
			ch.appendLine(`[LEGO Spike Prime] ${tool.name} found.`);
		}
	}

	if (missing.length > 0) {
		window.showInformationMessage(
			`LEGO Spike Prime: ${missing.length} tool${missing.length > 1 ? 's are' : ' is'} missing — attempting to install…`,
		);

		const stillMissing: typeof TOOLS[number][] = [];
		for (const tool of missing) {
			window.showInformationMessage(
				`LEGO Spike Prime: Installing ${tool.name}…`,
			);
			ch.appendLine(`[LEGO Spike Prime] Installing ${tool.pip}…`);
			const ok = pipInstallSync(tool.pip);
			if (ok && isToolAvailableSync(tool.name)) {
				ch.appendLine(`[LEGO Spike Prime] ${tool.name} installed.`);
				window.showInformationMessage(
					`LEGO Spike Prime: ${tool.name} installed successfully.`,
				);
			} else {
				ch.appendLine(`[LEGO Spike Prime] ${tool.name} install failed.`);
				stillMissing.push(tool);
			}
		}

		if (stillMissing.length > 0) {
			const lines = stillMissing.map((t) => `- **${t.name}** (${t.desc})`);
			const detail = [
				'The following tools are required for hub communication but could not be found or installed:',
				'',
				...lines,
				'',
				'Install them manually with:',
				'',
				'  pip install mpy-cross mpremote',
				'',
				'Make sure pip is on your PATH.',
			].join('\n');
			window.showWarningMessage(
				'LEGO Spike Prime: Required tools missing',
				{ modal: false, detail },
			);
		}
	} else {
		ch.appendLine('[LEGO Spike Prime] All tools found.');
	}
}

function isToolAvailableSync(toolName: string): boolean {
	const platform = process.platform;
	const cmd = platform === 'win32' ? `where "${toolName}"` : `which "${toolName}"`;
	try {
		execSync(cmd, { stdio: 'ignore', timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

function pipInstallSync(pipPackage: string): boolean {
	try {
		execSync(`pip install --quiet "${pipPackage}"`, { stdio: 'ignore', timeout: 60000 });
		return true;
	} catch {
		return false;
	}
}

export async function activate(context: ExtensionContext) {
	// 1. Create output channels
	const outputChannel: OutputChannel = window.createOutputChannel('LEGO Spike Prime');
	const consoleChannel: OutputChannel = window.createOutputChannel('LEGO Spike Prime Console');

	// 2. Create device state store and BLE connection manager
	const deviceState = new DeviceStateStore();
	bleManager = new BleConnectionManager(outputChannel, consoleChannel, context.extensionUri.fsPath, deviceState);

	// 3. Create the webview panel manager
	const panelManager = new WebviewPanelManager(deviceState, context.extensionUri, {
		onStop: async () => {
			outputChannel.appendLine('[LEGO Spike Prime] Stop requested from webview.');
			await commands.executeCommand('lego.stopHub');
		},
		onDisconnect: async () => {
			outputChannel.appendLine('[LEGO Spike Prime] Disconnect requested.');
			await commands.executeCommand('lego.disconnectHub');
		},
		onConnect: async () => {
			outputChannel.appendLine('[LEGO Spike Prime] Connect requested from webview.');
			await commands.executeCommand('lego.connectHub');
		},
		onPlaySlot: (slot: number) => {
			outputChannel.appendLine(`[LEGO Spike Prime] Play slot ${slot} requested from webview.`);
			commands.executeCommand('lego.runOnHub', slot);
		},
	});

	// 4. Create the central UI manager — owns status bar, commands, and webview coordination.
	const uiManager = new ExtensionUIManager(bleManager, deviceState, outputChannel, consoleChannel, panelManager);
	uiManager.registerCommands();

	// 5. Subscribe the webview panel to device-state changes (so data flows to the webview).
	panelManager.subscribeToState();

	// 6. Push all disposables to context.
	context.subscriptions.push(
		outputChannel,
		uiManager,
		panelManager,
	);

	// 6. Check required tools (deferred to microtask after activation completes).
	queueMicrotask(() => {
		runToolCheck(outputChannel);
	});

	return { outputChannel };
}

export function deactivate(): void {
	// Clean up the BLE connection helper process.
	bleManager?.dispose();
}