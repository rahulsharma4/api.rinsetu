import axios from 'axios';
import User from '../models/User.js';

/**
 * Sends a WhatsApp Template message using Meta WhatsApp Cloud API.
 * @param {string} tenantId - The lender admin ID.
 * @param {string} toPhone - The recipient's phone number.
 * @param {string} templateKey - The template key ('upcomingDue' | 'dueToday' | 'paymentReceived' | 'overdueWarning').
 * @param {Array<string>} bodyParams - Array of string values for template variables {{1}}, {{2}}, etc.
 */
export async function sendWhatsAppTemplate(tenantId, toPhone, templateKey, bodyParams = []) {
  try {
    // 1. Fetch Admin's WhatsApp Credentials
    const adminUser = await User.findById(tenantId)
      .select('+whatsappAccessToken +whatsappPhoneNumberId +whatsappEnabled +whatsappTemplates +whatsappMode');
      
    if (!adminUser || !adminUser.whatsappEnabled) {
      console.log(`ℹ️ WhatsApp automation is disabled or not configured for tenant: ${tenantId}`);
      return null;
    }

    const whatsappMode = adminUser.whatsappMode || 'manual';

    if (whatsappMode === 'manual') {
      console.log(`ℹ️ WhatsApp mode is set to Manual. Server-side auto message skipped.`);
      return null;
    }

    // 2. Format phone number to international format (e.g. 91XXXXXXXXXX)
    let cleanPhone = toPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = `91${cleanPhone}`;
    }

    // 3. Automated Local QR Gateway (Baileys)
    if (whatsappMode === 'automated_qr') {
      const templateText = adminUser.whatsappTemplates?.get(templateKey);
      if (!templateText) {
        console.warn(`⚠️ Template not found for key: ${templateKey}`);
        return null;
      }

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const paymentLink = `${frontendUrl}/pay/loan/${bodyParams[3] || ''}`;

      const messageText = templateText
        .replace(/{{customerName}}/g, bodyParams[0] || '')
        .replace(/{{amount}}/g, bodyParams[1] || '')
        .replace(/{{dueDate}}/g, bodyParams[2] || '')
        .replace(/{{loanId}}/g, (bodyParams[3] || '').slice(-6))
        .replace(/{{paymentLink}}/g, paymentLink)
        .replace(/{{outstanding}}/g, bodyParams[4] || '');

      const { sendWhatsAppMessage } = await import('./whatsappService.js');
      const success = await sendWhatsAppMessage(cleanPhone, messageText);
      
      if (success) {
        return { success: true, gateway: 'local_qr' };
      }
      return null;
    }

    // 4. Cloud API Mode (Meta)
    const { whatsappAccessToken, whatsappPhoneNumberId, whatsappTemplates } = adminUser;
    if (!whatsappAccessToken || !whatsappPhoneNumberId) {
      console.warn(`⚠️ Meta API keys missing in WhatsApp settings for tenant: ${tenantId}`);
      return null;
    }

    // Get the template name registered for this key, fallback to default if not configured
    const templateName = whatsappTemplates?.get(templateKey) || templateKey;

    const url = `https://graph.facebook.com/v17.0/${whatsappPhoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${whatsappAccessToken}`,
      'Content-Type': 'application/json',
    };

    const parameters = bodyParams.map(param => ({
      type: 'text',
      text: String(param),
    }));

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: 'en_US', // Standard language code
        },
        components: [
          {
            type: 'body',
            parameters: parameters,
          },
        ],
      },
    };

    console.log(`🔄 Sending Meta WhatsApp Template message to ${cleanPhone}...`);
    const response = await axios.post(url, data, { headers });
    console.log(`✅ WhatsApp template "${templateName}" sent. Meta ID:`, response.data?.messages?.[0]?.id);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to send WhatsApp via Meta API:', error.response?.data || error.message);
    return null;
  }
}
