import {
	Disposable,
	Position,
	StatusBarAlignment,
	StatusBarItem,
	window,
} from 'vscode';

let connectionBtn: StatusBarItem | null = null;
let hubName = 'Unknown';

/** Extract slot number from the first line if it matches `# slot: N`. */
function extractSlotFromFirstLine(editor: typeof window.activeTextEditor): number | null {
	if (!editor || !editor.document) return null;
	const firstLine = editor.document.lineAt(0).text.trim();
	const match = firstLine.match(/^#\s*slot:\s*(\d+)\s*$/);
	return match ? parseInt(match[1], 10) : null;
}

/** Insert or update the `# slot: N` comment on the first line. */
async function insertSlotComment(editor: typeof window.activeTextEditor, slot: number): Promise<void> {
	if (!editor || !editor.document) return;
	const firstLine = editor.document.lineAt(0).text.trim();
	const slotPattern = /^#\s*slot:\s*\d+\s*$/;
	const slotComment = `# slot: ${slot}`;

	if (slotPattern.test(firstLine)) {
		// Replace existing slot comment
		await editor.edit((edit) => {
			edit.replace(
				editor.document.lineAt(0).range,
				slotComment,
			);
		});
	} else {
		// Insert slot comment at the very top
		await editor.edit((edit) => {
			edit.insert(new Position(0, 0), `${slotComment}\n`);
		});
	}
}

export function createConnectButton(): StatusBarItem {
	connectionBtn = window.createStatusBarItem(
		'lego.connectHub',
		StatusBarAlignment.Left,
		101,
	);
	updateConnectionIcon(connectionBtn, false);
	connectionBtn.command = 'lego.connectHub';
	connectionBtn.tooltip = 'LEGO Spike Prime: Click to connect';

	// Defer .show() until after VS Code's UI is fully initialized
	setImmediate(() => {
		if (connectionBtn) {
			connectionBtn.show();
		}
	});

	return connectionBtn;
}

export function setHubName(name: string): void {
	hubName = name;
	if (connectionBtn && getConnectionState()) {
		connectionBtn.text = `$(check) Connected to ${hubName}`;
	}
}

function setConnectionContext(connected: boolean): void {
	// Lazy require — vscode module is only available after activation
	const vscode = require('vscode');
	if (vscode.setContext) {
		vscode.setContext('lego.isConnected', connected);
	}
}

export function updateConnectionIcon(btn: StatusBarItem, connected: boolean): void {
	setConnectionContext(connected);
	if (connected) {
		btn.text = `$(check) Connected to ${hubName}`;
		btn.tooltip = 'LEGO Spike Prime: Click for menu';
	} else {
		btn.text = '$(plug) Connect to Hub';
		btn.tooltip = 'LEGO Spike Prime: Click to connect';
	}
}

export function getConnectionState(): boolean {
	return connectionBtn !== null;
}

export function disposeConnectButton(): Disposable {
	if (connectionBtn) {
		connectionBtn.dispose();
		connectionBtn = null;
	}
	return { dispose: () => {} };
}