import stateService from './StateService.js';

class NavigationService {
    /**
     * Get the WhatsApp ID from state if we need it for auth
     */
    _getWhatsAppId(from) {
        return from;
    }

    /**
     * Format projects list as text with progress bars
     */
    formatProjectsList(projects) {
        if (!projects || projects.length === 0) {
            return "Vos projets :\n\nVous n'avez aucun projet pour le moment.\n\nLes projets vous permettent de créer des plans de paiement automatiques.\n\nTapez 5 pour créer votre premier projet !";
        }

        let text = "Vos projets :\n";
        projects.forEach((v, index) => {
            const progress = v.target_amount > 0 ? (v.current_amount / v.target_amount) * 100 : 0;
            const bar = this._generateProgressBar(progress);
            const remaining = Math.max(0, v.target_amount - v.current_amount);

            text += `${index + 1}. ${v.name}\n`;
            text += `   ${bar} ${progress.toFixed(0)}%\n`;
            text += `   Total : ${v.target_amount} FCFA\n`;
            text += `   Payé  : ${v.current_amount} FCFA\n`;
            text += `   Reste : ${remaining} FCFA\n`;
            text += `   Date de fin : ${v.next_payment || 'N/A'}\n\n`;
        });
        text += "Tapez :\n-Le numéro du projet pour voir plus de détails\n-0 pour revenir au menu principal";
        return text;
    }

    /**
     * Format Support Menu
     */
    formatSupportMenu() {
        let text = "Centre d’assistance AfrikMoney\n";
        text += "Nous sommes là pour vous aider\n";
        text += "Que souhaitez-vous faire ?\n\n";
        text += "1️-FAQ – Questions fréquentes\n";
        text += "2️-Contacter un conseiller\n";
        text += "3️-Signaler un problème\n\n";
        text += "Liens utiles :\n";
        text += "Guide d’utilisation : https://afrikmoney.com/guide\n";
        text += "Tarifs : https://afrikmoney.com/tarifs\n\n";
        text += "Tapez :\n- Le numéro de votre choix\n-0 pour revenir au menu principal";
        return text;
    }

    /**
     * Helper to generate a text-based progress bar
     */
    _generateProgressBar(percent) {
        const size = 10;
        const dots = Math.round((percent / 100) * size);
        const emptyDots = size - dots;

        const filledBar = "█".repeat(Math.max(0, dots));
        const emptyBar = "░".repeat(Math.max(0, emptyDots));

        return `[${filledBar}${emptyBar}]`;
    }

    /**
     * Format payment history as text
     */
    formatHistoryList(history) {
        if (!history || history.length === 0) {
            return "Historique des paiements :\n\nAucune transaction trouvée.";
        }

        let text = "Vos derniers paiements\n";
        history.slice(0, 10).forEach((t, index) => {
            const date = new Date(t.created_at).toLocaleDateString('fr-FR');
            const statusLabel = t.status === 'SUCCESS' ? 'Réussi' : (t.status === 'FAILED' ? 'Échoué' : t.status);
            text += `${index + 1} - ${date}\n`;
            text += `${t.amount} FCFA – ${t.note || 'Paiement'}\n`;
            text += `Statut : ${statusLabel}\n\n`;
        });
        text += "Tapez :\n-0 pour revenir au menu principal";
        return text;
    }
}

export default new NavigationService();