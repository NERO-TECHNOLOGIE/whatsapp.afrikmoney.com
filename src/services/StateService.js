const ACTIVE_FLOW_TTL_MS = 30 * 60 * 1000;  // 30 min — flow actif abandonné
const IDLE_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h  — session idle sans flow
const USER_DATA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours — données persistantes utilisateur

class StateService {
    constructor() {
        /** @type {Map<string, Object>} chatContextId -> flowState */
        this.states = new Map();
        /** @type {Map<string, Object>} userId -> persistentData */
        this.users = new Map();

        // Cleanup toutes les 15 minutes
        setInterval(() => this._cleanupStaleSessions(), 15 * 60 * 1000);
    }

    _cleanupStaleSessions() {
        const now = Date.now();
        let cleaned = 0;

        for (const [sessionId, state] of this.states) {
            const age = now - new Date(state.last_activity_at).getTime();
            if (age > ACTIVE_FLOW_TTL_MS && state.current_flow !== 'none') {
                this.states.delete(sessionId);
                cleaned++;
            } else if (age > IDLE_SESSION_TTL_MS && state.current_flow === 'none') {
                this.states.delete(sessionId);
                cleaned++;
            }
        }

        for (const [userId, data] of this.users) {
            if (now - (data._last_seen || 0) > USER_DATA_TTL_MS) {
                this.users.delete(userId);
                cleaned++;
            }
        }

        if (cleaned > 0) console.log(`[StateService] Cleaned ${cleaned} session/user entrie(s).`);
    }

    // --- USER DATA (GLOBAL) ---

    getUserData(userId, key = null, defaultValue = null) {
        if (!this.users.has(userId)) {
            this.users.set(userId, { disclaimer_accepted: false, vcard_sent: false, _last_seen: Date.now() });
        }
        const data = this.users.get(userId);
        data._last_seen = Date.now();
        if (key === null) return data;
        return data[key] !== undefined ? data[key] : defaultValue;
    }

    setUserData(userId, key, value) {
        const data = this.getUserData(userId);
        data[key] = value;
        return data;
    }

    // --- SESSION STATE (CONTEXTUAL) ---

    getState(sessionId) {
        if (!this.states.has(sessionId)) {
            this.states.set(sessionId, {
                current_flow: 'none',
                current_step: null,
                data: {},
                last_activity_at: new Date()
            });
        }
        return this.states.get(sessionId);
    }

    setState(sessionId, flow, step = null, data = {}) {
        const state = this.getState(sessionId);
        state.current_flow = flow;
        state.current_step = step;
        state.data = { ...state.data, ...data };
        state.last_activity_at = new Date();
        return state;
    }

    addData(sessionId, key, value) {
        const state = this.getState(sessionId);
        state.data[key] = value;
        state.last_activity_at = new Date();
    }

    getData(sessionId, key = null, defaultValue = null) {
        const state = this.getState(sessionId);
        if (key === null) return state.data;
        return state.data[key] !== undefined ? state.data[key] : defaultValue;
    }

    // Supprime l'entrée Map — libère la mémoire pour le GC
    clearState(sessionId) {
        this.states.delete(sessionId);
    }

    // Réinitialise le flow mais garde les données de session
    clearFlow(sessionId) {
        if (!this.states.has(sessionId)) return;
        const state = this.states.get(sessionId);
        state.current_flow = 'none';
        state.current_step = null;
        state.last_activity_at = new Date();
    }

    // Fast path : ne crée PAS d'entrée si elle n'existe pas encore
    getCurrentFlow(sessionId) {
        const state = this.states.get(sessionId);
        if (!state || state.current_flow === 'none') return null;
        return state.current_flow;
    }

    getCurrentStep(sessionId) {
        return this.states.get(sessionId)?.current_step ?? null;
    }
}

export default new StateService();
