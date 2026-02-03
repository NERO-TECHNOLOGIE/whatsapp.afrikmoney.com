import botLogic from './BotLogic.js';

class QueueService {
    constructor() {
        // Map to store promise chains for each user to ensure sequential processing
        this.userQueues = new Map();
    }

    /**
     * Process an incoming message using an in-memory queue.
     * Ensures that messages from the same user are processed one by one.
     */
    async processMessage(instanceId, sock, msg) {
        const userId = msg.key.remoteJid;

        console.log(`[Queue] Scheduling message from ${userId}`);

        // Initialize queue for user if it doesn't exist
        if (!this.userQueues.has(userId)) {
            this.userQueues.set(userId, Promise.resolve());
        }

        // Chain the new task to the user's existing promise chain
        const task = this.userQueues.get(userId).then(async () => {
            try {
                // Simulate a small delay/yield to event loop if needed
                // await new Promise(r => setImmediate(r));
                await botLogic.handleMessage(sock, msg);
            } catch (error) {
                console.error(`[Queue] Error processing message from ${userId}:`, error);
            }
        });

        // Update the user's queue with the new tail promise
        // We catch errors here to ensure the chain doesn't break for future messages
        const safeTask = task.catch(err => console.error("Queue chain error:", err));
        this.userQueues.set(userId, safeTask);

        // Return the promise in case caller wants to await it (though usually fire-and-forget for the listener)
        return safeTask;
    }

    // Kept for compatibility but not used or implemented with Redis anymore
    async addIncoming(instanceId, data) {
        console.warn("[QueueService] addIncoming is deprecated. Use processMessage instead.");
    }

    async addOutgoing(instanceId, chatId, text, options = {}) {
        console.warn("[QueueService] addOutgoing is not implemented in memory queue.");
    }
}

export default new QueueService();