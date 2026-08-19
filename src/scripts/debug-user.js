import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();

async function debugUser() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('DB connected!');
  const users = await User.find({}).select('+gatewayKeyId +gatewayKeySecret +gatewayWebhookSecret');
  console.log('Users in database:');
  console.log(JSON.stringify(users, null, 2));
  process.exit(0);
}

debugUser();
