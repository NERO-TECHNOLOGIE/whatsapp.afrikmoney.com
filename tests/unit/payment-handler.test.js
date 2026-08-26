import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import paymentHandler from '../../src/handlers/PaymentHandler.js';
import stateService from '../../src/services/StateService.js';
import authService from '../../src/services/AuthService.js';
import paymentService from '../../src/services/PaymentService.js';

import { createMockSock, lastText, fakeMsg, uniquePhone } from './_helpers.js';

function seedAmountStepState(sessionId, extra = {}) {
    stateService.setState(sessionId, 'merchant_payment', 'amount', {
        merchant_code: 'SHOP01',
        merchant_id: 'm1',
        merchant_name: 'Shop Test',
        merchant_phone: '22990000001',
        service_fee: 0,
        object: 'Facture',
        ...extra
    });
}

describe('PaymentHandler — amount step', () => {
    test('rejects zero / non-numeric amounts', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedAmountStepState(sessionId);

        await paymentHandler.handleMerchantPayment(sock, fullId, 'amount', '0', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Montant invalide/);

        await paymentHandler.handleMerchantPayment(sock, fullId, 'amount', 'abc', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Montant invalide/);

        assert.equal(stateService.getCurrentStep(sessionId), 'amount');
    });

    test('accepts a valid amount and only lists operators the merchant configured', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedAmountStepState(sessionId, { available_operators: ['mtn_bj'] });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'amount', '1500', fakeMsg(), sessionId);

        assert.equal(stateService.getData(sessionId, 'amount'), 1500);
        assert.equal(stateService.getCurrentStep(sessionId), 'source');
        const call = sent[sent.length - 1];
        const labels = call.content.nativeFlow.map(b => b.text);
        assert.ok(labels.some(l => l.includes('MTN')));
        assert.ok(!labels.some(l => l.includes('FLOOZ')));
    });
});

describe('PaymentHandler — source step', () => {
    test('"4" goes back to the amount step', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'source', { amount: 500 });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'source', '4', fakeMsg(), sessionId);
        assert.equal(stateService.getCurrentStep(sessionId), 'amount');
        assert.match(lastText(sent), /Montant du paiement/);
    });

    test('invalid operator choice is rejected', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'source', { amount: 500 });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'source', '9', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Choix invalide/);
    });

    test('unregistered user is told to register first', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'source', { amount: 500 });

        t.mock.method(authService, 'authenticate', async () => null);
        await paymentHandler.handleMerchantPayment(sock, fullId, 'source', '1', fakeMsg(), sessionId);
        assert.match(lastText(sent), /pas encore inscrit/);
    });

    test('missing payer phone for chosen operator re-shows the operator menu with a warning', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'source', { amount: 500, service_fee: 0 });

        t.mock.method(authService, 'authenticate', async () => ({ num_mtn: null, num_moov: null, num_celtiis: null }));
        await paymentHandler.handleMerchantPayment(sock, fullId, 'source', '1', fakeMsg(), sessionId);

        const warned = sent.some(s => (s.content.text || '').includes("n'avez pas de numéro"));
        assert.ok(warned);
    });

    test('valid operator + phone moves straight to confirmation summary', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'source', {
            amount: 1000, service_fee: 0, merchant_name: 'Shop', merchant_code: 'S1', object: 'Test'
        });

        t.mock.method(authService, 'authenticate', async () => ({ num_mtn: '22990000002' }));
        await paymentHandler.handleMerchantPayment(sock, fullId, 'source', '1', fakeMsg(), sessionId);

        assert.equal(stateService.getCurrentStep(sessionId), 'confirmation');
        assert.equal(stateService.getData(sessionId, 'source'), 'MTN');
        assert.match(lastText(sent), /Confirmez-vous ce paiement/);
    });

    test('external P2P recipient is asked for their phone number after operator choice', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'source', {
            amount: 1000, is_p2p: true, merchant_name: 'Destinataire Externe'
        });

        t.mock.method(authService, 'authenticate', async () => ({ num_mtn: '22990000002' }));
        await paymentHandler.handleMerchantPayment(sock, fullId, 'source', '1', fakeMsg(), sessionId);

        assert.equal(stateService.getCurrentStep(sessionId), 'recipient_phone');
        assert.match(lastText(sent), /numéro \*MTN\* du destinataire/);
    });
});

describe('PaymentHandler — recipient phone step (external P2P)', () => {
    test('rejects too-short phone numbers', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'recipient_phone', { amount: 500 });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'recipient_phone', '123', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Numéro invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'recipient_phone');
    });

    test('valid phone stores it and shows the confirmation summary', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'merchant_payment', 'recipient_phone', {
            amount: 500, is_p2p: true, merchant_name: 'Destinataire Externe'
        });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'recipient_phone', '229 91 23 45 67', fakeMsg(), sessionId);
        assert.equal(stateService.getData(sessionId, 'p2p_recipient_phone'), '22991234567');
        assert.equal(stateService.getCurrentStep(sessionId), 'confirmation');
    });
});

describe('PaymentHandler — confirmation step', () => {
    function seedConfirmState(sessionId, extra = {}) {
        stateService.setState(sessionId, 'merchant_payment', 'confirmation', {
            amount: 1000, merchant_code: 'S1', merchant_name: 'Shop', object: 'Test',
            source: 'MTN', user_phone: '22990000002', merchant_phone: '22990000003',
            ...extra
        });
    }

    test('"2" goes back to operator selection', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedConfirmState(sessionId);

        await paymentHandler.handleMerchantPayment(sock, fullId, 'confirmation', '2', fakeMsg(), sessionId);
        assert.equal(stateService.getCurrentStep(sessionId), 'source');
    });

    test('anything other than "1"/"2" cancels the flow', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedConfirmState(sessionId);

        const result = await paymentHandler.handleMerchantPayment(sock, fullId, 'confirmation', 'nope', fakeMsg(), sessionId);
        assert.equal(result, null);
    });

    test('P2P confirmation without a resolved recipient number errors out', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedConfirmState(sessionId, { is_p2p: true, p2p_recipient_phone: null });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'confirmation', '1', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Aucun numéro de paiement associé/);
    });

    test('successful merchant payment submits the right payload and starts polling', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedConfirmState(sessionId);

        let submitted = null;
        t.mock.method(paymentService, 'submitMerchantPayment', async (payload) => {
            submitted = payload;
            return { success: true, data: { reference: 'REF123' } };
        });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'confirmation', '1', fakeMsg(), sessionId);

        assert.equal(submitted.amount, 1000);
        assert.equal(submitted.merchant_code, 'S1');
        assert.equal(submitted.source, 'MTN');
        assert.match(lastText(sent), /Paiement en cours/);
        assert.equal(stateService.getData(sessionId, 'current_payment_ref'), 'REF123');

        // A background poll was scheduled (setTimeout, 5s) that would call
        // paymentService.checkPaymentStatus against the *real* production API
        // once this test's mocks are restored. Invalidate the ref so the poll's
        // own guard clause makes it a no-op whenever it eventually fires.
        stateService.clearState(sessionId);
    });

    test('API rejection shows the backend error message', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedConfirmState(sessionId);

        t.mock.method(paymentService, 'submitMerchantPayment', async () => ({
            success: false, error: { message: 'Solde insuffisant côté marchand' }
        }));

        await paymentHandler.handleMerchantPayment(sock, fullId, 'confirmation', '1', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Solde insuffisant côté marchand/);
    });

    test('a thrown exception during submission is caught and reported', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        seedConfirmState(sessionId);

        t.mock.method(paymentService, 'submitMerchantPayment', async () => { throw new Error('SOCKET_HANG_UP'); });

        await paymentHandler.handleMerchantPayment(sock, fullId, 'confirmation', '1', fakeMsg(), sessionId);
        assert.match(lastText(sent), /Échec de l'initiation du paiement/);
    });

    test('group chat: plain-text reply to the wrong message is silently ignored', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = '120363425718811577@g.us';
        seedConfirmState(sessionId, { last_summary_id: 'REAL_MSG_ID' });

        const result = await paymentHandler.handleMerchantPayment(
            sock, fullId, 'confirmation', '1', fakeMsg({ quotedId: 'WRONG_ID' }), sessionId
        );
        assert.equal(result, undefined);
        assert.equal(sent.length, 0);
    });
});
