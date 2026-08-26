import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import registrationHandler from '../../src/handlers/RegistrationHandler.js';
import stateService from '../../src/services/StateService.js';
import authService from '../../src/services/AuthService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

describe('RegistrationHandler — disclaimer', () => {
    test('accepting the disclaimer starts the registration flow', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleDisclaimer(sock, fullId, '1', userId, userId);
        assert.equal(stateService.getUserData(userId, 'disclaimer_accepted'), true);
        assert.equal(stateService.getCurrentFlow(userId), 'registration');
        assert.match(lastText(sent), /Quel est votre \*NOM\*/);
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

describe('RegistrationHandler — step-by-step registration', () => {
    test('rejects a phone number that does not start with 229 or is too short', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'telephone');

        await registrationHandler.handleRegistration(sock, fullId, 'telephone', '12345', sessionId);
        assert.match(lastText(sent), /Numéro invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'telephone');
    });

    test('rejects a phone number that is already registered', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'telephone');

        t.mock.method(authService, 'checkPhoneExists', async () => true);
        await registrationHandler.handleRegistration(sock, fullId, 'telephone', '22990123456', sessionId);
        assert.match(lastText(sent), /déjà enregistré/);
    });

    test('walks through nom -> prenom -> telephone -> whatsapp -> mtn -> moov -> celtiis and registers', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'nom');

        t.mock.method(authService, 'checkPhoneExists', async () => false);
        let registerPayload = null;
        t.mock.method(authService, 'registerUser', async (payload) => {
            registerPayload = payload;
            return { nom: 'Doe', prenom: 'John' };
        });

        await registrationHandler.handleRegistration(sock, fullId, 'nom', 'Doe', sessionId);
        await registrationHandler.handleRegistration(sock, fullId, 'prenom', 'John', sessionId);
        await registrationHandler.handleRegistration(sock, fullId, 'telephone', '22990123456', sessionId);
        await registrationHandler.handleRegistration(sock, fullId, 'whatsapp', '22990123456', sessionId);
        await registrationHandler.handleRegistration(sock, fullId, 'mtn', '22990123456', sessionId);
        await registrationHandler.handleRegistration(sock, fullId, 'moov', '0', sessionId);
        await registrationHandler.handleRegistration(sock, fullId, 'celtiis', '0', sessionId);

        assert.equal(registerPayload.nom, 'Doe');
        assert.equal(registerPayload.prenom, 'John');
        assert.equal(registerPayload.num_mtn, '22990123456');
        assert.equal(registerPayload.num_moov, null);
        assert.equal(registerPayload.num_celtiis, null);
        assert.match(lastText(sent), /Bienvenue sur AFRIKMONEY/);
        assert.equal(stateService.getCurrentFlow(sessionId), 'main_menu');
    });

    test('a registration API failure surfaces the backend error', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'celtiis', {
            nom: 'Doe', prenom: 'John', telephone: '22990123456', whatsapp_num: '22990123456'
        });

        t.mock.method(authService, 'registerUser', async () => {
            const err = new Error('fail');
            err.response = { data: { message: 'Téléphone invalide côté serveur' } };
            throw err;
        });

        await registrationHandler.handleRegistration(sock, fullId, 'celtiis', '0', sessionId);
        assert.match(lastText(sent), /Téléphone invalide côté serveur/);
    });
});
