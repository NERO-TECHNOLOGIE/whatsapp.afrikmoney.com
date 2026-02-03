class StateService {
    constructor() {
        this.states = new Map();
    }

    getState(whatsappId) {
        if (!this.states.has(whatsappId)) {
            this.states.set(whatsappId, {
                current_flow: 'none',
                current_step: null,
                data: {},
                last_activity_at: new Date()
            });
        }
        return this.states.get(whatsappId);
    }

    setState(whatsappId, flow, step = null, data = {}) {
        const state = this.getState(whatsappId);
        state.current_flow = flow;
        state.current_step = step;
        state.data = { ...state.data, ...data };
        state.last_activity_at = new Date();
        return state;
    }

    addData(whatsappId, key, value) {
        const state = this.getState(whatsappId);
        state.data[key] = value;
        state.last_activity_at = new Date();
    }

    getData(whatsappId, key = null, defaultValue = null) {
        const state = this.getState(whatsappId);
        if (key === null) return state.data;
        return state.data[key] !== undefined ? state.data[key] : defaultValue;
    }

    clearState(whatsappId) {
        this.states.delete(whatsappId);
    }

    getCurrentFlow(whatsappId) {
        const state = this.getState(whatsappId);
        return state.current_flow === 'none' ? null : state.current_flow;
    }

    getCurrentStep(whatsappId) {
        const state = this.getState(whatsappId);
        return state.current_step;
    }
}

export default new StateService();