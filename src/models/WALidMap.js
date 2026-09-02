import mongoose from 'mongoose';

// Stores WhatsApp @lid JID to phone number mapping
// Needed for WhatsApp multi-device protocol v2 where JIDs are internal IDs, not phone numbers
const waLidMapSchema = new mongoose.Schema(
  {
    lid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    phoneJid: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const WALidMap = mongoose.model('WALidMap', waLidMapSchema);
export default WALidMap;
