import messageRouter from '../src/core/MessageRouter.js';
import httpClient from '../src/services/http/HttpClient.js';
import stateService from '../src/services/StateService.js';
import registrationHandler from '../src/handlers/RegistrationHandler.js';
import paymentHandler from '../src/handlers/PaymentHandler.js';
import profileHandler from '../src/handlers/ProfileHandler.js';
import projectHandler from '../src/handlers/ProjectHandler.js';
import groupHandler from '../src/handlers/GroupHandler.js';

/**
 * AggressiveFuzzer - Extreme stress test for the AfrikMoney bot.
 * Simulates thousands of concurrent, malformed, and chaotic interactions.
 */
class AggressiveFuzzer {
    constructor() {
        this.results = {
            total: 0,
            passed: 0,
            crashed: 0,
            errors: []
        };
        this.mockSock = {
            user: { id: '22901000000:1@s.whatsapp.net', lid: 'bot_lid_123' },
            authState: { creds: { me: { lid: 'bot_lid_123' } } },
            sendPresenceUpdate: async () => { },
            sendMessage: async (jid, content) => {
                // To simulate high load, we add a tiny artificial delay
                await new Promise(r => setTimeout(r, Math.random() * 5));
                return { key: { id: 'msg_' + Math.random().toString(36).substring(7) } };
            }
        };
    }

    /**
     * Generates extremely chaotic strings
     */
    generateChaosText() {
        const types = [
            () => 'A'.repeat(Math.floor(Math.random() * 5000)), // SQL injection size strings
            () => '!@#$%^&*()_+{}|:"<>?[]\\;\',./`~'.repeat(10),
            () => '0'.repeat(100),
            () => 'true',
            () => 'false',
            () => 'null',
            () => '{}',
            () => '[]',
            () => 'NaN',
            () => 'Infinity',
            () => '{"json": "malformed',
            () => '\u0000\u0001\u0002\u0003', // Binary garbage
            () => '🚩'.repeat(100), // Emoji flood
            () => '1'.repeat(10), // Valid-looking but repetitive
            () => 'DROP TABLE users;--',
            () => '<img src=x onerror=alert(1)>',
            () => '   \n\r\t   ' // Whitespace only
        ];
        return types[Math.floor(Math.random() * types.length)]();
    }

    /**
     * Mocks random API behavior including extreme failures
     */
    mockExtremeApi() {
        const originalRequest = httpClient.request.bind(httpClient);
        httpClient.request = async (method, endpoint, data, whatsappId) => {
            const roll = Math.random();
            if (roll < 0.1) { // 10% chance of extreme failure
                const errorType = Math.floor(Math.random() * 4);
                if (errorType === 0) return { success: false, status: 500, error: "CRITICAL_FAILURE" };
                if (errorType === 1) return { success: true, data: null }; // Null data where object expected
                if (errorType === 2) throw new Error('SOCKET_HANG_UP');
                if (errorType === 3) return { success: true, data: { status: 'UNDEFINED_STATUS' } };
            }
            return originalRequest(method, endpoint, data, whatsappId);
        };
        return () => { httpClient.request = originalRequest; };
    }

    /**
     * Simulated Message Execution
     */
    async simulateMessage(from, text, isGroup = false) {
        this.results.total++;
        const remoteJid = isGroup ? '120363425718811577@g.us' : `${from}@s.whatsapp.net`;
        const msg = {
            key: {
                remoteJid,
                fromMe: false,
                id: 'MID' + Math.random().toString(36).substring(2),
                participant: isGroup ? `${from}@s.whatsapp.net` : null
            },
            message: {
                conversation: text,
                extendedTextMessage: { text: text, contextInfo: { mentionedJid: [this.mockSock.user.id] } }
            }
        };

        try {
            await messageRouter.handleMessage(this.mockSock, msg);
            this.results.passed++;
        } catch (err) {
            this.results.crashed++;
            this.results.errors.push({ from, text, stack: err.stack });
        }
    }

    async run() {
        console.log('🔥🔥 STARTING AGGRESSIVE FUZZING (1000+ ITERATIONS) 🔥🔥\n');
        const restoreApi = this.mockExtremeApi();

        const USERS = Array.from({ length: 50 }, (_, i) => `229019000${i.toString().padStart(2, '0')}`);
        const FLOWS = [
            'registration', 'merchant_payment', 'create_project', 'projects_list', 'support', 'main_menu'
        ];
        const STEPS = ['init', 'nom', 'amount', 'code', 'confirmation', 'selection'];

        // SCENARIO 1: Chaos storm (1000 messages)
        console.log('🌪️  Scenario 1: Global Chaos Storm...');
        let promises = [];
        for (let i = 0; i < 1000; i++) {
            const user = USERS[Math.floor(Math.random() * USERS.length)];
            const text = Math.random() > 0.3 ? this.generateChaosText() : Math.floor(Math.random() * 10).toString();

            // Randomly corrupt state before message
            if (Math.random() > 0.95) {
                stateService.setState(user, FLOWS[Math.floor(Math.random() * FLOWS.length)], STEPS[Math.floor(Math.random() * STEPS.length)]);
            }

            promises.push(this.simulateMessage(user, text, Math.random() > 0.5));

            // Control concurrency to avoid local resource exhaustion
            if (promises.length >= 20) {
                await Promise.all(promises);
                promises = [];
            }
        }
        await Promise.all(promises);

        // SCENARIO 2: Rapid-fire state switching
        console.log('⚡ Scenario 2: Rapid-fire State Switching...');
        for (const user of USERS.slice(0, 10)) {
            for (let i = 0; i < 50; i++) {
                const flow = FLOWS[Math.floor(Math.random() * FLOWS.length)];
                stateService.setState(user, flow, 'init');
                await this.simulateMessage(user, this.generateChaosText());
            }
        }

        // SCENARIO 3: Deep Recursion / Infinite Loop attempt
        console.log('🔄 Scenario 3: Recursive Logic stress...');
        const recursiveUser = 'recursive_bot';
        stateService.setState(recursiveUser, 'main_menu', 'init');
        for (let i = 0; i < 100; i++) {
            await this.simulateMessage(recursiveUser, '1'); // Keep hitting menu/main items
        }

        restoreApi();

        console.log('\n--- AGGRESSIVE FUZZING RESULTS ---');
        console.log(`Total Messages Processed : ${this.results.total}`);
        console.log(`Passed                   : ${this.results.passed}`);
        console.log(`Crashes (Exceptions 🚩)  : ${this.results.crashed}`);

        if (this.results.crashed > 0) {
            console.log('\n❌ SYSTEM VULNERABILITIES DETECTED:');
            // Log unique errors
            const uniqueErrors = [...new Set(this.results.errors.map(e => e.stack.split('\n')[0]))];
            uniqueErrors.forEach(err => console.log(`- ${err}`));
            process.exit(1);
        } else {
            console.log('\n💎 SYSTEM IS IRONCLAD. No unhandled exceptions in 1000+ chaotic calls.');
            process.exit(0);
        }
    }
}

new AggressiveFuzzer().run().catch(console.error);
