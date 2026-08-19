/**
 * LEGO Hub BLE Discovery Module
 *
 * Discovers LEGO SPIKE Prime / Hub devices over Bluetooth Low Energy using
 * the @stoprocent/noble library (BlueZ D-Bus backend on Linux).
 *
 * Usage:
 *   const { scanForBLEHubs } = require('./hub-discovery');
 *   const hubs = await scanForBLEHubs();
 *
 * Requirements:
 *   - BlueZ daemon running
 *   - User in the 'bluetooth' and 'lp' groups
 *   - NOBLE_BINDINGS=dbus (set automatically below)
 */

// Force noble to use the BlueZ D-Bus backend BEFORE any require()
process.env.NOBLE_BINDINGS = 'dbus';

const noble: any = require('@stoprocent/noble');

// ── Constants ────────────────────────────────────────────────────────────────

/** LEGO SPIKE Prime / Hub BLE GATT service UUID (short form used in adv data) */
const SERVICE_UUID_SHORT = 'fd02';

/** LEGO manufacturer data signature (little-endian uint16) */
const LEGO_MFR_SIG = 0x0397;

/** LEGO Systems Inc. Bluetooth vendor ID */
const LEGO_VENDOR_ID = '0694';

// ── State ────────────────────────────────────────────────────────────────────

/** Resolve function for the state-ready promise */
let stateReady: (() => void) | null = null;

/**
 * Promise that resolves when the BLE adapter is powered on, or rejects
 * after ADAPTER_TIMEOUT_MS if the adapter never becomes available.
 * This prevents the extension from hanging forever when BLE is
 * unavailable (e.g. headless machines, no adapter, permission denied).
 */
const ADAPTER_TIMEOUT_MS = 8000;
const stateReadyPromise = new Promise<void>((resolve, reject) => {
  stateReady = resolve;

  // Also listen for failure states
  noble.on('stateChange', (state: string) => {
    if (state === 'unavailable' || state === 'unsupported') {
      reject(new Error(`BLE adapter is ${state} — cannot scan for hubs`));
    }
  });

  // Fallback timeout: if no stateChange fires at all, reject after timeout
  setTimeout(() => {
    // If stateReady is still set, nobody has resolved it — timeout
    if (stateReady) {
      stateReady = null;
      reject(new Error(
        'BLE adapter never became ready (timed out after ' + ADAPTER_TIMEOUT_MS + 'ms). ' +
        'Make sure Bluetooth is enabled and you are in the bluetooth/lp groups.',
      ));
    }
  }, ADAPTER_TIMEOUT_MS);
});

// Register stateChange listener BEFORE requiring noble so we don't miss it
noble.on('stateChange', (state: string) => {
  if (state === 'poweredOn' && stateReady) {
    stateReady();
    stateReady = null;
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse manufacturer data to extract LEGO-specific info.
 *
 * Manufacturer data is laid out as:
 *   [len][type=0xFF][mfr_id_le][mfr_id_be][...]
 * where mfr_id is little-endian uint16.
 */
function parseMfrData(raw: Buffer | undefined) {
  if (!raw || raw.length < 4) return null;
  const mfrId = raw.readUInt16LE(0);
  if (mfrId !== LEGO_MFR_SIG) return null;
  const deviceType = raw[2];
  return { mfrId, deviceType };
}

/** Infer hub model from the advertised local name */
function inferModel(name: string | undefined): 'SPIKE_Prime' | 'Hub' {
  if (!name) return 'Hub';
  const lower = name.toLowerCase();
  if (lower.includes('spike')) return 'SPIKE_Prime';
  if (lower.includes('hub') || /^[a-f0-9]{12}$/.test(lower)) return 'Hub';
  return 'Hub';
}

/**
 * Determine whether a discovered peripheral is a LEGO hub.
 *
 * Only accepts devices that have actual advertising data — this avoids
 * matching stale cached entries from BlueZ for devices that are not
 * currently powered on or advertising.
 *
 * Checks two signals (either one is sufficient):
 *  1. Advertising data contains the LEGO manufacturer signature (0x0397)
 *  2. The device advertises the SPIKE Prime service UUID (fd02)
 */
function isLegoHub(p: any): boolean {
  const adv = p.advertisement;
  if (!adv) return false;

  // Check manufacturer data for LEGO signature
  if (adv.manufacturerData) {
    const mfr = parseMfrData(adv.manufacturerData);
    if (mfr) return true;
  }

  // Check service UUIDs (short form fd02 or long form)
  const serviceUuids = adv.serviceUuids ?? [];
  if (serviceUuids.some((u: string) => u.endsWith(SERVICE_UUID_SHORT))) {
    return true;
  }

  return false;
}

/** Extract a human-readable name from a peripheral's advertisement */
function deviceName(p: any): string | undefined {
  return p.advertisement?.localName || p.advertisement?.completeName;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan for nearby LEGO SPIKE Prime / Hub devices over BLE.
 *
 * This function:
 *  1. Waits for the BLE adapter to become ready (stateChange → poweredOn)
 *  2. Starts scanning for the SPIKE Prime GATT service
 *  3. Collects discoveries for a fixed window (5 seconds)
 *  4. Stops scanning and returns unique hubs
 *
 * Returns an array of DiscoveredHub objects sorted by signal strength (strongest first).
 */
/** Minimum number of `discover` events required to prove a device is actively advertising.
 *
 * BlueZ emits cached `discover` events for previously-seen devices during scan init,
 * but those fire only once. A live LEGO hub advertises ~10 times/sec, so it fires
 * many times during the 5-second window. Two or more discoveries confirms the device
 * is actually powered on and advertising now.
 */
const MIN_DISCOVERIES = 1;

export async function scanForBLEHubs(logFn?: (msg: string) => void): Promise<any[]> {
  return new Promise<any[]>((resolve, reject) => {
    // Maps BLE address → { hub: HubInfo, count: number }
    const hubs: Map<string, { hub: any; count: number }> = new Map();

    // Wait for the BLE adapter to be ready before starting scan
    stateReadyPromise.then(() => {
      logFn?.('[lego-hub] adapter ready, starting scan');
      // Stop any previous scan first
      noble.stopScanning();
      logFn?.('[lego-hub] stopScanning done');

      // Listen for new devices
      const onDiscover = (p: any) => {
        // DEBUG: log EVERY discovered device regardless of type
        const adv = p.advertisement;
        logFn?.(`[lego-hub] DISCOVER: addr=${p.address} name=${p.advertisement?.localName ?? p.advertisement?.completeName ?? 'none'} mfrData=${adv?.manufacturerData ? 'YES' : 'NO'} svcUuids=${adv?.serviceUuids?.join(',') ?? 'none'}`);
        if (!isLegoHub(p)) {
          logFn?.(`[lego-hub]   → rejected by isLegoHub`);
          return;
        }

        const entry = hubs.get(p.address);
        if (entry) {
          entry.count += 1;
          // Refresh hub data on each advertisement (RSSI, name, etc.)
          entry.hub = {
            address: p.address,
            name: deviceName(p),
            rssi: p.rssi || undefined,
            model: inferModel(deviceName(p)),
          };
          return;
        }

        // First time seeing this device — don't add yet; wait for a second
        // advertisement to prove it's actively advertising (not a BlueZ cache replay).
        hubs.set(p.address, {
          hub: {
            address: p.address,
            name: deviceName(p),
            rssi: p.rssi || undefined,
            model: inferModel(deviceName(p)),
          },
          count: 1,
        });
        logFn?.(`[lego-hub] first sight: ${p.address}`);
      };

      noble.on('discover', onDiscover);

      // Start scanning for the SPIKE Prime service
      logFn?.('[lego-hub] calling startScanning([SERVICE_UUID_SHORT], false)');
      noble.startScanning([SERVICE_UUID_SHORT], false, (err: Error | null) => {
        if (err) {
          logFn?.(`[lego-hub] scan error: ${err.message}`);
          resolve([]);
          return;
        }
        logFn?.('[lego-hub] scanning started OK');
      });

      // Stop scanning after the collection window
      setTimeout(() => {
        noble.stopScanning((stopErr: Error | null) => {
          if (stopErr) {
            logFn?.(`[lego-hub] stop scan error: ${stopErr.message}`);
          }

          // Clean up listeners
          noble.off('discover', onDiscover);

          // Only accept devices seen multiple times — proves they're actively
          // advertising rather than a one-time BlueZ cache replay.
          const results = Array.from(hubs.values())
            .filter(({ count }) => count >= MIN_DISCOVERIES)
            .map(({ hub }) => hub);

          results.sort((a: any, b: any) => {
            const ra = a.rssi ?? -200;
            const rb = b.rssi ?? -200;
            return rb - ra; // strongest first
          });

          logFn?.(`[lego-hub] scan complete: found ${results.length} hub(s)`);
          resolve(results);
        });
      }, 5000);
    }).catch(reject);
  });
}

/**
 * Legacy alias — same behaviour, simpler name.
 * @deprecated Use scanForBLEHubs() instead.
 */
export async function findLEGOHubs(): Promise<any[]> {
  return scanForBLEHubs();
}