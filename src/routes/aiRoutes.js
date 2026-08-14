import express from 'express';
import axios from 'axios';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';

const router = express.Router();

/**
 * Helper to fetch database summary for the AI context.
 */
async function getSystemContextSummary(tenantId) {
  const customers = await Customer.find({ tenantId });
  const loans = await Loan.find({ tenantId }).populate('customerId');
  const transactions = await Transaction.find({ tenantId }).populate('customerId');
  
  const loanIds = loans.map(l => l._id);
  const installments = await Installment.find({ loanId: { $in: loanIds } });

  const activeLoans = loans.filter(l => l.status === 'active');
  const overdueLoans = loans.filter(l => l.status === 'overdue');
  
  const totalPrincipalLent = loans.reduce((acc, l) => acc + l.principalAmount, 0);
  const totalReceived = transactions.reduce((acc, t) => acc + t.amount, 0);

  // Overdue details
  const overdueInstallments = installments.filter(i => i.status === 'overdue');
  const totalOverdueAmount = overdueInstallments.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

  // Group overdue by customer
  const overdueCustomersList = overdueLoans.map(l => ({
    name: l.customerId?.name,
    phone: l.customerId?.phone,
    principal: l.principalAmount,
    remarks: l.remarks
  }));

  return {
    totalCustomersCount: customers.length,
    activeLoansCount: activeLoans.length,
    overdueLoansCount: overdueLoans.length,
    totalPrincipalLent,
    totalReceived,
    totalOverdueAmount,
    overdueCustomersList,
    systemDate: new Date().toLocaleDateString('en-IN')
  };
}

// 1. Dashboard AI Assistant Chat
router.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ message: 'Message is required' });
  }

  try {
    const summary = await getSystemContextSummary(req.admin.tenantId);
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
      // Direct call to Gemini API
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const systemPrompt = `You are a helpful Hinglish AI assistant for a money lender's CRM called "RinSetu".
Here is the current state of the lender's database:
- Total Customers: ${summary.totalCustomersCount}
- Active Loans: ${summary.activeLoansCount}
- Overdue Loans: ${summary.overdueLoansCount}
- Total Capital Disbursed: ₹${summary.totalPrincipalLent}
- Total Repayments Received: ₹${summary.totalReceived}
- Total Overdue Outstanding: ₹${summary.totalOverdueAmount}
- Overdue Borrowers: ${JSON.stringify(summary.overdueCustomersList)}
- Today's Date: ${summary.systemDate}

The lender is asking: "${message}"
Please answer in a short, friendly, business-focused manner in a mix of Hindi and English (Hinglish). Use the exact figures provided in the summary above to answer the query. Do not do any calculations yourself; use the data. Keep it under 100 words.`;

      const response = await axios.post(geminiUrl, {
        contents: [{ parts: [{ text: systemPrompt }] }]
      });

      const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Mafi chahta hu, mai abhi response generate nahi kar pa raha hu.";
      return res.json({ reply });
    } else {
      // NLP Fallback Engine (Keyword matching)
      const text = message.toLowerCase();
      let reply = "";

      if (text.includes('overdue') || text.includes('baki') || text.includes('nuksan') || text.includes('late')) {
        reply = `Sir, abhi system me total **${summary.overdueLoansCount} loans overdue** chal rahe hain. Kul overdue amount **₹${summary.totalOverdueAmount.toLocaleString('en-IN')}** hai. Overdue list me main borrowers: ${summary.overdueCustomersList.map(c => c.name).join(', ') || 'None'} hain.`;
      } else if (text.includes('aaj') || text.includes('collection') || text.includes('due') || text.includes('aana')) {
        reply = `Aaj ki summary: Total active accounts **${summary.activeLoansCount}** hain. System me aaj expected recovery check karne ke liye Collections tab me 'Today's Due' dekhein. Abhi tak hume total **₹${summary.totalReceived.toLocaleString('en-IN')}** received ho chuke hain.`;
      } else if (text.includes('profit') || text.includes('kamai') || text.includes('byaj') || text.includes('interest')) {
        reply = `Sir, abhi tak total disbursed capital **₹${summary.totalPrincipalLent.toLocaleString('en-IN')}** hai. Kul repayment amount **₹${summary.totalReceived.toLocaleString('en-IN')}** collect ho chuka hai.`;
      } else {
        reply = `Namaste! Mai RinSetu ka AI Assistant hu. Aap mujhse overdue clients, total collections, ya business profit se jude sawal puch sakte hain. (e.g. "Kitne log overdue hain?")`;
      }

      return res.json({ reply });
    }
  } catch (error) {
    console.error('AI Chat Error:', error.message);
    res.status(500).json({ reply: 'AI server processing error. Kripya bad me try karein.' });
  }
});

// 2. Draft WhatsApp Reminder
router.post('/draft-reminder', async (req, res) => {
  const { customerId, loanId } = req.body;

  try {
    const customer = await Customer.findOne({ _id: customerId, tenantId: req.admin.tenantId });
    const loan = await Loan.findOne({ _id: loanId, tenantId: req.admin.tenantId });
    
    if (!customer || !loan) {
      return res.status(404).json({ message: 'Customer or Loan not found' });
    }

    // Get overdue installments
    const overdueInst = await Installment.find({ loanId, status: 'overdue' });
    const overdueAmount = overdueInst.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

    const apiKey = process.env.GEMINI_API_KEY;
    const defaultTemplate = `Namaste ${customer.name} ji,\n\nAapka RinSetu account par active loan ka overdue amount *₹${overdueAmount.toLocaleString('en-IN')}* ho chuka hai. Kripya iska bhugtan jald se jald karein taaki penalty charges na lagein.\n\nRegards,\nRinSetu Admin`;

    if (apiKey && overdueAmount > 0) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const prompt = `Write a short, polite, yet professional WhatsApp payment reminder message in Hindi (written in English script / Hinglish) for a borrower.
Details:
- Borrower Name: ${customer.name}
- Overdue Amount: ₹${overdueAmount}
- Core request: Pay as soon as possible to avoid status issues.
Output only the message text, no other formatting.`;

      const response = await axios.post(geminiUrl, {
        contents: [{ parts: [{ text: prompt }] }]
      });

      const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || defaultTemplate;
      return res.json({ message: reply.trim() });
    } else {
      return res.json({ message: defaultTemplate });
    }
  } catch (error) {
    console.error('Reminder Draft Error:', error.message);
    res.status(500).json({ message: 'Error drafting reminder.' });
  }
});

// 3. Document OCR Scanner Mockup
router.post('/ocr', async (req, res) => {
  // Simulate processing an uploaded document (e.g. Aadhar card)
  setTimeout(() => {
    return res.json({
      success: true,
      documentType: 'Aadhar Card',
      extractedData: {
        name: 'Rahul Sharma',
        dob: '12/10/1996',
        gender: 'Male',
        address: '22 Civil Lines, Sector 5, Jaipur, Rajasthan'
      }
    });
  }, 1000); // 1-second process simulation delay
});

// 4. GET /api/ai/credit-risk/:customerId - AI Borrower Credit & Default Risk Analysis
router.get('/credit-risk/:customerId', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.customerId, tenantId: req.admin.tenantId });
    if (!customer) {
      return res.status(404).json({ message: 'Borrower file not found.' });
    }

    const loans = await Loan.find({ customerId: customer._id, tenantId: req.admin.tenantId });
    const installments = await Installment.find({ loanId: { $in: loans.map(l => l._id) } });
    const transactions = await Transaction.find({ customerId: customer._id, tenantId: req.admin.tenantId });

    const activeLoans = loans.filter(l => l.status === 'active' || l.status === 'overdue');
    const overdueLoans = loans.filter(l => l.status === 'overdue');
    const repaymentsSum = transactions.reduce((acc, t) => acc + t.amount, 0);
    
    const overdueInsts = installments.filter(i => i.status === 'overdue');
    const overdueSum = overdueInsts.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const prompt = `Perform a money lending credit risk assessment for borrower:
Customer Details:
- Name: ${customer.name}
- Collateral Assets: ${customer.collateralType} (Valued at: ₹${customer.collateralValue || 0})
- Guarantor backing: ${customer.guarantorName ? 'Yes (' + customer.guarantorName + ')' : 'No'}
- Total Loans: ${loans.length}
- Active Loans: ${activeLoans.length}
- Overdue Loans: ${overdueLoans.length}
- Overdue Balance: ₹${overdueSum}
- Total Repayments Received: ₹${repaymentsSum}

Based on this, return a JSON response containing:
1. "creditScore": number (300 to 900)
2. "riskRating": string ("LOW" | "MEDIUM" | "HIGH")
3. "riskFactors": array of 3 brief Hinglish bullet points (explaining delayed payments, lack of collateral, or positive guarantor status)
4. "advice": 2 sentences of actionable lending advice in Hinglish.

Return ONLY raw JSON. No markdown formatting, no backticks, no comments.`;

      const response = await axios.post(geminiUrl, {
        contents: [{ parts: [{ text: prompt }] }]
      });

      const rawReply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      try {
        const cleanJson = rawReply.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJson);
        return res.json(parsed);
      } catch (err) {
        console.warn('Gemini JSON parse failed, falling back to algorithmic calculation.', err.message);
      }
    }

    // Algorithmic Fallback Engine
    let score = 650;
    let rating = 'LOW';
    let factors = [];
    let advice = '';

    if (overdueLoans.length > 0) {
      score -= 120;
      rating = 'HIGH';
      factors.push('Overdue accounts aur past-due installments database me register hain.');
      factors.push(`Borrower par ₹${overdueSum.toLocaleString('en-IN')} ka delay fine outstanding balance hai.`);
    } else if (activeLoans.length > 0) {
      score += 50;
      rating = 'MEDIUM';
      factors.push('Account active hai aur sabhi payment timestamps normal chal rahe hain.');
    } else {
      score += 100;
      rating = 'LOW';
      factors.push('Naya file profile hai, koi historical payment delay nahi mila.');
    }

    if (customer.collateralType !== 'None') {
      score += 40;
      factors.push(`Collateral details register hain: "${customer.collateralType}" (Value: ₹${customer.collateralValue || 0}).`);
    } else {
      score -= 30;
      factors.push('Bina collateral asset register kiye loan open kiya gaya hai.');
    }

    if (customer.guarantorName) {
      score += 30;
      factors.push(`Security verification ke liye guarantor "${customer.guarantorName}" aligned hai.`);
    } else {
      factors.push('Ledger me security guarantor details register nahi hain.');
    }

    score = Math.max(300, Math.min(900, score));
    if (score < 550) rating = 'HIGH';
    else if (score < 720) rating = 'MEDIUM';
    else rating = 'LOW';

    if (rating === 'HIGH') {
      advice = 'Inhe naya capital disburse na karein. Pehle pending overdue collection recoveries complete karein.';
    } else if (rating === 'MEDIUM') {
      advice = 'Disbursement risk control me hai. Future loans par heavy gold/silver assets limit enforce karein.';
    } else {
      advice = 'Clean repayment ledger record. Disbursed loans can be safely extended up to verified guarantor limits.';
    }

    return res.json({
      creditScore: score,
      riskRating: rating,
      riskFactors: factors.slice(0, 3),
      advice
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
