import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import httpClient from './http/HttpClient.js';

const _assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');

/**
 * CompanyService - API calls for the company/merchant side of the bot
 * (service creation, dashboard link, service listing).
 *
 * Distinct from api.afrikmoney.com's own PHP "CompanyService" domain class —
 * same name, different codebase/language, no relation.
 */
class CompanyService {

    /**
     * Create the company's first (or an additional) service/offering.
     * The backend requires a real uploaded image for `thumbnail` — the bot
     * has no per-merchant photo yet, so it ships a bundled default.
     *
     * @param {{name: string, type: string, description?: string}} data
     * @param {string} whatsappId - Caller's WhatsApp ID (for auth token)
     */
    async createService(data, whatsappId) {
        const form = new FormData();
        form.append('name', data.name);
        form.append('type', data.type);
        if (data.description) form.append('description', data.description);

        const thumbnail = this._loadDefaultThumbnail();
        if (thumbnail) {
            form.append('thumbnail', thumbnail, { filename: 'thumbnail.jpg', contentType: 'image/jpeg' });
        }

        return httpClient.request('POST', '/company-services', form, whatsappId, true);
    }

    /**
     * List the authenticated company's own services.
     * @param {string} whatsappId
     */
    async getServices(whatsappId) {
        return httpClient.request('GET', '/company-services', null, whatsappId);
    }

    /**
     * Generate a personalized magic link to the company's web dashboard
     * (same mechanism as the client dashboard link).
     * @param {string} whatsappId
     */
    async getDashboardLink(whatsappId) {
        return httpClient.request('GET', '/bot/company-dashboard-link', null, whatsappId);
    }

    _loadDefaultThumbnail() {
        try {
            const p = path.join(_assetsDir, 'default-service-thumbnail.jpg');
            if (fs.existsSync(p)) return fs.readFileSync(p);
        } catch { /* no bundled asset, request goes out without a thumbnail */ }
        return null;
    }
}

export default new CompanyService();
