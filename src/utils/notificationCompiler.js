import Settings from '../models/Settings.js';
import Notification from '../models/Notification.js';
import Customer from '../models/Customer.js';
import Loan from '../models/Loan.js';

/**
 * Compiles and queues a pending WhatsApp notification record.
 */
export async function queueNotification(customerId, loanId, type, data = {}) {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = new Settings();
      await settings.save();
    }

    if (!settings.whatsappAutomation) {
      console.log('🔌 WhatsApp Automation toggled OFF. Skipping notification queue.');
      return null;
    }

    const customer = await Customer.findById(customerId);
    const loan = await Loan.findById(loanId);
    if (!customer || !loan) {
      console.warn('Customer or Loan not found for queuing notification.');
      return null;
    }

    if (customer.enableWhatsappAutomation === false || loan.enableWhatsappAutomation === false) {
      console.log(`🔌 WhatsApp Automation disabled for borrower ${customer.name} or Loan ${loan._id}. Skipping message.`);
      return null;
    }

    let template = '';
    let notificationType = '';
    
    if (type === 'upcoming_due') {
      template = settings.whatsappTemplates.upcomingDue;
      notificationType = 'upcoming_due';
    } else if (type === 'due_today') {
      template = settings.whatsappTemplates.dueToday;
      notificationType = 'due_today';
    } else if (type === 'payment_received') {
      template = settings.whatsappTemplates.paymentReceived;
      notificationType = 'payment_received';
    } else if (type === 'overdue_warning') {
      template = settings.whatsappTemplates.overdueReminder;
      notificationType = 'overdue_warning';
    } else if (type === 'guarantor_warning') {
      template = settings.whatsappTemplates.guarantorWarning;
      notificationType = 'guarantor_warning';
    }

    if (!template) {
      return null;
    }

    // Format metrics
    const formattedAmount = data.amount ? parseFloat(data.amount).toLocaleString('en-IN') : '0';
    const formattedOutstanding = data.outstanding ? parseFloat(data.outstanding).toLocaleString('en-IN') : '0';
    const formattedDate = data.dueDate ? new Date(data.dueDate).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN');
    
    const frontendUrl = process.env.FRONTEND_URL || 'https://rin-setu-jk8h-amber.vercel.app';
    const paymentLink = `${frontendUrl}/pay/loan/${loan._id}`;

    let messageText = template
      .replace(/{{customerName}}/g, customer.name)
      .replace(/{{amount}}/g, formattedAmount)
      .replace(/{{dueDate}}/g, formattedDate)
      .replace(/{{loanId}}/g, loan._id.toString().slice(-6))
      .replace(/{{paymentLink}}/g, paymentLink)
      .replace(/{{outstanding}}/g, formattedOutstanding)
      .replace(/{{guarantorName}}/g, customer.guarantorName || 'Guarantor');

    const targetPhone = type === 'guarantor_warning' ? customer.guarantorPhone : customer.phone;
    if (!targetPhone) return null;

    // Skip duplicates in queue
    const existing = await Notification.findOne({
      customerId,
      loanId,
      type: notificationType,
      status: 'pending',
      recipientPhone: targetPhone,
      messageText
    });

    if (existing) {
      return existing;
    }

    const notification = new Notification({
      customerId,
      loanId,
      type: notificationType,
      recipientPhone: targetPhone,
      messageText,
      status: 'pending',
      tenantId: loan.tenantId,
    });

    await notification.save();
    console.log(`✉️ Queued WhatsApp message (${type}) for ${customer.name}.`);

    // Direct background Meta WhatsApp template send if enabled by this admin
    try {
      const { sendWhatsAppTemplate } = await import('./whatsappHelper.js');
      const templateKey = 
        type === 'upcoming_due' ? 'upcomingDue' :
        type === 'due_today' ? 'dueToday' :
        type === 'payment_received' ? 'paymentReceived' :
        type === 'overdue_warning' ? 'overdueWarning' : 
        type === 'guarantor_warning' ? 'guarantorWarning' : type;

      const sentResult = await sendWhatsAppTemplate(
        loan.tenantId,
        targetPhone,
        templateKey,
        [customer.name, formattedAmount, formattedDate, loan._id.toString().slice(-6), formattedOutstanding, customer.guarantorName || 'Guarantor']
      );

      if (sentResult) {
        notification.status = 'sent';
        await notification.save();
        console.log(`✉️ Automated WhatsApp message successfully sent via Meta for ${customer.name}.`);
      }
    } catch (wsErr) {
      console.error('Meta WhatsApp background trigger error:', wsErr.message);
    }

    return notification;

  } catch (err) {
    console.error('Error queuing notification:', err.message);
    return null;
  }
}

/**
 * Periodically auto-scans installments and queues WhatsApp reminders (Due Today, Upcoming 3 days, Overdue 7-day throttle).
 */
import Installment from '../models/Installment.js';

export async function autoQueuePeriodicNotifications() {
  try {
    // Determine the current date in IST (UTC+5:30)
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);

    // Start of current day in IST (Shifted back to UTC for MongoDB queries)
    const startOfDayIst = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0, 0));
    const startOfDay = new Date(startOfDayIst.getTime() - istOffset);

    // End of current day in IST (Shifted back to UTC)
    const endOfDayIst = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 23, 59, 59, 999));
    const endOfDay = new Date(endOfDayIst.getTime() - istOffset);

    // Three days later in IST
    const threeDaysLaterIst = new Date(startOfDayIst);
    threeDaysLaterIst.setUTCDate(threeDaysLaterIst.getUTCDate() + 3);
    const threeDaysLater = new Date(threeDaysLaterIst.getTime() - istOffset);
    const threeDaysLaterEnd = new Date(threeDaysLater.getTime() + 24 * 60 * 60 * 1000 - 1);

    // 1. Due Today Notifications (Scans installments due today)
    const dueTodayInsts = await Installment.find({
      status: { $ne: 'paid' },
      dueDate: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    }).populate({
      path: 'loanId',
      populate: { path: 'customerId' }
    });

    for (const inst of dueTodayInsts) {
      if (inst.loanId && inst.loanId.customerId) {
        await queueNotification(
          inst.loanId.customerId._id,
          inst.loanId._id,
          'due_today',
          { amount: inst.totalAmount - inst.amountPaid, dueDate: inst.dueDate }
        );
      }
    }

    // 2. Upcoming Due (3 Days Ahead) Notifications
    const upcomingInsts = await Installment.find({
      status: { $ne: 'paid' },
      dueDate: {
        $gte: threeDaysLater,
        $lte: threeDaysLaterEnd
      }
    }).populate({
      path: 'loanId',
      populate: { path: 'customerId' }
    });

    for (const inst of upcomingInsts) {
      if (inst.loanId && inst.loanId.customerId) {
        await queueNotification(
          inst.loanId.customerId._id,
          inst.loanId._id,
          'upcoming_due',
          { amount: inst.totalAmount - inst.amountPaid, dueDate: inst.dueDate }
        );
      }
    }

    // 3. Consolidated Overdue Notifications (Aggregates multiple unpaid/overdue installments into 1 single message)
    const overdueInsts = await Installment.find({
      status: 'overdue'
    }).populate({
      path: 'loanId',
      populate: { path: 'customerId' }
    });

    // Group overdue installments by loanId
    const overdueByLoan = {};
    for (const inst of overdueInsts) {
      if (inst.loanId && inst.loanId.customerId) {
        const lId = inst.loanId._id.toString();
        if (!overdueByLoan[lId]) {
          overdueByLoan[lId] = {
            loan: inst.loanId,
            customer: inst.loanId.customerId,
            totalOverdueAmount: 0,
            count: 0,
            oldestDueDate: inst.dueDate
          };
        }
        overdueByLoan[lId].totalOverdueAmount += (inst.totalAmount - inst.amountPaid);
        overdueByLoan[lId].count += 1;
        if (new Date(inst.dueDate) < new Date(overdueByLoan[lId].oldestDueDate)) {
          overdueByLoan[lId].oldestDueDate = inst.dueDate;
        }
      }
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    for (const loanIdStr of Object.keys(overdueByLoan)) {
      const { loan, customer, totalOverdueAmount, count, oldestDueDate } = overdueByLoan[loanIdStr];

      // Anti-Spam: Check if overdue reminder was queued/sent in last 7 days
      const recentNotification = await Notification.findOne({
        customerId: customer._id,
        loanId: loan._id,
        type: 'overdue_warning',
        createdAt: { $gte: sevenDaysAgo }
      });

      if (!recentNotification) {
        // Custom consolidated message for multiple pending installments
        const frontendUrl = process.env.FRONTEND_URL || 'https://rin-setu-jk8h-amber.vercel.app';
        const paymentLink = `${frontendUrl}/pay/loan/${loan._id}`;

        let messageText = '';
        if (count > 1) {
          messageText = `Namaste ${customer.name} ji, aapki kul ${count} kistein (Kul ₹${totalOverdueAmount.toLocaleString('en-IN')}) pichli tarikhon se baki hain. Penalty se bachne ke liye kripya bhugtan karein: ${paymentLink} - RinSetu`;
        } else {
          messageText = `Namaste ${customer.name} ji, aapki kist ₹${totalOverdueAmount.toLocaleString('en-IN')} overdue hai. Kripya is link se pay karein: ${paymentLink} - RinSetu`;
        }

        if (customer.enableWhatsappAutomation !== false && loan.enableWhatsappAutomation !== false) {
          const notification = new Notification({
            customerId: customer._id,
            loanId: loan._id,
            type: 'overdue_warning',
            recipientPhone: customer.phone,
            messageText,
            status: 'pending',
            tenantId: loan.tenantId
          });
          await notification.save();
          console.log(`✉️ Queued consolidated overdue reminder (${count} EMIs, ₹${totalOverdueAmount}) for ${customer.name}.`);
        }
      }

      // 4. Guarantor Warning Notice
      // If customer has 2 or more overdue installments and a guarantor is registered
      if (count >= 2 && customer.guarantorPhone) {
        const recentGuarantorNotice = await Notification.findOne({
          customerId: customer._id,
          loanId: loan._id,
          type: 'guarantor_warning',
          createdAt: { $gte: sevenDaysAgo } // Throttle to 1 per week
        });
        
        if (!recentGuarantorNotice && customer.enableWhatsappAutomation !== false && loan.enableWhatsappAutomation !== false) {
           await queueNotification(
             customer._id,
             loan._id,
             'guarantor_warning',
             { amount: totalOverdueAmount }
           );
           console.log(`✉️ Queued Guarantor Warning for ${customer.name}'s loan (Sent to ${customer.guarantorName}).`);
        }
      }
    }

    console.log('🔔 autoQueuePeriodicNotifications completed.');
    // Auto-flush pending queue after periodic scan
    await flushPendingNotifications();
  } catch (err) {
    console.error('Error during auto-queueing periodic notifications:', err.message);
  }
}

/**
 * Flushes and sends all 'pending' notifications for a tenant or globally when WhatsApp reconnects.
 * Features smart payment status check (skips if borrower paid in the meantime).
 */
export async function flushPendingNotifications(tenantId = null) {
  try {
    const query = { status: 'pending' };
    if (tenantId) query.tenantId = tenantId;

    const pendingList = await Notification.find(query).populate('customerId').populate('loanId');
    if (!pendingList || pendingList.length === 0) return { flushed: 0 };

    console.log(`🚀 Processing ${pendingList.length} pending WhatsApp notifications...`);
    let sentCount = 0;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    for (const notif of pendingList) {
      const customer = notif.customerId;
      const loan = notif.loanId;

      if (!customer || !loan) {
        notif.status = 'failed';
        await notif.save();
        continue;
      }

      // 1. Check client/loan automation toggles
      if (customer.enableWhatsappAutomation === false || loan.enableWhatsappAutomation === false) {
        notif.status = 'failed';
        await notif.save();
        console.log(`⏸️ Notification skipped for ${customer.name} (Automation toggled OFF).`);
        continue;
      }

      // 2. Real-Time Payment Verification: If all installments are settled, cancel obsolete notification!
      if (notif.type === 'due_today' || notif.type === 'upcoming_due' || notif.type === 'overdue_warning') {
        const activeUnpaidCount = await Installment.countDocuments({
          loanId: loan._id,
          status: { $in: ['unpaid', 'partially_paid', 'overdue'] }
        });

        if (activeUnpaidCount === 0) {
          notif.status = 'failed';
          await notif.save();
          console.log(`✅ Obsolete notification cancelled for ${customer.name} (Installments ALREADY PAID).`);
          continue;
        }
      }

      // 3. Single Message Per Day Anti-Spam Check: Don't send multiple reminders to same borrower today
      const alreadySentToday = await Notification.findOne({
        customerId: customer._id,
        status: 'sent',
        sentAt: { $gte: startOfDay },
        _id: { $ne: notif._id }
      });

      if (alreadySentToday && notif.type !== 'payment_received') {
        console.log(`⏳ Reminder for ${customer.name} deferred (Already received a reminder message today).`);
        continue;
      }

      try {
        let sentSuccess = false;
        
        // 1. Try local Baileys WhatsApp Gateway first
        try {
          const { sendWhatsAppMessage } = await import('./whatsappService.js');
          sentSuccess = await sendWhatsAppMessage(notif.recipientPhone, notif.messageText);
        } catch (_) {}

        // 2. Fallback to Meta Cloud API if local gateway is unavailable
        if (!sentSuccess) {
          const { sendWhatsAppTemplate } = await import('./whatsappHelper.js');
          const templateKey = 
            notif.type === 'upcoming_due' ? 'upcomingDue' :
            notif.type === 'due_today' ? 'dueToday' :
            notif.type === 'payment_received' ? 'paymentReceived' :
            notif.type === 'overdue_warning' ? 'overdueWarning' : notif.type;

          const sentResult = await sendWhatsAppTemplate(
            notif.tenantId || loan.tenantId,
            notif.recipientPhone,
            templateKey,
            [customer.name, '0', new Date().toLocaleDateString('en-IN'), loan._id.toString().slice(-6), '0']
          );
          if (sentResult) sentSuccess = true;
        }

        if (sentSuccess) {
          notif.status = 'sent';
          notif.sentAt = new Date();
          await notif.save();
          sentCount++;
          console.log(`✅ Dispatched reminder message to ${customer.name} (${customer.phone}).`);
        }
      } catch (err) {
        console.error('Flush notification item error:', err.message);
      }
    }

    console.log(`✅ Flushed and dispatched ${sentCount} pending notifications.`);
    return { flushed: sentCount };
  } catch (err) {
    console.error('Error in flushPendingNotifications:', err.message);
    return { flushed: 0, error: err.message };
  }
}
