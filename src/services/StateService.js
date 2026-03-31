class StateService {
    constructor() {
        /** @type {Map<string, Object>} chatContextId -> flowState */
        this.states = new Map();
        /** @type {Map<string, Object>} userId -> persistentData */
        this.users = new Map();
    }

    // --- USER DATA (GLOBAL) ---

    getUserData(userId, key = null, defaultValue = null) {
        if (!this.users.has(userId)) {
            this.users.set(userId, {
                disclaimer_accepted: false,
                vcard_sent: false
            });
        }
        const data = this.users.get(userId);
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

    clearState(sessionId) {
        this.states.set(sessionId, {
            current_flow: 'none',
            current_step: null,
            data: {},
            last_activity_at: new Date()
        });
    }

    clearFlow(sessionId) {
        const state = this.getState(sessionId);
        state.current_flow = 'none';
        state.current_step = null;
        state.last_activity_at = new Date();
    }

    getCurrentFlow(sessionId) {
        const state = this.getState(sessionId);
        return state.current_flow === 'none' ? null : state.current_flow;
    }

    getCurrentStep(sessionId) {
        const state = this.getState(sessionId);
        return state.current_step;
    }
}

export default new StateService();