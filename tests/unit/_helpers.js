/**
 * Shared test helpers for the unit test suite.
 * Provides a mock Baileys `sock`, a way to inspect everything it "sent",
 * and unique JIDs/session ids so tests never collide via the shared
 * StateService singleton.
 */

let counter = 0;

/** Generates a fresh, collision-free WhatsApp-style phone number for each test. */
export function uniquePhone() {
    counter += 1;
    return `22990${String(100000 + counter).slice(-6)}`;
}

/**
 * Builds a mock Baileys sock that records every sendMessage call instead
 * of hitting the network. Presence updates resolve immediately.
 */
export function createMockSock() {
    const sent = [];
    const sock = {
        user: { id: '22900000000:1@s.whatsapp.net', lid: 'bot_lid_test' },
        authState: { creds: { me: { lid: 'bot_lid_test' } } },
        sendPresenceUpdate: async () => {},
        sendMessage: async (jid, content) => {
            const entry = { jid, content };
            sent.push(entry);
            return { key: { id: 'mock_' + Math.random().toString(36).slice(2) } };
        }
    };
    return { sock, sent };
}

/** Returns the text of the last message sent to any jid (body + footer, so
 *  assertions can match content placed in either — nativeFlow messages
 *  often put the key detail in the footer). */
export function lastText(sent) {
    const last = sent[sent.length - 1];
    const body = last?.content?.text ?? last?.content?.orderText ?? '';
    const footer = last?.content?.footer ?? '';
    return footer ? `${body}\n${footer}` : body;
}

/** Builds a minimal fake incoming-message object (only fields handlers read). */
export function fakeMsg({ isButtonClick = false, quotedId = null } = {}) {
    if (isButtonClick) {
        return { message: { interactiveResponseMessage: {} } };
    }
    return {
        message: quotedId
            ? { extendedTextMessage: { contextInfo: { stanzaId: quotedId } } }
            : {}
    };
}
