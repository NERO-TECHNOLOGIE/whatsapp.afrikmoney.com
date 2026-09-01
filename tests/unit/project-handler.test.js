import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import projectHandler from '../../src/handlers/ProjectHandler.js';
import stateService from '../../src/services/StateService.js';
import projectService from '../../src/services/ProjectService.js';
import merchantService from '../../src/services/MerchantService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

/** Drives the handler through merchant-code -> service -> name -> target so
 *  each test can start directly at the step it wants to exercise. */
async function reachTargetStep(t, { serviceFee = 0 } = {}) {
    const sessionId = uniquePhone();
    const { sock, sent } = createMockSock();
    const fullId = sessionId + '@s.whatsapp.net';

    t.mock.method(merchantService, 'checkMerchant', async () => ({
        id: 'merchant_1',
        company_name: 'Shop Test',
        service_fee: serviceFee,
        services: [{ id: 'svc_1', name: 'Abonnement Premium' }]
    }));

    stateService.setState(sessionId, 'create_project', 'merchant_code');
    await projectHandler.handleProjectCreation(sock, fullId, 'merchant_code', 'SHOP01', sessionId);
    await projectHandler.handleProjectCreation(sock, fullId, 'service', '1', sessionId);

    return { sessionId, sock, sent, fullId };
}

async function reachInstallmentStep(t, targetAmountText, opts) {
    const ctx = await reachTargetStep(t, opts);
    await projectHandler.handleProjectCreation(ctx.sock, ctx.fullId, 'target', targetAmountText, ctx.sessionId);
    await projectHandler.handleProjectCreation(ctx.sock, ctx.fullId, 'frequency', '3', ctx.sessionId); // monthly
    return ctx;
}

describe('ProjectHandler — installment amount vs total amount (the reported bug)', () => {
    test('rejects an installment amount greater than the total target amount', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '1');

        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '8', sessionId);

        const msg = lastText(sent);
        assert.match(msg, /ne peut pas dépasser/i);
        assert.match(msg, /1 FCFA/);

        // Must stay on the installment step — not silently advance to confirmation.
        assert.equal(stateService.getCurrentStep(sessionId), 'installment');
        assert.equal(stateService.getData(sessionId, 'amount'), null);
    });

    test('accepts an installment amount equal to the total target amount (single payment)', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '100');

        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '100', sessionId);

        assert.equal(stateService.getCurrentStep(sessionId), 'confirmation');
        assert.equal(stateService.getData(sessionId, 'amount'), 100);
        assert.match(lastText(sent), /Récapitulatif du projet/);
    });

    test('accepts an installment amount smaller than the total target amount', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '1000');

        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '250', sessionId);

        assert.equal(stateService.getCurrentStep(sessionId), 'confirmation');
        const recap = lastText(sent);
        assert.match(recap, /Versements prévus : \*4\*/);
    });

    test('still rejects a non-numeric / zero installment before the total-amount check', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '500');

        await projectHandler.handleProjectCreation(sock, fullId, 'installment', 'abc', sessionId);
        assert.match(lastText(sent), /montant de versement valide/i);

        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '0', sessionId);
        assert.match(lastText(sent), /montant de versement valide/i);

        assert.equal(stateService.getCurrentStep(sessionId), 'installment');
    });

    test('the created project is never sent to the API with an installment above the target', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '1');

        let createCalled = false;
        t.mock.method(projectService, 'createProject', async (payload) => {
            createCalled = true;
            return { id: 'proj_1' };
        });

        // Attacker/careless user tries an over-large installment first.
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '8', sessionId);
        assert.equal(createCalled, false);

        // Then corrects it — flow should now proceed normally.
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '1', sessionId);
        await projectHandler.handleProjectCreation(sock, fullId, 'confirmation', '1', sessionId);

        assert.equal(createCalled, true);
    });
});

describe('ProjectHandler — full creation flow', () => {
    test('invalid merchant code says the merchant doesn\'t exist and offers a link to register', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';
        stateService.setState(sessionId, 'create_project', 'merchant_code');

        t.mock.method(merchantService, 'checkMerchant', async () => { throw new Error('Code marchand invalide'); });
        await projectHandler.handleProjectCreation(sock, fullId, 'merchant_code', 'NOPE', sessionId);

        const text = lastText(sent);
        assert.match(text, /n'existe pas/);
        assert.match(text, /wa\.me\//);
        assert.equal(stateService.getCurrentStep(sessionId), 'merchant_code');
    });

    test('rejects an out-of-range service selection', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(merchantService, 'checkMerchant', async () => ({
            id: 'm1', company_name: 'Shop', service_fee: 0,
            services: [{ id: 's1', name: 'Only Service' }]
        }));

        stateService.setState(sessionId, 'create_project', 'merchant_code');
        await projectHandler.handleProjectCreation(sock, fullId, 'merchant_code', 'SHOP', sessionId);
        await projectHandler.handleProjectCreation(sock, fullId, 'service', '99', sessionId);

        assert.match(lastText(sent), /Choix invalide/);
        assert.equal(stateService.getCurrentStep(sessionId), 'service');
    });

    test('rejects an invalid total target amount', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachTargetStep(t);
        await projectHandler.handleProjectCreation(sock, fullId, 'target', '0', sessionId);
        assert.match(lastText(sent), /montant total valide/i);
        assert.equal(stateService.getCurrentStep(sessionId), 'target');
    });

    test('rejects an invalid frequency choice', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachTargetStep(t);
        await projectHandler.handleProjectCreation(sock, fullId, 'target', '1000', sessionId);
        await projectHandler.handleProjectCreation(sock, fullId, 'frequency', '9', sessionId);
        assert.match(lastText(sent), /Choix invalide/);
    });

    test('recap computes the number of installments and fees correctly', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '1000', { serviceFee: 3 });
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '300', sessionId);

        const recap = lastText(sent);
        // ceil(1000/300) = 4 installments
        assert.match(recap, /Versements prévus : \*4\*/);
        // fee = 300 * (3+2)% = 15 -> total 315
        assert.match(recap, /315 FCFA/);
    });

    test('confirmation: "0" cancels without creating the project', async (t) => {
        const { sock, sessionId, fullId } = await reachInstallmentStep(t, '500');
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '250', sessionId);

        let createCalled = false;
        t.mock.method(projectService, 'createProject', async () => { createCalled = true; return {}; });

        const result = await projectHandler.handleProjectCreation(sock, fullId, 'confirmation', '0', sessionId);
        assert.equal(result, null);
        assert.equal(createCalled, false);
    });

    test('confirmation: invalid text re-prompts instead of creating', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '500');
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '250', sessionId);

        await projectHandler.handleProjectCreation(sock, fullId, 'confirmation', 'yes please', sessionId);
        assert.match(lastText(sent), /Tapez 1 pour confirmer/);
    });

    test('confirmation: "1" creates the project via the API and shows success recap', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '500');
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '250', sessionId);

        t.mock.method(projectService, 'createProject', async (payload, whatsappId) => {
            assert.equal(payload.target_amount, 500);
            assert.equal(payload.amount, 250);
            return { id: 'proj_42' };
        });

        await projectHandler.handleProjectCreation(sock, fullId, 'confirmation', '1', sessionId);
        assert.match(lastText(sent), /Projet créé avec succès/);
        assert.equal(stateService.getData(sessionId, 'selected_project')?.id, 'proj_42');
    });

    test('confirmation: API failure surfaces the error message', async (t) => {
        const { sock, sent, sessionId, fullId } = await reachInstallmentStep(t, '500');
        await projectHandler.handleProjectCreation(sock, fullId, 'installment', '250', sessionId);

        t.mock.method(projectService, 'createProject', async () => { throw new Error('Backend down'); });

        await projectHandler.handleProjectCreation(sock, fullId, 'confirmation', '1', sessionId);
        assert.match(lastText(sent), /Echec de la creation du projet : Backend down/);
    });
});

describe('ProjectHandler — projects list & details', () => {
    test('showProjects filters out completed projects', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(projectService, 'getProjects', async () => ([
            { id: 1, name: 'Done', current_amount: 100, target_amount: 100, is_paid: true, created_at: '2026-01-01' },
            { id: 2, name: 'Ongoing', current_amount: 20, target_amount: 100, is_paid: false, created_at: '2026-02-01' }
        ]));

        await projectHandler.showProjects(sock, fullId, sessionId);
        const cached = stateService.getData(sessionId, 'cached_projects');
        assert.equal(cached.length, 1);
        assert.equal(cached[0].name, 'Ongoing');
    });

    test('showProjects with an empty list offers project creation', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(projectService, 'getProjects', async () => ([]));
        await projectHandler.showProjects(sock, fullId, sessionId);

        assert.match(lastText(sent), /aucun projet/i);
        assert.equal(stateService.getCurrentFlow(sessionId), 'main_menu');
    });

    test('handleProjectListSelection rejects an out-of-range index', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        stateService.setState(sessionId, 'projects_list', 'selection');
        stateService.addData(sessionId, 'cached_projects', [{ id: 1 }]);

        await projectHandler.handleProjectListSelection(sock, fullId, '5', sessionId);
        assert.match(lastText(sent), /Choix invalide/);
    });

    test('showProjectDetails displays amount due and next-payment info', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        const project = {
            id: 7, client_name: 'John', company: { name: 'Shop' }, description: 'Sub',
            current_amount: 250, target_amount: 500, amount: 250, next_payment: '2026-09-01'
        };
        await projectHandler.showProjectDetails(sock, fullId, project, sessionId);

        const text = lastText(sent);
        assert.match(text, /250 FCFA/);
        assert.match(text, /payer l'échéance maintenant/);
    });

    test('handleProjectDetails routes "1" to the plan payment flow and "0" to main menu', async () => {
        const sessionId = uniquePhone();
        const { sock } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        const project = {
            id: 7, company: { merchant_code: 'C1', id: 'm1', name: 'Shop', merchant_phone: '229000', service_fee: 0 },
            current_amount: 0, target_amount: 500, amount: 250, name: 'Plan A'
        };
        stateService.addData(sessionId, 'selected_project', project);
        stateService.setState(sessionId, 'project_details', 'options');

        await projectHandler.handleProjectDetails(sock, fullId, '1', sessionId);
        assert.equal(stateService.getCurrentStep(sessionId), 'source');
        assert.equal(stateService.getData(sessionId, 'amount'), 250);

        const result = await projectHandler.handleProjectDetails(sock, fullId, '0', sessionId);
        assert.equal(result, null);
    });

    test('handleProjectDetails blocks payment on a completed project', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        const project = { id: 1, current_amount: 500, target_amount: 500 };
        stateService.addData(sessionId, 'selected_project', project);
        stateService.setState(sessionId, 'project_details', 'options');

        await projectHandler.handleProjectDetails(sock, fullId, '1', sessionId);
        assert.match(lastText(sent), /deja termine/);
    });
});
