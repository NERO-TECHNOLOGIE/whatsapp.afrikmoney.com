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
        let text = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            ''
        ).trim();

        // --- 3. BOT IDENTITY ---
        const botJid = sock.user?.id ? `${sock.user.id.split(':')[0]}@s.whatsapp.net` : null;
        const botPN = botJid ? this._normalizeId(botJid) : null;
        const botLID = (sock.user?.lid || sock.authState?.creds?.me?.lid)
            ? this._normalizeId(sock.user?.lid || sock.authState?.creds?.me?.lid)
            : null;

        // --- 4. CONTEXT DETECTION ---
        const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

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

        // --- 5. GROUP EARLY GATES ---
        if (isGroup) {
            const notInteractingWithBot = !isMentioned && !isReplyToBot &&
                !msg.message?.buttonsResponseMessage &&
                !msg.message?.templateButtonReplyMessage;
            if (notInteractingWithBot) return;
        }

        if (isGroup && (isMentioned || isReplyToBot)) {
            console.log(`[MessageRouter] Group from ${from}: "${text}" (Mention: ${isMentioned}, Reply: ${isReplyToBot})`);
        }

        // Strip bot @mention from text to get clean command
        if (isMentioned) {
            text = text.replace(/@\d+/g, '').trim();
        }

        // Skip completely empty messages (no text, no button response)
        if (!text && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage) return;

        // --- 6. SESSION & AUTHENTICATION ---
        const sessionKey = isGroup ? `${from}:group:${this._normalizeId(fullId)}` : from;

        // Try to pre-authenticate the user if they're interacting with the bot
        // This ensures the HttpClient has a valid token for subsequent API calls.
        let user = null;
        try {
            user = await authService.authenticate(from);
            if (user) {
                stateService.addData(sessionKey, 'user_phone', user.telephone);
            }
        } catch (error) {
            console.log(`[MessageRouter] Early auth failed for ${from}:`, error.message);
        }

        // --- 7. TYPING INDICATOR ---
        await this._showTypingIndicator(sock, fullId, isGroup);

        try {
            const currentFlow = stateService.getCurrentFlow(sessionKey);
            const currentStep = stateService.getCurrentStep(sessionKey);

            // --- 8. GROUP-SPECIFIC HANDLING ---
            // If in a group and bot was mentioned (fresh, no active flow), delegate to GroupHandler
            if (isGroup && isMentioned && !currentFlow) {
                return groupHandler.handleGroupMention(
                    sock, fullId, sessionKey, text, contextInfo, mentions,
                    botPN, botLID, senderJid,
                    // Callback that lets GroupHandler trigger the payment confirm step
                    (s, id, step, t, m, f) => paymentHandler.handleMerchantPayment(s, id, step, t, m, f)
                );
            }

            // If in a group with an active flow, ONLY allow continuation via replies to the bot
            if (isGroup && !isMentioned) {
                if (!currentFlow || !isReplyToBot) return;
            }

            // --- 9. PRIVATE / DIRECT FLOW HANDLING ---

            // Send vCard on first contact (private chats only)
            if (!isGroup && !currentFlow && !stateService.getData(sessionKey, 'vcard_sent', false)) {
                await registrationHandler.sendContact(sock, fullId);
                stateService.addData(sessionKey, 'vcard_sent', true);
                await registrationHandler.sendMessage(sock, fullId, 'Enregistrez mon contact pour ne rien manquer !');
                await new Promise(r => setTimeout(r, 500));
            }

            // Disclaimer acknowledgment
            if (currentFlow === 'welcome' && currentStep === 'disclaimer') {
                return registrationHandler.handleDisclaimer(sock, fullId, text, sessionKey);
            }

            // Global cancel — "0" exits any flow back to the main menu
            const isSkippingRegistrationPayment = (currentFlow === 'registration' && ['mtn', 'moov', 'celtiis'].includes(currentStep));
            if (text === '0' && currentFlow !== 'main_menu' && !isSkippingRegistrationPayment) {
                stateService.clearState(sessionKey);
                return this._showMainMenuOrWelcome(sock, fullId, from, sessionKey, user);
            }

            // --- 10. NO FLOW / MAIN MENU ---
            if (!currentFlow || currentFlow === 'main_menu') {
                // Groups: strictly restricted to payment mentions/shorthands (handled in step 8)
                // We do NOT show the main menu in groups.
                if (isGroup) return;
                
                return this._handleMainMenu(sock, fullId, from, text, sessionKey, user);
            }

            // --- 11. ACTIVE FLOW ROUTING ---
            return this._routeFlow(sock, fullId, currentFlow, currentStep, text, msg, from, sessionKey);

        } catch (error) {
            console.error('[MessageRouter] Unhandled error:', error);
            await this._sendMessage(sock, fullId, 'Une erreur est survenue. Réessayez plus tard.');
        }
    }

    // ===== PRIVATE: ROUTING HELPERS =====

    /**
     * Dispatch an active flow to the appropriate handler.
     */
    async _routeFlow(sock, fullId, flow, step, text, msg, from, sessionKey) {
        const isGroup = fullId.endsWith('@g.us');
        
        // Groups: Only merchant_payment flow is allowed to continue
        if (isGroup && flow !== 'merchant_payment') {
            stateService.clearState(sessionKey);
            return;
        }

        switch (flow) {
            case 'registration':
                return registrationHandler.handleRegistration(sock, fullId, step, text, sessionKey);

            case 'merchant_payment':
                return paymentHandler.handleMerchantPayment(sock, fullId, step, text, msg, sessionKey);

            case 'create_project':
                return projectHandler.handleProjectCreation(sock, fullId, step, text, sessionKey);

            case 'projects_list':
                return projectHandler.handleProjectListSelection(sock, fullId, text, sessionKey);

            case 'project_details': {
                const result = await projectHandler.handleProjectDetails(sock, fullId, text, sessionKey);
                if (result === null) return this._showMainMenuOrWelcome(sock, fullId, from, sessionKey);
                return result;
            }

            case 'support': {
                const result = await profileHandler.handleSupport(sock, fullId, text, sessionKey);
                if (result === null) return this._showMainMenuOrWelcome(sock, fullId, from, sessionKey);
                return result;
            }

            case 'profile': {
                const result = await profileHandler.handleProfile(sock, fullId, text, sessionKey);
                if (result === null) return this._showMainMenuOrWelcome(sock, fullId, from, sessionKey);
                return result;
            }

            default:
                return this._showMainMenuOrWelcome(sock, fullId, from, sessionKey);
        }
    }

    /**
     * Handle the main menu: authenticate user, then dispatch to the chosen option.
     */
    async _handleMainMenu(sock, fullId, from, text, sessionKey, preAuthUser = null) {
        let user = preAuthUser;

        if (!user) {
            try {
                user = await authService.authenticate(from);
            } catch (error) {
                console.log(`[MessageRouter] Auth failed for ${from}:`, error.message);
                if (error.message.includes('ECONNREFUSED')) {
                    await this._sendMessage(sock, fullId, '⚠️ Le service d\'authentification est actuellement indisponible (Backend unreachable).');
                    return;
                }
            }
        }

        if (!user) {
            // Unregistered user: show welcome/disclaimer
            const hasAccepted = stateService.getData(sessionKey, 'disclaimer_accepted', false);
            if (!hasAccepted) return registrationHandler.showWelcome(sock, fullId, sessionKey);

            if (text === '1') {
                return registrationHandler.startRegistrationFlow(sock, fullId, sessionKey);
            }
            return registrationHandler.showWelcome(sock, fullId, sessionKey);
        }

        // Registered user: store phone and route selection
        stateService.addData(sessionKey, 'user_phone', user.telephone);

        switch (text) {
            case '1': return projectHandler.showProjects(sock, fullId, sessionKey);
            case '2': return paymentHandler.startMerchantPaymentFlow(sock, fullId, sessionKey);
            case '3': return profileHandler.showHistory(sock, fullId, sessionKey);
            case '4': return profileHandler.showProfile(sock, fullId, user, sessionKey);
            case '5': return projectHandler.startProjectCreationFlow(sock, fullId, sessionKey);
            case '6': return profileHandler.showSupport(sock, fullId, sessionKey);
            default: return profileHandler.showMainMenu(sock, fullId, user, sessionKey);
        }
    }

    /**
     * Show main menu if the user is authenticated, otherwise show welcome.
     */
    async _showMainMenuOrWelcome(sock, fullId, from, sessionKey, preAuthUser = null) {
        // Groups: don't show menu on flow completion
        if (fullId.endsWith('@g.us')) return;

        let user = preAuthUser;
        if (!user) {
            try { user = await authService.authenticate(from); } catch { }
        }

        if (!user) return registrationHandler.showWelcome(sock, fullId, sessionKey);
        return profileHandler.showMainMenu(sock, fullId, user, sessionKey);
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
