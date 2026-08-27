import express from 'express';
import axios from 'axios';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';
import Installment from '../models/Installment.js';
import Transaction from '../models/Transaction.js';
import CashBook from '../models/CashBook.js';

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

  const tenantId = req.admin.tenantId;
  const lowerMsg = message.toLowerCase();

  try {
    let reply = "";

    if (lowerMsg.includes('expected') || lowerMsg.includes('collection expected') || lowerMsg.includes('recovery')) {
      // 1. Expected collection calculation
      const startOfToday = new Date();
      startOfToday.setHours(0,0,0,0);
      const endOfToday = new Date();
      endOfToday.setHours(23,59,59,999);
      
      const loans = await Loan.find({ tenantId });
      const loanIds = loans.map(l => l._id);
      const todaysInstallments = await Installment.find({
        loanId: { $in: loanIds },
        dueDate: { $gte: startOfToday, $lte: endOfToday }
      });

      const expectedToday = todaysInstallments.reduce((acc, i) => acc + i.totalAmount, 0);
      const paidToday = todaysInstallments.reduce((acc, i) => acc + i.amountPaid, 0);
      const pendingToday = Math.max(0, expectedToday - paidToday);

      reply = `Sir, aaj ka total expected collection **₹${expectedToday.toLocaleString('en-IN')}** hai. Isme se abhi tak **₹${paidToday.toLocaleString('en-IN')}** collect ho chuka hai, aur **₹${pendingToday.toLocaleString('en-IN')}** expected collection pending chal raha hai.`;

    } else if (lowerMsg.includes('overdue') || lowerMsg.includes('check overdue') || lowerMsg.includes('baki')) {
      // 2. Overdue loans check
      const overdueLoans = await Loan.find({ tenantId, status: 'overdue' }).populate('customerId');
      const loanIds = overdueLoans.map(l => l._id);
      const overdueInsts = await Installment.find({ loanId: { $in: loanIds }, status: 'overdue' });
      
      const totalOverdue = overdueInsts.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);
      const uniqueNames = Array.from(new Set(overdueLoans.map(l => l.customerId?.name).filter(Boolean)));

      reply = `Sir, system me abhi total **${overdueLoans.length} accounts overdue** (विलंबित) chal rahe hain. Kul overdue outstanding amount **₹${totalOverdue.toLocaleString('en-IN')}** hai. Mukhya overdue clients me **${uniqueNames.slice(0, 5).join(', ') || 'koi nahi'}** shamil hain. Aap inke contacts check karke warning reminder bhej sakte hain.`;

    } else if (lowerMsg.includes('cash book') || lowerMsg.includes('cashbook') || lowerMsg.includes('balance')) {
      // 3. Cash Book balance
      const entries = await CashBook.find({ tenantId });
      let openingBalance = 0;
      let totalCollected = 0;
      let totalDisbursed = 0;
      let expenses = 0;

      entries.forEach(entry => {
        if (entry.type === 'opening_balance') {
          openingBalance += entry.amount;
        } else if (entry.type === 'collection' || entry.type === 'penalty_charge') {
          totalCollected += entry.amount;
        } else if (entry.type === 'disbursement') {
          totalDisbursed += entry.amount;
        } else if (entry.type === 'expense') {
          expenses += entry.amount;
        }
      });

      const closingBalance = openingBalance + totalCollected - totalDisbursed - expenses;

      reply = `Sir, aapke Cash Book ka current drawer balance details:
- Opening Balance: **₹${openingBalance.toLocaleString('en-IN')}**
- Total Collected: **₹${totalCollected.toLocaleString('en-IN')}**
- Total Disbursed: **₹${totalDisbursed.toLocaleString('en-IN')}**
- Total Expenses: **₹${expenses.toLocaleString('en-IN')}**
- **Net Cash Closing Balance: ₹${closingBalance.toLocaleString('en-IN')}**`;

    } else {
      // 4. Default user guide / instructions fallback
      reply = `Namaste! Mai RinSetu ka AI Assistant hu. 
Aap mujhse expected collections, overdue files, ya cash book balance se jude sawal preset options par click karke puch sakte hain. Kripya niche diye chips ko select karein.`;
    }

    res.json({ reply });
  } catch (error) {
    console.error('Calculated AI Chat Error:', error);
    res.status(500).json({ reply: 'Server local calculation error: ' + error.message });
  }
});

// 2. Draft WhatsApp Reminder
router.post('/draft-reminder', async (req, res) => {
  const { customerId, loanId, installmentId, type } = req.body;

  try {
    const User = (await import('../models/User.js')).default;
    const adminUser = await User.findById(req.admin.id).select('+whatsappTemplates');
    const customer = await Customer.findOne({ _id: customerId, tenantId: req.admin.tenantId });
    const loan = await Loan.findOne({ _id: loanId, tenantId: req.admin.tenantId });
    
    if (!customer || !loan) {
      return res.status(404).json({ message: 'Customer or Loan not found' });
    }

    // Get installment details
    let inst = null;
    if (installmentId) {
      const Installment = (await import('../models/Installment.js')).default;
      inst = await Installment.findById(installmentId);
    }

    const amountDue = inst ? Math.round(inst.totalAmount - inst.amountPaid) : 0;
    const dueDateStr = inst ? new Date(inst.dueDate).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN');

    // Get outstanding calculations
    const Installment = (await import('../models/Installment.js')).default;
    const insts = await Installment.find({ loanId });
    let totalInterestAccrued = 0;
    let totalInterestPaid = 0;
    let totalPrincipalPaid = 0;
    insts.forEach(i => {
      totalInterestAccrued += i.interestComponent;
      totalInterestPaid += i.interestPaid || 0;
      totalPrincipalPaid += i.principalPaid || 0;
    });
    const outstanding = Math.max(0, loan.principalAmount - totalPrincipalPaid) + Math.max(0, totalInterestAccrued - totalInterestPaid);

    // Build Payment link
    const host = req.headers.origin || req.headers.referer || 'https://rin-setu-jk8h-amber.vercel.app';
    const cleanHost = host.replace(/\/$/, '');
    const paymentLink = `${cleanHost}/pay/loan/${loanId}?am=${amountDue || Math.round(outstanding)}`;

    // Select custom template
    let templateKey = 'overdueWarning';
    if (type === 'today' || type === 'dueToday') templateKey = 'dueToday';
    else if (type === 'upcoming' || type === 'upcomingDue') templateKey = 'upcomingDue';
    else if (type === 'paymentReceived') templateKey = 'paymentReceived';

    let customTemplate = adminUser.whatsappTemplates ? adminUser.whatsappTemplates.get(templateKey) : null;

    if (customTemplate) {
      // Compile template placeholders
      let compiled = customTemplate
        .replace(/\{\{customerName\}\}/g, customer.name)
        .replace(/\{\{amount\}\}/g, (amountDue || Math.round(outstanding)).toLocaleString('en-IN'))
        .replace(/\{\{dueDate\}\}/g, dueDateStr)
        .replace(/\{\{outstanding\}\}/g, Math.round(outstanding).toLocaleString('en-IN'))
        .replace(/\{\{paymentLink\}\}/g, paymentLink);

      return res.json({ message: compiled });
    }

    // Default Fallbacks
    const overdueInst = await Installment.find({ loanId, status: 'overdue' });
    const overdueAmount = overdueInst.reduce((acc, i) => acc + (i.totalAmount - i.amountPaid), 0);

    const apiKey = process.env.GEMINI_API_KEY;
    const defaultTemplate = `Namaste ${customer.name} ji,\n\nAapka RinSetu account par active loan ka overdue amount *₹${overdueAmount.toLocaleString('en-IN')}* ho chuka hai. Kripya iska bhugtan jald se jald karein taaki penalty charges na lagein: ${paymentLink}\n\nRegards,\nAdmin`;

    if (apiKey && overdueAmount > 0) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const prompt = `Write a short, polite, yet professional WhatsApp payment reminder message in Hindi (written in English script / Hinglish) for a borrower.
Details:
- Borrower Name: ${customer.name}
- Overdue Amount: ₹${overdueAmount}
- Core request: Pay as soon as possible via this link: ${paymentLink} to avoid penalty status.
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
