import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import companyRegistrationHandler from '../../src/handlers/CompanyRegistrationHandler.js';
import companyHandler from '../../src/handlers/CompanyHandler.js';
import stateService from '../../src/services/StateService.js';
import authService from '../../src/services/AuthService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

describe('CompanyRegistrationHandler — terms (CGU)', () => {
    test('startRegistrationFlow shows the CGU link and accept/cancel buttons', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyRegistrationHandler.startRegistrationFlow(sock, fullId, sessionId);

        assert.equal(stateService.getCurrentFlow(sessionId), 'company_registration');
        assert.equal(stateService.getCurrentStep(sessionId), 'terms');
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.url && b.url.includes('/cgu')));
        assert.ok(call.content.nativeFlow.some(b => b.id === '1'));
        assert.ok(call.content.nativeFlow.some(b => b.id === '0'));
    });

    test('accepting the CGU advances to company name', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyRegistrationHandler.handleStep(sock, fullId, 'terms', '1', sessionId);

        assert.equal(stateService.getData(sessionId, 'terms_accepted'), true);
        assert.equal(stateService.getCurrentStep(sessionId), 'nom_entreprise');
        assert.match(lastText(sent), /nom de votre entreprise/);
    });

    test('declining the CGU cancels the flow', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyRegistrationHandler.handleStep(sock, fullId, 'terms', '0', sessionId);

        assert.equal(stateService.getCurrentFlow(sessionId), null);
        assert.match(lastText(sent), /annulée/);
    });

    test('an invalid choice re-prompts the CGU buttons', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyRegistrationHandler.handleStep(sock, fullId, 'terms', 'blah', sessionId);
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.id === '1'));
    });
});

describe('CompanyRegistrationHandler — step-by-step fields', () => {
    test('rejects an empty company name', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'nom_entreprise');

        await companyRegistrationHandler.handleStep(sock, fullId, 'nom_entreprise', '   ', sessionId);
        assert.match(lastText(sent), /invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'nom_entreprise');
    });

    test('nom_entreprise advances straight to email (no separate whatsapp question)', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'nom_entreprise');

        await companyRegistrationHandler.handleStep(sock, fullId, 'nom_entreprise', 'Ma Boutique', sessionId);
        assert.equal(stateService.getCurrentStep(sessionId), 'email');
        assert.match(lastText(sent), /email professionnel/);
    });

    test('rejects an invalid email', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'email');

        await companyRegistrationHandler.handleStep(sock, fullId, 'email', 'not-an-email', sessionId);
        assert.match(lastText(sent), /Email invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'email');
    });

    test('"0" skips optional fields (ifu, mtn, moov) instead of cancelling', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'ifu');

        await companyRegistrationHandler.handleStep(sock, fullId, 'ifu', '0', sessionId);
        assert.equal(stateService.getData(sessionId, 'ifu'), null);
        assert.equal(stateService.getCurrentStep(sessionId), 'mtn');

        await companyRegistrationHandler.handleStep(sock, fullId, 'mtn', '0', sessionId);
        assert.equal(stateService.getData(sessionId, 'num_mtn'), null);
        assert.equal(stateService.getCurrentStep(sessionId), 'moov');
    });

    test('rejects an IFU that is too short', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'ifu');

        await companyRegistrationHandler.handleStep(sock, fullId, 'ifu', '12345', sessionId);
        assert.match(lastText(sent), /IFU invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'ifu');
    });

    test('accepts a 13-digit IFU with formatting characters stripped', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'ifu');

        await companyRegistrationHandler.handleStep(sock, fullId, 'ifu', '3202400-123456', sessionId);
        assert.equal(stateService.getData(sessionId, 'ifu'), '3202400123456');
        assert.equal(stateService.getCurrentStep(sessionId), 'mtn');
    });

    test('rejects a moov payment number that is not a valid Benin phone', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'moov');

        await companyRegistrationHandler.handleStep(sock, fullId, 'moov', 'nope', sessionId);
        assert.match(lastText(sent), /Moov invalide/);
    });
});

describe('CompanyRegistrationHandler — cannot dual-register (backend guard surfaced in chat)', () => {
    test('a WhatsApp number already registered as a client is rejected with a clear message', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'celtiis', {
            company_name: 'Ma Boutique', company_email: 'x@x.com',
        });

        t.mock.method(authService, 'registerCompany', async () => {
            throw new Error('Ce numéro WhatsApp est déjà utilisé par un compte client. Un même numéro ne peut pas être à la fois client et entreprise.');
        });

        await companyRegistrationHandler.handleStep(sock, fullId, 'celtiis', '0', sessionId);
        assert.match(lastText(sent), /déjà utilisé par un compte client/);
    });
});

describe('CompanyRegistrationHandler — full happy path', () => {
    test('walks through terms -> nom -> whatsapp -> email -> ifu -> mtn -> moov -> celtiis, registers, and hands off to service setup', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        let registerPayload = null;
        t.mock.method(authService, 'registerCompany', async (payload) => {
            registerPayload = payload;
            return {
                company: { id: 'c1', name: payload.company_name, is_verified: false, merchant_code: '048213' },
                generated_password: 'ABCD1234',
            };
        });
        t.mock.method(authService, 'authenticateCompany', async () => null);
        t.mock.method(companyHandler.companies, 'createService', async () => ({ success: true, data: { id: 's1' } }));

        await companyRegistrationHandler.startRegistrationFlow(sock, fullId, sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'terms', '1', sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'nom_entreprise', 'Ma Boutique', sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'email', 'contact@maboutique.com', sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'ifu', '3202400123456', sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'mtn', '22990000001', sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'moov', '0', sessionId);
        await companyRegistrationHandler.handleStep(sock, fullId, 'celtiis', '0', sessionId);

        assert.equal(registerPayload.company_name, 'Ma Boutique');
        // whatsapp is forced to the real session identity, not a free-text answer
        // (sessionId has no ':' here, so userId === sessionId — see handler comment).
        assert.equal(registerPayload.whatsapp, sessionId);
        assert.equal(registerPayload.email, 'contact@maboutique.com');
        assert.equal(registerPayload.ifu, '3202400123456');
        assert.equal(registerPayload.num_mtn, '22990000001');
        assert.equal(registerPayload.num_moov, null);
        assert.equal(registerPayload.terms_accepted, true);

        // The generated password must never be echoed in chat — it's emailed instead
        // (CompanyCredentialsNotification, sent by the backend on every registration).
        const registrationConfirmation = sent.find(s => (s.content.text || '').includes('Compte entreprise créé'));
        assert.ok(registrationConfirmation, 'should have sent a registration confirmation message');
        assert.doesNotMatch(registrationConfirmation.content.text, /ABCD1234/);
        assert.match(registrationConfirmation.content.text, /048213/);
        assert.match(registrationConfirmation.content.text, /envoyés par email/);

        // Registration cleared its own flow and handed off into service setup —
        // type is asked before the name (see CompanyHandler.startServiceSetup).
        assert.match(lastText(sent), /premier service|type.*de service/i);
        assert.equal(stateService.getCurrentFlow(sessionId), 'company_service_setup');
        assert.equal(stateService.getCurrentStep(sessionId), 'service_type');
    });

    test('a registration API failure surfaces the backend error message', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_registration', 'celtiis', {
            company_name: 'X', company_email: 'x@x.com',
        });

        t.mock.method(authService, 'registerCompany', async () => {
            throw new Error('Ce numéro WhatsApp est déjà utilisé.');
        });

        await companyRegistrationHandler.handleStep(sock, fullId, 'celtiis', '0', sessionId);
        assert.match(lastText(sent), /Ce numéro WhatsApp est déjà utilisé/);
    });
});
