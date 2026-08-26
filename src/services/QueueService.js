import messageRouter from '../core/MessageRouter.js';

class QueueService {
    constructor() {
        this.userQueues = new Map();
    }

    async processMessage(instanceId, sock, msg) {
        // Scoped by instance too: this server can run several WhatsApp instances at
        // once, and without the prefix the same chat JID messaging two different
        // instances around the same time would serialize onto one shared queue.
        const queueKey = `${instanceId}:${msg.key.remoteJid}`;

        if (!this.userQueues.has(queueKey)) {
            this.userQueues.set(queueKey, Promise.resolve());
        }

        const task = this.userQueues.get(queueKey).then(async () => {
            try {
                // Mark as read before responding — humans read before they reply
                await sock.readMessages([msg.key]).catch(() => {});
                await messageRouter.handleMessage(sock, msg, instanceId);
            } catch (error) {
                console.error(`[Queue] Error processing message from ${queueKey}:`, error);
            }
        });

        const safeTask = task.catch(err => console.error('[Queue] Chain error:', err));

        // Cleanup : supprime l'entrée Map une fois la queue résolue
        // La vérification d'identité évite de supprimer une queue plus récente
        safeTask.finally(() => {
            if (this.userQueues.get(queueKey) === safeTask) {
                this.userQueues.delete(queueKey);
            }
        });

        this.userQueues.set(queueKey, safeTask);
        return safeTask;
    }

    get queueSize() {
        return this.userQueues.size;
    }
}

export default new QueueService();
