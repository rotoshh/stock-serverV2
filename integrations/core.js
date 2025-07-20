const nodemailer = require('nodemailer');

async function SendEmail({ to, subject, body, from_name = "RiskWise Auto-Trader" }) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"${from_name}" <${process.env.MAIL_USER}>`,
      to,
      subject,
      html: body,
    });

    console.log(`📧 מייל נשלח בהצלחה אל ${to}`);
  } catch (err) {
    console.error(`❌ שגיאה בשליחת מייל: ${err.message}`);
  }
}

module.exports = { SendEmail };
