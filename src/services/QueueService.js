import messageRouter from '../core/MessageRouter.js';

class QueueService {
    constructor() {
        this.userQueues = new Map();
    }

    async processMessage(instanceId, sock, msg) {
        const userId = msg.key.remoteJid;

        if (!this.userQueues.has(userId)) {
            this.userQueues.set(userId, Promise.resolve());
        }

        const task = this.userQueues.get(userId).then(async () => {
            try {
                // Mark as read before responding — humans read before they reply
                await sock.readMessages([msg.key]).catch(() => {});
                await messageRouter.handleMessage(sock, msg);
            } catch (error) {
                console.error(`[Queue] Error processing message from ${userId}:`, error);
            }
        });

        const safeTask = task.catch(err => console.error('[Queue] Chain error:', err));

        // Cleanup : supprime l'entrée Map une fois la queue résolue
        // La vérification d'identité évite de supprimer une queue plus récente
        safeTask.finally(() => {
            if (this.userQueues.get(userId) === safeTask) {
                this.userQueues.delete(userId);
            }
        });

        this.userQueues.set(userId, safeTask);
        return safeTask;
    }

    get queueSize() {
        return this.userQueues.size;
    }
}

export default new QueueService();
