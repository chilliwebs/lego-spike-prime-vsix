/**
 * LEGO Hub BLE Connection Module
 *
 * Manages the full BLE connection lifecycle to a SPIKE Prime hub using
 * the @stoprocent/noble library (BlueZ D-Bus backend on Linux).
 *
 * Handles:
 *  - Connecting to a hub peripheral by BLE address
 *  - Discovering GATT services and characteristics
 *  - Subscribing to TX notifications
 *  - COBS encoding/decoding of frames
 *  - Message serialization and deserialization
 *
 * Usage:
 *   const mgr = new BleConnectionManager(outputChannel, extensionRoot);
 *   mgr.connect(address);   // connects and performs init sequence
 *   mgr.disconnect();       // teardown
 *   mgr.dispose();          // cleanup resources
 */

import { OutputChannel } from 'vscode';
import { createHash } from 'crypto';
import zlib from 'zlib';

// Force noble to use BlueZ D-Bus backend.
// Node's require() cache ensures noble is instantiated only once,
// even if multiple modules (hub-discovery, ble-connection) require it.
process.env.NOBLE_BINDINGS = 'dbus';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let noble: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateReadyPromise: Promise<void> | null = null;

/**
 * Get (or create) the noble singleton and its state-ready promise.
 *
 * The first call bootstraps noble, registers a stateChange listener,
 * and creates a promise that resolves when the adapter is poweredOn.
 * Subsequent calls return the cached values.
 */
function getNobleAndState(): { noble: any; stateReadyPromise: Promise<void> } {
	if (noble) return { noble, stateReadyPromise: stateReadyPromise! };

	noble = require('@stoprocent/noble');

	const ADAPTER_TIMEOUT_MS = 8000;
	stateReadyPromise = new Promise<void>((resolve, reject) => {
		const rejectTimer = setTimeout(() => {
			reject(new Error(
				`BLE adapter never became ready (${ADAPTER_TIMEOUT_MS}ms timeout). ` +
				'Make sure Bluetooth is enabled and you are in the bluetooth/lp groups.',
			));
		}, ADAPTER_TIMEOUT_MS);

		const onState = (state: string) => {
			if (state === 'poweredOn') {
				clearTimeout(rejectTimer);
				resolve();
			} else if (state === 'unavailable' || state === 'unsupported') {
				clearTimeout(rejectTimer);
				reject(new Error(`BLE adapter is ${state}`));
			}
		};

		noble.on('stateChange', onState);

		// If the adapter is already powered on, resolve immediately.
		if (noble.state === 'poweredOn') {
			resolve();
		}
	});

	return { noble, stateReadyPromise };
}

// ── BLE Protocol Constants ───────────────────────────────────────────────────

// Noble returns service UUIDs with dashes (e.g. 0000fd02-0000-1000-8000-00805f9b34fb)
// but characteristic UUIDs without dashes on Linux (BlueZ backend).
// We keep SERVICE_UUID dashed for discoverServices() filtering, and char UUIDs
// undashed for direct comparison against noble's returned characteristic objects.
const SERVICE_UUID = '0000fd02-0000-1000-8000-00805f9b34fb';
const RX_CHAR_UUID = '0000fd0200011000800000805f9b34fb'; // write to hub
const TX_CHAR_UUID = '0000fd0200021000800000805f9b34fb'; // subscribe for notifications

// ── COBS Constants ───────────────────────────────────────────────────────────

const DELIMITER = 0x02;
const NO_DELIMITER = 0xff;
const COBS_CODE_OFFSET = 2;
const MAX_BLOCK_SIZE = 84;
const XOR_MASK = 3;

// ── Message Type IDs ─────────────────────────────────────────────────────────

const MSG_INFO_REQUEST = 0x00;
const MSG_INFO_RESPONSE = 0x01;
const MSG_CLEAR_SLOT_REQUEST = 0x46;
const MSG_START_FILE_UPLOAD_REQUEST = 0x0c;
const MSG_TRANSFER_CHUNK_REQUEST = 0x10;
const MSG_PROGRAM_FLOW_REQUEST = 0x1e;
const MSG_CONSOLE_NOTIFICATION = 0x21;
const MSG_DEVICE_NOTIFICATION_REQUEST = 0x28;
const MSG_DEVICE_NOTIFICATION_RESPONSE = 0x29;
const MSG_DEVICE_NOTIFICATION = 0x3c;
// Legacy constant — kept for backwards compat.
// Upload responses are actually request_opcode + 1 (see tryResolvePendingRequest).
const MSG_STATUS_RESPONSE = 0x29;

/**
 * Compute the expected response opcode for a given request opcode.
 * The SPIKE Prime hub echoes back request_id + 1 for all status responses:
 *   0x46 → 0x47 (ClearSlot), 0x0C → 0x0D (StartFileUpload),
 *   0x10 → 0x11 (TransferChunk), 0x1E → 0x1F (ProgramFlow).
 */
function responseOpcodeForRequest(requestOpcode: number): number {
	return requestOpcode + 1;
}

// Device notification sub-types (DEVICE_MESSAGE_MAP)
const DEV_MSG_BATTERY = 0x00;
const DEV_MSG_IMU = 0x01;
const DEV_MSG_DISPLAY_5X5 = 0x02;
const DEV_MSG_MOTOR = 0x0a;
const DEV_MSG_FORCE = 0x0b;
const DEV_MSG_COLOR = 0x0c;
const DEV_MSG_DISTANCE = 0x0d;
const DEV_MSG_DISPLAY_3X3 = 0x0e;

const DEV_MSG_FORMATS: Record<number, string> = {
	[DEV_MSG_BATTERY]: '<BB',
	[DEV_MSG_IMU]: '<BBBhhhhhhhhh',
	[DEV_MSG_DISPLAY_5X5]: '<B25B',
	[DEV_MSG_MOTOR]: '<BBBhhbi',
	[DEV_MSG_FORCE]: '<BBBB',
	[DEV_MSG_COLOR]: '<BBBBhhh',
	[DEV_MSG_DISTANCE]: '<BBh',
	[DEV_MSG_DISPLAY_3X3]: '<BB9B',
	// Undocumented sub-messages (reverse-engineered from live hub traffic):
	// [0x03]: '<BBBB',  // LED — RGB color (3 bytes + ID)
	// [0x04]: '<BB',    // Button — button ID + state
	// [0x64]: '<BH',    // Hub status (3 bytes: ID + uint16 LE)
	// [0x6f]: '<BH',    // Unknown hub event (3 bytes: ID + uint16 LE)
	// [0xff]: '<BB',    // Unknown trailer/heartbeat (2 bytes)
};

/**
 * Parse a struct format string and return the number of bytes it occupies.
 * Supports: B (uint8), h (int16), H (uint16), i (int32),
 *           repeat counts (e.g. "25B" = 25 uint8s), and mixed formats
 *           like "B25B" (1 uint8 + 25 uint8s = 26 bytes).
 *           Also handles consecutive identical chars like "hhh" = 3 shorts.
 */
/**
 * Strip the first format specifier from a Python struct format string.
 *
 * Python struct format strings encode repeats as: type-char + digits,
 * e.g. "25B" means 25 repetitions of 'B'. The first specifier often
 * carries a sub-message ID byte that should be excluded from data parsing.
 *
 * This function removes the first specifier entirely (type-char + any
 * explicit repeat count), since the ID byte is always a single instance
 * of a type (never repeated). The remaining body preserves its original
 * structure.
 *
 * Examples:
 * For '<B25B':
 *   First specifier is 'B' (no explicit repeat, 1 byte)
 *   Strip it. Body '25B' stays intact.
 *   Result: '<25B'
 *
 * For '<BB':
 *   First specifier is 'B' (1 byte)
 *   Strip it.
 *   Result: '<B'
 *
 * For '<BBbHHH':
 *   First specifier is 'B' (1 byte)
 *   Strip it.
 *   Result: '<BbHHH'
 */
function stripFirstFormatByte(fmt: string): string {
	// Strip endianness prefix
	const prefixMatch = fmt.match(/^([<>=!@])(.*)/);
	if (!prefixMatch) return fmt; // shouldn't happen

	const prefix = prefixMatch[1];
	let body = prefixMatch[2];

	// Parse the first format specifier from body.
	// Formats are like: B, H, h, i, b, or 25B, 9H, etc.
	// We need to consume the type char and any leading digits (repeat count).
	const specMatch = body.match(/^(\d*)([BHibh])/);
	if (!specMatch) return fmt; // fallback

	const repeatStr = specMatch[1];
	const typeChar = specMatch[2];
	const remainingBody = body.slice(specMatch[0].length);

	if (repeatStr) {
		// Has repeat count like "B25"
		const repeat = parseInt(repeatStr, 10);
		if (repeat > 1) {
			// Reduce repeat by 1: "25B" → "24B"
			body = (repeat - 1).toString() + typeChar + remainingBody;
		} else {
			// Repeat is 1: just remove the type char
			body = remainingBody;
		}
	} else {
		// No repeat count: just remove the type char
		body = remainingBody;
	}

	return prefix + body;
}

/**
 * Compute the byte size of a Python struct format string.
 *
 * Supports: B (uint8), h (int16), H (uint16), i (int32),
 *           repeat counts (e.g. "25B" = 25 uint8s), mixed formats
 *           like "B25B" (1 uint8 + 25 uint8s = 26 bytes),
 *           and consecutive identical chars like "hhh" = 3 shorts (6 bytes).
 */
function structByteLength(fmt: string): number {
	// Strip endianness and byte-order prefix (<, >, =, !, @)
	const body = fmt.replace(/^[<>=!@]/, '');

	let total = 0;
	let repeat = 0;
	let lastType: string | null = null;

	// Flush a pending type to the total
	const flush = () => {
		if (lastType !== null) {
			const count = repeat > 0 ? repeat : 1;
			total += count * structTypeSize(lastType);
			lastType = null;
			repeat = 0;
		}
	};

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];

		if (/^[0-9]$/.test(ch)) {
			// Digit: flush any pending type (handles "B25B" → 1*B + 25*B),
			// then start accumulating digits for the next type.
			flush();
			repeat = repeat * 10 + parseInt(ch, 10);
		} else if (/^[BHibh]$/.test(ch)) {
			if (lastType !== null && ch === lastType) {
				// Same type as current run — just extend the count.
				repeat++;
			} else {
				// New type (or first char): flush previous, start new run.
				flush();
				lastType = ch;
				repeat = repeat > 0 ? repeat : 1;
			}
		}
	}

	// Flush the last pending type
	flush();

	return total;
}

function structTypeSize(ch: string): number {
	switch (ch) {
		case 'B': return 1;
		case 'h': return 2;
		case 'H': return 2;
		case 'i': return 4;
		default: return 1;
	}
}

/**
 * Render a pixel grid using block characters: █ for lit, ░ for dark.
 * Pixels are laid out row-major (left-to-right, top-to-bottom).
 */
function renderGrid(cols: number, rows: number, pixels: number[]): string {
	const litChar = '█';  // █ FULL BLOCK
	const darkChar = '░';  // ░ LIGHT SHADE
	const lines: string[] = [];
	for (let r = 0; r < rows; r++) {
		const rowPixels: string[] = [];
		for (let c = 0; c < cols; c++) {
			const idx = r * cols + c;
			rowPixels.push(idx < pixels.length && pixels[idx] > 0 ? litChar : darkChar);
		}
		lines.push(rowPixels.join(''));
	}
	return lines.join('\n');
}

/**
 * Result of formatting a sub-message payload.
 * Kept for backwards compatibility with debug logging.
 */
interface SubMessageRender {
	name: string;
	value: string;
}

/**
 * Format a sub-message's payload according to its struct format string.
 * Returns structured data for the webview renderer, plus a {name, value}
 * pair for debug logging.
 */
type FormatResult =
	| { type: 'battery'; data: { percent: number }; debug: SubMessageRender }
	| { type: 'imu'; data: ImuData; debug: SubMessageRender }
	| { type: 'display5x5'; data: { brightnesses: number[] }; debug: SubMessageRender }
	| { type: 'display3x3'; data: { brightnesses: number[] }; debug: SubMessageRender }
	| { type: 'motor'; data: MotorData; debug: SubMessageRender }
	| { type: 'force'; data: SensorData; debug: SubMessageRender }
	| { type: 'color'; data: SensorData; debug: SubMessageRender }
	| { type: 'distance'; data: SensorData; debug: SubMessageRender }
	| { type: 'unknown'; data: { raw: string }; debug: SubMessageRender };

function formatSubMessage(subId: number, fmt: string, payload: Buffer): FormatResult {
	// Handle repeated formats (display grids) first
	if (subId === DEV_MSG_DISPLAY_5X5 || subId === DEV_MSG_DISPLAY_3X3) {
		const cols = subId === DEV_MSG_DISPLAY_5X5 ? 5 : 3;
		const rows = cols;
		const count = cols * cols;
		const pixels: number[] = [];
		for (let i = 0; i < Math.min(count, payload.length); i++) {
			pixels.push(payload[i]);
		}
		const debugName = subId === DEV_MSG_DISPLAY_5X5 ? 'Display (5x5)' : 'Display (3x3)';
		return {
			type: subId === DEV_MSG_DISPLAY_5X5 ? 'display5x5' : 'display3x3',
			data: { brightnesses: pixels },
			debug: { name: debugName, value: renderGrid(cols, rows, pixels) },
		};
	}

	// Parse individual fields for non-display types
	switch (subId) {
		case DEV_MSG_BATTERY: {
			const percent = payload.readUInt8(0);
			return {
				type: 'battery',
				data: { percent },
				debug: { name: 'Battery', value: `${percent}%` },
			};
		}
		case DEV_MSG_IMU: {
			const upFace = HUB_FACE_NAMES[payload.readUInt8(0)] ?? `Unknown(0x${payload.readUInt8(0).toString(16)})`;
			const yawFace = HUB_FACE_NAMES[payload.readUInt8(1)] ?? `Unknown(0x${payload.readUInt8(1).toString(16)})`;
			// Protocol: yaw/pitch/roll are in decidegrees (÷10 → degrees)
			const yaw = payload.readInt16LE(2) / 10;
			const pitch = payload.readInt16LE(4) / 10;
			const roll = payload.readInt16LE(6) / 10;
			// Protocol: accelerometer is in milli-G (×0.001 → g-force)
			const accelX = payload.readInt16LE(8) * 0.001;
			const accelY = payload.readInt16LE(10) * 0.001;
			const accelZ = payload.readInt16LE(12) * 0.001;
			// Protocol: gyroscope is in decidegrees/sec (÷10 → °/s)
			const gyroX = payload.readInt16LE(14) / 10;
			const gyroY = payload.readInt16LE(16) / 10;
			const gyroZ = payload.readInt16LE(18) / 10;
			return {
				type: 'imu',
				data: { upFace, yawFace, yaw, pitch, roll, accelX, accelY, accelZ, gyroX, gyroY, gyroZ },
				debug: {
					name: 'IMU',
					value: `upFace:${upFace} yawFace:${yawFace} Y:${yaw} P:${pitch} R:${roll} aX:${accelX} aY:${accelY} aZ:${accelZ} gX:${gyroX} gY:${gyroY} gZ:${gyroZ}`,
				},
			};
		}
		case DEV_MSG_MOTOR: {
			const port = payload.readUInt8(0);
			const motorType = MOTOR_TYPE_NAMES[payload.readUInt8(1)] ?? `Unknown(0x${payload.readUInt8(1).toString(16)})`;
			const absolutePosition = payload.readInt16LE(2);
			// Protocol: power is int16, range -10000..10000 (÷100 → % with sign)
			const power = payload.readInt16LE(4) / 100;
			// Protocol: speed is int8, range -100..100 (degrees/sec)
			const speed = payload.readInt8(6);
			const position = payload.readInt32LE(7);
			const portLetter = String.fromCharCode(65 + port);
			return {
				type: 'motor',
				data: {
					port: portLetter,
					type: motorType,
					absolutePosition,
					relativePosition: position,
					speed,
					power,
				},
				debug: { name: 'Motor', value: `port:${portLetter} type:${motorType} abs:${absolutePosition} speed:${speed} power:${power} pos:${position}` },
			};
		}
		case DEV_MSG_FORCE: {
			const forceRaw = payload.readUInt8(0);
			// Protocol: force is in decinewtons (0-100 dN, ÷10 → Newtons)
			const force = forceRaw / 10;
			return {
				type: 'force',
				data: {
					type: 'force',
					port: String.fromCharCode(65 + payload.readUInt8(1)),
					data: { force },
				},
				debug: { name: 'Force', value: `force:${forceRaw}dN=${force}N` },
			};
		}
		case DEV_MSG_COLOR: {
			const port = payload.readUInt8(0);
			const colorRaw = payload.readUInt8(1);
			const reflectivity = payload.readUInt8(2);
			const red = payload.readInt16LE(3);
			const green = payload.readInt16LE(5);
			const blue = payload.readInt16LE(7);
			const colorName = COLOR_NAMES[colorRaw] ?? `Unknown(0x${colorRaw.toString(16)})`;
			const portLetter = String.fromCharCode(65 + port);
			return {
				type: 'color',
				data: {
					type: 'color',
					port: portLetter,
					data: { color: colorName, R: red, G: green, B: blue, refl: reflectivity },
				},
				debug: { name: 'Color', value: `port:${portLetter} color:${colorName}(${colorRaw}) refl:${reflectivity} R:${red} G:${green} B:${blue}` },
			};
		}
		case DEV_MSG_DISTANCE: {
			const port = payload.readUInt8(0);
			const distance = payload.readInt16LE(1);
			const portLetter = String.fromCharCode(65 + port);
			return {
				type: 'distance',
				data: {
					type: 'distance',
					port: portLetter,
					data: { distance },
				},
				debug: { name: 'Distance', value: `port:${portLetter} ${distance}mm` },
			};
		}
		default:
			return {
				type: 'unknown',
				data: { raw: payload.toString('hex') },
				debug: { name: DEV_MSG_NAMES[subId] ?? 'Sub', value: payload.toString('hex') },
			};
	}
}

// ── IMU face enums ────────────────────────────────────────────────────────────

const HUB_FACE_NAMES = ['Top', 'Front', 'Right', 'Bottom', 'Back', 'Left'];

const MOTOR_TYPE_NAMES: Record<number, string> = {
	0x30: 'Medium Motor',
	0x31: 'Large Motor',
	0x41: 'Small Motor',
};

const COLOR_NAMES: Record<number, string> = {
	0x00: 'Black',
	0x01: 'Magenta',
	0x02: 'Purple',
	0x03: 'Blue',
	0x04: 'Azure',
	0x05: 'Turquoise',
	0x06: 'Green',
	0x07: 'Yellow',
	0x08: 'Orange',
	0x09: 'Red',
	0x0a: 'White',
	0xff: 'Unknown',
};

const DEV_MSG_NAMES: Record<number, string> = {
	[DEV_MSG_BATTERY]: 'Battery',
	[DEV_MSG_IMU]: 'IMU',
	[DEV_MSG_DISPLAY_5X5]: 'Display (5x5)',
	[DEV_MSG_MOTOR]: 'Motor',
	[DEV_MSG_FORCE]: 'Force',
	[DEV_MSG_COLOR]: 'Color',
	[DEV_MSG_DISTANCE]: 'Distance',
	[DEV_MSG_DISPLAY_3X3]: 'Display (3x3)',
};

// ── COBS Encoding ────────────────────────────────────────────────────────────

/**
 * COBS-pack data for transmission (matches spike_primes_ble/cobs.py::pack).
 *
 * Steps:
 *  1. COBS-encode (bytes <= DELIMITER become delimiters → split blocks)
 *  2. XOR every byte with XOR_MASK (3) to remove problematic control chars
 *  3. Append DELIMITER (0x02) to mark end of frame
 */
function cobsPack(data: Buffer): Buffer {
	const encoded = cobsEncode(data);
	const xored = Buffer.alloc(encoded.length);
	for (let i = 0; i < encoded.length; i++) {
		xored[i] = encoded[i] ^ XOR_MASK;
	}
	const result = Buffer.alloc(xored.length + 1);
	xored.copy(result, 0);
	result[xored.length] = DELIMITER;
	return result;
}

/**
 * COBS-encode data so that no byte equals DELIMITER (0x02).
 *
 * Matches spike_primes_ble/cobs.py::encode exactly.
 * Key difference from standard COBS: treats any byte <= DELIMITER (0x00, 0x01,
 * 0x02) as a delimiter, not just 0x00.  The code word formula is:
 *   code = (byte * MAX_BLOCK_SIZE) + (block_size + COBS_CODE_OFFSET)
 * which packs the original byte value into the high-order bits.
 */
function cobsEncode(data: Buffer): Buffer {
	const buffer: number[] = [];
	let codeIndex = 0;
	let block = 1;

	const beginBlock = () => {
		codeIndex = buffer.length;
		buffer.push(NO_DELIMITER); // placeholder, updated later
		block = 1;
	};

	beginBlock();

	for (let i = 0; i < data.length; i++) {
		const byte = data[i];

		// Non-delimiter value: write as-is
		if (byte > DELIMITER) {
			buffer.push(byte);
			block++;
		}

		// Block boundary: size limit or delimiter byte found
		if (byte <= DELIMITER || block > MAX_BLOCK_SIZE) {
			if (byte <= DELIMITER) {
				// Delimiter found — pack byte value + block info into code word
				const delimiterBase = byte * MAX_BLOCK_SIZE;
				const blockOffset = block + COBS_CODE_OFFSET;
				buffer[codeIndex] = delimiterBase + blockOffset;
			}
			beginBlock();
		}
	}

	// Finalize last code word
	buffer[codeIndex] = block + COBS_CODE_OFFSET;

	return Buffer.from(buffer);
}

// ── COBS Decoding ────────────────────────────────────────────────────────────

/**
 * COBS-unpack a received frame (matches spike_primes_ble/cobs.py::unpack).
 *
 * Steps:
 *  1. Optionally skip priority byte (0x01 prefix)
 *  2. Strip trailing DELIMITER (0x02)
 *  3. XOR every byte with XOR_MASK (3)
 *  4. COBS-decode to recover original data
 */
function cobsUnpack(frame: Buffer): Buffer {
	let start = 0;

	// Skip priority byte if present (per Python cobs.py unpack)
	if (frame.length > 0 && frame[0] === 0x01) {
		start = 1;
	}

	// Slice off trailing delimiter
	let data = frame;
	if (data.length > start && data[data.length - 1] === DELIMITER) {
		data = data.slice(start, -1);
	}

	// XOR unmask
	const xored = Buffer.alloc(data.length);
	for (let i = 0; i < data.length; i++) {
		xored[i] = data[i] ^ XOR_MASK;
	}

	// COBS decode
	return cobsDecode(xored);
}

/**
 * COBS-decode data (matches spike_primes_ble/cobs.py::decode).
 *
 * Reverses cobsEncode: unpacks code words that encode original byte values
 * and block boundaries.  The Python algorithm uses divmod to extract the
 * escaped byte value and block size from each code word.
 */
function cobsDecode(data: Buffer): Buffer {
	const buffer: number[] = [];

	const unescape = (code: number): [number | null, number] => {
		if (code === NO_DELIMITER) {
			return [null, MAX_BLOCK_SIZE + 1];
		}
		const [value, block] = [(code - COBS_CODE_OFFSET) / MAX_BLOCK_SIZE, (code - COBS_CODE_OFFSET) % MAX_BLOCK_SIZE];
		const intVal = Math.trunc(value);
		const intBlock = Math.trunc(block);
		if (intBlock === 0) {
			return [intVal - 1, MAX_BLOCK_SIZE];
		}
		return [intVal, intBlock];
	};

	let [value, block] = unescape(data[0]);

	for (let i = 1; i < data.length; i++) {
		block--;
		if (block > 0) {
			buffer.push(data[i]);
			continue;
		}

		// Block boundary — emit the escaped delimiter byte (if any)
		if (value !== null) {
			buffer.push(value);
		}

		[value, block] = unescape(data[i]);
	}

	return Buffer.from(buffer);
}

// ── Message Serialization ────────────────────────────────────────────────────

/** Serialize a message payload to a Buffer. */
function serializeMessage(typeId: number, payload?: Buffer): Buffer {
	switch (typeId) {
		case MSG_INFO_REQUEST:
			return Buffer.from([MSG_INFO_REQUEST]); // just b"\0"

		case MSG_DEVICE_NOTIFICATION_REQUEST: {
			// struct.pack("<BH", ID, interval_ms)
			const interval = payload ? payload.readUInt16LE(0) : 5000;
			const buf = Buffer.allocUnsafe(3);
			buf.writeUInt8(MSG_DEVICE_NOTIFICATION_REQUEST, 0);
			buf.writeUInt16LE(interval, 1);
			return buf;
		}

		case MSG_CLEAR_SLOT_REQUEST: {
			// struct.pack("<BB", self.ID, self.slot)
			const slot = payload ? payload.readUInt8(0) : 0;
			const buf = Buffer.allocUnsafe(2);
			buf.writeUInt8(MSG_CLEAR_SLOT_REQUEST, 0);
			buf.writeUInt8(slot, 1);
			return buf;
		}

		case MSG_PROGRAM_FLOW_REQUEST: {
			// struct.pack("<BBB", self.ID, self.stop, self.slot)
			let offset = 0;
			const buf = Buffer.allocUnsafe(3);
			buf.writeUInt8(MSG_PROGRAM_FLOW_REQUEST, offset++);
			if (payload && payload.length >= 2) {
				buf.writeUInt8(payload[0], offset++); // stop (0 or 1)
				buf.writeUInt8(payload[1], offset);   // slot
			} else {
				buf.writeUInt8(0, offset++); // stop = false (start)
				buf.writeUInt8(0, offset);   // slot = 0
			}
			return buf;
		}

		default:
			return Buffer.alloc(0);
	}
}

// ── CRC32 for file uploads (matches spike_primes_ble/crc.py) ────────────────

/**
 * Calculate CRC32 of data with optional seed and alignment.
 * Matches spike_primes_ble/crc.py::crc exactly.
 */
function calculateCrc(data: Buffer, seed: number = 0, align: number = 4): number {
	let remainder = data.length % align;
	if (remainder) {
		data = Buffer.concat([data, Buffer.alloc(align - remainder)]);
	}
	return zlib.crc32(data, seed) >>> 0; // unsigned 32-bit
}

// ── Upload Message Serialization ─────────────────────────────────────────────

/** Serialize a ClearSlotRequest payload to a Buffer. */
function serializeClearSlotRequest(slot: number): Buffer {
	const buf = Buffer.allocUnsafe(2);
	buf.writeUInt8(MSG_CLEAR_SLOT_REQUEST, 0);
	buf.writeUInt8(slot, 1);
	return buf;
}

/** Serialize a StartFileUploadRequest payload to a Buffer. */
function serializeStartFileUploadRequest(fileName: string, slot: number, crc: number): Buffer {
	const encodedName = Buffer.from(fileName, 'utf8');
	if (encodedName.length > 31) {
		throw new Error(`File name too long: ${encodedName.length} + 1 >= 32 bytes`);
	}
	const fmt = `<B${encodedName.length + 1}sBI`;
	const buf = Buffer.allocUnsafe(1 + encodedName.length + 1 + 1 + 4);
	let offset = 0;
	buf.writeUInt8(MSG_START_FILE_UPLOAD_REQUEST, offset++);
	encodedName.copy(buf, offset);
	offset += encodedName.length;
	buf.writeUInt8(0, offset++); // null terminator
	buf.writeUInt8(slot, offset++);
	buf.writeUInt32LE(crc, offset);
	return buf;
}

/** Serialize a TransferChunkRequest payload to a Buffer. */
function serializeTransferChunkRequest(runningCrc: number, chunk: Buffer): Buffer {
	const fmt = `<BIH${chunk.length}s`;
	const buf = Buffer.allocUnsafe(1 + 4 + 2 + chunk.length);
	let offset = 0;
	buf.writeUInt8(MSG_TRANSFER_CHUNK_REQUEST, offset++);
	buf.writeUInt32LE(runningCrc, offset);
	offset += 4;
	buf.writeUInt16LE(chunk.length, offset);
	offset += 2;
	chunk.copy(buf, offset);
	return buf;
}

// ── Message Deserialization ──────────────────────────────────────────────────

/**
 * Result of deserializing a BLE message.
 * `message` is the human-readable display string.
 * `debug` contains diagnostic metadata (e.g., unknown sub-message hex dumps).
 */
interface DeserializedMessage {
	message: string;
	debug?: string;
}

/**
 * Deserialize incoming data and return a human-readable description.
 * Looks at data[0] to determine message type and dispatches accordingly.
 */
function deserializeMessage(data: Buffer, deviceState?: DeviceStateStore): DeserializedMessage {
	if (data.length === 0) return { message: '(empty)' };

	const typeId = data[0];

	switch (typeId) {
		case MSG_INFO_RESPONSE: {
			// Python struct "<BBBHBBHHHHH" — 17 bytes total:
			//   B  id (0)
			//   B  rpc_major (1)
			//   B  rpc_minor (2)
			//   H  rpc_build (3)
			//   B  firmware_major (5)
			//   B  firmware_minor (6)
			//   H  max_packet_size (7)
			//   H  max_message_size (9)
			//   H  max_chunk_size (11)
			//   H  product_group_device (13)
			//   H  (15) — additional field
			if (data.length < 17) return { message: `InfoResponse (truncated, ${data.length}B)` };
			const major = data[1];
			const minor = data[2];
			const build = data.readUInt16LE(3);
			const firmwareMajor = data[5];
			const firmwareMinor = data[6];
			const maxPacketSize = data.readUInt16LE(7);
			const maxMessageSize = data.readUInt16LE(9);
			const maxChunkSize = data.readUInt16LE(11);
			const productGroup = data.readUInt16LE(13);
			const extraField = data.readUInt16LE(15);
			return {
				message: (
					`InfoResponse v${major}.${minor}.${build}: ` +
					`fw=${firmwareMajor}.${firmwareMinor} ` +
					`pkt=${maxPacketSize} msg=${maxMessageSize} ` +
					`chunk=${maxChunkSize} group=${productGroup} extra=${extraField}`
				),
			};
		}

		case MSG_DEVICE_NOTIFICATION_RESPONSE: {
			// StatusResponse: <BB — id(1B) + status_code(1B)
			// status_code 0x00 = success, non-zero = error
			if (data.length < 2) return { message: 'DeviceNotificationResponse: (truncated)' };
			const status = data.readUInt8(1);
			const statusText = status === 0 ? 'OK' : `error(0x${status.toString(16)})`;
			return { message: `DeviceNotificationResponse: ${statusText}` };
		}

		case MSG_DEVICE_NOTIFICATION: {
			// Frame layout: <B(1B msgID) + H(1B payload_size)> + payload
			// payload = sequence of sub-messages, each: <B(sub_id) + data>
			if (data.length < 3) return { message: `DeviceNotification (truncated, ${data.length}B)` };
			const payloadSize = data.readUInt16LE(1);
			const payload = data.subarray(3);

			if (payload.length === 0) {
				return { message: `DeviceNotification payloadSize=${payloadSize} (no payload)` };
			}

			// Parse sub-messages sequentially and build structured state.
			const state: DeviceStateData = {};
			const debugRows: SubMessageRender[] = [];
			let offset = 0;
			let debugInfo: string | undefined;
			while (offset < payload.length) {
				const subId = payload[offset];
				const name = DEV_MSG_NAMES[subId] ?? `Unknown(0x${subId.toString(16)})`;

				if (DEV_MSG_FORMATS[subId]) {
					const fmt = DEV_MSG_FORMATS[subId];
					const fullSize = structByteLength(fmt);
					const dataNeeded = fullSize - 1;
					if (payload.length - offset - 1 >= dataNeeded) {
						const dataBytes = payload.subarray(offset + 1);
						const dataFmt = stripFirstFormatByte(fmt);
						const result = formatSubMessage(subId, dataFmt, dataBytes);
						debugRows.push(result.debug);

						// Merge structured data into state
						switch (result.type) {
							case 'battery':
								state.battery = result.data;
								break;
							case 'imu':
								state.imu = result.data;
								break;
							case 'display5x5':
								state.display5x5 = result.data;
								break;
							case 'display3x3':
								state.display3x3 = result.data;
								break;
							case 'motor':
								state.motors = [...(state.motors ?? []), result.data];
								break;
							case 'force':
							case 'color':
							case 'distance':
								state.sensors = [...(state.sensors ?? []), result.data];
								break;
						}
						offset += fullSize;
					} else {
						const remainingBytes = [...payload.subarray(offset)].map(b => b.toString());
						debugRows.push({ name: 'Extra', value: `(${remainingBytes.join(',')})` });
						break;
					}
				} else {
					const remaining = payload.slice(offset);
					debugRows.push({ name, value: `[${remaining.toString('hex')}]` });
					debugInfo = (
						`Unknown sub-msg 0x${subId.toString(16).padStart(2, '0')} (${subId}): ` +
						`${remaining.toString('hex')} (${remaining.length} bytes remaining)`
					);
					offset += 1;
				}
			}

			// Persist the structured state for UI display.
			console.debug('[LEGO] deviceState.set called, state keys=', Object.keys(state));
			deviceState?.set(state);

			// Assemble a clean table for debug logging.
			const maxNameLen = Math.max(...debugRows.map(r => r.name.length), 'Module'.length);
			const pad = ' '.repeat(maxNameLen);
			const lines: string[] = [];
			lines.push(`DeviceNotification (payloadSize=${payloadSize})`);
			lines.push(`  ${'Module'.padEnd(maxNameLen)}  Details`);
			lines.push(`  ${'-'.repeat(maxNameLen)}  ${'-'.repeat(50)}`);
			for (const row of debugRows) {
				const nameLine = row.name.padEnd(maxNameLen);
				const valueLines = row.value.split('\n');
				for (let v = 0; v < valueLines.length; v++) {
					if (v === 0) {
						lines.push(`  ${nameLine}  ${valueLines[v]}`);
					} else {
						lines.push(`  ${pad}  ${valueLines[v]}`);
					}
				}
			}

			return { message: lines.join('\n'), debug: debugInfo };
		}

		case MSG_CONSOLE_NOTIFICATION: {
			// ConsoleNotification: [0x21] + UTF-8 text + trailing nulls
			// Matches Python: text_bytes = data[1:].rstrip(b"\0")
			const text = data.subarray(1).toString('utf8').replace(/\0+$/, '').replace(/\r?\n$/, '');
			return { message: text };
		}

		default:
			return { message: `(unknown msg 0x${typeId.toString(16).padStart(2, '0')}: ${data.toString('hex')})` };
	}
}

// ── Connection State Interface ───────────────────────────────────────────────

interface DiscoveredHub {
	address: string;
	name?: string;
	model?: string;
}

/** Structured device state matching the webview's expectations. */
export interface ImuData {
	upFace?: string;
	yawFace?: string;
	yaw: number;
	pitch: number;
	roll: number;
	accelX: number;
	accelY: number;
	accelZ: number;
	gyroX: number;
	gyroY: number;
	gyroZ: number;
}

export interface MotorData {
	port: string;
	type: string;
	absolutePosition: number;
	relativePosition: number;
	speed: number;
	power: number;
}

export interface SensorData {
	type: 'force' | 'color' | 'distance';
	port: string;
	data: Record<string, string | number>;
}

export interface DeviceStateData {
	battery?: { percent: number };
	imu?: ImuData;
	display5x5?: { brightnesses: number[] };
	display3x3?: { brightnesses: number[] };
	motors?: MotorData[];
	sensors?: SensorData[];
}

/**
 * Stores the last-known parsed DeviceNotification state for display in the UI.
 * Emits events to subscribed listeners when state changes.
 */
export class DeviceStateStore {
	private _state: DeviceStateData = {};
	private listeners: Set<(state: DeviceStateData) => void> = new Set();

	get state(): DeviceStateData {
		return this._state;
	}

	set(data: DeviceStateData): void {
		this._state = data;
		for (const fn of [...this.listeners]) {
			fn(this._state);
		}
	}

	subscribe(fn: (state: DeviceStateData) => void): { dispose: () => void } {
		this.listeners.add(fn);
		return {
			dispose: () => {
				this.listeners.delete(fn);
			},
		};
	}

	getSubscription(): DeviceStateData {
		return this._state;
	}

	clear(): void {
		this._state = {};
		for (const fn of [...this.listeners]) {
			fn(this._state);
		}
	}
}

// ── BleConnectionManager ─────────────────────────────────────────────────────

/**
 * Manages the full BLE connection lifecycle to a SPIKE Prime hub.
 *
 * Connects via @stoprocent/noble, discovers GATT characteristics,
 * subscribes to TX notifications, performs the init handshake,
 * and logs all activity to the VS Code output channel.
 */
export class BleConnectionManager {
	private noble: any = null;
	private stateReadyPromise: Promise<void> | null = null;
	private peripheral: any = null;
	private service: any = null;
	private txCharacteristic: any = null;
	private rxCharacteristic: any = null;
	private outputChannel: OutputChannel;
	private consoleChannel: OutputChannel;
	private deviceState: DeviceStateStore;
	private connectionTimeout: NodeJS.Timeout | null = null;
	private _connected = false;
	private initPhase = 0;

	/** Called when the peripheral disconnects (explicitly or auto-disconnect). */
	onDisconnect: (() => void) | null = null;

	// ── Receive-side buffering for fragmented BLE notifications ──────────────
	//
	// BLE GATT notifications can arrive split across multiple callbacks. The
	// Python reference maintains a recv_buf that accumulates bytes until a
	// complete COBS frame (delimited by 0x02) is assembled, then processes
	// the full frame via cobsUnpack. This mirrors that pattern.

	private recvBuf: Buffer = Buffer.alloc(0);
	private serviceDiscoveryPromise: Promise<void> | null = null;

	// ── InfoResponse cache ───────────────────────────────────────────
	//
	// Cached during init handshake so uploadSlot() can read maxChunkSize.

	private infoResponse: { maxChunkSize: number; maxPacketSize: number } | null = null;

	// ── Init handshake promise ─────────────────────────────────────────────
	//
	// Resolved when the full init handshake completes (InfoResponse +
	// DeviceNotificationResponse received).  Chained through
	// discoverCharacteristics() → discoverServices() → connect().

	private handshakeResolve: (() => void) | null = null;
	private handshakePromise: Promise<void> = new Promise<void>((resolve) => {
		this.handshakeResolve = resolve;
	});

	constructor(outputChannel: OutputChannel, consoleChannel: OutputChannel, _extensionRoot: string, deviceState: DeviceStateStore) {
		this.outputChannel = outputChannel;
		this.consoleChannel = consoleChannel;
		this.deviceState = deviceState;
	}

	// ── Public API ─────────────────────────────────────────────────────────

	/**
	 * Connect to a hub by BLE address and perform the init handshake.
	 *
	 * @returns A promise that resolves when the init handshake is complete.
	 */
	async connect(address: string): Promise<void> {
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Connecting to hub ${address} via noble`,
		);

		if (this._connected) {
			this.outputChannel.appendLine(
				'[LEGO Spike Prime] Already connected — ignoring connect request',
			);
			return;
		}

		const init = getNobleAndState();
		this.noble = init.noble;
		this.stateReadyPromise = init.stateReadyPromise;

		await this.stateReadyPromise.then(() => this.doConnect(address));

		// Clear the connection timeout — we're connected, no need to abort.
		if (this.connectionTimeout) {
			clearTimeout(this.connectionTimeout);
			this.connectionTimeout = null;
		}

		// Wait for the full handshake to complete (service discovery + init).
		if (this.serviceDiscoveryPromise) {
			await this.serviceDiscoveryPromise;
		}

		this.outputChannel.appendLine(
			'[LEGO Spike Prime] Init handshake complete',
		);
	}

	/**
	 * Clear the stored device state (called on disconnect to prevent stale data).
	 */
	clearState(): void {
		this.deviceState.clear();
	}

	/**
	 * Disconnect from the hub and clean up BLE resources.
	 */
	disconnect(): void {
		this._connected = false;
		this.initPhase = 0;

		if (this.txCharacteristic) {
			try {
				this.txCharacteristic.removeAllListeners('data');
				this.txCharacteristic.unsubscribe();
			} catch {
				// ignore — characteristic may already be gone
			}
			this.txCharacteristic = null;
		}

		if (this.rxCharacteristic) {
			this.rxCharacteristic = null;
		}

		if (this.service) {
			this.service = null;
		}

		if (this.peripheral) {
			try {
				this.peripheral.disconnect();
			} catch {
				// ignore — peripheral may already be disconnected
			}
			this.peripheral = null;
		}

		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Disconnected from hub`,
		);
	}

	/**
	 * Clean up all resources. Calls disconnect() and stops any ongoing scan.
	 */
	dispose(): void {
		this.disconnect();
		if (this.connectionTimeout) {
			clearTimeout(this.connectionTimeout);
			this.connectionTimeout = null;
		}
		if (this.noble) {
			try {
				this.noble.stopScanning();
			} catch {
				// ignore
			}
		}
	}

	// ── Connection Fallback ────────────────────────────────────────────────

	/**
	 * Attempt to connect to a peripheral by BLE address.
	 *
	 * Strategy:
	 *  1. Call `noble.connectAsync(address)` directly. This works when the
	 *     peripheral is already in noble's internal `_peripherals` map (e.g.
	 *     it was discovered during a previous scan or during bindings init).
	 *  2. If that hangs (peripheral not in map), fall back to scanning —
	 *     `ensurePeripheralDiscovered` starts a scan, waits for a 'discover'
	 *     event, then returns the peripheral for `connectAsync` to finish.
	 */
	private async tryConnectWithFallback(address: string): Promise<any> {
		// Try direct connect first.
		try {
			const peripheral = await this.noble.connectAsync(address);
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Direct connect succeeded for ${address}`,
			);
			return peripheral;
		} catch (directErr) {
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Direct connect failed (${(directErr as Error).message}) — falling back to scan`,
			);
		}

		// Fallback: start scanning, wait for the peripheral to appear,
		// then call connectAsync which should succeed because the peripheral
		// is now in noble's internal map.
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Scanning for ${address}…`,
		);

		await this.ensurePeripheralDiscovered(address, 8000);

		// Now that we have the peripheral in the map, connect.
		// Noble's connectAsync expects a BLE address string.
		const peripheral = await this.noble.connectAsync(address);
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Scan-based connect succeeded for ${address}`,
		);
		return peripheral;
	}

	// ── Internal Connection Logic ──────────────────────────────────────────

	/**
	 * Ensure the target peripheral is registered in noble's internal map.
	 *
	 * Noble only adds peripherals to its `_peripherals` map when the
	 * bindings emit a 'discover' event.  The bindings emit these events
	 * for cached devices during their async `_init()` — but `_init()`
	 * is fire-and-forget, so if we call `connectAsync()` too early
	 * noble won't find the peripheral and the promise hangs forever.
	 *
	 * This method waits for the target device to appear (via cached
	 * device 'discover' events from bindings init), with a timeout.
	 */
	private async ensurePeripheralDiscovered(
		address: string,
		timeoutMs: number,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const targetId = address.replace(/:/g, '').toLowerCase();
			let found = false;

			const onDiscover = (
				_uuid: string,
				addr: string,
			) => {
				if (found) return;
				if (addr.replace(/:/g, '').toLowerCase() === targetId) {
					found = true;
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] Peripheral discovered: ${addr}`,
					);
					this.noble.off('discover', onDiscover);
					resolve();
				}
			};

			this.noble.on('discover', onDiscover);

			// Also start scanning so that _if_ the device is advertising
			// (e.g. not yet connected) we can still find it.
			this.noble.startScanning();

			setTimeout(() => {
				if (found) return;
				this.noble.off('discover', onDiscover);
				this.noble.stopScanning();
				reject(new Error(`Peripheral ${address} not found (${timeoutMs}ms)`));
			}, timeoutMs).unref();
		});
	}

	private async doConnect(address: string): Promise<void> {
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Initiating connection to ${address}...`,
		);

		// Start the connection timeout before we begin (in case noble hangs).
		this.connectionTimeout = setTimeout(() => {
			if (this.peripheral) {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Error: Connection timed out after 15s`,
				);
				try {
					this.peripheral.disconnect();
				} catch { /* ignore */ }
				this.peripheral = null;
			}
		}, 15000).unref();

		// noble.connectAsync creates the peripheral internally and connects.
		// Capture the result in a local variable first so we can safely set
		// up listeners even if the connect attempt throws.
		//
		// Noble only adds peripherals to its internal map when they are
		// discovered via scanning.  If connectAsync hangs because the
		// peripheral isn't in noble's map, we fall back to scanning.
		const peripheral = await this.tryConnectWithFallback(address);
		this.peripheral = peripheral;

		// ── Peripheral event listeners ─────────────────────────────────

		peripheral.on('connect', () => {
			this._connected = true;
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Connected to ${address}`,
			);
			this.serviceDiscoveryPromise = this.discoverServices();
		});

		// Handle the race condition where BlueZ has the device cached as
		// already-connected, causing the 'connect' event to fire during
		// connectAsync() before our handler is attached. In that case
		// peripheral.state is 'connected' but the event has already fired,
		// so we trigger discovery here instead of waiting for the event.
		//
		// We also add a short delay before discovery: BlueZ may report
		// ServicesResolved=true before its ObjectManager has finished
		// populating the GATT service/characteristic object tree.  Without
		// this delay discoverServices() would query an empty _objects map
		// and return immediately with no services found.
		if (peripheral.state === 'connected') {
			this._connected = true;
			this.outputChannel.appendLine(
				'[LEGO Spike Prime] Peripheral already connected — delaying 500 ms for BlueZ GATT tree...',
			);
			// Initialize the promise NOW so connect() can await it.
			// The actual work happens in the setTimeout callback.
			this.serviceDiscoveryPromise = new Promise<void>((resolve) => {
				setTimeout(() => {
					this.discoverServices().then(resolve);
				}, 500);
			});
		}

		peripheral.on('disconnect', () => {
			this._connected = false;
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Disconnected from ${address}`,
			);
			this.txCharacteristic = null;
			this.rxCharacteristic = null;
			this.service = null;
			this.peripheral = null;
			// Notify external listeners (status bar, webview)
			if (this.onDisconnect) {
				this.onDisconnect();
			}
		});

		peripheral.on('connectError', (err: Error) => {
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Error: Connection failed — ${err.message}`,
			);
			// Note: connectAsync will already reject the promise; we just log.
			this.peripheral = null;
		});
	}

	private discoverServices(): Promise<void> {
		if (!this.peripheral) return Promise.resolve();

		this.outputChannel.appendLine(
			'[LEGO Spike Prime] Discovering services...',
		);

		return new Promise<void>((resolve) => {
			this.peripheral.discoverServices([SERVICE_UUID], (err: Error | null, services: any[]) => {
				if (err) {
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] Error: Service discovery failed — ${err.message}`,
					);
					resolve();
					return;
				}

				if (!services || services.length === 0) {
					this.outputChannel.appendLine(
						'[LEGO Spike Prime] Warning: LEGO GATT service not found',
					);
					resolve();
					return;
				}

				this.service = services[0];
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Discovered service ${SERVICE_UUID}`,
				);

				this.discoverCharacteristics().then(resolve);
			});
		});
	}

	private async discoverCharacteristics(): Promise<void> {
		if (!this.service) return;

		this.outputChannel.appendLine(
			'[LEGO Spike Prime] Discovering characteristics...',
		);

		await new Promise<void>((resolve) => {
			this.service!.discoverCharacteristics([], (err: Error | null, characteristics: any[]) => {
				if (err) {
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] Error: Characteristic discovery failed — ${err.message}`,
					);
					resolve();
					return;
				}

				if (!characteristics) {
					resolve();
					return;
				}

				// Log all discovered characteristic UUIDs for diagnostics
				const allUuids = characteristics.map(c => c.uuid).join(', ');
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Found ${characteristics.length} characteristics: ${allUuids}`,
				);

				for (const char of characteristics) {
					if (char.uuid === TX_CHAR_UUID) {
						this.txCharacteristic = char;
					} else if (char.uuid === RX_CHAR_UUID) {
						this.rxCharacteristic = char;
					}
				}

				if (!this.rxCharacteristic) {
					this.outputChannel.appendLine(
						'[LEGO Spike Prime] Warning: RX characteristic not found',
					);
				}

				resolve();
			});
		});

		// Enable notifications on the TX characteristic FIRST (per Python
		// reference: start_notify happens before any messages are sent).
		await this.setupTxNotifications();

		// Now begin the init handshake — the hub can safely send responses.
		this.performInitSequence();

		// Wait for the full init handshake to complete before resolving.
		await this.handshakePromise;
	}

	private setupTxNotifications(): Promise<void> {
		if (!this.txCharacteristic) return Promise.resolve();

		this.txCharacteristic.on('data', (data: Buffer, isNotification: boolean) => {
			if (isNotification) {
				this.handleTxData(data);
			}
		});

		return new Promise<void>((resolve) => {
			this.txCharacteristic.subscribe((err: Error | null) => {
				if (err) {
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] Error: TX subscribe failed — ${err.message}`,
					);
				} else {
					this.outputChannel.appendLine(
						'[LEGO Spike Prime] Subscribed to TX characteristic',
					);
				}
				resolve();
			});
		});
	}

	// ── Init Handshake ─────────────────────────────────────────────────────

	private performInitSequence(): void {
		if (!this._connected) return;

		// Step 1: Send InfoRequest → InfoResponse
		this.sendInfoRequest();
	}

	private sendInfoRequest(): void {
		const payload = serializeMessage(MSG_INFO_REQUEST);
		this.sendToHub(MSG_INFO_REQUEST, payload);
	}

	// ── TX Data Handler ────────────────────────────────────────────────────

	/**
	 * Handle incoming TX notification data from the hub.
	 *
	 * BLE GATT notifications can arrive fragmented across multiple callbacks.
	 * This method accumulates bytes in recvBuf until a complete COBS frame
	 * (delimited by 0x02) is assembled, then decodes and dispatches each
	 * complete frame. Multiple frames can arrive in a single callback.
	 *
	 * Mirrors the recv_buf pattern from spike_primes_ble/connect.py.
	 */
	private handleTxData(data: Buffer): void {
		// Append new bytes to the receive buffer.
		if (this.recvBuf.length === 0) {
			this.recvBuf = data;
		} else {
			this.recvBuf = Buffer.concat([this.recvBuf, data]);
		}

		// Scan for 0x02 delimiters and extract complete frames.
		while (this.recvBuf.length > 0) {
			const delimIdx = this.recvBuf.indexOf(DELIMITER);
			if (delimIdx === -1) {
				// No complete frame yet — wait for more data.
				break;
			}

			// Extract the frame including the delimiter.
			const frame = this.recvBuf.subarray(0, delimIdx + 1);
			this.recvBuf = this.recvBuf.subarray(delimIdx + 1);

			this.processFrame(frame);
		}
	}

	/**
	 * Decode a complete COBS frame and dispatch the deserialized message.
	 */
	private processFrame(frame: Buffer): void {
		try {
			const decoded = cobsUnpack(frame);

			// Check if this frame resolves a pending upload request before
			// doing anything else — upload responses must not be confused
			// with device notifications.
			if (this.tryResolvePendingRequest(decoded)) {
				return;
			}

			const description = deserializeMessage(decoded, this.deviceState);
			// ConsoleNotification messages go to the console channel; everything else goes to the main output channel.
			if (decoded.length > 0 && decoded[0] === MSG_CONSOLE_NOTIFICATION) {
				if (!description.message.trim()) {
					// Skip empty/whitespace-only fragments (e.g. standalone \r\n from hub print).
					return;
				}
				this.consoleChannel.appendLine(description.message);
			} else {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Received: ${description.message}`,
				);
				// Log debug metadata (e.g., unknown sub-message hex dumps)
				if (description.debug) {
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] Debug: ${description.debug}`,
					);
				}
			}

			// ── Init handshake state machine ───────────────────────
			if (this.initPhase === 0 && decoded.length > 0 && decoded[0] === MSG_INFO_RESPONSE) {
				// Cache the maxChunkSize and maxPacketSize from the InfoResponse.
				if (decoded.length >= 17) {
					this.infoResponse = {
						maxChunkSize: decoded.readUInt16LE(11),
						maxPacketSize: decoded.readUInt16LE(7),
					};
				}
				this.initPhase = 1;
				this.outputChannel.appendLine(
					'[LEGO Spike Prime] InfoResponse received — sending DeviceNotificationRequest',
				);
				this.sendToHub(MSG_DEVICE_NOTIFICATION_REQUEST);
			} else if (this.initPhase === 1 && decoded.length > 0 && decoded[0] === MSG_DEVICE_NOTIFICATION_RESPONSE) {
				this.initPhase = 2;
				this.outputChannel.appendLine(
					'[LEGO Spike Prime] Init handshake complete',
				);
				if (this.handshakeResolve) {
					this.handshakeResolve();
					this.handshakeResolve = null;
				}
			}
		} catch (err) {
			const errMsg = (err as Error).message;
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Error: COBS decode failed on frame — ${errMsg}`,
			);
		}
	}

	// ── Sending Messages ───────────────────────────────────────────────────

	/**
	 * Send a ProgramFlowRequest to start/stop the program on the given slot.
	 *
	 * Sends `ProgramFlowRequest(stop=False, slot=N)` which tells the hub to
	 * run (stop=false) or halt (stop=true) the program stored in *slot*.
	 *
	 * @param slot - Slot number (0-19) where the program is stored.
	 * @returns A promise that resolves when the write to the RX characteristic completes.
	 */
	async runSlot(slot: number): Promise<void> {
		if (!this._connected || !this.rxCharacteristic) {
			throw new Error('Not connected to hub');
		}

		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Starting program on slot ${slot}`,
		);

		// Build the payload: [stop_flag, slot_number]
		// stop=0 means start, stop=1 means stop
		const payload = Buffer.from([0x00, slot]);

		await new Promise<void>((resolve, reject) => {
			this.sendToHub(MSG_PROGRAM_FLOW_REQUEST, payload);
			// sendToHub's internal write callback fires asynchronously.
			// We resolve immediately since there's no response mechanism wired up
			// for ProgramFlowRequest in the current init handshake pipeline.
			resolve();
		});
	}

	/**
	 * Send a ProgramFlowRequest to stop the program on the given slot.
	 *
	 * Sends `ProgramFlowRequest(stop=True, slot=N)` which tells the hub to
	 * halt the program stored in *slot*.  Uses the same MSG_PROGRAM_FLOW_REQUEST
	 * (0x1e) but with the stop flag set to 0x01 instead of 0x00.
	 *
	 * @param slot - Slot number (0-19) where the program to stop is stored.
	 * @returns A promise that resolves when the write to the RX characteristic completes.
	 */
	async stopSlot(slot: number): Promise<void> {
		if (!this._connected || !this.rxCharacteristic) {
			throw new Error('Not connected to hub');
		}

		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Stopping program on slot ${slot}`,
		);

		// Build the payload: [stop_flag, slot_number]
		// stop=1 means halt/stop
		const payload = Buffer.from([0x01, slot]);

		await new Promise<void>((resolve, reject) => {
			this.sendToHub(MSG_PROGRAM_FLOW_REQUEST, payload);
			// sendToHub's internal write callback fires asynchronously.
			// We resolve immediately since there's no response mechanism wired up
			// for ProgramFlowRequest in the current init handshake pipeline.
			resolve();
		});
	}

	// ── Request/Response Queue ─────────────────────────────────────────

	// Used by the upload protocol to send a request and wait for the
	// corresponding response.  Each pending request tracks the expected
	// response message ID and holds a promise + resolver.

	private pendingRequests: Map<number, {
		resolve: (success: boolean) => void;
		reject: (err: Error) => void;
		expectedMsgId: number;
		timer: NodeJS.Timeout;
	}> = new Map();
	private _requestId = 0;

	/**
	 * Send a request and wait for a status response.
	 *
	 * The hub responds to status-bearing messages with a two-byte
	 * StatusResponse: `[msgId, statusCode]` where 0x00 = success.
	 *
	 * @param serializedPayload - Pre-serialized message bytes (including
	 *   the message type ID at offset 0).
	 * @param expectedResponseType - The message ID we expect in the response.
	 * @param label - Human-readable label for logging.
	 * @returns Whether the operation succeeded (status code 0).
	 */
	private async sendRequest(
		serializedPayload: Buffer,
		expectedResponseType: number,
		label: string,
	): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			if (!this._connected || !this.rxCharacteristic) {
				reject(new Error('Not connected to hub'));
				return;
			}

			const requestId = ++this._requestId;
			const packed = cobsPack(serializedPayload);

			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Upload request: ${label} (id=${requestId})`,
			);

			// Set up a one-shot resolver for the response.
			const timeoutMs = 10000;
			const timer = setTimeout(() => {
				const entry = this.pendingRequests.get(requestId);
				if (entry) {
					this.pendingRequests.delete(requestId);
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs).unref();

			this.pendingRequests.set(requestId, {
				resolve,
				reject: (err: Error) => {
					clearTimeout(timer);
					this.pendingRequests.delete(requestId);
					reject(err);
				},
				expectedMsgId: expectedResponseType,
				timer,
			});

			// Fragment the COBS-packed frame to fit within the BLE MTU.
			// The Python reference (app.py) splits the packed frame into
			// packets of maxPacketSize bytes before writing.
			const packetSize = this.infoResponse?.maxPacketSize ?? packed.length;

			let writeOffset = 0;
			let firstErr: Error | null = null;

			const writeNext = () => {
				if (firstErr || writeOffset >= packed.length) return;

				const end = Math.min(writeOffset + packetSize, packed.length);
				const packet = packed.slice(writeOffset, end);
				this.rxCharacteristic.write(packet, true, (err: Error | null) => {
					if (err) {
						firstErr = err;
						return;
					}
					writeOffset = end;
					if (writeOffset < packed.length) {
						writeNext();
					}
				});
			};

			writeNext();
		});
	}

	/**
	 * Process an incoming frame and check if it matches any pending
	 * upload request.  Called from processFrame() after successful
	 * COBS decode.
	 */
	private tryResolvePendingRequest(decoded: Buffer): boolean {
		if (decoded.length < 2) return false;

		const responseType = decoded[0];
		const statusCode = decoded[1];

		// Find a pending request expecting this response type.
		// Upload responses use request_type + 1 (e.g. 0x46→0x47).
		for (const [requestId, entry] of this.pendingRequests) {
			if (responseType === entry.expectedMsgId || responseType === entry.expectedMsgId + 1) {
				this.pendingRequests.delete(requestId);
				clearTimeout(entry.timer);
				const success = statusCode === 0x00;
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Upload response: status=${statusCode} (${success ? 'OK' : 'FAIL'})`,
				);
				entry.resolve(success);
				return true;
			}
		}

		return false;
	}

	/**
	 * Upload a program to the hub and optionally start it.
	 *
	 * Follows the SPIKE Prime file upload protocol:
	 *  1. ClearSlotRequest (0x46) — clear the target slot
	 *  2. StartFileUploadRequest (0x0C) — negotiate upload with filename, slot, CRC32
	 *  3. TransferChunkRequest (0x10) × N — transfer program in chunks with running CRC
	 *  4. ProgramFlowRequest (0x1E) — start the program (if startAfterUpload=true)
	 *
	 * Mirrors the protocol from spike_primes_ble/app.py.
	 *
	 * @param slot - Slot number (0-19) to upload to.
	 * @param programCode - UTF-8 encoded program source code.
	 * @param fileName - Filename to store on the hub (default: "program.py").
	 * @param startAfterUpload - Whether to start the program after uploading (default: true).
	 * @returns A promise that resolves when the upload (and optional start) completes.
	 */
	async uploadSlot(
		slot: number,
		programCode: string | Buffer,
		fileName: string = 'program.py',
		startAfterUpload: boolean = true,
	): Promise<void> {
		if (!this._connected || !this.rxCharacteristic) {
			throw new Error('Not connected to hub');
		}

		const programData = Buffer.isBuffer(programCode)
			? programCode
			: Buffer.from(programCode, 'utf8');

		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Uploading ${programData.length} bytes to slot ${slot} (${fileName})`,
		);

		// Step 1: Clear the slot (non-fatal if already empty).
		try {
			const clearSerialized = serializeClearSlotRequest(slot);
			const cleared = await this.sendRequest(
				clearSerialized,
				responseOpcodeForRequest(MSG_CLEAR_SLOT_REQUEST),
				'ClearSlot',
			);
			if (!cleared) {
				this.outputChannel.appendLine(
					'[LEGO Spike Prime] ClearSlotRequest was not acknowledged. ' +
					'This could mean the slot was already empty, proceeding...',
				);
			} else {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Cleared slot ${slot}`,
				);
			}
		} catch (err) {
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] ClearSlotRequest failed: ${(err as Error).message}. ` +
				'Proceeding with upload anyway...',
			);
		}

		// Step 2: Calculate CRC32 of the program.
		const programCrc = calculateCrc(programData);
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Program CRC32: 0x${programCrc.toString(16)}`,
		);

		// Step 3: Start file upload.
		const startSerialized = serializeStartFileUploadRequest(fileName, slot, programCrc);
		const started = await this.sendRequest(
			startSerialized,
			responseOpcodeForRequest(MSG_START_FILE_UPLOAD_REQUEST),
			'StartFileUpload',
		);
		if (!started) {
			throw new Error('Start file upload was not acknowledged by hub');
		}
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Started upload of ${fileName}`,
		);

		// Step 4: Transfer the program in chunks with running CRC.
		const chunkSize = this.infoResponse?.maxChunkSize ?? 20;
		let runningCrc = 0;
		let chunkIndex = 0;

		for (
			let offset = 0;
			offset < programData.length;
			offset += chunkSize, chunkIndex++
		) {
			const chunk = programData.slice(offset, offset + chunkSize);
			runningCrc = calculateCrc(chunk, runningCrc);

			const chunkSerialized = serializeTransferChunkRequest(runningCrc, chunk);
			const chunkOk = await this.sendRequest(
				chunkSerialized,
				responseOpcodeForRequest(MSG_TRANSFER_CHUNK_REQUEST),
				`TransferChunk[${chunkIndex}]`,
			);
			if (!chunkOk) {
				throw new Error(`Failed to transfer chunk ${chunkIndex}`);
			}
		}

		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Upload complete (${programData.length} bytes, ${chunkIndex + 1} chunks)`,
		);

		// Step 5: Start the program (optional).
		if (startAfterUpload) {
			this.outputChannel.appendLine(
				`[LEGO Spike Prime] Starting program on slot ${slot}`,
			);
			const startSerialized = serializeMessage(
				MSG_PROGRAM_FLOW_REQUEST,
				Buffer.from([0x00, slot]), // stop=false, slot=N
			);
			const packed = cobsPack(startSerialized);

			this.rxCharacteristic.write(packed, true, (err: Error | null) => {
				if (err) {
					this.outputChannel.appendLine(
						`[LEGO Spike Prime] Error: Failed to start program — ${err.message}`,
					);
				}
			});
		}
	}

	/**
	 * Send a message to the hub.
	 * Serializes, COBS-packs, and writes to the RX characteristic.
	 */
	sendToHub(typeId: number, payload?: Buffer): void {
		if (!this._connected || !this.rxCharacteristic) {
			this.outputChannel.appendLine(
				'[LEGO Spike Prime] Cannot send: not connected or RX characteristic missing',
			);
			return;
		}

		const serialized = serializeMessage(typeId, payload);
		const packed = cobsPack(serialized);

		const desc = deserializeMessage(serialized, this.deviceState);
		this.outputChannel.appendLine(
			`[LEGO Spike Prime] Sent: ${desc.message}`,
		);

		this.rxCharacteristic.write(packed, true, (err: Error | null) => {
			if (err) {
				this.outputChannel.appendLine(
					`[LEGO Spike Prime] Error: Write failed — ${err.message}`,
				);
			}
		});
	}
}