import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Notification from './src/models/Notification.js';

dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const pending = await Notification.find({ status: 'pending' }).populate('customerId');
  console.log(`Found ${pending.length} pending notifications`);
  pending.forEach(p => {
    console.log(`To: ${p.recipientPhone}, Type: ${p.type}, Date: ${p.createdAt}`);
  });
  process.exit(0);
}
check();
