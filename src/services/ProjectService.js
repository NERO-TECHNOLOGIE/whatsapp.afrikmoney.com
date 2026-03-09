import httpClient from './http/HttpClient.js';

/**
 * ProjectService - Manages user payment plan projects.
 *
 * Single Responsibility: Fetching and creating payment plan projects.
 */
class ProjectService {

    /**
     * Get all projects for a user.
     *
     * @param {string} whatsappId - User's normalized WhatsApp ID (for auth)
     * @returns {Promise<Array>} List of project objects
     */
    async getProjects(whatsappId) {
        const result = await httpClient.request('GET', '/afrik/projects', null, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Failed to fetch projects: ${result.error?.message}`);
    }

    /**
     * Create a new payment plan project.
     *
     * @param {Object} projectData - { service_id, name, target_amount, amount, frequency, ... }
     * @param {string} whatsappId - User's normalized WhatsApp ID (for auth)
     * @returns {Promise<Object>} Created project
     */
    async createProject(projectData, whatsappId) {
        console.log(`[ProjectService] Creating project for ${whatsappId}:`, JSON.stringify(projectData, null, 2));
        const result = await httpClient.request('POST', '/afrik/projects/create', projectData, whatsappId);
        if (result.success) return result.project;
        throw new Error(result.message || `Failed to create project: ${JSON.stringify(result.error)}`);
    }
}

export default new ProjectService();
