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
  if (cachedConnection) {
    return cachedConnection;
  }

  mongoose.connection.on("connected", () => console.log("MongoDB connected"));
  mongoose.connection.on("error", (err) =>
    console.error("MongoDB connection error:", err)
  );

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
    });

    cachedConnection = conn;
    return conn;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}


const Schema = mongoose.Schema;

const OrderSchema = new Schema({
  name: String,
  language: String,
  email: { type: String, unique: true },
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

// Enable various security headers
app.use(helmet());

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
  region: "na", // The region of the selling partner API endpoint (“eu”, “na” or “fe”)
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
      await connectToDatabase();

      // Create a new order
      const order = new Order(formData);
      // Save the order to the database
      await order.save();

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

      // // Send email to the user
      // transporter.sendMail(userMailOptions, (error, info) => {
      //   if (error) {
      //     console.error(error);
      //   } else {
      //     // Send email to the admin
      //     transporter.sendMail(adminMailOptions, (error, info) => {
      //       if (error) {
      //         console.error(error);
      //       } else {
      //         console.log(info);
      //       }
      //     });
      //   }
      // });

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
            console.error("Error sending email to user:", error);
            reject(error);
          } else {
            console.log("Email sent to user:", info);
            resolve(info);
          }
        });
      });

      res
        .status(200)
        .json({ success: true, message: "Emails sent successfully" });
    } catch (err) {
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

// app.listen(5000, function (err) {
//   if (err) console.log("Error in server setup");
//   console.log("Server listening on Port", 5000);
// });

module.exports = app;
