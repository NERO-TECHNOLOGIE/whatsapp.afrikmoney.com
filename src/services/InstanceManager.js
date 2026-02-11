import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import botLogic from './BotLogic.js';
import queueService from './QueueService.js';

const logger = pino({ level: 'info' });

class InstanceManager {
    constructor() {
        this.instances = new Map();
        this.maxInstances = 20;
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
        const sessionPath = `./sessions/instance-${id}`;

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
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
                const shouldReconnect = (lastDisconnect.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

                console.log(`[Instance ${id}] Connection closed due to`, lastDisconnect.error, ', reconnecting:', shouldReconnect);

                instanceData.ready = false;
                instanceData.status = 'disconnected';

                if (shouldReconnect) {
                    this.connectToWhatsApp(id);
                } else {
                    console.log(`[Instance ${id}] Connection logged out. Cleaning up...`);
                    this.instances.delete(id);
                    // Remove session folder if logged out
                    if (fs.existsSync(sessionPath)) {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                }
            } else if (connection === 'open') {
                console.log(`[Instance ${id}] Connection opened!`);
                instanceData.ready = true;
                instanceData.status = 'ready';
                instanceData.qr = null;
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
