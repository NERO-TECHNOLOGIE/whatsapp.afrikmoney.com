// Même liste que CompanyServiceComponent.vue (espace entreprise du site web) —
// les valeurs (id) doivent rester identiques à celles envoyées par le formulaire
// web pour que les services créés depuis le bot ou depuis le site soient cohérents.
// Partagée entre CompanyHandler (création de service) et PaymentHandler (motif
// d'un paiement marchand, sélectionné dans la liste plutôt que tapé en texte libre).
export const SERVICE_TYPES = [
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
