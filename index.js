const express = require("express");
const geoip = require("fast-geoip");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const SellingPartnerAPI = require("amazon-sp-api");
const path = require("path");

const app = express();
app.use(express.json());
require("dotenv").config();

const cors = require("cors");
const allowedOrigins = [
  "https://studykey-riddles.vercel.app",
  // "http://localhost:3000",
];

const nodemailer = require("nodemailer");
const createDOMPurify = require("dompurify");
const { JSDOM } = require("jsdom");
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const admin = require("firebase-admin");

const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "studykey-b1dc7.appspot.com",
  });
}

const bucket = admin.storage().bucket();
const englishPdfFile = bucket.file("reward_english.pdf");
const spanishPdfFile = bucket.file("reward_spanish.pdf");

const mongoose = require("mongoose");
require("dotenv").config();

// MongoDB connection optimization
let cachedConnection = null;

async function connectToDatabase() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  mongoose.connection.on('connected', () => console.log('MongoDB connected'));
  mongoose.connection.on('error', (err) => console.error('MongoDB connection error:', err));

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000, // Increase timeout to 30 seconds
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000, // Increase timeout to 30 seconds
      maxPoolSize: 10,
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    cachedConnection = conn;
    return conn;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

// Connect to MongoDB on server startup
(async () => {
  try {
    await connectToDatabase();
    console.log('Connected to MongoDB at startup');
  } catch (err) {
    console.error('Failed to connect to MongoDB at startup:', err);
  }
})();

const Schema = mongoose.Schema;

const OrderSchema = new Schema({
  name: String,
  language: String,
  email: { type: String, unique: true },
  product: String,
  createdAt: { type: Date, default: Date.now }
});

let Order;
if (mongoose.models.Order) {
  Order = mongoose.model("Order");
} else {
  Order = mongoose.model("Order", OrderSchema);
}

const handlebars = require("nodemailer-express-handlebars");

// Create a transporter object using the default SMTP transport
let transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER, // Your Gmail address
    pass: process.env.GMAIL_PASS, // Your Gmail password or App Password
  },
});

transporter.use(
  "compile",
  handlebars({
    viewEngine: {
      extName: ".html", // handlebars extension
      partialsDir: path.join(__dirname, "views/email"),
      layoutsDir: path.join(__dirname, "views/email"),
      defaultLayout: "reward.html", // email template file
    },
    viewPath: path.join(__dirname, "views/email"),
    extName: ".html",
  })
);

// Completely disable Helmet CSP to make the admin page work properly
app.use(
  helmet({
    contentSecurityPolicy: false // Completely disable CSP
  })
);

// Limit requests to 100 per hour per IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // limit each IP to 100 requests per windowMs
});

// Apply rate limiter to all requests
app.use(limiter);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        var msg =
          "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

let sellingPartner = new SellingPartnerAPI({
  region: "na", // The region of the selling partner API endpoint ("eu", "na" or "fe")
  refresh_token: process.env.REFRESH_TOKEN, // The refresh token of your app user
  options: {
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET:
        process.env.SELLING_PARTNER_APP_CLIENT_SECRET,
    },
  },
});

app.post("/validate-order-id", async (req, res) => {
  const { orderId } = req.body;
  try {
    const order = await sellingPartner.callAPI({
      operation: "getOrder",
      endpoint: "orders",
      path: {
        orderId: orderId,
      },
    });

    if (Object.keys(order).length > 0) {
      // // Get the order items
      // const orderItems = await sellingPartner.callAPI({
      //   operation: "getOrderItems",
      //   endpoint: "orders",
      //   path: {
      //     orderId: orderId,
      //   },
      // });

      // // Extract the ASINs from the order items
      // const asins = orderItems.OrderItems.map((item) => item.ASIN);

      res.status(200).send({ valid: true });
    } else {
      res.status(400).send({ valid: false });
    }
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send({ error: "An error occurred while validating the order ID" });
  }
});

app.post("/submit-review", async (req, res) => {
  const formData = req.body;

  if (formData) {
    // Determine the PDF file based on the user's language
    let pdfFile;
    if (formData.language === "English") {
      pdfFile = englishPdfFile;
    } else if (formData.language === "Spanish") {
      pdfFile = spanishPdfFile;
    } else {
      // Default to English if the language is neither English nor Spanish
      pdfFile = englishPdfFile;
    }

    try {
      // Ensure we're connected to the database before proceeding
      await connectToDatabase();

      // Create a new order
      const order = new Order({
        name: formData.name,
        language: formData.language,
        email: formData.email,
        set: formData.set, // Store 'set' value in 'product' field
        createdAt: new Date()
      });
      
      // Save the order to the database with explicit try/catch
      try {
        await order.save();
      } catch (dbError) {
        // Check if this is a duplicate email error
        if (dbError.code === 11000) {
          return res.status(409).json({ 
            success: false, 
            message: "This email has already claimed a reward." 
          });
        }
        
        console.error("Database save error:", dbError);
        return res.status(500).json({ 
          success: false, 
          message: "Database error: " + dbError.message 
        });
      }

      // Generate a signed URL for the PDF
      const [url] = await pdfFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days from now in milliseconds
      });

      // Email to the user
      let userMailOptions = {
        from: process.env.GMAIL_USER, // Sender address
        to: formData.email, // User's email
        subject: "Study Key FREE gift", // Subject line
        template: "reward", // Name of the template file without extension
        context: {
          // Variables to replace in the template
          name: formData.name,
          url, // Include the URL in the email
        },
      };

      // Email to the admin
      let adminMailOptions = {
        from: process.env.GMAIL_USER, // Sender address
        to: process.env.GMAIL_USER, // Admin's email
        subject: `New ${formData.language} PDF Claimed`, // Subject line
        html: DOMPurify.sanitize(`
          <h1>New Order Submission</h1>
          <p><strong>User Name:</strong> ${formData.name}</p>
          <p><strong>Language:</strong> ${formData.language}</p>
          <p><strong>Level:</strong> ${formData.level}</p>
          <p><strong>Email:</strong> ${formData.email}</p>
          <p><strong>Set:</strong> ${formData.set}</p>
          <p><strong>OrderID:</strong> ${formData.orderId}</p>
        `), // Sanitized HTML body
      };

      await new Promise((resolve, reject) => {
        transporter.sendMail(userMailOptions, (error, info) => {
          if (error) {
            console.error("Error sending email to user:", error);
            reject(error);
          } else {
            console.log("Email sent to user:", info);
            resolve(info);
          }
        });
      });

      await new Promise((resolve, reject) => {
        transporter.sendMail(adminMailOptions, (error, info) => {
          if (error) {
            console.error("Error sending email to admin:", error);
            reject(error);
          } else {
            console.log("Email sent to admin:", info);
            resolve(info);
          }
        });
      });

      res
        .status(200)
        .json({ success: true, message: "Emails sent successfully" });
    } catch (err) {
      console.error("Error in submit-review:", err);
      res
        .status(500)
        .json({ success: false, message: "Error: " + err.message });
    }
  } else {
    res.status(400).json({ success: false, message: "Invalid form data" });
  }
});

app.get("/", async (req, res) => {
  res.status(200).send("api running");
});

app.get("/api/location", async (req, res) => {
  const ip = req.ip || "127.0.0.1";
  const geo = await geoip.lookup(ip);
  res.send(geo);
});

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
  const { token } = req.query;
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

// Admin routes
app.get("/admin/orders", authenticateAdmin, async (req, res) => {
  try {
    // Ensure we're connected to the database before proceeding
    await connectToDatabase();
    
    const { startDate, endDate, language, searchTerm, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    // Build filter based on query parameters
    let filter = {};
    
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else if (startDate) {
      filter.createdAt = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.createdAt = { $lte: new Date(endDate) };
    }
    
    if (language) {
      filter.language = language;
    }
    
    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } }
      ];
    }
    
    // Use a try/catch for the database operation specifically
    let orders;
    let total;
    try {
      // Get total count for pagination
      total = await Order.countDocuments(filter);
      
      // Get paginated results
      orders = await Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean()
        .exec();
    } catch (dbError) {
      console.error("Database query error:", dbError);
      return res.status(500).json({ success: false, message: "Database error: " + dbError.message });
    }
    
    res.status(200).json({ 
      success: true, 
      orders,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ success: false, message: "Error: " + err.message });
  }
});

// Route to download orders as CSV
app.get("/admin/orders/csv", authenticateAdmin, async (req, res) => {
  try {
    // Ensure we're connected to the database before proceeding
    await connectToDatabase();
    
    const { startDate, endDate, language, searchTerm } = req.query;
    
    // Build filter same as above
    let filter = {};
    
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else if (startDate) {
      filter.createdAt = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.createdAt = { $lte: new Date(endDate) };
    }
    
    if (language) {
      filter.language = language;
    }
    
    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } }
      ];
    }
    
    // Use a try/catch for the database operation specifically
    let orders;
    try {
      // Get all matching orders without pagination
      orders = await Order.find(filter).sort({ createdAt: -1 }).lean().exec();
    } catch (dbError) {
      console.error("Database query error:", dbError);
      return res.status(500).json({ success: false, message: "Database error: " + dbError.message });
    }
    
    // Generate CSV content
    let csv = 'Name,Email,Language,Product,Created Date\n';
    orders.forEach(order => {
      const date = order.createdAt ? new Date(order.createdAt).toISOString().split('T')[0] : 'N/A';
      csv += `"${order.name || ''}","${order.email || ''}","${order.language || ''}","${order.set || ''}","${date}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    res.status(200).send(csv);
  } catch (err) {
    console.error("Error downloading CSV:", err);
    res.status(500).json({ success: false, message: "Error: " + err.message });
  }
});

// Admin page HTML route
app.get("/admin", authenticateAdmin, async (req, res) => {
  try {
    // Ensure we're connected to the database before proceeding
    await connectToDatabase();
    
    // Get query parameters
    const { startDate, endDate, language, searchTerm, page = 1 } = req.query;
    const pageNum = parseInt(page) || 1;
    const limit = 10;
    const skip = (pageNum - 1) * limit;
    
    // Build filter based on query parameters
    let filter = {};
    
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else if (startDate) {
      filter.createdAt = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.createdAt = { $lte: new Date(endDate) };
    }
    
    if (language) {
      filter.language = language;
    }
    
    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } }
      ];
    }
    
    // Use a try/catch for the database operations
    let orders;
    let total = 0;
    
    try {
      // Get total count for pagination
      total = await Order.countDocuments(filter);
      
      // Get paginated results
      orders = await Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec();
    } catch (dbError) {
      console.error("Database query error:", dbError);
      return res.status(500).json({ success: false, message: "Database error: " + dbError.message });
    }
    
    const totalPages = Math.ceil(total / limit);
    
    // Generate rows for the current page
    let rows = orders.map(order => {
      const date = order.createdAt ? new Date(order.createdAt).toLocaleDateString() : 'N/A';
      return '<tr>' + 
        '<td>' + (order.name || '-') + '</td>' +
        '<td>' + (order.email || '-') + '</td>' +
        '<td>' + (order.language || '-') + '</td>' +
        '<td>' + (order.set || '-') + '</td>' +
        '<td>' + date + '</td>' +
        '</tr>';
    }).join('');

    // Generate pagination HTML
    let paginationHTML = '';
    
    if (totalPages > 1) {
      paginationHTML += `<li class="page-item ${pageNum <= 1 ? 'disabled' : ''}">
        <a class="page-link" href="?token=${req.query.token}&page=${pageNum - 1}${startDate ? '&startDate='+startDate : ''}${endDate ? '&endDate='+endDate : ''}${language ? '&language='+language : ''}${searchTerm ? '&searchTerm='+searchTerm : ''}">Previous</a>
      </li>`;
      
      // Page numbers
      const startPage = Math.max(1, pageNum - 2);
      const endPage = Math.min(totalPages, pageNum + 2);
      
      for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `<li class="page-item ${i === pageNum ? 'active' : ''}">
          <a class="page-link" href="?token=${req.query.token}&page=${i}${startDate ? '&startDate='+startDate : ''}${endDate ? '&endDate='+endDate : ''}${language ? '&language='+language : ''}${searchTerm ? '&searchTerm='+searchTerm : ''}">${i}</a>
        </li>`;
      }
      
      // Next button
      paginationHTML += `<li class="page-item ${pageNum >= totalPages ? 'disabled' : ''}">
        <a class="page-link" href="?token=${req.query.token}&page=${pageNum + 1}${startDate ? '&startDate='+startDate : ''}${endDate ? '&endDate='+endDate : ''}${language ? '&language='+language : ''}${searchTerm ? '&searchTerm='+searchTerm : ''}">Next</a>
      </li>`;
    }

    // HTML template
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin Dashboard</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
          body { padding: 20px; }
          .filters { margin-bottom: 20px; }
          table { width: 100%; }
          th, td { padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          .pagination { justify-content: center; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1 class="mb-4">Study Key - Orders Management</h1>
          <div class="alert alert-info">Total Orders: ${total} (Page ${pageNum} of ${totalPages})</div>
          
          <form method="GET" action="/admin" class="filters row g-3">
            <input type="hidden" name="token" value="${req.query.token}">
            <div class="col-md-3">
              <label class="form-label">Start Date</label>
              <input type="date" class="form-control" id="startDate" name="startDate" value="${startDate || ''}">
            </div>
            <div class="col-md-3">
              <label class="form-label">End Date</label>
              <input type="date" class="form-control" id="endDate" name="endDate" value="${endDate || ''}">
            </div>
            <div class="col-md-3">
              <label class="form-label">Language</label>
              <select class="form-select" id="language" name="language">
                <option value="" ${!language ? 'selected' : ''}>All Languages</option>
                <option value="English" ${language === 'English' ? 'selected' : ''}>English</option>
                <option value="Spanish" ${language === 'Spanish' ? 'selected' : ''}>Spanish</option>
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label">Search</label>
              <input type="text" class="form-control" id="searchTerm" name="searchTerm" placeholder="Name or Email" value="${searchTerm || ''}">
            </div>
            <div class="col-12 mt-3">
              <button type="submit" class="btn btn-primary">Apply Filters</button>
              <a href="/admin?token=${req.query.token}" class="btn btn-secondary ms-2">Reset Filters</a>
              <a href="/admin/orders/csv?token=${req.query.token}${startDate ? '&startDate='+startDate : ''}${endDate ? '&endDate='+endDate : ''}${language ? '&language='+language : ''}${searchTerm ? '&searchTerm='+searchTerm : ''}" class="btn btn-success ms-2">Download CSV</a>
              <a href="/admin/orders/pdf?token=${req.query.token}${startDate ? '&startDate='+startDate : ''}${endDate ? '&endDate='+endDate : ''}${language ? '&language='+language : ''}${searchTerm ? '&searchTerm='+searchTerm : ''}" class="btn btn-danger ms-2">Download PDF</a>
            </div>
          </form>
          
          <div class="table-responsive">
            <table class="table table-striped">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Language</th>
                  <th>Set</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length ? rows : '<tr><td colspan="5" class="text-center">No orders found</td></tr>'}
              </tbody>
            </table>
          </div>
          
          <nav aria-label="Page navigation">
            <ul class="pagination">
              ${paginationHTML}
            </ul>
          </nav>
        </div>
      </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (err) {
    console.error("Error rendering admin page:", err);
    res.status(500).json({ success: false, message: "Error: " + err.message });
  }
});

// Add PDF generation route using PDFKit
const PDFDocument = require('pdfkit');

app.get("/admin/orders/pdf", authenticateAdmin, async (req, res) => {
  try {
    // Ensure we're connected to the database before proceeding
    await connectToDatabase();
    
    const { startDate, endDate, language, searchTerm } = req.query;
    
    let filter = {};
    
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else if (startDate) {
      filter.createdAt = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.createdAt = { $lte: new Date(endDate) };
    }
    
    if (language) {
      filter.language = language;
    }
    
    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } }
      ];
    }
    
    // Use a try/catch for the database operation specifically
    let orders;
    try {
      // Get all matching orders without pagination
      orders = await Order.find(filter).sort({ createdAt: -1 }).lean().exec();
    } catch (dbError) {
      console.error("Database query error:", dbError);
      return res.status(500).json({ success: false, message: "Database error: " + dbError.message });
    }
    
    // Generate PDF
    const doc = new PDFDocument();
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.pdf');
    
    // Pipe the PDF to the response
    doc.pipe(res);
    
    // Add content to the PDF
    doc.fontSize(20).text('Study Key - Orders Report', { align: 'center' });
    doc.moveDown();
    
    // Add filters info
    doc.fontSize(12);
    if (startDate || endDate) {
      let dateRange = 'Date Range: ';
      if (startDate) dateRange += `From ${startDate} `;
      if (endDate) dateRange += `To ${endDate}`;
      doc.text(dateRange);
    }
    if (language) doc.text(`Language: ${language}`);
    if (searchTerm) doc.text(`Search Term: ${searchTerm}`);
    doc.text(`Total Orders: ${orders.length}`);
    
    doc.moveDown();
    
    // Define table layout
    const tableTop = 150;
    const nameX = 50;
    const emailX = 150;
    const languageX = 300;
    const productX = 380;
    const dateX = 470;
    
    // Add table headers
    doc.font('Helvetica-Bold');
    doc.text('Name', nameX, tableTop);
    doc.text('Email', emailX, tableTop);
    doc.text('Language', languageX, tableTop);
    doc.text('Product', productX, tableTop);
    doc.text('Date', dateX, tableTop);
    
    // Add table rows
    let y = tableTop + 20;
    doc.font('Helvetica');
    
    orders.forEach((order, i) => {
      // Add a new page if we reach the bottom
      if (y > 700) {
        doc.addPage();
        y = 50;
        // Add headers to new page
        doc.font('Helvetica-Bold');
        doc.text('Name', nameX, y);
        doc.text('Email', emailX, y);
        doc.text('Language', languageX, y);
        doc.text('Product', productX, y);
        doc.text('Date', dateX, y);
        doc.font('Helvetica');
        y += 20;
      }
      
      const date = order.createdAt ? new Date(order.createdAt).toLocaleDateString() : 'N/A';
      doc.text(order.name || '-', nameX, y, { width: 90 });
      doc.text(order.email || '-', emailX, y, { width: 140 });
      doc.text(order.language || '-', languageX, y, { width: 70 });
      doc.text(order.product || '-', productX, y, { width: 80 });
      doc.text(date, dateX, y);
      
      y += 20;
    });
    
    // Finalize the PDF
    doc.end();
  } catch (err) {
    console.error("Error generating PDF:", err);
    res.status(500).json({ success: false, message: "Error: " + err.message });
  }
});

app.listen(5000, function (err) {
  if (err) console.log("Error in server setup");
  console.log("Server listening on Port", 5000);
});

module.exports = app;
