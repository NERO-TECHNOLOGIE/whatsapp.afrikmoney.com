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
        assert.equal(stateService.getCurrentFlow(`instanceA:${phone}`), 'registration');
        assert.equal(stateService.getCurrentFlow(`instanceB:${phone}`), 'welcome');
    });

    test('omitting instanceId (e.g. a direct/legacy caller) falls back to a stable default scope without crashing', async (t) => {
        const phone = uniquePhone();
        const { sock } = createMockSock();
        sock.user = { id: BOT_ID };
        t.mock.method(authService, 'authenticate', async () => null);

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

        await messageRouter.handleMessage(sock, privateTextMsg(`${phone}@s.whatsapp.net`, 'menu'), 'instA');

        assert.equal(stateService.getCurrentFlow(`instA:${phone}`), 'welcome');
        assert.match(lastText(sent), /INFORMATION IMPORTANTE/);
    });
});
