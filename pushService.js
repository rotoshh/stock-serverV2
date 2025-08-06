const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function sendPushNotification(subscription, payload) {
  return webpush.sendNotification(subscription, JSON.stringify(payload))
    .then(() => console.log('📤 נשלחה התראה דחיפה'))
    .catch(err => console.error('❌ שגיאה בשליחת התראה:', err));
}

module.exports = {
  sendPushNotification
};
