import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import groupHandler from '../../src/handlers/GroupHandler.js';
import stateService from '../../src/services/StateService.js';
import merchantService from '../../src/services/MerchantService.js';
import authService from '../../src/services/AuthService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

const GROUP_JID = '120363425718811577@g.us';

describe('GroupHandler — shorthand merchant payment (#amount#code)', () => {
    test('valid shorthand without operator shows the payment card and waits for operator choice', async (t) => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        t.mock.method(merchantService, 'checkMerchant', async () => ({
            id: 'm1', company_name: 'Boutique X', merchant_phone: '22990000009', service_fee: 0
        }));

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '#500#SHOP01', {}, [], null, null, senderJid, null
        );

        assert.equal(stateService.getCurrentFlow(sessionId), 'merchant_payment');
        assert.equal(stateService.getCurrentStep(sessionId), 'source');
        assert.equal(stateService.getData(sessionId, 'amount'), 500);
        assert.match(lastText(sent), /Boutique X/);
    });

    test('shorthand with an operator suffix skips straight to confirmation via the callback', async (t) => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const { sock } = createMockSock();

        t.mock.method(merchantService, 'checkMerchant', async () => ({
            id: 'm1', company_name: 'Boutique X', merchant_phone: '22990000009', service_fee: 0
        }));
        t.mock.method(authService, 'authenticate', async () => ({ num_mtn: '22990000002' }));

        let callbackArgs = null;
        const onPaymentFlowStarted = async (...args) => { callbackArgs = args; };

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '#500#SHOP01#1', {}, [], null, null, senderJid, onPaymentFlowStarted
        );

        assert.equal(stateService.getCurrentStep(sessionId), 'confirmation');
        assert.equal(stateService.getData(sessionId, 'source'), 'MTN');
        assert.ok(callbackArgs, 'onPaymentFlowStarted should have been invoked');
        assert.equal(callbackArgs[2], 'confirmation');
        assert.equal(callbackArgs[3], '1');
    });

    test('new shorthand format *pay*code*amount*op# is also recognized', async (t) => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        t.mock.method(merchantService, 'checkMerchant', async () => ({
            id: 'm1', company_name: 'Boutique Y', merchant_phone: '22990000009', service_fee: 0
        }));
        // rawOp 'flooz' maps to a real operator, so the handler will look up the payer's
        // registered number — mock it so no live network call is made.
        t.mock.method(authService, 'authenticate', async () => ({ num_moov: '22990000002' }));

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '*pay*SHOP02*750*flooz#', {}, [], null, null, senderJid, null
        );

        assert.equal(stateService.getData(sessionId, 'amount'), 750);
    });

    test('unknown code (neither merchant nor user) reports "introuvable"', async (t) => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        t.mock.method(merchantService, 'checkMerchant', async () => { throw new Error('not found'); });
        t.mock.method(merchantService, 'findUserByWhatsapp', async () => ({ success: false }));

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '#500#GHOST99', {}, [], null, null, senderJid, null
        );

        assert.match(lastText(sent), /introuvable/);
    });
});

describe('GroupHandler — tag + amount P2P', () => {
    test('mentioning a registered user with an amount sets up a P2P transfer', async (t) => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const targetJid = uniquePhone() + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        t.mock.method(merchantService, 'findUserByWhatsapp', async () => ({
            success: true, data: { user: { prenom: 'Alice' } }
        }));

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '1000', {}, [targetJid], 'BOTPN', null, senderJid, null
        );

        assert.equal(stateService.getData(sessionId, 'is_p2p'), true);
        assert.equal(stateService.getData(sessionId, 'amount'), 1000);
        assert.match(lastText(sent), /Alice/);
    });

    test('mentioning an unregistered user still starts an external P2P flow', async (t) => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const targetJid = uniquePhone() + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        t.mock.method(merchantService, 'findUserByWhatsapp', async () => ({ success: false }));

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '1000', {}, [targetJid], 'BOTPN', null, senderJid, null
        );

        assert.equal(stateService.getData(sessionId, 'merchant_name'), 'Destinataire Externe');
        assert.match(lastText(sent), /Non inscrit/);
    });

    test('an amount with no target asks the user to reply or mention someone', async () => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, '1000', {}, [], 'BOTPN', null, senderJid, null
        );

        assert.match(lastText(sent), /répondez au message de votre ami/);
    });

    test('no shorthand and no amount shows the group help message', async () => {
        const sessionId = uniquePhone();
        const senderJid = sessionId + '@s.whatsapp.net';
        const { sock, sent } = createMockSock();

        await groupHandler.handleGroupMention(
            sock, GROUP_JID, sessionId, 'salut', {}, [], 'BOTPN', null, senderJid, null
        );

        assert.match(lastText(sent), /AfrikMoney Bot/);
    });
});
