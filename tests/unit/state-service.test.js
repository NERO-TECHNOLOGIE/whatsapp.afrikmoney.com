import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import stateService from '../../src/services/StateService.js';
import { uniquePhone } from './_helpers.js';

describe('StateService — session flow state', () => {
    test('a fresh session starts with no active flow', () => {
        const id = uniquePhone();
        const state = stateService.getState(id);
        assert.equal(state.current_flow, 'none');
        assert.equal(state.current_step, null);
        assert.deepEqual(state.data, {});
    });

    test('setState updates flow/step and merges (not replaces) data', () => {
        const id = uniquePhone();
        stateService.setState(id, 'create_project', 'target', { a: 1 });
        stateService.setState(id, 'create_project', 'installment', { b: 2 });

        const state = stateService.getState(id);
        assert.equal(state.current_step, 'installment');
        assert.deepEqual(state.data, { a: 1, b: 2 });
    });

    test('addData/getData round-trip a single key, with defaults for missing keys', () => {
        const id = uniquePhone();
        stateService.addData(id, 'amount', 250);
        assert.equal(stateService.getData(id, 'amount'), 250);
        assert.equal(stateService.getData(id, 'missing_key', 'fallback'), 'fallback');
        assert.equal(stateService.getData(id, 'missing_key'), null);
    });

    test('clearState removes the session entirely', () => {
        const id = uniquePhone();
        stateService.setState(id, 'merchant_payment', 'amount');
        assert.equal(stateService.getCurrentFlow(id), 'merchant_payment');

        stateService.clearState(id);
        assert.equal(stateService.getCurrentFlow(id), null);
        assert.equal(stateService.getCurrentStep(id), null);
    });

    test('clearFlow resets the flow but preserves accumulated data', () => {
        const id = uniquePhone();
        stateService.setState(id, 'create_project', 'installment', { amount: 500 });
        stateService.clearFlow(id);

        assert.equal(stateService.getCurrentFlow(id), null);
        assert.equal(stateService.getData(id, 'amount'), 500);
    });

    test('getCurrentFlow/getCurrentStep do not create an entry for an unknown session (fast path)', () => {
        const id = uniquePhone();
        assert.equal(stateService.states.has(id), false);
        assert.equal(stateService.getCurrentFlow(id), null);
        assert.equal(stateService.getCurrentStep(id), null);
        assert.equal(stateService.states.has(id), false);
    });
});

describe('StateService — persistent user data', () => {
    test('getUserData lazily initializes sane defaults', () => {
        const id = uniquePhone();
        assert.equal(stateService.getUserData(id, 'disclaimer_accepted'), false);
        assert.equal(stateService.getUserData(id, 'vcard_sent'), false);
    });

    test('setUserData persists across calls and survives flow state clears', () => {
        const id = uniquePhone();
        stateService.setUserData(id, 'disclaimer_accepted', true);
        stateService.setState(id, 'registration', 'nom');
        stateService.clearState(id);

        assert.equal(stateService.getUserData(id, 'disclaimer_accepted'), true);
    });
});
