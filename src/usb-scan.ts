import { spawn } from 'child_process';

/** Represents a discovered LEGO hub connected via USB. */
export interface UsbHubInfo {
    /** OS device path */
    device: string;
    /** Product name from mpremote */
    product: string;
}

/** LEGO USB vendor ID used by SPIKE Prime hubs */
const LEGO_VENDOR_ID = '0694';

/**
 * Scan for LEGO SPIKE Prime hubs connected via USB.
 *
 * Spawns `mpremote devs` and parses its output. Does NOT depend on
 * @stoprocent/noble so it can be used as a fallback when BLE is unavailable.
 *
 * @returns Array of discovered USB hubs
 */
export function scanUsbHubs(): Promise<UsbHubInfo[]> {
    return new Promise<UsbHubInfo[]>((resolve) => {
        const proc = spawn('mpremote', ['devs'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';

        proc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0 && code !== null) {
                resolve([]);
                return;
            }

            const hubs: UsbHubInfo[] = [];

            for (const line of stdout.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                // Parse: /dev/ttyXXX <serial> <VID:PID> <manufacturer> <product>
                // Example: /dev/ttyACM0 334933683431 0694:0009 LEGO System A/S SPIKE Prime VCP
                const parts = trimmed.split(/\s+/);
                if (parts.length < 5) continue;

                const devPath = parts[0];
                const vidPid = parts[2];

                const colonIdx = vidPid.indexOf(':');
                if (colonIdx === -1) continue;

                const vid = vidPid.slice(0, colonIdx).toLowerCase();
                if (vid !== LEGO_VENDOR_ID) continue;

                const productName = parts.slice(3).join(' ').toLowerCase();
                if (!productName.includes('spike')) continue;

                hubs.push({
                    device: devPath,
                    product: productName,
                });
            }

            resolve(hubs);
        });

        proc.on('error', () => {
            resolve([]);
        });
    });
}
