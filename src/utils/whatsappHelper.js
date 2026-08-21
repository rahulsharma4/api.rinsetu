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
      .select('+whatsappAccessToken +whatsappPhoneNumberId +whatsappEnabled +whatsappTemplates');
      
    if (!adminUser || !adminUser.whatsappEnabled) {
      console.log(`ℹ️ WhatsApp automation is disabled or not configured for tenant: ${tenantId}`);
      return null;
    }

    const { whatsappAccessToken, whatsappPhoneNumberId, whatsappTemplates } = adminUser;
    if (!whatsappAccessToken || !whatsappPhoneNumberId) {
      console.warn(`⚠️ Meta API keys missing in WhatsApp settings for tenant: ${tenantId}`);
      return null;
    }

    // Get the template name registered for this key, fallback to default if not configured
    const templateName = whatsappTemplates?.get(templateKey) || templateKey;

    // 2. Format phone number to international format (Meta requires country code without +, e.g. 91XXXXXXXXXX)
    let cleanPhone = toPhone.replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = `91${cleanPhone}`;
    }

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
