import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import registrationHandler from '../../src/handlers/RegistrationHandler.js';
import stateService from '../../src/services/StateService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

describe('RegistrationHandler — disclaimer', () => {
    test('accepting the disclaimer shows the client-vs-entreprise choice', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleDisclaimer(sock, fullId, '1', userId, userId);
        assert.equal(stateService.getUserData(userId, 'disclaimer_accepted'), true);
        assert.equal(stateService.getCurrentFlow(userId), 'welcome');
        assert.equal(stateService.getCurrentStep(userId), 'account_type');
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.id === '1'));
        assert.ok(call.content.nativeFlow.some(b => b.id === '2'));
    });

    test('declining ends the session', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleDisclaimer(sock, fullId, '0', userId, userId);
        assert.match(lastText(sent), /Session terminée/);
    });

    test('an invalid choice re-prompts the disclaimer buttons', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleDisclaimer(sock, fullId, 'blah', userId, userId);
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.id === '1'));
    });
});

describe('RegistrationHandler — account type choice', () => {
    test('choosing "client" sends the web signup link and clears state (no more chat Q&A)', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';
        stateService.setState(userId, 'welcome', 'account_type');

        await registrationHandler.handleAccountTypeChoice(sock, fullId, '1', userId, userId);

        assert.equal(stateService.getCurrentFlow(userId), null);
        const call = sent[sent.length - 1];
        assert.match(call.content.text, /Créer mon compte AfrikMoney/);
        assert.ok(call.content.nativeFlow.some(b => b.url && b.url.includes('/inscription-client')));
    });

    test('choosing "entreprise" starts the company registration flow', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleAccountTypeChoice(sock, fullId, '2', userId, userId);
        assert.equal(stateService.getCurrentFlow(userId), 'company_registration');
        assert.equal(stateService.getCurrentStep(userId), 'terms');
        assert.match(lastText(sent), /Créer un compte Entreprise/);
    });

    test('an invalid choice re-prompts client-vs-entreprise', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleAccountTypeChoice(sock, fullId, 'blah', userId, userId);
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.id === '1'));
        assert.ok(call.content.nativeFlow.some(b => b.id === '2'));
    });
});

describe('RegistrationHandler — sendClientSignupLink', () => {
    test('uses FRONTEND_URL when set', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';
        const previous = process.env.FRONTEND_URL;
        process.env.FRONTEND_URL = 'https://example.test';

        try {
            await registrationHandler.sendClientSignupLink(sock, fullId, userId);
            const call = sent[sent.length - 1];
            assert.ok(call.content.nativeFlow.some(b => b.url === `https://example.test/inscription-client?wa=${userId}&lid=0`));
        } finally {
            if (previous === undefined) delete process.env.FRONTEND_URL;
            else process.env.FRONTEND_URL = previous;
        }
    });

    test('embeds the phone-number identity with lid=0 for a normal JID', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.sendClientSignupLink(sock, fullId, userId);
        const call = sent[sent.length - 1];
        const link = call.content.nativeFlow.find(b => b.url)?.url;
        assert.ok(link.includes(`wa=${userId}`));
        assert.ok(link.endsWith('&lid=0'));
    });

    test('embeds the LID identity with lid=1 for a @lid JID — nobody can type their own LID', async () => {
        const lid = '19876543210987';
        const { sock, sent } = createMockSock();
        const fullId = `${lid}@lid`;

        await registrationHandler.sendClientSignupLink(sock, fullId, 'some-session');
        const call = sent[sent.length - 1];
        const link = call.content.nativeFlow.find(b => b.url)?.url;
        assert.ok(link.includes(`wa=${lid}`));
        assert.ok(link.endsWith('&lid=1'));
    });
});
