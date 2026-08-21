import Razorpay from 'razorpay';

/**
 * Registers a new Linked Account (sub-merchant beneficiary) on the platform's central Razorpay account.
 * Used for automatic, instant routing of client payments to the Lender's bank account.
 *
 * @param {object} adminUser - MongoDB Admin User document
 * @param {object} bankDetails - { accountNumber, ifsc, beneficiaryName }
 * @returns {Promise<string|null>} - Returns the generated 'acc_xxxxxxxx' ID on success, or null on failure.
 */
export async function createRazorpayLinkedAccount(adminUser, bankDetails) {
  const masterKeyId = process.env.RAZORPAY_KEY_ID;
  const masterKeySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!masterKeyId || !masterKeySecret) {
    console.warn('⚠️ Master Razorpay credentials not configured in backend .env file. Automatic linking bypassed.');
    return null;
  }

  try {
    const rzp = new Razorpay({ key_id: masterKeyId, key_secret: masterKeySecret });

    const email = adminUser.email || 'lender@rinsetu.com';
    const phone = adminUser.phone || '9999999999';
    const businessName = (adminUser.businessName || adminUser.name || 'Lender Business').slice(0, 40);

    console.log(`🔄 Contacting Razorpay API to register Linked Account for "${businessName}"...`);

    const accountResponse = await rzp.accounts.create({
      email: email,
      phone: phone,
      legal_business_name: businessName,
      business_type: 'individual',
      contact_name: adminUser.name || 'Lender Admin',
      profile: {
        category: 'financial_services',
        subcategory: 'lending',
        addresses: {
          registered: {
            street: 'Main Street',
            city: 'Delhi',
            state: 'DL',
            postal_code: '110001',
            country: 'IN'
          }
        }
      },
      bank_account: {
        ifsc_code: bankDetails.ifsc.trim().toUpperCase(),
        beneficiary_name: bankDetails.beneficiaryName.trim(),
        account_number: bankDetails.accountNumber.trim()
      }
    });

    console.log(`✅ Sub-merchant Linked Account created successfully on Razorpay: ${accountResponse.id}`);
    return accountResponse.id;
  } catch (error) {
    console.error('❌ Razorpay Accounts API error during Linked Account creation:', error.response?.data || error.message);
    return null;
  }
}
