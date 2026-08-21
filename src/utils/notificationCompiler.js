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
    }

    if (!template) {
      return null;
    }

    // Format metrics
    const formattedAmount = data.amount ? parseFloat(data.amount).toLocaleString('en-IN') : '0';
    const formattedOutstanding = data.outstanding ? parseFloat(data.outstanding).toLocaleString('en-IN') : '0';
    const formattedDate = data.dueDate ? new Date(data.dueDate).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN');
    
    let messageText = template
      .replace(/{{customerName}}/g, customer.name)
      .replace(/{{amount}}/g, formattedAmount)
      .replace(/{{dueDate}}/g, formattedDate)
      .replace(/{{loanId}}/g, loan._id.toString().slice(-6))
      .replace(/{{outstanding}}/g, formattedOutstanding);

    // Skip duplicates in queue
    const existing = await Notification.findOne({
      customerId,
      loanId,
      type: notificationType,
      status: 'pending',
      recipientPhone: customer.phone,
      messageText
    });

    if (existing) {
      return existing;
    }

    const notification = new Notification({
      customerId,
      loanId,
      type: notificationType,
      recipientPhone: customer.phone,
      messageText,
      status: 'pending'
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
        type === 'overdue_warning' ? 'overdueWarning' : type;

      const sentResult = await sendWhatsAppTemplate(
        loan.tenantId,
        customer.phone,
        templateKey,
        [customer.name, formattedAmount, formattedDate, loan._id.toString().slice(-6), formattedOutstanding]
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const threeDaysLater = new Date(today);
    threeDaysLater.setDate(today.getDate() + 3);

    // 1. Due Today Notifications
    const dueTodayInsts = await Installment.find({
      status: { $ne: 'paid' },
      dueDate: {
        $gte: today,
        $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
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
        $lt: new Date(threeDaysLater.getTime() + 24 * 60 * 60 * 1000)
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

    // 3. Overdue Warning Notifications (7-day throttle)
    const overdueInsts = await Installment.find({
      status: 'overdue'
    }).populate({
      path: 'loanId',
      populate: { path: 'customerId' }
    });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    for (const inst of overdueInsts) {
      if (inst.loanId && inst.loanId.customerId) {
        const customerId = inst.loanId.customerId._id;
        const loanId = inst.loanId._id;

        const recentNotification = await Notification.findOne({
          customerId,
          loanId,
          type: 'overdue_warning',
          createdAt: { $gte: sevenDaysAgo }
        });

        if (!recentNotification) {
          await queueNotification(
            customerId,
            loanId,
            'overdue_warning',
            { amount: inst.totalAmount - inst.amountPaid, dueDate: inst.dueDate }
          );
        }
      }
    }

    console.log('🔔 autoQueuePeriodicNotifications completed.');
  } catch (err) {
    console.error('Error during auto-queueing periodic notifications:', err.message);
  }
}
