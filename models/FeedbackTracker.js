const mongoose = require('mongoose');

// Email Template Schema - for customizable email templates
const EmailTemplateSchema = new mongoose.Schema({
  day: { type: Number, required: true, min: 1, max: 30 },
  subject: { type: String, required: true },
  htmlContent: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Email Schedule Schema - tracks individual email statuses
const EmailScheduleSchema = new mongoose.Schema({
  scheduledDate: { type: Date, required: true },
  sent: { type: Boolean, default: false },
  sentAt: { type: Date },
  error: { type: String },
  messageId: { type: String }, // For tracking via SendGrid
  opened: { type: Boolean, default: false },
  openCount: { type: Number, default: 0 },
  clicked: { type: Boolean, default: false }
}, { _id: false });

// Main Feedback Tracker Schema
const FeedbackTrackerSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  customerEmail: { type: String, required: true },
  customerName: { type: String, required: true },
  asin: { type: String },
  productName: { type: String },
  productUrl: { type: String },
  reviewUrl: { type: String },
  submissionDate: { type: Date, default: Date.now },
  emailSchedule: {
    day3: EmailScheduleSchema,
    day7: EmailScheduleSchema,
    day14: EmailScheduleSchema,
    day30: EmailScheduleSchema
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'unreviewed', 'cancelled'],
    default: 'pending'
  },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Static method to create scheduled dates
FeedbackTrackerSchema.statics.createScheduledDates = function(submissionDate) {
  const schedule = {};
  
  // Day 3 email
  const day3 = new Date(submissionDate);
  day3.setDate(day3.getDate() + 3);
  schedule.day3 = { scheduledDate: day3 };

  // Day 7 email
  const day7 = new Date(submissionDate);
  day7.setDate(day7.getDate() + 7);
  schedule.day7 = { scheduledDate: day7 };

  // Day 14 email
  const day14 = new Date(submissionDate);
  day14.setDate(day14.getDate() + 14);
  schedule.day14 = { scheduledDate: day14 };

  // Day 30 email
  const day30 = new Date(submissionDate);
  day30.setDate(day30.getDate() + 30);
  schedule.day30 = { scheduledDate: day30 };

  return schedule;
};

// Instance method to mark as reviewed
FeedbackTrackerSchema.methods.markAsReviewed = async function() {
  this.status = 'reviewed';
  this.isActive = false;
  this.updatedAt = new Date();
  return await this.save();
};

// Instance method to mark as unreviewed
FeedbackTrackerSchema.methods.markAsUnreviewed = async function() {
  this.status = 'unreviewed';
  this.isActive = false;
  this.updatedAt = new Date();
  return await this.save();
};

// Instance method to cancel tracking
FeedbackTrackerSchema.methods.cancelTracking = async function() {
  this.status = 'cancelled';
  this.isActive = false;
  this.updatedAt = new Date();
  return await this.save();
};

const FeedbackTracker = mongoose.model('FeedbackTracker', FeedbackTrackerSchema);
const EmailTemplate = mongoose.model('EmailTemplate', EmailTemplateSchema);

module.exports = FeedbackTracker;
module.exports.EmailTemplate = EmailTemplate;