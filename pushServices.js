// pushServices.js
const webPush = require('web-push');

const vapidKeys = {
  publicKey: 'BLQ_Lig1S07gbWxbvMzNIvr7kgt8s0AT7gnL91wdCt5hl_GjOIvjO--9GCJL7j0L1vI-BtHVVL1HG8Nubr1mrnA',
  privateKey: process.env.VAPID_PRIVATE_KEY
};

webPush.setVapidDetails(
  'mailto:your-email@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// זיכרון זמני – רצוי להחליף למסד נתונים
const subscriptions = {};

function registerSubscription(userId, subscription) {
  subscriptions[userId] = subscription;
}

async function sendPushNotification(userId, message) {
  const subscription = subscriptions[userId];
  if (!subscription) return;

  try {
    await webPush.sendNotification(subscription, JSON.stringify({ title: 'התראה', body: message }));
    console.log(`📲 נשלחה התראה למשתמש ${userId}: ${message}`);
  } catch (err) {
    console.error(`❌ שגיאה בשליחת התראה למשתמש ${userId}:`, err.message);
  }
}

module.exports = {
  registerSubscription,
  sendPushNotification
};
