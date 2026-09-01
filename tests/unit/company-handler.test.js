import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import companyHandler from '../../src/handlers/CompanyHandler.js';
import stateService from '../../src/services/StateService.js';
import authService from '../../src/services/AuthService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

describe('CompanyHandler — service setup', () => {
    test('startServiceSetup offers the type list first', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyHandler.startServiceSetup(sock, fullId, sessionId);

        assert.equal(stateService.getCurrentFlow(sessionId), 'company_service_setup');
        assert.equal(stateService.getCurrentStep(sessionId), 'service_type');
        const call = sent[sent.length - 1];
        assert.ok(call.content.sections[0].rows.some(r => r.rowId === 'abonnements'));
        assert.ok(call.content.sections[0].rows.some(r => r.rowId === 'remboursement de prets'));
    });

    test('rejects a type not in the list', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_type');

        await companyHandler.handleServiceSetup(sock, fullId, 'service_type', 'Un truc random', sessionId);
        assert.match(lastText(sent), /invalide/);
    });

    test('service_type -> service_nom asks for the service name', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_type');

        await companyHandler.handleServiceSetup(sock, fullId, 'service_type', 'location', sessionId);
        assert.equal(stateService.getData(sessionId, 'service_type'), 'location');
        assert.equal(stateService.getCurrentStep(sessionId), 'service_nom');
        assert.match(lastText(sent), /nom.*ce service/i);
    });

    test('accepts a type selected by its display label too', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_type');

        await companyHandler.handleServiceSetup(sock, fullId, 'service_type', 'Assurance', sessionId);
        assert.equal(stateService.getData(sessionId, 'service_type'), 'assurance');
    });

    test('rejects an empty service name', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_nom', { service_type: 'location' });

        await companyHandler.handleServiceSetup(sock, fullId, 'service_nom', '   ', sessionId);
        assert.match(lastText(sent), /invalide/);
    });

    test('service_nom -> service_description', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_nom', { service_type: 'location' });

        await companyHandler.handleServiceSetup(sock, fullId, 'service_nom', 'Livraison express', sessionId);
        assert.equal(stateService.getData(sessionId, 'service_name'), 'Livraison express');
        assert.equal(stateService.getCurrentStep(sessionId), 'service_description');
        assert.match(lastText(sent), /description/i);
    });

    test('"0" on the description step skips it (not a cancel)', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_description', {
            service_name: 'Livraison', service_type: 'location',
        });

        let createPayload = null;
        t.mock.method(companyHandler.companies, 'createService', async (data) => { createPayload = data; return { success: true, data: { id: 's1' } }; });
        t.mock.method(authService, 'authenticateCompany', async () => ({ id: 'c1', name: 'Ma Boutique', is_verified: false }));

        await companyHandler.handleServiceSetup(sock, fullId, 'service_description', '0', sessionId);

        assert.equal(createPayload.description, null);
        assert.match(lastText(sent), /Espace Entreprise/);
    });

    test('service creation failure still lands the company on its main menu', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_service_setup', 'service_description', {
            service_name: 'Livraison', service_type: 'location',
        });

        t.mock.method(companyHandler.companies, 'createService', async () => { throw new Error('network down'); });
        t.mock.method(authService, 'authenticateCompany', async () => ({ id: 'c1', name: 'Ma Boutique', is_verified: false }));

        await companyHandler.handleServiceSetup(sock, fullId, 'service_description', '0', sessionId);

        assert.match(lastText(sent), /Espace Entreprise/);
        assert.equal(stateService.getCurrentFlow(sessionId), 'company_main_menu');
    });
});

describe('CompanyHandler — main menu', () => {
    test('showCompanyMainMenu lists the expected options', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyHandler.showCompanyMainMenu(sock, fullId, { name: 'Ma Boutique', is_verified: false }, sessionId);

        assert.equal(stateService.getCurrentFlow(sessionId), 'company_main_menu');
        const call = sent[sent.length - 1];
        const ids = call.content.sections[0].rows.map(r => r.rowId);
        assert.deepEqual(ids, ['1', '2', '3', '4', '5']);
    });

    test('showCompanyMainMenu displays the merchant code', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await companyHandler.showCompanyMainMenu(sock, fullId, { name: 'Ma Boutique', is_verified: false, merchant_code: '048213' }, sessionId);

        assert.match(lastText(sent), /048213/);
    });

    test('"1" sends the dashboard link', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_main_menu', 'selection');

        t.mock.method(companyHandler.companies, 'getDashboardLink', async () => ({ success: true, data: { url: 'https://afrikmoney.com/magic-login?kt=abc&to=/dashboard' } }));

        await companyHandler.handleCompanyMenu(sock, fullId, '1', sessionId);
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.url && b.url.includes('magic-login')));
    });

    test('"2" starts the add-a-service flow', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_main_menu', 'selection');

        await companyHandler.handleCompanyMenu(sock, fullId, '2', sessionId);
        assert.equal(stateService.getCurrentFlow(sessionId), 'company_service_setup');
        void sent;
    });

    test('"3" lists existing services', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_main_menu', 'selection');

        t.mock.method(companyHandler.companies, 'getServices', async () => ({
            success: true, data: { data: [{ name: 'Livraison', type: 'Prestation de service' }] }
        }));

        await companyHandler.handleCompanyMenu(sock, fullId, '3', sessionId);
        assert.match(lastText(sent), /Livraison/);
    });

    test('"4" reports pending verification status', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_main_menu', 'selection');

        t.mock.method(authService, 'authenticateCompany', async () => ({ id: 'c1', name: 'Ma Boutique', is_verified: false, merchant_code: '048213' }));

        await companyHandler.handleCompanyMenu(sock, fullId, '4', sessionId);
        assert.match(lastText(sent), /attente de vérification/);
        assert.match(lastText(sent), /048213/);
    });

    test('"4" reports verified status', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_main_menu', 'selection');

        t.mock.method(authService, 'authenticateCompany', async () => ({ id: 'c1', name: 'Ma Boutique', is_verified: true }));

        await companyHandler.handleCompanyMenu(sock, fullId, '4', sessionId);
        assert.match(lastText(sent), /vérifié/);
    });

    test('an invalid choice re-prompts', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'company_main_menu', 'selection');

        await companyHandler.handleCompanyMenu(sock, fullId, 'zzz', sessionId);
        assert.match(lastText(sent), /invalide/);
    });
});
