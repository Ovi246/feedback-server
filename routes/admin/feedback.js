const express = require('express');
const router = express.Router();
const FeedbackTracker = require('../../models/FeedbackTracker');
const EmailTemplate = require('../../models/FeedbackTracker').EmailTemplate;

// Middleware to connect to database
const connectToDatabase = require('../../index').connectToDatabase;

// Get all feedback trackers
router.get('/feedback-trackers', async (req, res) => {
  try {
    await connectToDatabase();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const skip = (page - 1) * limit;

    const query = {};
    if (status) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { customerName: { $regex: search, $options: 'i' } },
        { customerEmail: { $regex: search, $options: 'i' } },
      ];
    }

    const [trackers, total] = await Promise.all([
      FeedbackTracker.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      FeedbackTracker.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        trackers,
        pagination: {
          total,
          page,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching feedback trackers:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching feedback trackers',
    });
  }
});

// Get feedback tracker by order ID
router.get('/feedback-trackers/:orderId', async (req, res) => {
  try {
    await connectToDatabase();
    
    const tracker = await FeedbackTracker.findOne({ orderId: req.params.orderId });
    
    if (!tracker) {
      return res.status(404).json({
        success: false,
        message: 'Feedback tracker not found',
      });
    }
    
    res.json({
      success: true,
      data: tracker,
    });
  } catch (error) {
    console.error('Error fetching feedback tracker:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching feedback tracker',
    });
  }
});

// Update feedback tracker status
router.patch('/feedback-trackers/:orderId/status', async (req, res) => {
  try {
    await connectToDatabase();
    
    const { status } = req.body;
    const tracker = await FeedbackTracker.findOne({ orderId: req.params.orderId });
    
    if (!tracker) {
      return res.status(404).json({
        success: false,
        message: 'Feedback tracker not found',
      });
    }
    
    if (['pending', 'reviewed', 'unreviewed', 'cancelled'].indexOf(status) === -1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status',
      });
    }
    
    if (status === 'reviewed') {
      await tracker.markAsReviewed();
    } else if (status === 'unreviewed') {
      await tracker.markAsUnreviewed();
    } else if (status === 'cancelled') {
      await tracker.cancelTracking();
    } else {
      tracker.status = status;
      tracker.updatedAt = new Date();
      await tracker.save();
    }
    
    res.json({
      success: true,
      message: 'Status updated successfully',
      data: tracker,
    });
  } catch (error) {
    console.error('Error updating feedback tracker status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating feedback tracker status',
    });
  }
});

// Get email templates
router.get('/email-templates', async (req, res) => {
  try {
    await connectToDatabase();
    
    const templates = await EmailTemplate.find({}).sort({ day: 1 });
    
    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    console.error('Error fetching email templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching email templates',
    });
  }
});

// Create or update email template
router.post('/email-templates', async (req, res) => {
  try {
    await connectToDatabase();
    
    const { day, subject, htmlContent, isActive } = req.body;
    
    // Validate input
    if (!day || !subject || !htmlContent) {
      return res.status(400).json({
        success: false,
        message: 'Day, subject, and HTML content are required',
      });
    }
    
    if (day < 1 || day > 30) {
      return res.status(400).json({
        success: false,
        message: 'Day must be between 1 and 30',
      });
    }
    
    // Check if template already exists
    let template = await EmailTemplate.findOne({ day });
    
    if (template) {
      // Update existing template
      template.subject = subject;
      template.htmlContent = htmlContent;
      template.isActive = isActive !== undefined ? isActive : true;
      template.updatedAt = new Date();
      await template.save();
    } else {
      // Create new template
      template = new EmailTemplate({
        day,
        subject,
        htmlContent,
        isActive: isActive !== undefined ? isActive : true,
      });
      await template.save();
    }
    
    res.json({
      success: true,
      message: 'Template saved successfully',
      data: template,
    });
  } catch (error) {
    console.error('Error saving email template:', error);
    res.status(500).json({
      success: false,
      message: 'Error saving email template',
    });
  }
});

// Get email statistics
router.get('/statistics', async (req, res) => {
  try {
    await connectToDatabase();
    
    const stats = await FeedbackTracker.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);
    
    const totalTrackers = await FeedbackTracker.countDocuments();
    
    // Calculate email statistics
    const emailStats = await FeedbackTracker.aggregate([
      {
        $project: {
          totalEmails: { $literal: 4 }, // 4 emails per tracker (days 3, 7, 14, 30)
          sentEmails: {
            $add: [
              { $cond: [{ $eq: ['$emailSchedule.day3.sent', true] }, 1, 0] },
              { $cond: [{ $eq: ['$emailSchedule.day7.sent', true] }, 1, 0] },
              { $cond: [{ $eq: ['$emailSchedule.day14.sent', true] }, 1, 0] },
              { $cond: [{ $eq: ['$emailSchedule.day30.sent', true] }, 1, 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalEmailsPossible: { $sum: '$totalEmails' },
          totalEmailsSent: { $sum: '$sentEmails' },
        },
      },
    ]);
    
    res.json({
      success: true,
      data: {
        overall: {
          totalTrackers,
          statusBreakdown: stats.reduce((acc, stat) => {
            acc[stat._id] = stat.count;
            return acc;
          }, {}),
        },
        emailPerformance: emailStats[0] ? {
          emailsSent: emailStats[0].totalEmailsSent,
          emailsPossible: emailStats[0].totalEmailsPossible,
          emailRate: emailStats[0].totalEmailsPossible > 0 
            ? Math.round((emailStats[0].totalEmailsSent / emailStats[0].totalEmailsPossible) * 100) 
            : 0,
        } : { emailsSent: 0, emailsPossible: 0, emailRate: 0 },
      },
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics',
    });
  }
});

module.exports = router;