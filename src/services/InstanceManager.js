import {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@itsliaaa/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import queueService from './QueueService.js';
import { useSQLiteAuthState, getStoredInstanceIds } from './SQLiteAuthState.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS  = 120000; // 2 min cap
const RECONNECT_MAX_ATTEMPTS  = 8;      // Circuit breaker: give up after 8 failures (~6 min total)

// Codes that must NOT trigger a reconnect — reconnecting makes things worse
const NO_RECONNECT_CODES = new Set([
    DisconnectReason.loggedOut,        // 401 — session revoked
    DisconnectReason.forbidden,        // 403 — account banned/restricted
    DisconnectReason.connectionReplaced, // 440 — another device took the session
    DisconnectReason.badSession,       // 500 — corrupted session, need new QR
]);

// Cache Baileys version — fetched once, reused on reconnects
let _waVersion = null;
async function getWAVersion() {
    if (!_waVersion) {
        const { version } = await fetchLatestBaileysVersion();
        _waVersion = version;
        console.log(`[Manager] WA version cached: ${version.join('.')}`);
    }
    return _waVersion;
}

class InstanceManager {
    constructor() {
        this.instances = new Map();
        this.maxInstances = 20;
        this._reconnectAttempts = new Map(); // instanceId -> attempt count
        this._reconnectTimers = new Map();   // instanceId -> timer ref (for cancellation)
    }

    /**
     * Auto-reconnect all instances that have credentials saved in bot.db.
     * Called once on server startup — no QR code needed.
     */
    async restorePersistedInstances() {
        const ids = getStoredInstanceIds();
        if (ids.length === 0) {
            console.log('[Manager] No persisted sessions found — waiting for first QR scan.');
            return;
        }
        console.log(`[Manager] Restoring ${ids.length} persisted session(s): ${ids.join(', ')}`);
        for (const id of ids) {
            await this.initInstance(id);
        }
    }

    async initInstance(id) {
        if (this.instances.has(id)) {
            const inst = this.instances.get(id);
            if (inst.status === 'ready') {
                return { success: false, message: `Instance ${id} is already connected.` };
            }
            return { success: true, message: `Instance ${id} is already initializing.` };
        }

        if (this.instances.size >= this.maxInstances) {
            return { success: false, message: `Maximum instance limit (${this.maxInstances}) reached.` };
        }

        console.log(`[Manager] Initializing instance ${id}…`);

        const instanceData = {
            id,
            sock: null,
            status: 'initializing',
            qr: null,
            ready: false
        };

        this.instances.set(id, instanceData);

        this.connectToWhatsApp(id).catch(err => {
            console.error(`[Instance ${id}] Fatal connection error:`, err);
            this.instances.delete(id);
        });

        return { success: true, message: `Instance ${id} initialization started.` };
    }

    async connectToWhatsApp(id) {
        const instanceData = this.instances.get(id);
        if (!instanceData) return; // Instance was stopped before timer fired

        // Close old socket cleanly — stops keep-alive timers from the previous connection
        if (instanceData.sock) {
            try { instanceData.sock.ws?.close(); } catch { /* ignore */ }
            instanceData.sock = null;
        }

        const { state, saveCreds, clearSession } = useSQLiteAuthState(id);
        const version = await getWAVersion();

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: process.env.NODE_ENV !== 'production',
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            generateHighQualityLinkPreview: false,
        });

        instanceData.sock = sock;

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`[Instance ${id}] QR ready — scan at GET /instances/qr/${id}`);
                instanceData.qr = qr;
                instanceData.status = 'awaiting_scan';
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : null;

                instanceData.ready = false;
                instanceData.status = 'disconnected';

                // --- Cases that must NOT reconnect ---
                if (NO_RECONNECT_CODES.has(statusCode)) {
                    if (statusCode === DisconnectReason.forbidden) {
                        console.error(`[Instance ${id}] ⚠️  ACCOUNT BANNED/RESTRICTED (403) — not reconnecting.`);
                        instanceData.status = 'banned';
                    } else if (statusCode === DisconnectReason.connectionReplaced) {
                        console.warn(`[Instance ${id}] Session taken by another device (440) — not reconnecting to avoid ban.`);
                        instanceData.status = 'replaced';
                    } else if (statusCode === DisconnectReason.badSession) {
                        console.warn(`[Instance ${id}] Corrupted session (500) — clearing and stopping.`);
                        clearSession();
                        this.instances.delete(id);
                        this._reconnectAttempts.delete(id);
                    } else {
                        // loggedOut (401)
                        console.log(`[Instance ${id}] Logged out — clearing session.`);
                        clearSession();
                        this.instances.delete(id);
                        this._reconnectAttempts.delete(id);
                    }
                    return;
                }

                // --- restartRequired: reconnect immediately, no backoff ---
                if (statusCode === DisconnectReason.restartRequired) {
                    console.log(`[Instance ${id}] Restart requested by WhatsApp — reconnecting now.`);
                    this.connectToWhatsApp(id);
                    return;
                }

                // --- Default: reconnect with exponential backoff + circuit breaker ---
                const attempts = (this._reconnectAttempts.get(id) || 0) + 1;
                this._reconnectAttempts.set(id, attempts);

                if (attempts > RECONNECT_MAX_ATTEMPTS) {
                    console.error(`[Instance ${id}] ⛔ Circuit breaker tripped after ${attempts - 1} attempts — stopping reconnection to protect the account. Call POST /instances/init/${id} to retry manually.`);
                    instanceData.status = 'failed';
                    this._reconnectAttempts.delete(id);
                    return;
                }

                // Exponential backoff with ±20% jitter to avoid thundering herd
                const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempts - 1), RECONNECT_MAX_DELAY_MS);
                const jitter = base * 0.2 * (Math.random() * 2 - 1);
                const delay = Math.round(base + jitter);

                console.log(`[Instance ${id}] Reconnect ${attempts}/${RECONNECT_MAX_ATTEMPTS} in ${(delay / 1000).toFixed(1)}s (code: ${statusCode})…`);
                instanceData.status = `reconnecting_${attempts}`;

                const timer = setTimeout(() => {
                    this._reconnectTimers.delete(id);
                    this.connectToWhatsApp(id);
                }, delay);
                this._reconnectTimers.set(id, timer);

            } else if (connection === 'open') {
                console.log(`[Instance ${id}] ✅ Connected.`);
                instanceData.ready = true;
                instanceData.status = 'ready';
                instanceData.qr = null;
                this._reconnectAttempts.delete(id); // Reset circuit breaker on success
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && !msg.message?.protocolMessage) {
                        try {
                            await queueService.processMessage(id, sock, msg);
                        } catch (err) {
                            console.error(`[Instance ${id}] Message handling error:`, err);
                        }
                    }
                }
            }
        });

        return sock;
    }

    getInstance(id) {
        return this.instances.get(id);
    }

    getAllInstances() {
        return Array.from(this.instances.values()).map(inst => ({
            id: inst.id,
            status: inst.status,
            ready: inst.ready,
            hasQr: !!inst.qr
        }));
    }

    async stopInstance(id) {
        // Cancel any pending reconnect timer first
        const timer = this._reconnectTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this._reconnectTimers.delete(id);
        }
        this._reconnectAttempts.delete(id);

        const instance = this.instances.get(id);
        if (instance) {
            if (instance.sock) {
                try { instance.sock.ws?.close(); } catch { /* ignore */ }
            }
            this.instances.delete(id);
            return true;
        }
        return false;
    }
}

export default new InstanceManager();
