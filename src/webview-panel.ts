import {
	Disposable,
	Uri,
	ViewColumn,
	Webview,
	WebviewPanel,
	window,
} from 'vscode';

import { DeviceStateStore } from './ble-connection';
import {
	__getDisconnectedHTML as getDisconnectedHTML,
	__getScanningHTML as getScanningHTML,
	__getWaitingHTML as getWaitingHTML,
	__getBatteryColor as getBatteryColor,
	__renderAccelerometer as renderAccelerometer,
	__renderBattery as renderBattery,
	__renderGyroscope as renderGyroscope,
	__renderMotor as renderMotor,
	__renderFacing as renderFacing,
	__renderOrientation as renderOrientation,
	__renderPixelGrid as renderPixelGrid,
	__renderSensor as renderSensor,
} from './webview-render';

/** Callbacks invoked when the user interacts with the webview toolbar. */
export interface WebviewCallbacks {
	onConnect?: () => void;
	onDisconnect?: () => void;
	onStop?: () => void;
	onPlaySlot?: (slot: number) => void;
}

/**
 * Manages the LEGO device-state webview panel: creation, lifecycle,
 * message routing, and state-change notifications.
 *
 * Render functions are imported from webview-render.ts and serialized
 * into the webview at build time via .toString(), so the render logic
 * lives in exactly one place.
 */
export class WebviewPanelManager implements Disposable {

	private _panel?: WebviewPanel;
	private _disposed = false;
	private _disposables: Disposable[];

	constructor(
		private readonly _deviceState: DeviceStateStore,
		private readonly _extensionUri: Uri,
		private readonly _callbacks: WebviewCallbacks,
	) {
		this._disposables = [];
	}

	// ── Public API ───────────────────────────────────────────────────────────

	dispose(): void {
		this._panel?.dispose();
		Disposable.from(...this._disposables).dispose();
		this._disposed = true;
		this._disposables = [];
	}

	/** Bring the panel to the foreground (used by extension-ui-manager). */
	show(): void {
		this._ensurePanel().reveal();
	}

	/** Show the scanning UI and bring the panel to the foreground. */
	showScanning(): void {
		this._ensurePanel();
		this._panel!.webview.postMessage({ type: 'scanning', scanning: true });
		this._panel!.reveal();
	}

	/** Show the connected dashboard. */
	showConnected(connectionType?: 'ble' | 'usb'): void {
		this._ensurePanel();
		this._panel!.webview.postMessage({ type: 'connected', connectionType });
		this._panel!.reveal();
	}

	/** Show the disconnected state. */
	showDisconnected(): void {
		this._ensurePanel();
		this._panel!.webview.postMessage({ type: 'disconnected' });
		this._panel!.reveal();
	}

	/** Notify the webview that a connection attempt failed. */
	showConnectionFailed(): void {
		this._ensurePanel();
		this._panel!.webview.postMessage({ type: 'connectionFailed' });
		this._panel!.reveal();
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	private _ensurePanel(): WebviewPanel {
		if (this._panel && !this._disposed) {
			this._panel.reveal();
			return this._panel;
		}
		return this._createPanel();
	}

	private _createPanel(): WebviewPanel {
		const panel = window.createWebviewPanel(
			'legoDeviceState',
			'LEGO Device State',
			ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		panel.webview.html = this._buildWebviewHTML(panel.webview);

		// Route webview → extension messages
		panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.type) {
					case 'ready':
						await this._postInitialState();
						break;
					case 'connectHub':
						this._callbacks.onConnect?.();
						break;
					case 'disconnect':
						this._callbacks.onDisconnect?.();
						break;
					case 'stop':
						this._callbacks.onStop?.();
						break;
					case 'playSlot':
						this._callbacks.onPlaySlot?.(message.slot);
						break;
				}
			},
			null,
			this._disposables,
		);

		// Garbage-collect the panel when the user closes the tab
		panel.onDidDispose(() => {
				this._panel = undefined;
				this._disposed = true;
				this.dispose();
			}, null, this._disposables);

		this._panel = panel;
		return this._panel;
	}

	// ── HTML generation ──────────────────────────────────────────────────────

	/**
	 * Build the complete webview HTML.
	 *
	 * Render functions are serialized via .toString() so they live in only
	 * one place (webview-render.ts) and are injected automatically.
	 */
	private _buildWebviewHTML(webview: Webview): string {
		const csp = webview.cspSource;
		const uri = this._extensionUri.fsPath;

		// Map each function name to its imported implementation.
		// Because these are pure functions with no closures, .toString()
		// gives us valid, runnable JavaScript for the webview.
		const renderFns: Record<string, Function> = {
			__getBatteryColor: getBatteryColor,
			__renderBattery: renderBattery,
			__renderFacing: renderFacing,
			__renderOrientation: renderOrientation,
			__renderAccelerometer: renderAccelerometer,
			__renderGyroscope: renderGyroscope,
			__renderPixelGrid: renderPixelGrid,
			__renderMotor: renderMotor,
			__renderSensor: renderSensor,
			__getDisconnectedHTML: getDisconnectedHTML,
			__getScanningHTML: getScanningHTML,
			__getWaitingHTML: getWaitingHTML,
		};

		// Serialize each render function as a bare __xxx global.
		// Because all functions use __-prefixed names, cross-function
		// calls resolve automatically in the webview scope — no
		// namespace wrapping or regex rewriting needed.
		const renderDeclarations = Object.entries(renderFns).map(
			([name, fn]) => `var ${name} = ${fn.toString()};`,
		).join('\n');

		const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-lego-webview';">
  <style nonce="lego-webview">
    /* ── Theme variables ─────────────────────────────────────────── */
    :root {
      --bg-primary: var(--vscode-editor-background);
      --bg-card: var(--vscode-editor-inactiveSelectionBackground);
      --text-primary: var(--vscode-editor-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --border-color: var(--vscode-panel-border);
      --accent-green: #4ec9b0;
      --accent-red: #f44747;
      --accent-yellow: #cca700;
    }

    /* ── Reset ───────────────────────────────────────────────────── */
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--text-primary);
      background: var(--bg-primary);
      padding: 12px;
      overflow-y: auto;
      min-height: 100vh;
    }

    /* ── Toolbar ─────────────────────────────────────────────────── */
    #toolbar {
      display: flex;
      margin-bottom: 12px;
    }
    .toolbar-btn {
      flex: 1;
      padding: 6px 12px;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 500;
      transition: background-color 0.15s ease;
    }
    .toolbar-btn:hover {
      background: var(--vscode-button-background, #444);
      color: var(--vscode-button-foreground, #fff);
    }
    .toolbar-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .toolbar-start {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
    }
    #toolbar-end {
      margin-left: auto;
    }
    /* ── Play split-button + dropdown ──────────────────────────────── */
    .play-btn-wrapper {
      position: relative;
      display: inline-flex;
      align-items: stretch;
    }
    .play-btn-main {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
      border-right: none;
      padding-left: 10px;
      padding-right: 8px;
    }
    .play-btn-chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 8px;
      border-radius: 4px;
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      cursor: pointer;
      border: 1px solid var(--border-color);
      border-left: none;
      background: var(--bg-card);
      color: var(--text-primary);
      font-size: 0.7em;
      transition: background-color 0.15s ease;
    }
    .play-btn-chevron:hover {
      background: var(--vscode-button-background, #444);
      color: var(--vscode-button-foreground, #fff);
    }
    .play-dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 160px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      z-index: 10;
      max-height: 240px;
      overflow-y: auto;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .play-dropdown.open {
      display: block;
    }
    .play-dropdown-header {
      padding: 6px 10px;
      font-size: 0.8em;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .play-slot-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 0.9em;
      transition: background-color 0.1s ease;
    }
    .play-slot-item:hover {
      background: var(--vscode-button-background, #444);
      color: var(--vscode-button-foreground, #fff);
    }
    .play-slot-item.selected {
      font-weight: 600;
    }
    .play-slot-item .slot-radio {
      width: 12px;
      height: 12px;
      border: 1.5px solid var(--text-secondary);
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .play-slot-item.selected .slot-radio {
      border-color: var(--accent-green);
    }
    .play-slot-item.selected .slot-radio::after {
      content: '';
      width: 6px;
      height: 6px;
      background: var(--accent-green);
      border-radius: 50%;
    }
    .play-slot-item .slot-label {
      flex: 1;
    }
    .play-slot-item .slot-shortcut {
      font-size: 0.8em;
      color: var(--text-secondary);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .play-slot-item:hover .slot-shortcut {
      color: var(--vscode-button-foreground, #fff);
    }

    .btn-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-color);
      border-top-color: var(--accent-green);
      border-radius: 50%;
      animation: btn-spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 4px;
    }
    @keyframes btn-spin { to { transform: rotate(360deg); } }

    /* ── Toolbar visibility by state ─────────────────────────────── */
    /* Default states */
    #connect-btn { display: inline-block; }
    #connected-actions { display: none; gap: 6px; }

    /* Disconnected: show connect, hide connected-actions + toolbar-end */
    body[data-connected="false"] #connect-btn { display: inline-block; }
    body[data-connected="false"] #connected-actions,
    body[data-connected="false"] #toolbar-end { display: none; }

    /* Connected: hide connect, show connected-actions + toolbar-end */
    body[data-connected="true"] #connect-btn { display: none; }
    body[data-connected="true"] #connected-actions { display: flex; }
    body[data-connected="true"] #toolbar-end { display: block; }

    /* Scanning overrides: hide connect, hide connected-actions + toolbar-end, show scanning */
    body[data-scanning="true"] #connect-btn { display: none; }
    body[data-scanning="true"] #connected-actions,
    body[data-scanning="true"] #toolbar-end { display: none; }

    /* ── Scanning state ──────────────────────────────────────────── */
    #scanning-state {
      display: none;
    }

    /* ── Dashboard ───────────────────────────────────────────────── */
    #dashboard {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }

    /* ── Card base ───────────────────────────────────────────────── */
    .lego-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 10px;
      transition: opacity 0.2s ease;
    }
    .lego-card-title {
      font-weight: 600;
      margin-bottom: 6px;
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }

    /* ── Disconnected state ──────────────────────────────────────── */
    .disconnected {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      padding: 40px 20px;
      text-align: center;
      width: 100%;
    }

    /* ── Scanning / waiting ──────────────────────────────────────── */
    .scanning {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 20px;
      color: var(--text-secondary);
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-color);
      border-top-color: var(--accent-green);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Battery gauge ───────────────────────────────────────────── */
    .lego-battery-ring {
      width: 120px; height: 120px; margin: 0 auto 6px;
      position: relative;
    }
    .lego-battery-ring svg { width: 120px; height: 120px; }
    .lego-battery-ring .ring-bg {
      fill: none; stroke: var(--vscode-input-border, #555);
      stroke-width: 10;
    }
    .lego-battery-ring .ring-fill {
      fill: none; stroke-width: 10;
      transition: stroke-dashoffset 0.5s ease, stroke 0.5s ease;
    }
    .lego-battery-ring .ring-label {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 1.4em; font-weight: 700;
    }

    /* ── IMU ─────────────────────────────────────────────────────── */
    .lego-motor-stats {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 0.9em;
    }
    .lego-motor-row {
      display: flex;
      justify-content: space-between;
    }

    /* ── Pixel grid ──────────────────────────────────────────────── */
    .lego-pixel-grid {
      display: grid;
      gap: 2px;
      max-width: 160px;
      margin: 0 auto;
    }
    .lego-pixel {
      border-radius: 2px;
      transition: background-color 0.2s ease;
      border: 1px solid rgba(0,0,0,0.2);
      min-width: 24px;
      min-height: 24px;
    }
    .lego-pixel-grid-empty {
      text-align: center;
      color: var(--text-secondary);
      padding: 20px;
    }

    /* ── Sensor-specific ─────────────────────────────────────────── */
    .lego-force-bar-track {
      height: 8px;
      background: var(--vscode-badge-background, #333);
      border-radius: 4px;
      overflow: hidden;
      margin-top: 4px;
    }
    .lego-force-bar-fill {
      height: 100%;
      background: var(--accent-green);
      transition: width 0.3s ease;
    }
    .lego-color-swatch {
      width: 48px; height: 48px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      margin: 6px 0;
    }
  </style>
</head>
<body data-connected="false" data-scanning="false">

  <!-- Toolbar -->
  <div id="toolbar">
    <div class="toolbar-start">
      <button id="connect-btn" class="toolbar-btn">&#x1F50C;&nbsp;Connect to Hub</button>
    </div>
    <div id="connected-actions">
      <div class="play-btn-wrapper">
        <button id="play-btn" class="toolbar-btn play-btn-main">&#x25B6;&nbsp; Play</button>
        <button id="play-chevron" class="play-btn-chevron" aria-expanded="false" aria-haspopup="listbox">&#x25BC;</button>
        <div id="play-dropdown" class="play-dropdown" role="listbox" aria-label="Play slot" tabindex="-1"></div>
      </div>
      <button id="stop-btn" class="toolbar-btn">&#x23F9;&nbsp; Stop</button>
    </div>
    <div id="toolbar-end">
      <button id="disconnect-btn" class="toolbar-btn" style="flex: none;">&#x2298;&nbsp; Disconnect</button>
    </div>
  </div>

  <!-- Scanning overlay -->
  <div id="scanning-state"></div>

  <!-- Dashboard (cards rendered here) -->
  <div id="dashboard"></div>

  <!-- ── Inline script ──────────────────────────────────────────── -->
  <script nonce="lego-webview">
${renderDeclarations}

(function() {
  "use strict";

  /* ── State ─────────────────────────────────────────────────── */
  var vscode = acquireVsCodeApi();
  var dashboard = document.getElementById('dashboard');
  var scanningState = document.getElementById('scanning-state');
  var __isConnected = false;
  var __connectionType = null;
  var __isScanning = false;
  var __renderedCards = new Map();
  var __rafPending = false;
  var __pendingState = null;

  /* ── UI state setters (scanning separated from connected) ─── */
  function __setConnected(val) {
    __isConnected = val;
    document.body.dataset.connected = val ? 'true' : 'false';
  }

  function __setScanning(val) {
    __isScanning = val;
    document.body.dataset.scanning = val ? 'true' : 'false';
    if (val) {
      scanningState.innerHTML = __getScanningHTML();
      scanningState.style.display = 'flex';
      dashboard.style.display = 'none';
      __renderedCards.clear();
    } else {
      scanningState.style.display = 'none';
      scanningState.innerHTML = '';
      dashboard.style.display = '';
    }
  }

  /* ── RAF-batched dashboard updates ─────────────────────────── */
  function __scheduleUpdate(state) {
    console.log('[WEBVIEW] __scheduleUpdate called, state keys=', Object.keys(state), 'state=', JSON.stringify(state));
    __pendingState = state;
    if (__rafPending) return;
    __rafPending = true;
    requestAnimationFrame(function() {
      __rafPending = false;
      var st = __pendingState;
      __pendingState = null;
      if (st) {
        console.log('[WEBVIEW] __applyUpdates called, __isConnected=', __isConnected, 'st keys=', Object.keys(st));
        __applyUpdates(st);
      }
    });
  }

  function __hasData(state) {
    return !!(state && (
      state.battery ||
      state.imu ||
      state.display5x5 ||
      state.display3x3 ||
      (state.motors && state.motors.length > 0) ||
      (state.sensors && state.sensors.length > 0)
    ));
  }

  function __applyUpdates(state) {
    if (__hasData(state)) {
      __setScanning(false);
      var cb = document.getElementById('connect-btn');
      if (cb) { cb.innerHTML = '&#x1F50C;&nbsp;Connect to Hub'; cb.disabled = false; }
    }

    if (__isConnected && __hasData(state)) {
      // Connected and has data — render dashboard
    } else if (!__isConnected) {
      // Not connected — show disconnected UI
      dashboard.innerHTML = __getDisconnectedHTML();
      __renderedCards.clear();
      return;
    } else if (__connectionType === 'usb') {
      // USB connection — no data stream, clear any leftover waiting UI
      dashboard.innerHTML = '';
      __renderedCards.clear();
    } else {
      // Connected but no data yet — show waiting
      dashboard.innerHTML = __getWaitingHTML();
      __renderedCards.clear();
      return;
    }

    /* Clear dashboard before inserting cards */
    dashboard.innerHTML = '';
    __renderedCards.clear();

    /* Build card parts */
    var parts = [];
    if (state.battery) parts.push({ key: 'battery', html: __renderBattery(state.battery) });
    if (state.imu) {
      parts.push({ key: 'imu-facing', html: __renderFacing(state.imu) });
      parts.push({ key: 'imu-orientation', html: __renderOrientation(state.imu) });
      parts.push({ key: 'imu-accelerometer', html: __renderAccelerometer(state.imu) });
      parts.push({ key: 'imu-gyroscope', html: __renderGyroscope(state.imu) });
    }
    if (state.display5x5) parts.push({ key: 'display5x5', html: __renderPixelGrid('Display 5x5', state.display5x5.brightnesses, 5, 5) });
    if (state.display3x3) parts.push({ key: 'display3x3', html: __renderPixelGrid('Display 3x3', state.display3x3.brightnesses, 3, 3) });
    if (state.motors) for (var mi = 0; mi < state.motors.length; mi++) {
      parts.push({ key: 'motor-' + state.motors[mi].port, html: __renderMotor(state.motors[mi]) });
    }
    if (state.sensors) for (var si = 0; si < state.sensors.length; si++) {
      parts.push({ key: 'sensor-' + state.sensors[si].port + '-' + state.sensors[si].type, html: __renderSensor(state.sensors[si]) });
    }

    /* Diff-based update */
    var temp = document.createElement('div');
    temp.innerHTML = parts.map(function(p) { return p.html; }).join('');
    var newEls = new Map();
    for (var i = 0; i < temp.children.length; i++) {
      var el = temp.children[i];
      if (el instanceof HTMLElement && el.dataset.key) newEls.set(el.dataset.key, el);
    }

    /* Remove deleted cards */
    var keysToRemove = [];
    __renderedCards.forEach(function(el, key) { if (!newEls.has(key)) keysToRemove.push(key); });
    keysToRemove.forEach(function(key) { var el = __renderedCards.get(key); if (el) el.remove(); __renderedCards.delete(key); });

    /* Insert or update */
    for (var pi = 0; pi < parts.length; pi++) {
      var part = parts[pi];
      var newEl = newEls.get(part.key);
      if (!newEl) continue;
      var existing = __renderedCards.get(part.key);
      if (existing) {
        if (existing.innerHTML !== newEl.innerHTML) {
          existing.replaceWith(newEl);
          __renderedCards.set(part.key, newEl);
        }
      } else {
        __insertInOrder(dashboard, newEl, part.key, parts);
        __renderedCards.set(part.key, newEl);
      }
    }
  }

  function __insertInOrder(container, el, key, parts) {
    var ki = parts.findIndex(function(p) { return p.key === key; });
    var afterEl = null;
    for (var i = ki - 1; i >= 0; i--) {
      var cand = __renderedCards.get(parts[i].key);
      if (cand && cand.parentNode === container) { afterEl = cand; break; }
    }
    if (afterEl) container.insertBefore(el, afterEl.nextSibling);
    else container.appendChild(el);
  }

  /* ── Message handler (extension → webview) ─────────────────── */
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'device-state') {
      var hasData = __hasData(msg.state);
      if (hasData) {
        __setScanning(false);
        var cb = document.getElementById('connect-btn');
        if (cb) { cb.innerHTML = '&#x1F50C;&nbsp;Connect to Hub'; cb.disabled = false; }
      }
      if (hasData && !__isConnected) {
        __isConnected = true;
        __setConnected(true);
      }
      __scheduleUpdate(msg.state);

    } else if (msg.type === 'scanning') {
      __setScanning(!!msg.scanning);

    } else if (msg.type === 'connected') {
      __isConnected = true;
      __connectionType = msg.connectionType || null;
      __setConnected(true);
      __setScanning(false);
      var cb = document.getElementById('connect-btn');
      if (cb) { cb.innerHTML = '&#x1F50C;&nbsp;Connect to Hub'; cb.disabled = false; }
      if (msg.connectionType === 'usb') {
        dashboard.innerHTML = '';
        __renderedCards.clear();
      }

    } else if (msg.type === 'disconnected') {
      __isConnected = false;
      __setScanning(false);
      __setConnected(false);
      dashboard.innerHTML = __getDisconnectedHTML();
      __renderedCards.clear();
      var cb = document.getElementById('connect-btn');
      if (cb) { cb.innerHTML = '&#x1F50C;&nbsp;Connect to Hub'; cb.disabled = false; }

    } else if (msg.type === 'connectionFailed') {
      __isConnected = false;
      __setScanning(false);
      __setConnected(false);
      dashboard.innerHTML = __getDisconnectedHTML();
      __renderedCards.clear();
      var cb = document.getElementById('connect-btn');
      if (cb) { cb.innerHTML = '&#x1F50C;&nbsp;Connect to Hub'; cb.disabled = false; }
    }
  });

  /* ── Toolbar handlers (webview → extension) ────────────────── */
  var stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.addEventListener('click', function() { vscode.postMessage({ type: 'stop' }); });

  var disconnectBtn = document.getElementById('disconnect-btn');
  if (disconnectBtn) disconnectBtn.addEventListener('click', function() {
    __isConnected = false;
    __setScanning(false);
    __setConnected(false);
    dashboard.innerHTML = __getDisconnectedHTML();
    __renderedCards.clear();
    vscode.postMessage({ type: 'disconnect' });
  });

  var connectBtn = document.getElementById('connect-btn');
  if (connectBtn) connectBtn.addEventListener('click', function() {
    connectBtn.innerHTML = '<span class="btn-spinner"></span>&nbsp; Scanning for Hubs...';
    connectBtn.disabled = true;
    dashboard.innerHTML = __getWaitingHTML();
    __renderedCards.clear();
    __setScanning(true);
    vscode.postMessage({ type: 'connectHub' });
  });

  /* ── Play button + slot dropdown ─────────────────────────────── */
  var PLAY_SLOT_COUNT = 20;
  var __selectedSlot = 0;

  function __buildPlayDropdown() {
    var dropdown = document.getElementById('play-dropdown');
    if (!dropdown) return;
    var items = '';
    for (var i = 0; i < PLAY_SLOT_COUNT; i++) {
      var cls = i === __selectedSlot ? 'play-slot-item selected' : 'play-slot-item';
      items += '<div class="' + cls + '" role="option" aria-selected="' + (i === __selectedSlot) + '" data-slot="' + i + '">'
        + '<span class="slot-radio"></span>'
        + '<span class="slot-label">Slot ' + i + '</span>'
        + '<span class="slot-shortcut">' + (i + 1) + '</span>'
        + '</div>';
    }
    dropdown.innerHTML = '<div class="play-dropdown-header">Select Slot</div>' + items;

    // Wire up slot clicks
    var slotItems = dropdown.querySelectorAll('.play-slot-item');
    for (var j = 0; j < slotItems.length; j++) {
      slotItems[j].addEventListener('click', function(e) {
        e.stopPropagation();
        var slot = parseInt(this.getAttribute('data-slot'), 10);
        __selectSlot(slot);
        __closePlayDropdown();
      });
    }
  }

  function __selectSlot(slot) {
    __selectedSlot = slot;
    var mainBtn = document.getElementById('play-btn');
    if (mainBtn) {
      mainBtn.innerHTML = '&#x25B6;&nbsp; Play ' + slot;
    }
    // Update selected indicator in dropdown
    var items = document.querySelectorAll('.play-slot-item');
    for (var i = 0; i < items.length; i++) {
      var s = parseInt(items[i].getAttribute('data-slot'), 10);
      if (s === slot) {
        items[i].classList.add('selected');
        items[i].setAttribute('aria-selected', 'true');
      } else {
        items[i].classList.remove('selected');
        items[i].setAttribute('aria-selected', 'false');
      }
    }
  }

  function __openPlayDropdown() {
    __buildPlayDropdown();
    var dropdown = document.getElementById('play-dropdown');
    var chevron = document.getElementById('play-chevron');
    if (dropdown) dropdown.classList.add('open');
    if (chevron) chevron.setAttribute('aria-expanded', 'true');
  }

  function __closePlayDropdown() {
    var dropdown = document.getElementById('play-dropdown');
    var chevron = document.getElementById('play-chevron');
    if (dropdown) dropdown.classList.remove('open');
    if (chevron) chevron.setAttribute('aria-expanded', 'false');
  }

  function __togglePlayDropdown() {
    var dropdown = document.getElementById('play-dropdown');
    if (dropdown && dropdown.classList.contains('open')) {
      __closePlayDropdown();
    } else {
      __openPlayDropdown();
    }
  }

  // Chevron toggles dropdown
  var playChevron = document.getElementById('play-chevron');
  if (playChevron) {
    playChevron.addEventListener('click', function(e) {
      e.stopPropagation();
      __togglePlayDropdown();
    });
  }

  // Initialize play button label to match the default slot
  __selectSlot(__selectedSlot);

  // Initialize play button label to match the default slot
  __selectSlot(__selectedSlot);

  // Main play button runs the selected slot
  var playBtn = document.getElementById('play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', function(e) {
      // Don't trigger if clicking the chevron area (adjacent element)
      e.stopPropagation();
      vscode.postMessage({ type: 'playSlot', slot: __selectedSlot });
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', function() {
    __closePlayDropdown();
  });

  // Keyboard: Escape closes dropdown
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      __closePlayDropdown();
    }
  });

  // Number key shortcuts (1-9, 0 for 10-19)
  document.addEventListener('keydown', function(e) {
    var dropdown = document.getElementById('play-dropdown');
    if (!dropdown || !dropdown.classList.contains('open')) return;
    var num = parseInt(e.key, 10);
    if (!isNaN(num) && num >= 0 && num < PLAY_SLOT_COUNT) {
      __selectSlot(num);
      __closePlayDropdown();
      vscode.postMessage({ type: 'playSlot', slot: num });
    }
  });

  /* ── Initialize UI to disconnected state ──────────────────── */
  dashboard.innerHTML = __getDisconnectedHTML();
  __renderedCards.clear();
  __setConnected(false);
  __setScanning(false);

  /* ── Request initial state on load ─────────────────────────── */
  vscode.postMessage({ type: 'ready' });

})();
  </script>
</body>
</html>`;

		return html;
	}

	// ── State subscription ───────────────────────────────────────────

	/**
	 * Subscribe to device-state changes and forward them to the webview.
	 * Called once during activation.
	 */
	subscribeToState(): Disposable {
		return this._deviceState.subscribe((state) => {
			console.log('[LEGO] subscribeToState fired, panel=', !!this._panel, 'state keys=', Object.keys(state), 'state=', JSON.stringify(state));
			if (!this._panel) return;
			console.log('[LEGO] Posting device-state to webview, panel.webview=', !!this._panel.webview);
			this._panel.webview.postMessage({ type: 'device-state', state });
		});
	}

	// ── Initial state ──────────────────────────────────────────────

	/**
	 * Post the current device state to the webview in response to a
	 * 'ready' message.
	 */
	private async _postInitialState(): Promise<void> {
		if (!this._panel) return;
		const state = this._deviceState.state;
		const hasData = state && (state.battery || state.imu || state.display5x5 || state.display3x3 || (state.motors && state.motors.length > 0) || (state.sensors && state.sensors.length > 0));
		console.error('[LEGO] _postInitialState: panel=true, hasData=', hasData, 'state keys=', Object.keys(state), 'state=', JSON.stringify(state));
		if (hasData) {
			this._panel.webview.postMessage({ type: 'device-state', state });
		}
	}

	// ── Re-export render helpers (called by _buildWebviewHTML) ─────

	// These are shim methods so that `require('./webview-render')[name]`
	// works inside _buildWebviewHTML. In practice the render functions
	// are imported at the top of this file and forwarded here.
	private __renderBattery = renderBattery;
	private __renderFacing = renderFacing;
	private __renderOrientation = renderOrientation;
	private __renderAccelerometer = renderAccelerometer;
	private __renderGyroscope = renderGyroscope;
	private __renderPixelGrid = renderPixelGrid;
	private __renderMotor = renderMotor;
	private __renderSensor = renderSensor;
	private __getDisconnectedHTML = getDisconnectedHTML;
	private __getScanningHTML = getScanningHTML;
	private __getWaitingHTML = getWaitingHTML;
}