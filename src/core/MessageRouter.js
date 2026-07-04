import stateService from '../services/StateService.js';
import authService from '../services/AuthService.js';

import registrationHandler from '../handlers/RegistrationHandler.js';
import paymentHandler from '../handlers/PaymentHandler.js';
import projectHandler from '../handlers/ProjectHandler.js';
import profileHandler from '../handlers/ProfileHandler.js';
import groupHandler from '../handlers/GroupHandler.js';

/**
 * MessageRouter - Central orchestrator for all incoming WhatsApp messages.
 *
 * Single Responsibility: Receive a raw Baileys message, parse the context
 * (sender, group, mentions, active flow), and delegate to the correct handler.
 *
 * This class does NOT implement any business logic itself. It only
 * routes messages to the right handler (Open/Closed Principle).
 */
class MessageRouter {

    /**
     * Entry point — called by QueueService for every incoming message.
     * @param {Object} sock - Baileys socket instance
     * @param {Object} msg - Raw WhatsApp message object
     */
    async handleMessage(sock, msg) {
        // --- 1. GUARD CLAUSES ---
        const fullId = msg.key.remoteJid;
        if (!fullId || fullId === 'status@broadcast') return;

        const isGroup = fullId.endsWith('@g.us');
        const senderJid = isGroup ? msg.key.participant : fullId;
        if (!senderJid) return; // Skip system messages with no participant

        const from = this._normalizeId(senderJid);

        // --- 2. EXTRACT TEXT ---
        // Extract text from all interactive message types
        const _nativeFlowParams = msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
        const _nativeFlowId = _nativeFlowParams ? (() => { try { return JSON.parse(_nativeFlowParams)?.id ?? ''; } catch { return ''; } })() : '';
        const _listRowId = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId || '';

        let text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.buttonsResponseMessage?.selectedButtonId ||
            msg.message?.templateButtonReplyMessage?.selectedId ||
            _nativeFlowId ||
            _listRowId ||
            ''
        ).trim();

        // --- 3. BOT IDENTITY ---
        const botJid = sock.user?.id ? `${sock.user.id.split(':')[0]}@s.whatsapp.net` : null;
        const botPN = botJid ? this._normalizeId(botJid) : null;
        const botLID = (sock.user?.lid || sock.authState?.creds?.me?.lid)
            ? this._normalizeId(sock.user?.lid || sock.authState?.creds?.me?.lid)
            : null;

        // --- 4. CONTEXT DETECTION ---
        // Check contextInfo from both regular replies and interactive button responses
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.interactiveResponseMessage?.contextInfo
            || msg.message?.listResponseMessage?.contextInfo;

        const mentions = contextInfo?.mentionedJid || [];

        const isMentioned = botJid && (
            mentions.some(m => {
                const norm = this._normalizeId(m);
                return (botPN && norm === botPN) || (botLID && norm === botLID);
            }) ||
            (botPN && text.includes(botPN)) ||
            (botLID && text.includes(botLID))
        );

        const isReplyToBot = !!(contextInfo?.participant && (
            this._normalizeId(contextInfo.participant) === botPN ||
            this._normalizeId(contextInfo.participant) === botLID
        ));

        // Button/list clicks are inherently tied to a specific bot message — treat as reply to bot
        const isButtonClick = !!(
            msg.message?.interactiveResponseMessage ||
            msg.message?.buttonsResponseMessage ||
            msg.message?.templateButtonReplyMessage ||
            msg.message?.listResponseMessage
        );

        // --- 5. GROUP EARLY GATES ---
        if (isGroup) {
            const notInteractingWithBot = !isMentioned && !isReplyToBot &&
                !msg.message?.buttonsResponseMessage &&
                !msg.message?.templateButtonReplyMessage &&
                !msg.message?.interactiveResponseMessage;
            if (notInteractingWithBot) return;
        }

        if (isGroup && (isMentioned || isReplyToBot)) {
            console.log(`[MessageRouter] Group from ${from}: "${text}" (Mention: ${isMentioned}, Reply: ${isReplyToBot})`);
        }

        // Strip bot @mention from text to get clean command
        if (isMentioned) {
            text = text.replace(/@\d+/g, '').trim();
        }

        // Skip completely empty messages (no text, no button/list response)
        if (!text && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage && !msg.message?.interactiveResponseMessage && !msg.message?.listResponseMessage) return;

        // --- 6. TYPING INDICATOR ---
        await this._showTypingIndicator(sock, fullId, isGroup);

        try {
            const userId = from; // Global user ID (phone)
            const sessionId = isGroup ? `${this._normalizeId(fullId)}:${userId}` : userId; // Isolation

            const currentFlow = stateService.getCurrentFlow(sessionId);
            const currentStep = stateService.getCurrentStep(sessionId);

            // --- 7. GROUP-SPECIFIC HANDLING ---
            // If in a group and bot was mentioned (fresh, no active flow), delegate to GroupHandler
            if (isGroup && isMentioned && !currentFlow) {
                return groupHandler.handleGroupMention(
                    sock, fullId, sessionId, text, contextInfo, mentions,
                    botPN, botLID, senderJid,
                    // Callback that lets GroupHandler trigger the payment confirm step
                    (s, id, step, t, m, f) => paymentHandler.handleMerchantPayment(s, id, step, t, m, f)
                );
            }

            // If in a group with an active flow, allow replies to bot OR button clicks
            if (isGroup && !isMentioned) {
                if (!currentFlow || (!isReplyToBot && !isButtonClick)) return;
            }

            // --- 8. PRIVATE / DIRECT FLOW HANDLING ---

            // Send vCard on first contact (private chats only)
            if (!isGroup && !currentFlow && !stateService.getUserData(userId, 'vcard_sent', false)) {
                await registrationHandler.sendContact(sock, fullId);
                stateService.setUserData(userId, 'vcard_sent', true);
                await registrationHandler.sendMessage(sock, fullId, 'Enregistrez mon contact pour ne rien manquer !');
                await new Promise(r => setTimeout(r, 500));
            }

            // Disclaimer acknowledgment
            if (currentFlow === 'welcome' && currentStep === 'disclaimer') {
                return registrationHandler.handleDisclaimer(sock, fullId, text, userId, sessionId);
            }

            // Global cancel — "0" exits any flow back to the main menu
            const isSkippingRegistrationPayment = (currentFlow === 'registration' && ['mtn', 'moov', 'celtiis'].includes(currentStep));
            if (text === '0' && currentFlow !== 'main_menu' && !isSkippingRegistrationPayment) {
                stateService.clearState(sessionId);
                return this._showMainMenuOrWelcome(sock, fullId, userId, sessionId);
            }

            // --- 9. NO FLOW / MAIN MENU ---
            if (!currentFlow || currentFlow === 'main_menu') {
                // Groups that fall through to here without a button must stop
                if (isGroup && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage && !msg.message?.interactiveResponseMessage && !msg.message?.listResponseMessage) return;
                return this._handleMainMenu(sock, fullId, userId, sessionId, text);
            }

            // --- 10. ACTIVE FLOW ROUTING ---
            return this._routeFlow(sock, fullId, currentFlow, currentStep, text, msg, userId, sessionId);

        } catch (error) {
            console.error('[MessageRouter] Unhandled error:', error);
            await this._sendMessage(sock, fullId, 'Une erreur est survenue. Réessayez plus tard.');
        }
    }

    // ===== PRIVATE: ROUTING HELPERS =====

    /**
     * Dispatch an active flow to the appropriate handler.
     */
    async _routeFlow(sock, fullId, flow, step, text, msg, userId, sessionId) {
        switch (flow) {
            case 'registration':
                return registrationHandler.handleRegistration(sock, fullId, step, text, sessionId);

            case 'merchant_payment':
                return paymentHandler.handleMerchantPayment(sock, fullId, step, text, msg, sessionId);

            case 'create_project':
                return projectHandler.handleProjectCreation(sock, fullId, step, text, sessionId);

            case 'projects_list':
                return projectHandler.handleProjectListSelection(sock, fullId, text, sessionId);

            case 'project_details': {
                const result = await projectHandler.handleProjectDetails(sock, fullId, text, sessionId);
                if (result === null) return this._showMainMenuOrWelcome(sock, fullId, userId, sessionId);
                return result;
            }

            case 'support': {
                const result = await profileHandler.handleSupport(sock, fullId, text, sessionId);
                if (result === null) return this._showMainMenuOrWelcome(sock, fullId, userId, sessionId);
                return result;
            }

            case 'profile': {
                const result = await profileHandler.handleProfile(sock, fullId, text, sessionId);
                if (result === null) return this._showMainMenuOrWelcome(sock, fullId, userId, sessionId);
                return result;
            }

            default:
                return this._showMainMenuOrWelcome(sock, fullId, userId, sessionId);
        }
    }

    /**
     * Handle the main menu: authenticate user, then dispatch to the chosen option.
     */
    async _handleMainMenu(sock, fullId, userId, sessionId, text) {
        let user = null;
        try {
            user = await authService.authenticate(userId);
        } catch (error) {
            console.log(`[MessageRouter] Auth failed for ${userId}:`, error.message);
            if (error.message.includes('ECONNREFUSED')) {
                await this._sendMessage(sock, fullId, '⚠️ Le service d\'authentification est actuellement indisponible (Backend unreachable).');
                return;
            }
        }

        if (!user) {
            // Unregistered user: show welcome/disclaimer
            const hasAccepted = stateService.getUserData(userId, 'disclaimer_accepted', false);
            if (!hasAccepted) return registrationHandler.showWelcome(sock, fullId, userId, sessionId);

            if (text === '1') {
                return registrationHandler.startRegistrationFlow(sock, fullId, sessionId);
            }
            return registrationHandler.showWelcome(sock, fullId, userId, sessionId);
        }

        // Registered user: store phone and route selection (in session)
        stateService.addData(sessionId, 'user_phone', user.telephone);

        switch (text) {
            case '1': return projectHandler.showProjects(sock, fullId, sessionId);
            case '2': return paymentHandler.startMerchantPaymentFlow(sock, fullId, sessionId);
            case '3': return profileHandler.showHistory(sock, fullId, sessionId);
            case '4': return profileHandler.showProfile(sock, fullId, user, sessionId);
            case '5': return projectHandler.startProjectCreationFlow(sock, fullId, sessionId);
            case '6': return profileHandler.showSupport(sock, fullId, sessionId);
            default: return profileHandler.showMainMenu(sock, fullId, user, sessionId);
        }
    }

    /**
     * Show main menu if the user is authenticated, otherwise show welcome.
     */
    async _showMainMenuOrWelcome(sock, fullId, userId, sessionId) {
        // Groups: don't show menu on flow completion
        if (fullId.endsWith('@g.us')) return;

        let user = null;
        try { user = await authService.authenticate(userId); } catch { }

        if (!user) return registrationHandler.showWelcome(sock, fullId, userId, sessionId);
        return profileHandler.showMainMenu(sock, fullId, user, sessionId);
    }

    /**
     * Show typing indicator to give a more natural response feel.
     */
    async _showTypingIndicator(sock, fullId, isGroup) {
        try {
            await sock.sendPresenceUpdate('composing', fullId);
            await new Promise(r => setTimeout(r, isGroup ? 2000 : 1000));
            await sock.sendPresenceUpdate('paused', fullId);
        } catch (e) {
            console.warn(`[MessageRouter] Presence update error:`, e.message);
        }
    }

    /** Utility: normalize a WhatsApp JID to a plain string. */
    _normalizeId(id) {
        if (!id || typeof id !== 'string') return '';
        return id.split('@')[0].split(':')[0];
    }

    /** Utility: send a text message. */
    async _sendMessage(sock, jid, text, options = {}) {
        return sock.sendMessage(jid, { text, ...options });
    }
}

export default new MessageRouter();
