import apiService from './ApiService.js';
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
            return "Vos Projets :\n\nVous n'avez aucun projet pour le moment.\n\nLes projets vous permettent de creer des plans de paiement automatiques.\n\nTapez 5 pour creer votre premier projet !";
        }

        let text = "Vos Projets :\n\n";
        projects.forEach((v, index) => {
            const progress = v.target_amount > 0 ? (v.current_amount / v.target_amount) * 100 : 0;
            const bar = this._generateProgressBar(progress);

            text += `${index + 1}. ${v.name}\n`;
            text += `   ${bar} ${progress.toFixed(0)}%\n`;
            text += `   Montant: ${v.current_amount} / ${v.target_amount} FCFA\n`;
            text += `   Echeance: ${v.next_payment || 'N/A'}\n\n`;
        });
        text += "Tapez le numéro pour les détails, 5 pour créer un projet ou 0 pour quitter";
        return text;
    }

    /**
     * Format Support Menu
     */
    formatSupportMenu() {
        let text = "Centre d'Assistance Afrikmoney\n\n";
        text += "Comment pouvons-nous vous aider ?\n\n";
        text += "1-*FAQ* : Questions Frequentes\n";
        text += "2-*Contact* : Parler a un conseiller\n";
        text += "3-*Plainte* : Signaler un probleme\n\n";
        text += "Liens Rapides :\n";
        text += "- Guide : https://afrikmoney.com/guide\n";
        text += "- Tarifs : https://afrikmoney.com/tarifs\n\n";
        text += "Répondez avec le numéro correspondant ou *0* pour revenir.";
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
            return "Historique des Paiements :\n\nAucune transaction trouvée.";
        }

        let text = "Vos 10 dernieres transactions :\n\n";
        history.slice(0, 10).forEach((t, index) => {
            const date = new Date(t.created_at).toLocaleDateString();
            text += `${index + 1}. [${date}] ${t.amount} FCFA\n`;
            text += `   Lieu: ${t.note || 'Paiement Marchand'}\n`;
            text += `   Statut: ${t.status}\n\n`;
        });
        text += "\nTapez 0 pour revenir au menu principal";
        return text;
    }
}

export default new NavigationService();