import cron from 'node-cron';
import { updateOverdueStatuses } from './overdueTracker.js';
import { applyLateFees } from './lateFeeEngine.js';
import { autoQueuePeriodicNotifications } from './notificationCompiler.js';
import AutomationLog from '../models/AutomationLog.js';

export async function runDailyAccrualJob() {
  console.log('⏰ Running daily interest accrual and late fee cron job...');
  const startTime = new Date();
  
  try {
    // 1. Update overdue statuses of installments & loans
    await updateOverdueStatuses();
    
    // 2. Apply late fees
    const lateFeeRes = await applyLateFees();

    // 3. Queue periodic notifications
    await autoQueuePeriodicNotifications();
    
    const endTime = new Date();
    const durationMs = endTime - startTime;
    
    // Log automation success in database
    await AutomationLog.create({
      eventTrigger: 'daily_cron_job',
      status: 'success',
      executionTimeMs: durationMs,
      details: `Cron run complete. Overdue checked. Late fee applied: ${lateFeeRes.appliedCount} accounts updated, total charges: ₹${lateFeeRes.totalFeeAdded}`
    });
    
    console.log('✅ Daily cron job completed successfully.');
    return { success: true, ...lateFeeRes };
  } catch (error) {
    console.error('❌ Daily cron job failed:', error);
    const endTime = new Date();
    await AutomationLog.create({
      eventTrigger: 'daily_cron_job',
      status: 'failed',
      executionTimeMs: endTime - startTime,
      details: `Cron run failed: ${error.message}`
    });
    return { success: false, error: error.message };
  }
}

export function startCronEngine() {
  // Run every night at 12:00 AM (0 0 * * *)
  cron.schedule('0 0 * * *', async () => {
    await runDailyAccrualJob();
  });
  console.log('🚀 node-cron scheduler engine initialized: Scheduled to run every night at 12:00 AM.');
}
