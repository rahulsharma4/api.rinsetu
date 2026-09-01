import mongoose from 'mongoose';

const waSessionSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const WASession = mongoose.model('WASession', waSessionSchema);
export default WASession;
