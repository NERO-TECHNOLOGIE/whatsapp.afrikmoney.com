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

const logger = pino({ level: 'info' });

const RECONNECT_BASE_DELAY_MS = 2000;  // 2s initial backoff
const RECONNECT_MAX_DELAY_MS  = 60000; // 60s cap

class InstanceManager {
    constructor() {
        this.instances = new Map();
        this.maxInstances = 20;
        this._reconnectAttempts = new Map(); // instanceId -> attempt count
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
            // If it exists but not ready, we might want to restart it or just wait
            return { success: true, message: `Instance ${id} is already initializing.` };
        }

        if (this.instances.size >= this.maxInstances) {
            return { success: false, message: `Maximum instance limit (${this.maxInstances}) reached.` };
        }

        console.log(`[Manager] Initializing Baileys instance ${id}...`);

        const instanceData = {
            id,
            sock: null,
            status: 'initializing',
            qr: null,
            ready: false
        };

        this.instances.set(id, instanceData);

        // Start connection in background
        this.connectToWhatsApp(id).catch(err => {
            console.error(`[Instance ${id}] Connection error:`, err);
            this.instances.delete(id);
        });

        return { success: true, message: `L'initialisation de l'instance Baileys ${id} a demarre.` };
    }

    async connectToWhatsApp(id) {
        const instanceData = this.instances.get(id);

        // Close old socket cleanly before creating a new one — stops keep-alive timers
        if (instanceData.sock) {
            try { instanceData.sock.ws?.close(); } catch { /* ignore */ }
            instanceData.sock = null;
        }

        const { state, saveCreds, clearSession } = useSQLiteAuthState(id);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`[Instance ${id}] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            generateHighQualityLinkPreview: true,
        });

        instanceData.sock = sock;

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`[Instance ${id}] QR RECEIVED`);
                instanceData.qr = qr;
                instanceData.status = 'awaiting_scan';
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : null;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[Instance ${id}] Connection closed — code: ${statusCode}, reconnecting: ${shouldReconnect}`);

                instanceData.ready = false;
                instanceData.status = 'disconnected';

                if (shouldReconnect) {
                    const attempts = (this._reconnectAttempts.get(id) || 0) + 1;
                    this._reconnectAttempts.set(id, attempts);
                    // Exponential backoff: 2s, 4s, 8s … capped at 60s
                    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempts - 1), RECONNECT_MAX_DELAY_MS);
                    console.log(`[Instance ${id}] Reconnect attempt ${attempts} in ${delay / 1000}s…`);
                    setTimeout(() => this.connectToWhatsApp(id), delay);
                } else {
                    console.log(`[Instance ${id}] Logged out. Cleaning up…`);
                    this._reconnectAttempts.delete(id);
                    this.instances.delete(id);
                    clearSession();
                }
            } else if (connection === 'open') {
                console.log(`[Instance ${id}] Connection opened!`);
                instanceData.ready = true;
                instanceData.status = 'ready';
                instanceData.qr = null;
                this._reconnectAttempts.delete(id); // Reset backoff on success
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
                            console.error(`[Instance ${id}] Error handling message:`, err);
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
        const instance = this.instances.get(id);
        if (instance) {
            if (instance.sock) {
                instance.sock.logout(); // This will also close the connection and trigger the 'close' event
            }
            this.instances.delete(id);
            return true;
        }
        return false;
    }
}

export default new InstanceManager();
