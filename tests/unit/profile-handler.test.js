import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import profileHandler from '../../src/handlers/ProfileHandler.js';
import stateService from '../../src/services/StateService.js';
import userService from '../../src/services/UserService.js';
import paymentService from '../../src/services/PaymentService.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

const USER = { nom: 'Doe', prenom: 'John', telephone: '22990123456', num_mtn: '22990123456', num_moov: null, num_celtiis: null };

describe('ProfileHandler — menus', () => {
    test('showMainMenu greets the user by name', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await profileHandler.showMainMenu(sock, fullId, USER, sessionId);
        assert.match(lastText(sent), /Bonjour \*John Doe\*/);
        assert.equal(stateService.getCurrentFlow(sessionId), 'main_menu');
    });

    test('showMainMenu offers the WhatsApp channel as option 9', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await profileHandler.showMainMenu(sock, fullId, USER, sessionId);
        const rows = sent[sent.length - 1].content.sections[0].rows;
        assert.ok(rows.some(r => r.rowId === '9'));
    });

    test('sendChannelLink sends the channel invite with a join button', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await profileHandler.sendChannelLink(sock, fullId, sessionId);
        const call = sent[sent.length - 1];
        assert.match(call.content.text, /Chaîne AfrikMoney/);
        assert.ok(call.content.nativeFlow.some(b => b.url && b.url.includes('tinyurl.com')));
    });

    test('showProfile lists linked and unlinked mobile money accounts', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await profileHandler.showProfile(sock, fullId, USER, sessionId);
        const text = lastText(sent);
        assert.match(text, /MTN MOBILE MONEY : \*22990123456\*/);
        assert.match(text, /FLOOZ : \*Non lié\*/);
    });

    test('handleProfile: "1" explains web-only edits, "0" returns to main menu, other is invalid', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await profileHandler.handleProfile(sock, fullId, '1', sessionId);
        assert.match(lastText(sent), /uniquement disponible sur la plateforme web/);

        const result = await profileHandler.handleProfile(sock, fullId, '0', sessionId);
        assert.equal(result, null);

        await profileHandler.handleProfile(sock, fullId, 'x', sessionId);
        assert.match(lastText(sent), /Choix invalide/);
    });
});

describe('ProfileHandler — history', () => {
    test('renders the last transactions with French status labels', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(userService, 'getHistory', async () => ([
            { created_at: '2026-08-01', amount: 500, note: 'Facture EDM', status: 'SUCCESS' },
            { created_at: '2026-08-02', amount: 300, note: 'Facture SBEE', status: 'FAILED' }
        ]));

        await profileHandler.showHistory(sock, fullId, sessionId);
        const text = lastText(sent);
        assert.match(text, /Réussi/);
        assert.match(text, /Échoué/);
    });

    test('empty history shows a friendly empty state', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(userService, 'getHistory', async () => ([]));
        await profileHandler.showHistory(sock, fullId, sessionId);
        assert.match(lastText(sent), /Aucune transaction trouvée/);
    });

    test('a backend failure shows a fallback message and clears state', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(userService, 'getHistory', async () => { throw new Error('down'); });
        await profileHandler.showHistory(sock, fullId, sessionId);
        assert.match(lastText(sent), /Impossible de récupérer votre historique/);
        assert.equal(stateService.getCurrentFlow(sessionId), null);
    });
});

describe('ProfileHandler — support menu', () => {
    test('walks through FAQ, contact, and report options, then "0" exits', async () => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        await profileHandler.handleSupport(sock, fullId, '1', sessionId);
        assert.ok(sent.some(s => (s.content.text || '').includes('FAQ Afrikmoney')));

        await profileHandler.handleSupport(sock, fullId, '2', sessionId);
        assert.ok(sent.some(s => (s.content.text || '').includes('support@afrikmoney.com')));

        await profileHandler.handleSupport(sock, fullId, '3', sessionId);
        assert.ok(sent.some(s => (s.content.text || '').includes('Signaler un problème')));

        const result = await profileHandler.handleSupport(sock, fullId, '0', sessionId);
        assert.equal(result, null);
    });
});

describe('ProfileHandler — KYC link', () => {
    test('successful link generation shows the verification button', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getKycLink', async () => ({
            success: true, data: { url: 'https://kyc.example/link/abc', kyc_level: 0 }
        }));

        await profileHandler.sendKycLink(sock, fullId, sessionId);
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.url === 'https://kyc.example/link/abc'));
        assert.match(lastText(sent), /pas encore verifie/);
    });

    test('already-verified (level 2) users are told their identity is confirmed', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getKycLink', async () => ({
            success: false, data: { kyc_level: 2 }
        }));

        await profileHandler.sendKycLink(sock, fullId, sessionId);
        assert.match(lastText(sent), /deja verifiee/);
    });

    test('a generic backend failure shows a retry message', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getKycLink', async () => ({ success: false, data: {} }));
        await profileHandler.sendKycLink(sock, fullId, sessionId);
        assert.match(lastText(sent), /Impossible de generer votre lien KYC/);
    });

    test('a thrown exception is caught and reported', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getKycLink', async () => { throw new Error('timeout'); });
        await profileHandler.sendKycLink(sock, fullId, sessionId);
        assert.match(lastText(sent), /Une erreur est survenue/);
    });
});

describe('ProfileHandler — dashboard magic link', () => {
    test('successful link generation shows the dashboard button', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getDashboardLink', async () => ({
            success: true, data: { url: 'https://app.afrikmoney.com/magic-login?kt=abc&to=/client/dashboard' }
        }));

        await profileHandler.sendDashboardLink(sock, fullId, sessionId);
        const call = sent[sent.length - 1];
        assert.ok(call.content.nativeFlow.some(b => b.url?.includes('/magic-login')));
    });

    test('a generic backend failure shows a retry message', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getDashboardLink', async () => ({ success: false, data: {} }));
        await profileHandler.sendDashboardLink(sock, fullId, sessionId);
        assert.match(lastText(sent), /Impossible de generer votre lien/);
    });

    test('a thrown exception is caught and reported', async (t) => {
        const sessionId = uniquePhone();
        const { sock, sent } = createMockSock();
        const fullId = sessionId + '@s.whatsapp.net';

        t.mock.method(paymentService, 'getDashboardLink', async () => { throw new Error('timeout'); });
        await profileHandler.sendDashboardLink(sock, fullId, sessionId);
        assert.match(lastText(sent), /Une erreur est survenue/);
    });
});
