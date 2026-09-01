import BaseHandler from '../core/BaseHandler.js';

// Même liste que CompanyServiceComponent.vue (espace entreprise du site web) —
// les valeurs (id) doivent rester identiques à celles envoyées par le formulaire
// web pour que les services créés depuis le bot ou depuis le site soient cohérents.
const SERVICE_TYPES = [
    { label: 'Abonnements', id: 'abonnements' },
    { label: 'Achats de biens', id: 'achats de biens' },
    { label: 'Assurance', id: 'assurance' },
    { label: 'Budget de la Maison', id: 'budget de maison' },
    { label: 'Charges parentales', id: 'charges parentales' },
    { label: 'Contrat de location vente', id: 'contrat de location et vente' },
    { label: 'Cotisations sociales', id: 'cotisations sociales' },
    { label: 'Fêtes / Réceptions / Cérémonies', id: 'fetes ceremonies' },
    { label: 'Location', id: 'location' },
    { label: 'Projets de vie', id: 'projets de vie' },
    { label: 'Remboursement de prêts', id: 'remboursement de prets' },
];

/**
 * CompanyHandler - Service creation (mandatory before a company account is
 * usable) and the returning-company main menu.
 */
class CompanyHandler extends BaseHandler {

    // =====================
    // Service setup (flow: company_service_setup)
    // =====================

    async startServiceSetup(sock, fullId, sessionId, { isFirstService = false } = {}) {
        this.state.setState(sessionId, 'company_service_setup', 'service_type', { is_first_service: isFirstService });
        const intro = isFirstService
            ? "*Dernière étape : créez votre premier service* 🛠️\n\nUn \"service\" décrit ce que vous vendez (un produit, une prestation...). Vous pourrez en ajouter d'autres plus tard.\n\n"
            : '*Ajouter un service* 🛠️\n\n';
        return this.sendListMessage(
            sock, fullId,
            `${intro}Quel *type* de service est-ce ?`,
            'AfrikMoney — Entreprise',
            'Choisir un type',
            SERVICE_TYPES.map(t => ({ label: t.label, id: t.id }))
        );
    }

    /**
     * @param {string} step - service_type|service_nom|service_description
     */
    async handleServiceSetup(sock, fullId, step, text, sessionId) {
        switch (step) {
            case 'service_type': {
                const match = SERVICE_TYPES.find(t => t.id === text) || SERVICE_TYPES.find(t => t.label.toLowerCase() === text.trim().toLowerCase());
                if (!match) {
                    return this.sendMessage(sock, fullId, 'Choix invalide. Sélectionnez un type dans la liste.');
                }
                this.state.addData(sessionId, 'service_type', match.id);
                this.state.setState(sessionId, 'company_service_setup', 'service_nom');
                return this.sendMessage(sock, fullId, 'Quel est le *nom* de ce service ?');
            }

            case 'service_nom':
                if (!this._isValidCompanyName(text)) {
                    return this.sendMessage(sock, fullId, "Nom invalide. Utilisez 2 à 100 caractères (lettres, chiffres, espaces, - & '). Réessayez :");
                }
                this.state.addData(sessionId, 'service_name', text.trim());
                this.state.setState(sessionId, 'company_service_setup', 'service_description');
                return this.sendMessage(sock, fullId, "Une courte *description* ? (ou *0* pour passer)");

            case 'service_description':
                this.state.addData(sessionId, 'service_description', text === '0' ? null : text.trim());
                return this._completeServiceCreation(sock, fullId, sessionId);

            default:
                return this.startServiceSetup(sock, fullId, sessionId);
        }
    }

    async _completeServiceCreation(sock, fullId, sessionId) {
        const data = this.state.getData(sessionId);
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;

        try {
            const result = await this.companies.createService({
                name: data.service_name,
                type: data.service_type,
                description: data.service_description,
            }, userId);

            if (!result.success) {
                const msg = result.error?.message || 'Erreur inconnue';
                return this.sendMessage(sock, fullId, `Erreur lors de la création du service : ${msg}. Tapez *0* pour revenir au menu.`);
            }

            await this.sendMessage(sock, fullId, `✅ Service *${data.service_name}* créé avec succès !`);
        } catch (e) {
            console.error('[CompanyHandler] Service creation error:', e.message);
            await this.sendMessage(sock, fullId, "Une erreur est survenue lors de la création du service, mais votre compte reste actif. Vous pourrez réessayer depuis le menu.");
        }

        const company = await this.auth.authenticateCompany(userId).catch(() => null);
        if (!company) {
            this.state.clearState(sessionId);
            return this.sendMessage(sock, fullId, 'Tapez un message pour revenir au menu.');
        }
        return this.showCompanyMainMenu(sock, fullId, company, sessionId);
    }

    // =====================
    // Returning-company menu (flow: company_main_menu)
    // =====================

    async showCompanyMainMenu(sock, fullId, company, sessionId) {
        this.state.clearState(sessionId);
        this.state.setState(sessionId, 'company_main_menu', 'selection');
        return this.sendListMessage(
            sock, fullId,
            `*Espace Entreprise* 🏢\n\nBonjour *${company.name}*\n\n🔢 Votre code marchand : *${company.merchant_code}*\n\nQue souhaitez-vous faire ?`,
            'AfrikMoney — Entreprise',
            'Voir les options',
            [
                { label: '🌐 Mon espace web', id: '1', description: 'Accéder à votre tableau de bord' },
                { label: '🛠️ Ajouter un service', id: '2', description: 'Créer un nouveau service' },
                { label: '📋 Mes services', id: '3', description: 'Voir vos services existants' },
                { label: '✅ Statut de vérification', id: '4', description: 'Savoir si votre compte est validé' },
                { label: '❓ Besoin d\'aide', id: '5', description: 'Support et assistance' },
            ]
        );
    }

    async handleCompanyMenu(sock, fullId, text, sessionId) {
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;

        switch (text) {
            case '1':
                return this._sendDashboardLink(sock, fullId, userId);
            case '2':
                return this.startServiceSetup(sock, fullId, sessionId);
            case '3':
                return this._showServices(sock, fullId, userId);
            case '4':
                return this._showVerificationStatus(sock, fullId, userId);
            case '5':
                return this.sendMessage(sock, fullId,
                    "Pour toute question, contactez le support AfrikMoney au +229 XX XX XX XX ou par email à support@afrikmoney.com.\n\nTapez *0* pour revenir au menu."
                );
            default:
                return this.sendMessage(sock, fullId, 'Choix invalide. Sélectionnez une option dans la liste, ou tapez *0* pour revenir.');
        }
    }

    async _sendDashboardLink(sock, fullId, userId) {
        try {
            const result = await this.companies.getDashboardLink(userId);
            const data = result?.data;
            if (!result.success || !data?.url) {
                return this.sendMessage(sock, fullId, 'Impossible de générer votre lien pour le moment. Tapez *0* pour revenir au menu.');
            }
            return this.sendNativeFlowMessage(
                sock, fullId,
                '*Mon espace web*\n\nCliquez sur le bouton ci-dessous pour accéder directement à votre tableau de bord. Le lien expire dans 1 heure.',
                'AfrikMoney — Entreprise',
                [
                    { label: 'Accéder à mon dashboard', url: data.url },
                    { label: 'Retour au menu', id: '0' },
                ]
            );
        } catch (err) {
            console.error('[CompanyHandler] Dashboard link error:', err.message);
            return this.sendMessage(sock, fullId, 'Une erreur est survenue. Tapez *0* pour revenir au menu.');
        }
    }

    async _showServices(sock, fullId, userId) {
        try {
            const result = await this.companies.getServices(userId);
            const services = result?.data?.data || [];
            if (!result.success || services.length === 0) {
                return this.sendMessage(sock, fullId, "Vous n'avez encore aucun service. Tapez *0* pour revenir au menu.");
            }
            const lines = services.map((s, i) => `${i + 1}. *${s.name}* (${s.type})`).join('\n');
            return this.sendMessage(sock, fullId, `*Vos services*\n\n${lines}\n\nTapez *0* pour revenir au menu.`);
        } catch (err) {
            console.error('[CompanyHandler] Services list error:', err.message);
            return this.sendMessage(sock, fullId, 'Une erreur est survenue. Tapez *0* pour revenir au menu.');
        }
    }

    async _showVerificationStatus(sock, fullId, userId) {
        const company = await this.auth.authenticateCompany(userId).catch(() => null);
        const text = company?.is_verified
            ? '✅ *Votre compte est vérifié.* Vous pouvez recevoir de vrais paiements.'
            : "⏳ *Votre compte est en attente de vérification.* La collecte de paiements réels reste désactivée jusqu'à ce qu'un administrateur valide votre compte.";
        const merchantCodeLine = company?.merchant_code ? `\n\n🔢 Votre code marchand : *${company.merchant_code}*` : '';
        return this.sendMessage(sock, fullId, `${text}${merchantCodeLine}\n\nTapez *0* pour revenir au menu.`);
    }
}

export default new CompanyHandler();
