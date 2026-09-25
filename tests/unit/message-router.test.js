import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import messageRouter from '../../src/core/MessageRouter.js';
import stateService from '../../src/services/StateService.js';
import authService from '../../src/services/AuthService.js';
import groupHandler from '../../src/handlers/GroupHandler.js';

import { createMockSock, lastText, uniquePhone } from './_helpers.js';

const BOT_ID = '22900000099:1@s.whatsapp.net';
const BOT_PN = '22900000099';

function privateTextMsg(remoteJid, text, { remoteJidAlt } = {}) {
    return {
        key: { remoteJid, fromMe: false, id: 'MID' + Math.random().toString(36).slice(2), remoteJidAlt },
        message: { conversation: text }
    };
}

function groupMentionMsg(groupJid, participant, text, { participantAlt } = {}) {
    return {
        key: { remoteJid: groupJid, fromMe: false, id: 'MID' + Math.random().toString(36).slice(2), participant, participantAlt },
        message: {
            conversation: text,
            extendedTextMessage: { text, contextInfo: { mentionedJid: [`${BOT_PN}@s.whatsapp.net`] } }
        }
    };
}

describe('MessageRouter — LID vs phone-number sender identity (private chat)', () => {
    test('a plain phone-number JID is used as-is', async (t) => {
        const phone = uniquePhone();
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };

        let capturedAuthArg = null;
        t.mock.method(authService, 'authenticate', async (uid) => { capturedAuthArg = uid; return null; });
        t.mock.method(authService, 'authenticateCompany', async () => null);

        const msg = privateTextMsg(`${phone}@s.whatsapp.net`, 'salut');
        await messageRouter.handleMessage(sock, msg, 'instA');

        assert.equal(capturedAuthArg, phone);
        assert.equal(stateService.getCurrentFlow(`instA:${phone}`), 'welcome');
    });

    test('a @lid remoteJid is resolved to its phone-number alt for session/auth purposes', async (t) => {
        const phone = uniquePhone();
        const lid = 'LID' + phone;
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };

        let capturedAuthArg = null;
        t.mock.method(authService, 'authenticate', async (uid) => { capturedAuthArg = uid; return null; });
        t.mock.method(authService, 'authenticateCompany', async () => null);

        const msg = privateTextMsg(`${lid}@lid`, 'salut', { remoteJidAlt: `${phone}@s.whatsapp.net` });
        await messageRouter.handleMessage(sock, msg, 'instA');

        // The backend call and the flow state must use the phone number, not the LID —
        // otherwise the same person gets a second, disconnected session/onboarding.
        assert.equal(capturedAuthArg, phone);
        assert.equal(stateService.getCurrentFlow(`instA:${phone}`), 'welcome');
        assert.equal(stateService.getCurrentFlow(`instA:${lid}`), null);
    });

    test('a @lid remoteJid with no alt available falls back to the LID (no crash, no regression)', async (t) => {
        const lid = 'LID' + uniquePhone();
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };

        let capturedAuthArg = null;
        t.mock.method(authService, 'authenticate', async (uid) => { capturedAuthArg = uid; return null; });
        t.mock.method(authService, 'authenticateCompany', async () => null);

        const msg = privateTextMsg(`${lid}@lid`, 'salut'); // no remoteJidAlt
        await messageRouter.handleMessage(sock, msg, 'instA');

        assert.equal(capturedAuthArg, lid);
        assert.equal(stateService.getCurrentFlow(`instA:${lid}`), 'welcome');
    });
});

describe('MessageRouter — LID resolution does not break group @mentions', () => {
    test('GroupHandler still receives the original (unresolved) participant JID for correct @mention rendering', async (t) => {
        const groupJid = '1203634257' + Math.floor(Math.random() * 1e9) + '@g.us';
        const phone = uniquePhone();
        const lidParticipant = 'LID' + phone + '@lid';
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };

        let capturedArgs = null;
        t.mock.method(groupHandler, 'handleGroupMention', async (...args) => { capturedArgs = args; });

        const msg = groupMentionMsg(groupJid, lidParticipant, 'salut', { participantAlt: `${phone}@s.whatsapp.net` });
        await messageRouter.handleMessage(sock, msg, 'instA');

        assert.ok(capturedArgs, 'handleGroupMention should have been called');
        const senderJidArg = capturedArgs[8]; // (sock, fullId, sessionId, text, contextInfo, mentions, botPN, botLID, senderJid, cb)
        assert.equal(senderJidArg, lidParticipant, 'mentions must keep using the JID form WhatsApp actually renders in that chat');
    });
});

describe('MessageRouter — per-instance session isolation', () => {
    test('the same phone number gets independent flow state on two different WhatsApp instances', async (t) => {
        const phone = uniquePhone();
        const { sock: sockA } = createMockSock();
        const { sock: sockB } = createMockSock();
        sockA.user = { id: BOT_ID };
        sockB.user = { id: BOT_ID };

        t.mock.method(authService, 'authenticate', async () => null); // unregistered on both
        t.mock.method(authService, 'authenticateCompany', async () => null);

        await messageRouter.handleMessage(sockA, privateTextMsg(`${phone}@s.whatsapp.net`, 'salut'), 'instanceA');
        assert.equal(stateService.getCurrentFlow(`instanceA:${phone}`), 'welcome');
        // instanceB hasn't seen this phone yet — must be completely untouched
        assert.equal(stateService.getCurrentFlow(`instanceB:${phone}`), null);

        await messageRouter.handleMessage(sockB, privateTextMsg(`${phone}@s.whatsapp.net`, 'salut'), 'instanceB');
        assert.equal(stateService.getCurrentFlow(`instanceB:${phone}`), 'welcome');
        // instanceA's session must still be there, unaffected by instanceB's traffic
        assert.equal(stateService.getCurrentFlow(`instanceA:${phone}`), 'welcome');

        // Advance only instanceA's disclaimer to "accepted" and confirm instanceB is unaffected.
        await messageRouter.handleMessage(sockA, privateTextMsg(`${phone}@s.whatsapp.net`, '1'), 'instanceA');
        assert.equal(stateService.getCurrentFlow(`instanceA:${phone}`), 'welcome');
        assert.equal(stateService.getCurrentStep(`instanceA:${phone}`), 'account_type');
        assert.equal(stateService.getCurrentFlow(`instanceB:${phone}`), 'welcome');

        // Choosing "client" on instanceA only sends the web signup link and clears its
        // state, still without touching instanceB.
        await messageRouter.handleMessage(sockA, privateTextMsg(`${phone}@s.whatsapp.net`, '1'), 'instanceA');
        assert.equal(stateService.getCurrentFlow(`instanceA:${phone}`), null);
        assert.equal(stateService.getCurrentFlow(`instanceB:${phone}`), 'welcome');
    });

    test('omitting instanceId (e.g. a direct/legacy caller) falls back to a stable default scope without crashing', async (t) => {
        const phone = uniquePhone();
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };
        t.mock.method(authService, 'authenticate', async () => null);
        t.mock.method(authService, 'authenticateCompany', async () => null);

        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'salut'));
        assert.equal(stateService.getCurrentFlow(`default:${phone}`), 'welcome');
    });
});

describe('MessageRouter — a backend auth error must never look like "not registered"', () => {
    // authService.authenticate only resolves to null for a genuine 404 (checked inside
    // AuthService itself). Anything else — timeout, 500, DNS failure — throws. Confusing
    // that thrown error with "not registered" would send an existing, returning user
    // straight back through onboarding on a plain transient backend hiccup.

    test('_handleMainMenu path: a thrown auth error shows a retry message, not the registration screen', async (t) => {
        const phone = uniquePhone();
        const { sock, sent } = createMockSock();
        sock.user = { id: BOT_ID };

        t.mock.method(authService, 'authenticate', async () => { throw new Error('Request failed with status code 500'); });

        // Fresh session, non-"0" text -> routed through _handleMainMenu.
        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'menu'), 'instA');

        assert.match(lastText(sent), /momentanément indisponible/);
        assert.ok(!sent.some(s => (s.content.text || '').includes('INFORMATION IMPORTANTE')), 'must not show the disclaimer screen');
        assert.equal(stateService.getCurrentFlow(`instA:${phone}`), null, 'must not push the user into the welcome/registration flow');
    });

    test('_showMainMenuOrWelcome path: a thrown auth error shows a retry message, not the registration screen', async (t) => {
        const phone = uniquePhone();
        const { sock, sent } = createMockSock();
        sock.user = { id: BOT_ID };

        t.mock.method(authService, 'authenticate', async () => { throw new Error('socket hang up'); });

        // "0" on a flow-less session routes through the global-cancel branch into _showMainMenuOrWelcome.
        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, '0'), 'instA');

        assert.match(lastText(sent), /momentanément indisponible/);
        assert.ok(!sent.some(s => (s.content.text || '').includes('INFORMATION IMPORTANTE')), 'must not show the disclaimer screen');
    });

    test('regression: a genuine "not registered" (null, no throw) still shows the welcome screen', async (t) => {
        const phone = uniquePhone();
        const { sock, sent } = createMockSock();
        sock.user = { id: BOT_ID };

        t.mock.method(authService, 'authenticate', async () => null); // real 404 case
        t.mock.method(authService, 'authenticateCompany', async () => null);

        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'menu'), 'instA');

        assert.equal(stateService.getCurrentFlow(`instA:${phone}`), 'welcome');
        assert.match(lastText(sent), /INFORMATION IMPORTANTE/);
    });
});

describe('MessageRouter — passwordless WhatsApp login token', () => {
    test('a "LOGIN-<token>" message is confirmed via AuthService and relayed, bypassing any flow/state routing', async (t) => {
        const phone = uniquePhone();
        const { sock, sent } = createMockSock();
        sock.user = { id: BOT_ID };
        stateService.setState(`instA:${phone}`, 'welcome', 'disclaimer'); // mid-flow — must still work

        let captured = null;
        t.mock.method(authService, 'confirmWhatsAppLogin', async (token, waId, isLid) => {
            captured = { token, waId, isLid };
            return '✅ Connexion réussie ! Retournez sur le site AfrikMoney.';
        });

        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'LOGIN-aBc123XYZ'), 'instA');

        assert.deepEqual(captured, { token: 'aBc123XYZ', waId: phone, isLid: false });
        assert.match(lastText(sent), /Connexion réussie/);
        // Untouched: this must not clear or advance whatever flow the sender was in.
        assert.equal(stateService.getCurrentFlow(`instA:${phone}`), 'welcome');
        assert.equal(stateService.getCurrentStep(`instA:${phone}`), 'disclaimer');
    });

    test('relays a failure message as-is (expired token, unknown account, etc.)', async (t) => {
        const phone = uniquePhone();
        const { sock, sent } = createMockSock();
        sock.user = { id: BOT_ID };

        t.mock.method(authService, 'confirmWhatsAppLogin', async () => "Aucun compte AfrikMoney n'est encore lié à ce WhatsApp. Inscrivez-vous d'abord.");

        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'login-expired1'), 'instA');

        assert.match(lastText(sent), /Aucun compte AfrikMoney/);
    });

    test('never fires from a group, even on an exact match', async (t) => {
        const phone = uniquePhone();
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };

        let called = false;
        t.mock.method(authService, 'confirmWhatsAppLogin', async () => { called = true; return 'x'; });

        await messageRouter.handleMessage(sock, groupMentionMsg('120363000000000000@g.us', `${phone}@s.whatsapp.net`, 'LOGIN-abc123'), 'instA');

        assert.equal(called, false);
    });

    test('a message that merely contains "LOGIN-..." without being an exact match falls through to normal routing', async (t) => {
        const phone = uniquePhone();
        const { sock, sent } = createMockSock();
        sock.user = { id: BOT_ID };

        let called = false;
        t.mock.method(authService, 'confirmWhatsAppLogin', async () => { called = true; return 'x'; });
        t.mock.method(authService, 'authenticate', async () => null);
        t.mock.method(authService, 'authenticateCompany', async () => null);

        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'voici mon code LOGIN-abc123 merci'), 'instA');

        assert.equal(called, false);
        assert.match(lastText(sent), /INFORMATION IMPORTANTE/);
    });
});
