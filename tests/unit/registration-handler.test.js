import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import registrationHandler from '../../src/handlers/RegistrationHandler.js';
import stateService from '../../src/services/StateService.js';
import authService from '../../src/services/AuthService.js';

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
    test('choosing "client" starts the client registration flow', async () => {
        const userId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = userId + '@s.whatsapp.net';

        await registrationHandler.handleAccountTypeChoice(sock, fullId, '1', userId, userId);
        assert.equal(stateService.getCurrentFlow(userId), 'registration');
        assert.match(lastText(sent), /Quel est votre \*NOM\*/);
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

describe('RegistrationHandler — field validation (regex)', () => {
    test('rejects a nom containing digits or symbols', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'nom');

        await registrationHandler.handleRegistration(sock, fullId, 'nom', 'D0e123', sessionId);
        assert.match(lastText(sent), /Nom invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'nom');
    });

    test('accepts an accented, hyphenated nom', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'nom');

        await registrationHandler.handleRegistration(sock, fullId, 'nom', "N'Guessan-Ébah", sessionId);
        assert.equal(stateService.getCurrentStep(sessionId), 'prenom');
    });

    test('rejects a prenom that is a single character', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'prenom');

        await registrationHandler.handleRegistration(sock, fullId, 'prenom', 'X', sessionId);
        assert.match(lastText(sent), /Prénom invalide/);
    });

    test('rejects an mtn payment number that is not a valid Benin phone', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'mtn');

        await registrationHandler.handleRegistration(sock, fullId, 'mtn', 'abc', sessionId);
        assert.match(lastText(sent), /MTN invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'mtn');
    });

    test('"0" still skips mtn/moov/celtiis despite the new regex check', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'mtn');

        await registrationHandler.handleRegistration(sock, fullId, 'mtn', '0', sessionId);
        assert.equal(stateService.getData(sessionId, 'num_mtn'), null);
        assert.equal(stateService.getCurrentStep(sessionId), 'moov');
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
        assert.ok(sent.some(s => /Bienvenue sur AFRIKMONEY/.test(s.content.text || '')), 'should show the main menu');
        // The channel-invite nudge is sent last, right after the main menu.
        assert.match(lastText(sent), /Chaîne AfrikMoney/);
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
            throw new Error('Téléphone invalide côté serveur');
        });

        await registrationHandler.handleRegistration(sock, fullId, 'celtiis', '0', sessionId);
        assert.match(lastText(sent), /Téléphone invalide côté serveur/);
    });

    test('a "same number already used by a company" rejection is surfaced clearly', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'registration', 'celtiis', {
            nom: 'Doe', prenom: 'John', telephone: '22990123456', whatsapp_num: '22990123456'
        });

        t.mock.method(authService, 'registerUser', async () => {
            throw new Error('Ce numéro WhatsApp est déjà utilisé par un compte entreprise. Un même numéro ne peut pas être à la fois client et entreprise.');
        });

        await registrationHandler.handleRegistration(sock, fullId, 'celtiis', '0', sessionId);
        assert.match(lastText(sent), /déjà utilisé par un compte entreprise/);
    });
});
