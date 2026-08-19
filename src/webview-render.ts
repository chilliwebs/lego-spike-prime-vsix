/**
 * Pure render functions for the LEGO Spike Prime webview dashboard.
 *
 * These functions take structured data and return HTML strings.
 * They are the single source of truth for all rendering — injected
 * into the webview at build time by WebviewPanelManager so there is
 * zero duplication between extension code and the webview.
 */

// ── Battery ──────────────────────────────────────────────────────────────────

/** Determine battery bar color based on percentage. */
export function __getBatteryColor(percent: number): string {
	if (percent > 50) return '#4ec9b0';
	if (percent >= 21) return '#cca700';
	return '#f44747';
}

/** Render a battery card as an HTML string with circular SVG ring. */
export function __renderBattery(data: { percent: number }): string {
	const { percent } = data;
	const color = __getBatteryColor(percent);
	const circumference = 2 * Math.PI * 50; // r=50
	const offset = circumference - (percent / 100) * circumference;
	return (
		'<div class="lego-card lego-card" data-key="battery">'
		+ '<div class="lego-card-title">Battery</div>'
		+ '<div class="lego-battery-ring">'
		+ '<svg viewBox="0 0 120 120">'
		+ '<circle class="ring-bg" cx="60" cy="60" r="50" fill="none" stroke="var(--vscode-input-border,#555)" stroke-width="10"/>'
		+ '<circle class="ring-fill" cx="60" cy="60" r="50" fill="none" stroke="' + color + '" stroke-width="10"'
		+ ' stroke-dasharray="' + circumference.toFixed(1) + '"'
		+ ' stroke-dashoffset="' + offset.toFixed(1) + '"'
		+ ' transform="rotate(-90 60 60)"/>'
		+ '</svg>'
		+ '<div class="ring-label">' + percent + '%</div>'
		+ '</div>'
		+ '</div>'
	);
}

// ── IMU / Orientation ────────────────────────────────────────────────────────

/** Render a Facing card (up/yaw face directions) as an HTML string. */
export function __renderFacing(data: {
	upFace?: string;
	yawFace?: string;
}): string {
	return (
		'<div class="lego-card lego-card" data-key="imu-facing">'
		+ '<div class="lego-card-title">Facing</div>'
		+ '<div class="lego-motor-stats">'
		+ '<div class="lego-motor-row"><span>Up</span><span>' + (data.upFace || '?') + '</span></div>'
		+ '<div class="lego-motor-row"><span>Yaw</span><span>' + (data.yawFace || '?') + '</span></div>'
		+ '</div></div>'
	);
}

/** Render an Orientation card (yaw/pitch/roll degrees) as an HTML string. */
export function __renderOrientation(data: {
	yaw: number;
	pitch: number;
	roll: number;
}): string {
	return (
		'<div class="lego-card lego-card" data-key="imu-orientation">'
		+ '<div class="lego-card-title">Orientation</div>'
		+ '<div class="lego-motor-stats">'
		+ '<div class="lego-motor-row"><span>Yaw</span><span>' + data.yaw.toFixed(1) + '°</span></div>'
		+ '<div class="lego-motor-row"><span>Pitch</span><span>' + data.pitch.toFixed(1) + '°</span></div>'
		+ '<div class="lego-motor-row"><span>Roll</span><span>' + data.roll.toFixed(1) + '°</span></div>'
		+ '</div></div>'
	);
}

/** Render an IMU accelerometer card as an HTML string. */
export function __renderAccelerometer(data: {
	accelX: number;
	accelY: number;
	accelZ: number;
}): string {
	return (
		'<div class="lego-card lego-card" data-key="imu-accelerometer">'
		+ '<div class="lego-card-title">Accelerometer</div>'
		+ '<div class="lego-motor-stats">'
		+ '<div class="lego-motor-row"><span>X</span><span>' + data.accelX.toFixed(3) + '</span></div>'
		+ '<div class="lego-motor-row"><span>Y</span><span>' + data.accelY.toFixed(3) + '</span></div>'
		+ '<div class="lego-motor-row"><span>Z</span><span>' + data.accelZ.toFixed(3) + '</span></div>'
		+ '</div></div>'
	);
}

/** Render an IMU gyroscope card as an HTML string. */
export function __renderGyroscope(data: {
	gyroX: number;
	gyroY: number;
	gyroZ: number;
}): string {
	return (
		'<div class="lego-card lego-card" data-key="imu-gyroscope">'
		+ '<div class="lego-card-title">Gyroscope</div>'
		+ '<div class="lego-motor-stats">'
		+ '<div class="lego-motor-row"><span>X</span><span>' + data.gyroX.toFixed(1) + '</span></div>'
		+ '<div class="lego-motor-row"><span>Y</span><span>' + data.gyroY.toFixed(1) + '</span></div>'
		+ '<div class="lego-motor-row"><span>Z</span><span>' + data.gyroZ.toFixed(1) + '</span></div>'
		+ '</div></div>'
	);
}

// ── Display / Pixel Grid ─────────────────────────────────────────────────────

/** Render a pixel grid card as an HTML string. */
export function __renderPixelGrid(
	title: string,
	brightnesses: number[],
	cols: number,
	rows: number,
): string {
	const key = title.toLowerCase().replace(/\s/g, '');
	if (!brightnesses || brightnesses.length === 0) {
		return '<div class="lego-card lego-card" data-key="' + key + '">'
		+ '<div class="lego-card-title">' + title + '</div>'
		+ '<div class="lego-pixel-grid-empty">No data</div></div>';
	}

	let gridHTML = '';
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const idx = r * cols + c;
			const brightness = brightnesses[idx] || 0;
			// Map 0/255 to HSL lightness 10%-65% with green hue (145)
			const lightness = 10 + (brightness / 255) * 55;
			const color = 'hsl(145,70%,' + lightness.toFixed(0) + '%)';
			gridHTML += '<div class="lego-pixel" style="background:' + color + '"></div>';
		}
	}

	return '<div class="lego-card lego-card" data-key="' + key + '">'
	+ '<div class="lego-card-title">' + title + '</div>'
	+ '<div class="lego-pixel-grid" style="grid-template-columns:repeat(' + cols + ',1fr)">'
	+ gridHTML + '</div></div>';
}

// ── Motor ────────────────────────────────────────────────────────────────────

/** Render a motor card as an HTML string. */
export function __renderMotor(data: {
	port: string;
	type: string;
	absolutePosition: number;
	relativePosition: number;
	speed: number;
	power: number;
}): string {
	const { port, type, absolutePosition, relativePosition, speed, power } = data;
	const shortType = type.replace(/ Motor$/, '');
	return (
		'<div class="lego-card lego-card" data-key="motor-' + port + '">'
		+ '<div class="lego-card-title">Motor ' + port + '</div>'
		+ '<div class="lego-motor-stats">'
		+ '<div class="lego-motor-row"><span>Type</span><span>' + shortType + '</span></div>'
		+ '<div class="lego-motor-row"><span>Abs</span><span>' + absolutePosition + ' deg</span></div>'
		+ '<div class="lego-motor-row"><span>Pos</span><span>' + relativePosition + ' deg</span></div>'
		+ '<div class="lego-motor-row"><span>Speed</span><span>' + (speed >= 0 ? '+' : '') + speed.toFixed(1) + '°/s</span></div>'
		+ '<div class="lego-motor-row"><span>Power</span><span>' + (power >= 0 ? '+' : '') + power.toFixed(1) + '%</span></div>'
		+ '</div></div>'
	);
}

// ── Sensor ───────────────────────────────────────────────────────────────────

/** Render a sensor card as an HTML string. */
export function __renderSensor(data: {
	type: 'force' | 'color' | 'distance';
	port: string;
	data: Record<string, string | number>;
}): string {
	const { type, port, data: sensorData } = data;
	let valueHTML = '';

	switch (type) {
		case 'force': {
			// Handle nested data structure from ble-connection.ts
			const inner = sensorData.data && typeof sensorData.data === 'object'
				? sensorData.data
				: sensorData;
			const val = (inner as Record<string, string | number>).force != null ? (inner as Record<string, string | number>).force : 0;
			const barW = Math.min(Math.abs(Number(val)) / 10 * 100, 100);
			valueHTML = (
				'<div class="lego-motor-row"><span>Force</span><span>' + Number(val).toFixed(1) + ' N</span></div>'
				+ '<div class="lego-force-bar-track"><div class="lego-force-bar-fill" style="width:' + barW + '%"></div></div>'
			);
			break;
		}
		case 'color': {
			// Handle nested data structure from ble-connection.ts
			const inner = sensorData.data && typeof sensorData.data === 'object'
				? sensorData.data
				: sensorData;
			const colorName = (inner as Record<string, string | number>).color || 'Unknown';
			const r = Number((inner as Record<string, string | number>).R || 0);
			const g = Number((inner as Record<string, string | number>).G || 0);
			const b = Number((inner as Record<string, string | number>).B || 0);
			const rgb = 'rgb(' + (Math.min(r / 1023 * 255, 255) | 0) + ',' + (Math.min(g / 1023 * 255, 255) | 0) + ',' + (Math.min(b / 1023 * 255, 255) | 0) + ')';
			const refl = (inner as Record<string, string | number>).refl != null ? (inner as Record<string, string | number>).refl : '?';
			valueHTML = (
				'<div class="lego-color-swatch" style="background:' + rgb + '"></div>'
				+ '<div class="lego-motor-row"><span>Name</span><span>' + colorName + '</span></div>'
				+ '<div class="lego-motor-row"><span>RGB</span><span>' + r.toFixed(0) + ',' + g.toFixed(0) + ',' + b.toFixed(0) + '</span></div>'
				+ '<div class="lego-motor-row"><span>Refl</span><span>' + refl + '</span></div>'
			);
			break;
		}
		case 'distance': {
			// Handle nested data structure from ble-connection.ts
			const inner = sensorData.data && typeof sensorData.data === 'object'
				? sensorData.data
				: sensorData;
			const dist = (inner as Record<string, string | number>).distance != null ? (inner as Record<string, string | number>).distance : 0;
			valueHTML = (
				'<div class="lego-motor-row"><span>Distance</span><span>' + dist + ' mm</span></div>'
			);
			break;
		}
	}

	return '<div class="lego-card lego-card" data-key="sensor-' + port + '-' + type + '">'
	+ '<div class="lego-card-title">' + type.charAt(0).toUpperCase() + type.slice(1) + ' Sensor ' + port + '</div>'
	+ valueHTML + '</div>';
}

// ── Static UI Fragments ──────────────────────────────────────────────────────

/** HTML fragment shown when no hub is connected. */
export function __getDisconnectedHTML(): string {
	return '<div class="disconnected">&#x1F50C;&nbsp; No Hub Connected</div>';
}

/** HTML fragment shown while scanning for hubs. */
export function __getScanningHTML(): string {
	return '<div class="scanning"><div class="spinner"></div>&nbsp; Scanning for Hubs...</div>';
}

/** HTML fragment shown while waiting for hub data after connect click. */
export function __getWaitingHTML(): string {
	return '<div class="scanning"><div class="spinner"></div>&nbsp; Waiting for Hub data...</div>';
}